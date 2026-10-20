import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { enableExtensionDiagnostics } from './browser-diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = process.env.EXTENSION_DIR ? path.resolve(process.env.EXTENSION_DIR) : root;
const output = path.join(
  root,
  'artifacts',
  'i18n-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
const profile = await mkdtemp(path.join(tmpdir(), 'nivra-i18n-'));
const isolatedExtension = path.join(profile, 'extension');
await cp(extensionRoot, isolatedExtension, {
  recursive: true,
  filter: (source) =>
    source === extensionRoot ||
    !['node_modules', '.git', 'artifacts', 'dist', 'tests', 'scripts', 'mcp', 'store'].includes(
      path.basename(source),
    ),
});
const downloads = path.join(profile, 'downloads');
await mkdir(downloads);
await mkdir(output, { recursive: true });
await mkdir(path.join(profile, 'Default'));
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false },
    intl: { accept_languages: 'en-US,en', app_locale: 'en-US' },
  }),
);
const files = {
  'project-notes.txt': ['text/plain', Buffer.from('Nivra example notes.\n')],
  'brand.png': ['image/png', await readFile(path.join(root, 'icons/icon128.png'))],
  'project-assets.zip': [
    'application/zip',
    Buffer.from(zipSync({ 'readme.txt': strToU8('Nivra sample archive.\n') })),
  ],
  'sample-data.csv': ['text/csv', Buffer.from('sample,value\n'.repeat(400000))],
};
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
  if (name === 'page') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<title>Nivra demo resources</title><a href="/project-notes.txt">Project notes</a><img src="/brand.png" alt="Nivra icon">',
    );
    return;
  }
  const file = files[name];
  if (!file) {
    res.writeHead(404);
    res.end();
    return;
  }
  const [mime, bytes] = file;
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': bytes.length,
    'Content-Disposition': `attachment; filename="${name}"`,
  });
  if (name !== 'sample-data.csv') {
    res.end(bytes);
    return;
  }
  let offset = 0,
    tick = 0;
  const timer = setInterval(() => {
    const end = Math.min(
      bytes.length,
      offset + [65536, 196608, 327680, 131072][Math.floor(tick++ / 4) % 4],
    );
    res.write(bytes.subarray(offset, end));
    offset = end;
    if (offset === bytes.length) {
      clearInterval(timer);
      res.end();
    }
  }, 500);
  res.on('close', () => clearInterval(timer));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const checks = [],
  errors = [];
