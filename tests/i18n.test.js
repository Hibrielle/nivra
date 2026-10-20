import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocale, translate, setLocale, getLocale } from '../i18n.js';
import { messages } from '../i18n-messages.js';
import { defaultRules, defaultRuleLayout, setDefaultFolderLayout } from '../file-types.js';

test('automatic mode reads the current browser language instead of caching an early startup value', () => {
  const previousChrome = globalThis.chrome;
  const previousLocale = getLocale();
  let browser = 'zh-CN';
  try {
    globalThis.chrome = { i18n: { getUILanguage: () => browser } };
    setLocale('auto');
    assert.equal(getLocale(), 'zh-CN');
    browser = 'en-US';
    assert.equal(getLocale(), 'en');
  } finally {
    globalThis.chrome = previousChrome;
    setLocale(previousLocale);
  }
});

test('automatic language uses Chinese for Chinese browser locales and English otherwise', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hant'])
    assert.equal(resolveLocale('auto', locale), 'zh-CN');
  for (const locale of ['en-US', 'de-DE', 'ja', 'fr', ''])
    assert.equal(resolveLocale('auto', locale), 'en');
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
});

test('English messages preserve placeholders and do not translate interpolated user data', () => {
  for (const [source, english] of Object.entries(messages)) {
    assert.ok(english.trim(), source);
    assert.deepEqual(
      [...source.matchAll(/\{\d+\}/g)].map(([value]) => value).sort(),
      [...english.matchAll(/\{\d+\}/g)].map(([value]) => value).sort(),
      source,
    );
  }
  assert.equal(translate('en', '  目标路径  '), '  Target path  ');
  assert.equal(
    translate('en', '下载根目录 / {0}', '我的资料/{name}/发票.pdf'),
    'Download root / 我的资料/{name}/发票.pdf',
  );
  assert.equal(translate('zh-CN', '已选 {0} / {1} 项', 2, 4), '已选 2 / 4 项');
});

test('changing UI language preserves existing folders and still recognizes both default layouts', () => {
  const originalLocale = getLocale();
  try {
    for (const original of ['en', 'zh-CN']) {
      const rules = defaultRules(original);
      const before = structuredClone(rules);
      setLocale(original === 'en' ? 'zh-CN' : 'en');
      assert.deepEqual(defaultRuleLayout(rules[0]), {
        byType: true,
        date: 'month',
        order: 'type-first',
      });
      const updated = setDefaultFolderLayout(rules, {
        byType: true,
        date: 'day',
        order: 'type-first',
      });
      assert.equal(updated[0].folder, before[0].folder + '-{day}');
      assert.deepEqual(rules, before);
    }
  } finally {
    setLocale(originalLocale);
  }
});
