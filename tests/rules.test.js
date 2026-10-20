import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, decide } from '../engine.js';
import {
  makeRulePack,
  parseRulePack,
  planImport,
  explainRules,
  RULE_TEMPLATES,
  sampleFromRecord,
} from '../rules.js';

test('every template creates a valid portable rule pack and matches its example', () => {
  for (const template of RULE_TEMPLATES) {
    const pack = makeRulePack([template.rule]);
    const rule = pack.rules[0];
    assert.equal('id' in rule, false);
    assert.equal(
      decide(
        { ...template.sample, startTime: '2026-10-19T12:00:00Z' },
        { enabled: true, rules: [rule] },
      ).kind,
      'matched',
      template.id,
    );
  }
});

test('import parses JSON and AI fences, normalizes extensions and excludes internal state', () => {
  const pack = makeRulePack([
    { name: 'PDF', extensions: '.PDF，docx', folder: '文档', id: 'private-id' },
  ]);
  assert.equal(pack.rules[0].extensions, 'pdf, docx');
  assert.deepEqual(parseRulePack('```json\n' + JSON.stringify(pack) + '\n```'), pack);
  assert.equal(JSON.stringify(pack).includes('private-id'), false);
});

test('invalid imported rule or unsupported field rejects the entire pack', () => {
  const good = { name: 'PDF', extensions: 'pdf', folder: '文档' };
  for (const bad of [
    { ...good, folder: '../escape' },
    { ...good, enabled: 'false' },
    { ...good, script: 'execute' },
    { ...good, extensions: [] },
    { name: '空条件', folder: '文件' },
  ]) {
    assert.throws(
      () => parseRulePack({ format: 'nivra-rules', version: 1, rules: [good, bad] }),
      /第 2 条/,
    );
  }
  assert.throws(
    () => parseRulePack({ format: 'nivra-rules', version: 2, rules: [good] }),
    /version/,
  );
  assert.throws(() => parseRulePack(' '.repeat(128 * 1024 + 1)), /128 KiB/);
});

test('import preserves existing rule IDs/order, skips semantic duplicates, and supports prepend or append', () => {
  const existing = defaultConfig().rules;
  const before = structuredClone(existing);
  const newRule = { name: '发票', extensions: 'pdf', keyword: '发票', folder: '票据' };
  const pack = makeRulePack([
    {
      ...existing[0],
      name: '重命名的文档',
      extensions: existing[0].extensions.split(', ').reverse().join(', '),
    },
    newRule,
    newRule,
  ]);
  const first = planImport(pack, existing, 'first');
  const last = planImport(pack, existing, 'last');
  assert.equal(first.added.length, 1);
  assert.equal(first.skipped.length, 2);
  assert.equal(first.rules[0].name, '发票');
  assert.equal(first.rules[1].id, 'documents');
  assert.equal(last.rules[0].id, 'documents');
  assert.equal(last.rules.at(-1).name, '发票');
  assert.deepEqual(existing, before);
});

test('explanations agree with actual decisions and expose lower priority matches and failed conditions', () => {
  const rules = [
    {
      name: '票据',
      id: 'invoice',
      enabled: true,
      extensions: 'pdf',
      keyword: '发票',
      folder: '票据',
    },
    ...defaultConfig().rules,
  ];
  const sample = {
    filename: '发票.pdf',
    url: 'https://example.com/file',
    startTime: '2026-10-19T12:00:00Z',
  };
  const config = { enabled: true, rules };
  const result = explainRules(sample, config);
  assert.deepEqual(result.decision, decide(sample, config));
  assert.equal(result.steps[0].status, 'selected');
  assert.equal(result.steps[1].status, 'shadowed');
  assert.equal(result.steps[2].checks[0].matched, false);
  const noKeyword = explainRules({ ...sample, filename: 'other.pdf' }, config);
  assert.equal(noKeyword.steps[0].checks.find((c) => c.label === '文件名包含').matched, false);
  assert.equal(noKeyword.decision.ruleId, 'documents');
  assert.equal(explainRules(sample, { ...config, enabled: false }).steps[0].status, 'paused');
});

test('record samples preserve all available matching context and flag older partial records', () => {
  const context = {
    url: 'https://cdn.example.com/file',
    finalUrl: 'https://final.example.com/file',
    referrer: 'https://source.example.com/page',
  };
  const sample = sampleFromRecord({
    originalName: 'a.pdf',
    filename: '/Downloads/a (1).pdf',
    startTime: '2026-10-19T12:00:00Z',
    matchContext: context,
  });
  assert.equal(sample.filename, 'a.pdf');
  assert.equal(sample.referrer, context.referrer);
  assert.equal(sample.approximate, false);
  assert.equal(sampleFromRecord({ filename: 'a.pdf', source: context.url }).approximate, true);
});
