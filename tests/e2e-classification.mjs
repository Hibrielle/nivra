import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRules } from '../file-types.js';
import { RULE_TEMPLATES } from '../rules.js';
import {
  enableExtensionDiagnostics,
  reloadExtension,
  setTestLanguage,
} from './browser-diagnostics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = process.env.EXTENSION_DIR ? path.resolve(process.env.EXTENSION_DIR) : root;
const output = path.join(
  root,
  'artifacts',
  'classification-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
const downloads = path.join(output, 'chosen-browser-root');
const profile = await mkdtemp(path.join(tmpdir(), 'mate-classification-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);
const bytes = Buffer.from('Nivra classification fixture; byte-verified.');
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.end(bytes);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://localhost:${server.address().port}/`;
let context, manager, worker, diagnostics, id;
const errors = [],
  checks = [];
async function until(fn, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Timed out: ' + label);
}
async function call(type, payload = {}) {
  const result = await manager.evaluate((message) => chrome.runtime.sendMessage(message), {
    type,
    ...payload,
  });
  assert.equal(result.ok, true, result.error);
  return result;
}
async function openManager(hash = 'settings') {
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/manager.html#${hash}`);
  await manager.waitForFunction(() => Number(document.querySelector('#ruleCount').textContent) > 0);
}
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  await (
    await context.browser().newBrowserCDPSession()
  ).send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  id = new URL(worker.url()).hostname;
  await setTestLanguage(worker);
  diagnostics = await enableExtensionDiagnostics(context, id);
  worker = await reloadExtension(context, worker, id);
  await openManager();
}
async function download(name) {
  const downloadId = await manager.evaluate(
    (url) => chrome.downloads.download({ url, saveAs: false }),
    base + encodeURIComponent(name),
  );
  const record = await until(
    async () =>
      (await call('GET_STATE')).records.find((r) => r.id === downloadId && r.state === 'complete'),
    'completed ' + name,
  );
  assert.deepEqual(await readFile(record.filename), bytes);
  return record;
}

try {
  await launch();
  await call('SET_SETTINGS', { settings: { autoOpenPanel: false } });
  assert.equal((await call('GET_STATE')).config.rules.length, defaultRules().length);
  const old = await download('before-root.pdf');
  assert.ok(!old.filename.includes('资料/下载'));
  const rootInput = manager.locator('#archiveRootForm [name="archiveRoot"]');
  await rootInput.fill('/Users/example/Desktop');
  await until(
    () => manager.locator('#saveArchiveRoot').isDisabled(),
    'invalid root disables saving',
  );
  assert.match(await manager.locator('#archiveRootError').textContent(), /相对目录/);
  const beforeReject = (await call('GET_STATE')).config;
  const rejected = await manager.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { archiveRoot: '../escape' } }),
  );
  assert.equal(rejected.ok, false);
  assert.deepEqual((await call('GET_STATE')).config, beforeReject);
  await rootInput.fill('资料/下载');
  await manager.locator('#archiveExample').selectOption('brand.woff2');
  await until(
    async () =>
      (await manager.locator('#archiveRootPreview').textContent()).includes('资料/下载/字体/'),
    'root preview',
  );
  const preview = (await manager.locator('#archiveRootPreview').textContent()).replace(
    '下载根目录 / ',
    '',
  );
  await manager.locator('#saveArchiveRoot').click();
  await until(
    async () => (await call('GET_STATE')).config.archiveRoot === '资料/下载',
    'saved root',
  );
  checks.push(
    'Archive root UI previews the path, persists the setting, and rejects unsafe input without partial writes',
  );

  const settingsTabPromise = context.waitForEvent('page');
  await manager.locator('#chooseDownloadRoot').click();
  const settingsTab = await settingsTabPromise;
  await settingsTab.waitForURL('chrome://settings/downloads');
  assert.equal(settingsTab.url(), 'chrome://settings/downloads');
  await settingsTab.close();
  await manager.bringToFront();
  checks.push(
    'Choose root opens the real Chrome Downloads settings; the test profile uses an actual custom browser download directory',
  );

  const samples = [
    ['brand.woff2', '字体'],
    ['novel.epub', '电子书'],
    ['photo.CR3', '图片'],
    ['scene.glb', '模型与 CAD'],
    ['data.parquet', '数据与配置'],
    ['app.ts', '代码'],
    ['captions.srt', '字幕'],
    ['source.tar.zst', '压缩包'],
  ];
  for (const [name, category] of samples) {
    const record = await download(name);
    assert.equal(record.filename, path.join(downloads, record.decision.target));
    assert.ok(record.decision.target.startsWith('资料/下载/' + category + '/'), record.filename);
    if (name === 'brand.woff2') assert.equal(record.decision.target, preview);
  }
  assert.deepEqual(await readFile(old.filename), bytes);
  assert.equal(
    (await call('GET_STATE')).records.find((record) => record.id === old.id).filename,
    old.filename,
  );
  checks.push(
    'Eight real downloads verify new and expanded types, byte integrity, root prefix and preview equality; old files stay put',
  );
  const unknown = await download('unknown.blob');
  assert.equal(unknown.filename, path.join(downloads, 'unknown.blob'));
  await call('SET_ENABLED', { enabled: false });
  const paused = await download('paused.pdf');
  assert.equal(paused.filename, path.join(downloads, 'paused.pdf'));
  await call('SET_ENABLED', { enabled: true });
  checks.push(
    'Unmatched downloads and globally paused classification keep the browser default location',
  );

  await call('ADD_BATCH', { text: base + 'batch.txt', template: '批次/{num:3}_{filename}' });
  const batch = await until(
    async () =>
      (await call('GET_STATE')).records.find(
        (record) => record.decision.ruleName === '本次批量命名' && record.state === 'complete',
      ),
    'batch with root',
  );
  assert.equal(batch.decision.target, '资料/下载/批次/001_batch.txt');
  assert.equal(batch.filename, path.join(downloads, '资料/下载/批次/001_batch.txt'));
  assert.deepEqual(await readFile(batch.filename), bytes);
  checks.push(
    'Explicit batch paths receive the global root exactly once, including the filename-determination event',
  );

  await manager.screenshot({
    path: path.join(output, 'archive-settings.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await manager.setViewportSize({ width: 780, height: 950 });
  assert.ok(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await manager.screenshot({
    path: path.join(output, 'archive-settings-narrow.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await manager.setViewportSize({ width: 1440, height: 1080 });
  await manager.locator('#moreFileTypes > summary').click();
  await manager.locator('a[href="#font"]').click();
  await manager.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1);
  assert.match(await manager.locator('#downloadList').textContent(), /brand.woff2/);
  await manager.locator('#rulesNav').click();
  await manager.locator('#openTemplates').click();
  assert.equal(await manager.locator('.template-card').count(), RULE_TEMPLATES.length);
  await manager.locator('#templateSearch').fill('woff2');
  assert.equal(await manager.locator('.template-card').count(), 1);
  await manager.locator('#templateSearch').fill('');
  await manager.screenshot({
    path: path.join(output, 'expanded-templates.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await manager.locator('[data-close="templateDialog"]').click();
  await manager.locator('a[href="#settings"]').click();
  await manager.locator('.default-catalogue > summary').click();
  await manager.locator('#supplementDefaults').click();
  await until(
    async () => (await manager.locator('#importPreview').textContent()).includes('新增 0 条'),
    'duplicate default pack skipped',
  );
  assert.equal(await manager.locator('#importPosition').inputValue(), 'last');
  assert.equal(await manager.locator('#applyImport').isDisabled(), true);
  checks.push(
    'New type filters, searchable templates and non-duplicating catalogue supplementation work through the UI',
  );

  await context.close();
  await launch();
  assert.equal((await call('GET_STATE')).config.archiveRoot, '资料/下载');
  const restartFile = await download('after-restart.epub');
  assert.ok(restartFile.filename.startsWith(path.join(downloads, '资料/下载/电子书/')));
  checks.push(
    'The saved archive root persists through a full browser restart and affects the next download',
  );

  const custom = {
    id: 'my-rule',
    name: '我的项目',
    enabled: true,
    extensions: 'pdf',
    folder: '我的项目',
  };
  const savedRules = [custom, ...defaultRules().slice(0, 4)];
  savedRules.find((rule) => rule.id === 'images').enabled = false;
  await manager.evaluate(async (rules) => {
    const { config } = await chrome.storage.local.get('config');
    config.rules = rules;
    await chrome.storage.local.set({ config });
  }, savedRules);
  worker = await reloadExtension(context, worker, id);
  await manager.close();
  await openManager('rules');
  const reloaded = (await call('GET_STATE')).config;
  assert.deepEqual(reloaded.rules, savedRules);
  assert.equal(reloaded.archiveRoot, '资料/下载');
  checks.push(
    'Reload preserves custom priority, disabled rules and intentionally removed defaults',
  );
  const browserErrors = await diagnostics.read();
  assert.deepEqual(browserErrors.runtimeErrors, []);
  assert.deepEqual(browserErrors.manifestErrors, []);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      { extensionRoot, browser: context.browser().version(), checks, errors, browserErrors },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, 'artifacts/latest-classification.json'),
    JSON.stringify({ output, checks: checks.length }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
} catch (error) {
  await manager
    ?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
    .catch(() => {});
  await writeFile(
    path.join(output, 'failure.txt'),
    error.stack +
      '\n' +
      JSON.stringify(
        { checks, errors, diagnostics: await diagnostics?.read().catch(() => null) },
        null,
        2,
      ),
  );
  console.error('Evidence:', output);
  throw error;
} finally {
  await context?.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
