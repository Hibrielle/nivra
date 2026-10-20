import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRule, decide, renderTemplate, defaultConfig } from '../engine.js';
import { parseRulePack, makeRulePack, exportRegExpRules, explainRules } from '../rules.js';
import { evaluateExpression, compileExpression } from '../expressions.js';
import { evaluateNode } from '../mcp/evaluator.mjs';
import { expandUrls, normalizeBatch, addBatch } from '../tasks.js';
const item = {
  filename: 'report-2026.pdf',
  url: 'https://files.test/projects/42/report.pdf?tag=ready',
  finalUrl: 'https://cdn.test/report.pdf',
  referrer: 'https://source.test/page',
  tabUrl: 'https://source.test/tab',
  mime: 'application/pdf',
  startTime: '2026-10-19T12:00:00Z',
  totalBytes: 2048,
  state: 'complete',
  pageTitle: 'Project 42',
  linkText: 'Quarterly report',
  batchIndex: 7,
};
const config = (rules) => ({ enabled: true, matchMode: 'first', rules });
test('full multi-field regex, captures and date/name templates agree with the returned destination', () => {
  const rule = validateRule({
    id: 'advanced',
    name: '项目报告',
    regex: '^(report|invoice)-(\\d+)\\.pdf$',
    mime: '^application/(pdf|zip)$',
    urlRegex: '/projects/(\\d+)/',
    finalUrlRegex: 'cdn\\.test',
    referrerRegex: 'source\\.test',
    tabUrlRegex: '/tab$',
    pathTemplate: '项目/${url:1}/${date:YYYY.MM}/${filename:1}-${filename:2}.{ext}',
  });
  assert.equal(decide(item, config([rule])).target, '项目/42/2026.10/report-2026.pdf');
  assert.equal(decide({ ...item, mime: 'image/png' }, config([rule])).kind, 'unmatched');
  assert.equal(decide({ ...item, tabUrl: '' }, config([rule])).kind, 'unmatched');
  assert.equal(
    renderTemplate('批量/{num:3}_*page_title*_*name*.*ext*', item),
    '批量/007_Project 42_report-2026.pdf',
  );
});
test('first/last match, exclusions and missing captures are explicit', () => {
  const rules = [
    { id: 'keep', name: '排除', enabled: true, extensions: 'pdf', action: 'keep' },
    { id: 'move', name: '文档', enabled: true, extensions: 'pdf', folder: '文件' },
  ];
  assert.equal(decide(item, config(rules)).kind, 'excluded');
  assert.equal(
    decide(item, { ...config(rules), matchMode: 'last' }).target,
    '文件/report-2026.pdf',
  );
  assert.equal(
    explainRules(item, { ...config(rules), matchMode: 'last' }).steps[1].status,
    'selected',
  );
  assert.equal(
    decide(
      item,
      config([
        { name: 'missing', enabled: true, extensions: 'pdf', pathTemplate: '${url:5}/${filename}' },
      ]),
    ).kind,
    'error',
  );
  assert.equal(
    decide({ ...item, filename: '%E5%8F%91%E7%A5%A8.pdf' }, defaultConfig()).target,
    '文档/2026-10/发票.pdf',
  );
});
test('RegExp native import and export retain field matching and capture destinations', () => {
  const native = [
    {
      description: 'Native',
      enabled: true,
      mime: 'application/pdf',
      filename: '(report)-([0-9]+)\\.pdf',
      url: '/projects/(\\d+)/',
      finalUrl: 'cdn.test',
      referrer: 'source.test',
      tabUrl: 'source.test',
      pattern: '/${url:1}/${date:YYYY-MM}/${filename:1}.pdf',
      'conflict-action': 'prompt',
    },
  ];
  const pack = parseRulePack(JSON.stringify(native));
  assert.equal(decide(item, config(pack.rules)).target, '42/2026-10/report.pdf');
  assert.equal(decide(item, config(pack.rules)).conflictAction, 'prompt');
  const roundtrip = parseRulePack(exportRegExpRules(pack.rules));
  assert.deepEqual(roundtrip, pack);
  const basics = makeRulePack([
    { name: 'Docs', extensions: 'pdf, docx', keyword: 'report', folder: 'Docs/{year}-{month}' },
  ]);
  assert.equal(
    decide(item, config(parseRulePack(exportRegExpRules(basics.rules)).rules)).target,
    'Docs/2026-10/report-2026.pdf',
  );
  assert.throws(
    () => exportRegExpRules([{ name: 'cannot', domain: 'files.test', folder: 'A' }]),
    /拆为多条/,
  );
});
test('Chrono rules, filter references, macros, dates and naming use an AST interpreter', () => {
  const native = [
    {
      int_name: 'r_docs',
      caption: 'Docs filter',
      condition: '*ext*.is([ext_doc])',
      active: false,
      as_filter: true,
    },
    {
      int_name: 'r_project',
      caption: 'Small docs',
      condition: '{r_docs} && *size* >= kb(1) && *size* < mb(1) && *state* = [finished]',
      active: true,
      folder: 'Project/*page_title*',
      naming: '*num*_*name*.*ext*',
    },
  ];
  const pack = parseRulePack(native);
  assert.equal(decide(item, config(pack.rules)).target, 'Project/Project 42/7_report-2026.pdf');
  assert.equal(
    evaluateExpression('*time_add*._btwn_([today],[today_])', item, { now: item.startTime }),
    true,
  );
  assert.equal(evaluateExpression('*url*.has("projects") && *filename*.length > 2', item), true);
  assert.throws(
    () => compileExpression('*filename*.constructor.constructor("alert(1)")()'),
    /未知/,
  );
  assert.throws(
    () =>
      evaluateExpression('{r_loop}', item, {
        rules: [{ reference: 'r_loop', condition: '{r_loop}' }],
      }),
    /循环/,
  );
  assert.throws(
    () =>
      parseRulePack([
        {
          caption: 'Run external command',
          active: true,
          condition: 'true',
          post_action: 'evil.exe',
        },
      ]),
    /不受支持/,
  );
});
test('a catastrophic regex terminates in the Node worker and the next evaluation still works', async () => {
  const payload = {
    item: { ...item, filename: 'a'.repeat(240) + '!' },
    config: config([{ name: 'costly', enabled: true, regex: '(a+)+$', folder: 'x' }]),
  };
  const started = Date.now();
  await assert.rejects(evaluateNode('decide', payload, 120), /超过 120/);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await evaluateNode('decide', { item, config: defaultConfig() })).kind, 'matched');
});
test('file preview post-actions are rejected while folder reveal remains available', () => {
  const legacy = { caption: '完成后操作', active: true, condition: 'true' };
  assert.throws(() => parseRulePack([{ ...legacy, post_action: '<file>' }]), /不受支持/);
  assert.equal(
    parseRulePack([{ ...legacy, post_action: '<folder>' }]).rules[0].postAction,
    'reveal',
  );
  assert.throws(
    () => validateRule({ name: '预览', extensions: 'txt', postAction: 'preview' }),
    /完成后动作/,
  );
});
test('batch URL ranges cover numeric/alphabetic/step/cartesian/descending forms and enforce limits', () => {
  assert.deepEqual(expandUrls('https://example.test/[a:b]/[001:003:2].pdf'), [
    'https://example.test/a/001.pdf',
    'https://example.test/a/003.pdf',
    'https://example.test/b/001.pdf',
    'https://example.test/b/003.pdf',
  ]);
  assert.deepEqual(expandUrls('https://example.test/[3:1].pdf\nhttps://example.test/3.pdf'), [
    'https://example.test/3.pdf',
    'https://example.test/2.pdf',
    'https://example.test/1.pdf',
  ]);
  for (const url of [
    'javascript:alert(1)',
    'file:///tmp/a',
    'https://user:pass@example.test/a',
    'https://example.test/[1:1000000]',
    'https://example.test/[1:4:0]',
  ])
    assert.throws(() => expandUrls(url));
  const batch = normalizeBatch({
    text: 'https://example.test/[1:3].pdf',
    template: 'Batch/{num:3}_{filename}',
  });
  assert.equal(batch.length, 3);
  assert.equal(batch[2].batchIndex, 3);
  assert.equal(batch[0].state, 'waiting');
  assert.throws(
    () => normalizeBatch({ text: 'https://example.test/1.pdf', template: '../escape' }),
    /相对|越界|目录/,
  );
});

test('a full waiting queue rejects additions without dropping older tasks', async () => {
  const queue = {
    paused: true,
    items: Array.from({ length: 3000 }, (_, index) => ({
      id: String(index),
      state: 'waiting',
      url: `https://example.test/${index}.pdf`,
    })),
  };
  const previous = globalThis.chrome;
  let wrote = false;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ downloadQueue: structuredClone(queue) }),
        set: async () => {
          wrote = true;
          throw new Error('Unexpected write');
        },
      },
    },
  };
  try {
    await assert.rejects(addBatch({ text: 'https://example.test/extra.pdf' }), /3000/);
    assert.equal(wrote, false);
    assert.equal(queue.items[0].id, '0');
  } finally {
    globalThis.chrome = previous;
  }
});

test('path expansion sanitizes page titles consistently for batch and rule downloads', async () => {
  const result = await evaluateNode('template', {
    template: 'Assets/{page_title}/{filename}',
    item: { ...item, pageTitle: 'Project: alpha?' },
  });
  assert.equal(result, 'Assets/Project_ alpha_/report-2026.pdf');
  await assert.rejects(
    evaluateNode('template', {
      template: '{page_title}/{filename}',
      item: { ...item, pageTitle: '../escape' },
    }),
    /越界/,
  );
});
