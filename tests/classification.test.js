import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, decide, validateArchiveRoot, renderPath, validateRule } from '../engine.js';
import { FILE_TYPES, defaultRuleLayout, setDefaultFolderLayout } from '../file-types.js';
import { downloadCategory, matchesTaskView } from '../task-view.js';
import { evaluateExpression } from '../expressions.js';
import { evaluateNode } from '../mcp/evaluator.mjs';

const sample = (filename) => ({
  filename,
  url: 'https://files.example.com/download',
  startTime: '2026-10-19T12:00:00Z',
});
test('all catalogue suffixes route to the expected category and agree with completed-task filters', () => {
  const config = defaultConfig();
  assert.equal(config.rules.length, 15);
  for (const rule of config.rules) validateRule(rule);
  const used = new Set();
  for (const type of FILE_TYPES) {
    for (const ext of type.extensions) {
      assert.equal(used.has(ext), false, 'duplicate extension: ' + ext);
      used.add(ext);
      const item = sample('sample.' + ext.toUpperCase());
      const folder = ['audio', 'video'].includes(type.id) ? '音视频' : type.name;
      assert.equal(decide(item, config).target, `${folder}/2026-10/${item.filename}`, ext);
      assert.equal(downloadCategory(item.filename), type.id, ext);
      assert.equal(matchesTaskView({ ...item, state: 'complete' }, type.id), true);
      assert.equal(matchesTaskView({ ...item, state: 'in_progress' }, type.id), false);
    }
  }
  assert.equal(downloadCategory('app.ts'), 'code');
  assert.equal(downloadCategory('weights.unknown'), 'other');
  assert.equal(evaluateExpression('*ext*.is([ext_font])', sample('font.woff2')), true);
  assert.equal(evaluateExpression('*ext*.is([ext_image])', sample('photo.cr3')), true);
});

test('one literal archive prefix is used by normal rules, templates and the isolated evaluator', async () => {
  const config = { ...defaultConfig(), archiveRoot: '资料/下载' };
  assert.equal(decide(sample('font.woff2'), config).target, '资料/下载/字体/2026-10/font.woff2');
  const rule = {
    name: 'Custom',
    enabled: true,
    regex: '(.*)\\.pdf$',
    pathTemplate: '项目/${filename:1}.pdf',
  };
  assert.equal(
    decide(sample('report.pdf'), { ...config, rules: [rule] }).target,
    '资料/下载/项目/report.pdf',
  );
  const batch = {
    template: '批次/{num:3}_{filename}',
    item: sample('book.epub'),
    archiveRoot: '资料/下载',
  };
  assert.equal(await evaluateNode('template', batch), '资料/下载/批次/001_book.epub');
  assert.equal(renderPath('{filename}', sample('report.pdf'), {}, '资料'), '资料/report.pdf');
  assert.equal(decide(sample('report.pdf'), { ...config, enabled: false }).kind, 'paused');
  assert.equal(decide(sample('unknown.log'), config).kind, 'unmatched');
  assert.equal(
    decide(sample('report.pdf'), {
      ...config,
      rules: [{ name: 'Keep', enabled: true, extensions: 'pdf', action: 'keep' }],
    }).kind,
    'excluded',
  );
});

test('archive prefix rejects absolute, traversal, variable, reserved and malformed paths', () => {
  assert.equal(validateArchiveRoot('  资料/下载  '), '资料/下载');
  assert.equal(validateArchiveRoot(''), '');
  for (const root of [
    '/tmp',
    'C:\\Downloads',
    '../out',
    'a/../b',
    'a//b',
    'a/',
    'CON',
    'a.',
    '{year}',
    42,
    'a'.repeat(257),
  ])
    assert.throws(() => validateArchiveRoot(root), undefined, String(root));
});

test('type, month, day and folder order produce the requested download paths', () => {
  const original = defaultConfig();
  for (const [byType, date, order, folder] of [
    [true, 'none', 'type-first', '文档'],
    [false, 'month', 'type-first', '2026-10'],
    [false, 'day', 'type-first', '2026-10-19'],
    [true, 'month', 'type-first', '文档/2026-10'],
    [true, 'day', 'type-first', '文档/2026-10-19'],
    [true, 'month', 'date-first', '2026-10/文档'],
    [true, 'day', 'date-first', '2026-10-19/文档'],
    [false, 'none', 'type-first', ''],
  ]) {
    const layout = { byType, date, order };
    const rules = setDefaultFolderLayout(original.rules, layout);
    const config = { ...original, archiveRoot: '资料', rules };
    assert.equal(
      decide(sample('report.pdf'), config).target,
      ['资料', folder, 'report.pdf'].filter(Boolean).join('/'),
    );
    assert.equal(
      decide(sample('photo.heic'), config).target,
      ['资料', folder.replace('文档', '图片'), 'photo.heic'].filter(Boolean).join('/'),
    );
    assert.deepEqual(defaultRuleLayout(rules[0]), layout);
    assert.deepEqual(
      setDefaultFolderLayout(rules, { byType: true, date: 'month', order: 'type-first' }),
      original.rules,
    );
  }
});

test('layout choice preserves custom paths, rules, disabled states and missing defaults', () => {
  const rules = defaultConfig().rules.slice(0, 5);
  rules[0].folder = '我的文档/{year}';
  rules[1].pathTemplate = '素材/{filename}';
  rules[2].action = 'keep';
  rules[3].enabled = false;
  rules.unshift({ ...rules[4], id: 'custom', folder: '音视频/{year}-{month}' });
  const result = setDefaultFolderLayout(rules, { byType: false, date: 'day', order: 'date-first' });
  assert.deepEqual(result.slice(0, 4), rules.slice(0, 4));
  assert.equal(result[4].enabled, false);
  assert.equal(result[4].folder, '{year}-{month}-{day}');
  assert.equal(result[5].folder, '{year}-{month}-{day}');
  assert.deepEqual(
    result.map((rule) => rule.id),
    rules.map((rule) => rule.id),
  );
});

test('unchanged mixed dimensions retain per-rule choices while invalid options are rejected', () => {
  const rules = defaultConfig().rules.slice(0, 3);
  rules[1].folder = '图片/{year}-{month}-{day}';
  rules[2].folder = '压缩包';
  const result = setDefaultFolderLayout(rules, { byType: false, date: null, order: null });
  assert.deepEqual(
    result.map((rule) => rule.folder),
    ['{year}-{month}', '{year}-{month}-{day}', ''],
  );
  assert.throws(() =>
    setDefaultFolderLayout(rules, { byType: true, date: 'year', order: 'type-first' }),
  );
  assert.throws(() =>
    setDefaultFolderLayout(rules, { byType: 'false', date: 'day', order: 'type-first' }),
  );
});
