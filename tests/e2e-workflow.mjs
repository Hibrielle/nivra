import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enableExtensionDiagnostics,
  reloadExtension,
  setTestLanguage,
} from './browser-diagnostics.mjs';
import { defaultRules } from '../file-types.js';
const DEFAULT_COUNT = defaultRules().length;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  extensionRoot = process.env.EXTENSION_DIR ? path.resolve(process.env.EXTENSION_DIR) : root;
const output = path.join(
    root,
    'artifacts',
    'workflow-' + new Date().toISOString().replace(/[:.]/g, '-'),
  ),
  downloads = path.join(output, 'downloads'),
  profile = await mkdtemp(path.join(tmpdir(), 'mate-workflow-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);
const slow = Buffer.alloc(4 * 1024 * 1024, 81),
  small = Buffer.from('Nivra workflow fixture.');
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'),
    name = decodeURIComponent(url.pathname.split('/').pop());
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<html><head><title>Download workflow fixture</title></head><body><a id="download" href="/slow/feature-video.mp4">Start download</a></body></html>',
    );
    return;
  }
  const buffer = url.pathname.startsWith('/slow/') ? slow : small;
  let offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
  res.writeHead(offset ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': buffer.length - offset,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Accept-Ranges': 'bytes',
    ETag: '"fixture"',
    ...(offset ? { 'Content-Range': `bytes ${offset}-${buffer.length - 1}/${buffer.length}` } : {}),
  });
  if (buffer === slow) {
    const timer = setInterval(() => {
      const end = Math.min(offset + 65536, buffer.length);
      res.write(buffer.subarray(offset, end));
      offset = end;
      if (offset === buffer.length) {
        clearInterval(timer);
        res.end();
      }
    }, 65);
    res.on('close', () => clearInterval(timer));
  } else res.end(buffer);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;
let context, manager, id, diagnostics;
const errors = [],
  checks = [];