let context, manager, popup, report, diagnostics, extensionId;
const until = async (fn, label, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('Timed out: ' + label);
};
const call = async (type, payload = {}) => {
  const result = await manager.evaluate((message) => chrome.runtime.sendMessage(message), {
    type,
    ...payload,
  });
  assert.equal(result?.ok, true, result?.error);
  return result;
};
async function englishOnly(page, selector = 'body') {
  const remaining = await page.locator(selector).evaluate((element) => {
    const result = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!/\p{Script=Han}/u.test(node.textContent)) continue;
      const parent = node.parentElement;
      if (parent.closest('script,style,option[value="zh-CN"]')) continue;
      const range = document.createRange();
      range.selectNode(node);
      if (range.getBoundingClientRect().width && parent.checkVisibility())
        result.push(node.textContent.trim());
    }
    return result;
  });
  assert.deepEqual(remaining, [], 'Untranslated visible UI');
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, name), animations: 'disabled' });
}
async function showView(view) {
  await manager.goto(`chrome-extension://${extensionId}/manager.html#${view}`);
  await manager.waitForFunction(() => document.querySelector('#ruleCount')?.textContent.trim());
}
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: true,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--lang=en-US',
      `--disable-extensions-except=${isolatedExtension}`,
      `--load-extension=${isolatedExtension}`,
    ],
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await (
    await context.browser().newBrowserCDPSession()
  ).send('Browser.setDownloadBehavior', { behavior: 'default' });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).hostname;
  diagnostics = await enableExtensionDiagnostics(context, extensionId);
  manager = await context.newPage();
  await showView('all');
  assert.equal(await manager.locator('html').getAttribute('lang'), 'en');
  assert.equal(await manager.locator('#pageTitle').innerText(), 'All tasks');
  assert.equal((await call('GET_STATE')).config.rules[0].folder, 'Documents/{year}-{month}');
  await call('SET_SETTINGS', { settings: { autoOpenPanel: false } });
  await englishOnly(manager);
  checks.push(
    'Fresh English browser uses English UI and English default directories without a saved language preference',
  );

  await manager.locator('#setupBanner [data-open-setup]').click();
  await manager.locator('#setupNext').click();
  await until(
    () => manager.locator('#setupExampleTree').getAttribute('data-path'),
    'setup example',
  );
  await englishOnly(manager, '#setupDialog');
  for (const width of [1280, 360]) {
    await manager.setViewportSize({ width, height: 800 });
    assert.ok(
      await manager
        .locator('#setupDialog')
        .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1),
      'Setup horizontal overflow',
    );
    const bounds = await manager.locator('#setupDialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
  }
  await manager.setViewportSize({ width: 1280, height: 800 });
  await screenshot(manager, 'en-setup.png');
  await manager.locator('#closeSetup').click();
  checks.push(
    'English setup has translated options and a real rule preview, without horizontal overflow at 360 or 1280 pixels',
  );

  await call('SET_SETTINGS', { settings: { onboardingDismissed: true } });
  for (const view of ['rules', 'batch', 'resources', 'settings']) {
    await showView(view);
    await englishOnly(manager);
  }
  await showView('rules');
  for (const [button, dialog] of [
    ['#addRule', '#ruleDialog'],
    ['#openTemplates', '#templateDialog'],
    ['#openLab', '#labDialog'],
    ['#openImport', '#importDialog'],
    ['#openRuleGuide', '#ruleGuideDialog'],
    ['#howItWorks', '#helpDialog'],
  ]) {
    await manager.locator(button).click();
    await manager.locator(dialog).waitFor({ state: 'visible' });
    await englishOnly(manager, dialog);
    if (dialog === '#ruleDialog') await screenshot(manager, 'en-rules.png');
    await manager.locator(`${dialog} [data-close]`).first().click();
  }
  checks.push(
    'English task, resource, rule, queue, settings, and all rule dialogs have no untranslated visible Chinese UI',
  );

  await showView('settings');
  const beforeRules = (await call('GET_STATE')).config.rules;
  await call('SYNC_UPLOAD');
  await manager.evaluate(() => chrome.storage.sync.set({ unrelatedFixture: 'keep' }));
  manager.once('dialog', (dialog) => dialog.dismiss());
  await manager.locator('#clearSync').click();
  assert.ok(
    await manager.evaluate(async () => (await chrome.storage.sync.get('rules:meta'))['rules:meta']),
  );
  manager.once('dialog', (dialog) => dialog.accept());
  await manager.locator('#clearSync').click();
  await until(
    () =>
      manager
        .locator('#syncStatus')
        .textContent()
        .then((value) => value.includes('deleted')),
    'backup deleted',
  );
  const syncData = await manager.evaluate(() => chrome.storage.sync.get(null));
  assert.deepEqual(syncData, { unrelatedFixture: 'keep' });
  assert.deepEqual((await call('GET_STATE')).config.rules, beforeRules);
  checks.push(
    'Cloud backup deletion requires confirmation and removes only rule backup data, preserving local rules and unrelated sync keys',
  );

  const privacyOpened = context.waitForEvent('page');
  await manager.locator('a[href="privacy.html"]').click();
  const privacy = await privacyOpened;
  await privacy.waitForLoadState();
  assert.match(await privacy.locator('body').innerText(), /scieszkanottingham@gmail.com/);
  await privacy.close();
  const resourcesPage = await context.newPage();
  await resourcesPage.goto(base + '/page');
  await showView('resources');
  await manager.locator('#scanResources').click();
  await until(
    () =>
      manager
        .locator('#resourceList .resource-card')
        .count()
        .then((count) => count >= 2),
    'resources without tabs permission',
  );
  await englishOnly(manager);
  await resourcesPage.close();
  checks.push(
    'Privacy policy opens locally and selected-page resource discovery works without redundant tabs or activeTab permissions',
  );

  await showView('all');
  const ids = [];
  for (const name of Object.keys(files)) {
    ids.push(
      await manager.evaluate((url) => chrome.downloads.download({ url }), base + '/' + name),
    );
  }
  await until(
    async () =>
      (await call('GET_STATE')).records.filter((record) => record.state === 'complete').length ===
      ids.length,
    'demo downloads',
    45000,
  );
  for (const record of (await call('GET_STATE')).records) {
    const name = path.basename(record.filename);
    assert.deepEqual(await readFile(record.filename), files[name][1]);
  }
  report = await context.newPage();
  await report.goto(`chrome-extension://${extensionId}/report.html?id=${ids.at(-1)}`);
  await report.locator('#reportBody').waitFor({ state: 'visible' });
  await englishOnly(report);
  await screenshot(report, 'en-report.png');
  await showView('all');
  await screenshot(manager, 'en-manager.png');
  popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 580 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await until(
    () =>
      popup
        .locator('[data-popup-task]')
        .count()
        .then((count) => count === ids.length),
    'popup tasks',
  );
  await englishOnly(popup);
  assert.ok(
    await popup.evaluate(() => document.documentElement.scrollWidth <= 441),
    'Popup horizontal overflow',
  );
  await screenshot(popup, 'en-popup.png');
  checks.push(
    'Actual downloads retain matching bytes; English popup, manager, and sampled report render correctly',
  );

  // A literal that is also a UI translation key must stay user data.
  await call('UPDATE_RECORDS', { action: 'note', ids: [ids[0]], note: '下载完成 / My note' });
  await call('SAVE_RULE', {
    rule: { name: '下载完成', extensions: 'custom', folder: '我的资料/{year}-{month}' },
  });
  const before = await call('GET_STATE');
  await showView('settings');
  await manager.locator('#languageSelect').selectOption('zh-CN');
  await manager.waitForFunction(
    () =>
      document.documentElement.lang === 'zh-CN' &&
      document.querySelector('#pageTitle')?.textContent === '设置',
  );
  await popup.waitForFunction(
    () =>
      document.documentElement.lang === 'zh-CN' &&
      document.querySelector('#popupStatusText')?.textContent.includes('自动归档'),
  );
  await report.waitForFunction(
    () =>
      document.documentElement.lang === 'zh-CN' && !document.querySelector('#reportBody').hidden,
  );
  const after = await call('GET_STATE');
  assert.deepEqual(after.config.rules, before.config.rules);
  assert.deepEqual(
    after.records.map((r) => [r.id, r.filename, r.note]),
    before.records.map((r) => [r.id, r.filename, r.note]),
  );
  await manager.reload();
  await manager.locator('#languageSelect').waitFor();
  assert.equal(await manager.locator('#languageSelect').inputValue(), 'zh-CN');
  checks.push(
    'Manual Chinese selection updates manager, popup, and report; preference survives reload while custom names, notes, rules, and paths stay byte-for-byte unchanged',
  );

  await manager.locator('#featureView [data-open-setup]').click();
  await manager.locator('#setupNext').click();
  await until(
    () => manager.locator('#setupExampleTree').getAttribute('data-path'),
    'Chinese setup preview',
  );
  await screenshot(manager, 'zh-CN-setup.png');
  await manager.locator('#closeSetup').click();
  await showView('all');
  await screenshot(manager, 'zh-CN-manager.png');
  await screenshot(report, 'zh-CN-report.png');
  await screenshot(popup, 'zh-CN-popup.png');
  await showView('rules');
  await manager.locator('#addRule').click();
  await screenshot(manager, 'zh-CN-rules.png');
  await manager.locator('#ruleDialog [data-close]').first().click();
  await showView('all');
  await manager.locator('#themeToggle').click();
  await screenshot(manager, 'zh-CN-dark.png');
  await showView('settings');
  await manager.locator('#languageSelect').selectOption('auto');
  await manager.waitForFunction(
    () =>
      document.documentElement.lang === 'en' &&
      document.querySelector('#pageTitle')?.textContent === 'Settings',
  );
  await showView('all');
  await screenshot(manager, 'en-dark.png');
  assert.deepEqual((await call('GET_STATE')).config.rules, before.config.rules);
  checks.push(
    'Returning to browser language restores English and preserves dark mode and saved rules',
  );

  const diagnostic = await diagnostics.read();
  assert.deepEqual(errors, []);
  assert.deepEqual(diagnostic.runtimeErrors, []);
  assert.deepEqual(diagnostic.manifestErrors, []);
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify({ passed: checks.length, checks, diagnostic }, null, 2),
  );
  await writeFile(
    path.join(root, 'artifacts/latest-i18n.json'),
    JSON.stringify({ output, passed: checks.length, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
