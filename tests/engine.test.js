import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultConfig,
  decide,
  validateRule,
  validateFolder,
  sanitizedFilename,
  displaySource,
  recordStatus,
  compileFilenameRegex,
} from '../engine.js';

const item = (filename, extra = {}) => ({
  filename,
  startTime: '2026-10-19T12:00:00Z',
  url: 'https://cdn.example.com/download/file',
  ...extra,
});
const rule = (extra = {}) => ({
  id: 'test',
  name: '工作文档',
  enabled: true,
  extensions: 'pdf',
  folder: '文档/{year}-{month}',
  ...extra,
});
const config = (rules) => ({ enabled: true, rules });

test('routes new document, image, archive and installer downloads into dated directories', () => {
  const defaults = defaultConfig();
  for (const [file, folder] of [
    ['report.PDF', '文档'],
    ['image.png', '图片'],
    ['source.zip', '压缩包'],
    ['build.apk', '安装包'],
  ]) {
    assert.equal(decide(item(file), defaults).target, `${folder}/2026-10/${file}`);
  }
  assert.equal(decide(item('unknown.blob'), defaults).kind, 'unmatched');
});

test('first enabled matching rule wins; conditions are combined with AND', () => {
  const rules = [
    rule({ id: 'specific', domain: 'example.com', keyword: 'report', folder: '工作' }),
    rule({ id: 'fallback' }),
  ];
  assert.equal(decide(item('report.pdf'), config(rules)).folder, '工作');
  assert.equal(decide(item('invoice.pdf'), config(rules)).ruleId, 'fallback');
  assert.equal(
    decide(item('report.pdf', { url: 'https://evil-example.com/file' }), config(rules)).ruleId,
    'fallback',
  );
  assert.equal(
    decide(item('report.pdf'), config([{ ...rules[0], enabled: false }, rules[1]])).ruleId,
    'fallback',
  );
});

test('source metadata supports exact or child domains but not misleading hosts', () => {
  const rules = [rule({ domain: 'example.com' })];
  assert.equal(
    decide(
      item('a.pdf', { url: 'https://files.test/a', referrer: 'https://www.example.com/report' }),
      config(rules),
    ).kind,
    'matched',
  );
  assert.equal(
    decide(item('a.pdf', { url: 'https://example.com.attacker.test/a' }), config(rules)).kind,
    'unmatched',
  );
  assert.equal(decide(item('a.pdf', { url: 'blob:test' }), config(rules)).kind, 'unmatched');
});

test('paused automation does not suggest any alternate filename', () => {
  assert.deepEqual(decide(item('a.pdf'), { ...defaultConfig(), enabled: false }), {
    kind: 'paused',
  });
});

test('paths reject traversal, absolute paths, unknown template tokens and OS reserved names', () => {
  for (const path of [
    '/tmp',
    '../out',
    '文档/../out',
    'C:\\temp',
    '文档//a',
    '文档/',
    '文档/{oops}',
    'CON/file',
    'folder.',
  ])
    assert.throws(() => validateFolder(path), undefined, path);
  assert.equal(validateFolder('文档/{year}/{month}/{day}'), '文档/{year}/{month}/{day}');
  assert.equal(sanitizedFilename('../../report?.pdf'), 'report_.pdf');
  assert.equal(sanitizedFilename('CON.txt'), '_CON.txt');
});

test('invalid rules are skipped while later valid rules continue working', () => {
  assert.equal(
    decide(item('a.pdf'), config([rule({ folder: '../unsafe' }), rule({ id: 'valid' })])).ruleId,
    'valid',
  );
  assert.throws(() => validateRule(rule({ extensions: '', domain: '', keyword: '', regex: '' })));
});

test('regex compilation supports full syntax; execution is isolated in worker tests', () => {
  const r = rule({ regex: '^report.*\\.pdf$' });
  assert.equal(decide(item('report-2026.pdf'), config([r])).kind, 'matched');
  assert.equal(decide(item('invoice.pdf'), config([r])).kind, 'unmatched');
  for (const pattern of ['(a+)+$', 'a*a*a*$', 'a?a?a?$', '(a|aa)+$', '(a)\\1'])
    assert.ok(compileFilenameRegex(pattern));
  assert.throws(() => compileFilenameRegex('['));
});

test('archive status uses the completed actual directory, tolerating auto-numbered filenames', () => {
  const rec = {
    state: 'complete',
    filename: '/Users/test/Downloads/文档/2026-10/a (1).pdf',
    decision: { kind: 'matched', folder: '文档/2026-10' },
  };
  assert.equal(recordStatus(rec), 'archived');
  assert.equal(recordStatus({ ...rec, filename: '/Users/test/Desktop/a.pdf' }), 'changed');
  assert.equal(
    recordStatus({ ...rec, filename: '/Users/test/Downloads/其他文档/2026-10/a.pdf' }),
    'changed',
  );
  assert.equal(recordStatus({ ...rec, state: 'in_progress' }), 'active');
  assert.equal(recordStatus({ ...rec, state: 'interrupted' }), 'failed');
});

test('activity storage drops URL credentials, tokens and fragments', () => {
  assert.equal(
    displaySource('https://user:secret@example.com/files/report.pdf?token=secret#private'),
    'https://example.com/files/report.pdf',
  );
  assert.equal(displaySource('blob:https://example.com/id'), 'blob:');
  assert.equal(displaySource('not-a-url'), '');
});