const call = async (type, payload = {}) => {
  const result = await manager.evaluate((message) => chrome.runtime.sendMessage(message), {
    type,
    ...payload,
  });
  if (!result?.ok) throw new Error(result?.error || 'No response');
  return result;
};
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Timed out: ' + label);
}
async function openManager() {
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/manager.html`);
  await manager.waitForFunction(
    (count) => Number(document.querySelector('#ruleCount').textContent) === count,
    DEFAULT_COUNT,
  );
}
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: process.env.HEADED !== '1',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  id = new URL(worker.url()).hostname;
  await setTestLanguage(worker);
  diagnostics = await enableExtensionDiagnostics(context, id);
  worker = await reloadExtension(context, worker, id);
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await openManager();
  return worker;
}
try {
  let worker = await launch();
  const grants = await manager.evaluate(() => chrome.permissions.getAll());
  assert.ok(grants.origins.includes('http://*/*') && grants.origins.includes('https://*/*'));
  assert.equal(
    await worker.evaluate(() => chrome.webRequest.onHeadersReceived.hasListeners()),
    true,
  );
  const initial = await call('GET_STATE');
  assert.equal(initial.config.replaceDownloadUI, true);
  assert.equal(initial.config.autoOpenPanel, true);
  assert.deepEqual((await diagnostics.read()).runtimeErrors, []);
  checks.push(
    'Fresh shipping manifest declares network hosts, registers capture synchronously, and has no Chrome extension errors',
  );
  const savedRules = initial.config.rules;
  await call('SET_SETTINGS', { settings: { replaceDownloadUI: false, autoOpenPanel: false } });
  worker = await reloadExtension(context, worker, id);
  await manager.close();
  await openManager();
  const reloaded = await call('GET_STATE');
  assert.deepEqual(reloaded.config.rules, savedRules);
  assert.equal(reloaded.config.replaceDownloadUI, false);
  assert.equal(reloaded.config.autoOpenPanel, false);
  checks.push('Reload preserves existing rules and explicit download-surface preferences');
  await call('SET_SETTINGS', { settings: { replaceDownloadUI: true, autoOpenPanel: true } });
  const website = await context.newPage();
  await website.goto(base);
  await website.bringToFront();
  await website.locator('#download').click();
  const active = await until(
    async () =>
      (await call('GET_STATE')).records.find(
        (r) => r.state === 'in_progress' && r.bytesReceived > 65536,
      ),
    'active download',
  );
  const surface = await until(async () => {
    const { downloadSurface } = await manager.evaluate(() =>
      chrome.storage.session.get('downloadSurface'),
    );
    return downloadSurface && downloadSurface.mode !== 'manager' ? downloadSurface : null;
  }, 'automatic extension panel');
  assert.notEqual(surface.mode, 'failed');
  assert.ok(['toolbar', 'window'].includes(surface.mode));
  if (surface.mode === 'toolbar') {
    const panels = await manager.evaluate(() =>
      chrome.runtime.getContexts({ contextTypes: ['POPUP'] }),
    );
    assert.ok(panels.some((panel) => panel.documentUrl === `chrome-extension://${id}/popup.html`));
  }
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 590 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() =>
    document.querySelector('.popup-item .task-metrics')?.textContent.includes('/秒'),
  );
  await popup.screenshot({ path: path.join(output, 'live-popup.png'), fullPage: true });
  await popup.locator('[data-task-action="pause"]').first().click();
  await until(
    async () => (await call('GET_STATE')).records.find((r) => r.id === active.id)?.paused,
    'popup pause',
  );
  await popup.locator('[data-task-action="resume"]').first().click();
  const complete = await until(
    async () =>
      (await call('GET_STATE')).records.find((r) => r.id === active.id && r.state === 'complete'),
    'popup resume',
  );
  assert.deepEqual(await readFile(complete.filename), slow);
  await popup.close();
  checks.push(
    'A website download automatically opens our panel; live speed and pause/resume operate on the real download',
  );
  await call('SET_SETTINGS', { settings: { autoOpenPanel: false } });
  await manager.bringToFront();
  for (const name of [
    '项目方案.pdf',
    '工作笔记.txt',
    'assets.zip',
    'cover.png',
    'demo.wav',
    'app.apk',
  ]) {
    const fileId = await manager.evaluate(
      (url) => chrome.downloads.download({ url }),
      base + '/files/' + encodeURIComponent(name),
    );
    await until(
      async () =>
        (await call('GET_STATE')).records.find((r) => r.id === fileId && r.state === 'complete'),
      name,
    );
  }
  await manager.goto(`chrome-extension://${id}/manager.html#all`);
  await manager.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 7);
  assert.equal(await manager.locator('#stats').count(), 0);
  const rows = manager.locator('[data-task-row]');
  const firstId = Number(await rows.nth(0).getAttribute('data-task-row'));
  const secondId = Number(await rows.nth(1).getAttribute('data-task-row'));
  await rows.nth(0).click();
  assert.equal(await manager.locator('dialog[open]').count(), 0);
  assert.match(await manager.locator('#detailContent').innerText(), /保存位置/);
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  assert.equal(await manager.locator('.task-row.selected').count(), 2);
  await manager.locator('#recordNote').fill('这个任务用于演示侧边详情');
  await manager.locator('#saveRecordNote').click();
  await until(
    async () =>
      (await call('GET_STATE')).records.find((r) => r.id === secondId)?.note ===
      '这个任务用于演示侧边详情',
    'note persists',
  );
  await manager.locator('#detailDialog').evaluate((element) => (element.scrollTop = 0));
  await manager.screenshot({ path: path.join(output, 'task-manager.png'), fullPage: true });
  await manager.locator('[data-selected-action="trash"]').click();
  await until(
    async () => (await call('GET_STATE')).records.filter((r) => r.trashedAt).length === 2,
    'trash',
  );
  for (const record of (await call('GET_STATE')).records.filter((r) => r.trashedAt))
    await stat(record.filename);
  await manager.locator('#navigation a[href="#trash"]').click();
  await manager.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 2);
  await manager.locator('#selectVisible').check();
  await manager.locator('[data-selected-action="restore"]').click();
  await until(async () => (await call('GET_STATE')).records.every((r) => !r.trashedAt), 'restore');
  checks.push(
    'Single-click inspector, multi-select, persistent notes and reversible task trash work without moving files',
  );
  await manager.locator('#navigation a[href="#image"]').click();
  await manager.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1);
  assert.match(await manager.locator('[data-task-row]').innerText(), /cover\.png/);
  await manager.locator('#navigation a[href="#all"]').click();
  await manager.locator('[data-task-row]').first().click();
  await manager.locator('#themeToggle').click();
  await manager.screenshot({ path: path.join(output, 'task-manager-dark.png'), fullPage: true });
  await manager.locator('#themeToggle').click();
  await manager.setViewportSize({ width: 760, height: 900 });
  await manager.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.sidebar')).position === 'fixed' &&
      document.querySelector('.topbar').getBoundingClientRect().height > 0,
  );
  assert.ok(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await manager.screenshot({
    path: path.join(output, 'task-manager-narrow.png'),
    fullPage: true,
    animations: 'disabled',
  });
  checks.push('Completed file categories, dark theme and a narrow-window inspector remain usable');
  await manager.setViewportSize({ width: 1440, height: 900 });
  await manager.locator('#clearSelection').click();
  await manager.locator('#newBatch').click();
  await manager.locator('#taskUrls').fill(base + '/files/dialog-task.txt');
  await manager.locator('#submitTask').click();
  await manager.locator('#taskDialog').waitFor({ state: 'hidden' });
  await until(
    async () =>
      (await call('GET_STATE')).records.some(
        (record) => record.filename.endsWith('dialog-task.txt') && record.state === 'complete',
      ),
    'new task dialog download',
  );
  checks.push(
    'The primary New task button downloads directly from a compact dialog and returns to the task list',
  );
  await context.close();
  worker = await launch();
  assert.equal((await call('GET_STATE')).config.autoOpenPanel, false);
  assert.equal((await call('GET_STATE')).config.replaceDownloadUI, true);
  assert.equal(
    await worker.evaluate(() => chrome.webRequest.onHeadersReceived.hasListeners()),
    true,
  );
  const browserErrors = await diagnostics.read();
  assert.deepEqual(browserErrors.runtimeErrors, []);
  assert.deepEqual(browserErrors.manifestErrors, []);
  assert.deepEqual(errors, []);
  checks.push(
    'Restart preserves the user auto-popup preference and produces no Chrome extension errors',
  );
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        browser: context.browser().version(),
        extensionRoot,
        checks,
        surface,
        browserErrors,
        errors,
        selectedIds: [firstId, secondId],
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, 'artifacts/latest-workflow.json'),
    JSON.stringify({ output, checks: checks.length }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, surface, output }, null, 2));
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
