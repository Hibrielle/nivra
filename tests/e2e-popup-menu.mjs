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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = process.env.EXTENSION_DIR ? path.resolve(process.env.EXTENSION_DIR) : root;
const output = path.join(
  root,
  'artifacts',
  'popup-menu-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
const downloads = path.join(output, 'downloads');
const profile = await mkdtemp(path.join(tmpdir(), 'mate-menu-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);
const small = Buffer.from('Nivra isolated popup test fixture.');
const slow = Buffer.alloc(6 * 1024 * 1024, 65);
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/redirect') {
    res.writeHead(302, { Location: '/files/package.tgz?delivered=1' });
    res.end();
    return;
  }
  const name = decodeURIComponent(url.pathname.split('/').pop());
  const data = url.pathname.startsWith('/slow/') ? slow : small;
  let offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
  res.writeHead(url.pathname.startsWith('/missing/') ? 404 : offset ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': data.length - offset,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Accept-Ranges': 'bytes',
    ETag: '"fixture"',
    ...(offset ? { 'Content-Range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {}),
  });
  if (data === slow) {
    const timer = setInterval(() => {
      const end = Math.min(offset + 65536, data.length);
      res.write(data.subarray(offset, end));
      offset = end;
      if (offset === data.length) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
    res.on('close', () => clearInterval(timer));
  } else res.end(data);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://localhost:${server.address().port}`;
let context, manager, popup, diagnostics, id;
const checks = [],
  errors = [];
async function until(fn, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Timed out: ' + message);
}
async function call(type, payload = {}) {
  const result = await manager.evaluate((message) => chrome.runtime.sendMessage(message), {
    type,
    ...payload,
  });
  assert.equal(result.ok, true, result.error);
  return result;
}
const record = async (downloadId) =>
  (await call('GET_STATE')).records.find((r) => r.id === downloadId);
async function start(url, state = 'complete') {
  const downloadId = await manager.evaluate((url) => chrome.downloads.download({ url }), url);
  return until(async () => {
    const r = await record(downloadId);
    return r?.state === state ? r : null;
  }, url);
}
async function openPopup() {
  popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 580 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('[data-more]').first().waitFor();
  await popup.bringToFront();
}
async function popupGeometry() {
  return popup.evaluate(() => ({
    height: document.body.getBoundingClientRect().height,
    footerBottom: document.querySelector('.popup-footer').getBoundingClientRect().bottom,
    listHeight: document.querySelector('#popupList').clientHeight,
    listScrollHeight: document.querySelector('#popupList').scrollHeight,
  }));
}
async function nativePopupGeometry() {
  return manager.evaluate(() => {
    const view = chrome.extension.getViews({ type: 'popup' })[0];
    if (!view?.document.querySelector('.popup-empty, [data-popup-task]')) return null;
    return {
      height: view.innerHeight,
      bodyHeight: view.document.body.getBoundingClientRect().height,
      footerBottom: view.document.querySelector('.popup-footer').getBoundingClientRect().bottom,
      count: view.document.querySelectorAll('[data-popup-task]').length,
      theme: view.document.documentElement.dataset.theme,
      availableScreenHeight: view.screen.availHeight,
    };
  });
}
async function menuFor(downloadId) {
  if (await popup.locator('#taskMenu').isVisible()) await popup.keyboard.press('Escape');
  await popup.locator(`[data-more="${downloadId}"]`).click();
  await popup.locator('#taskMenu').waitFor({ state: 'visible' });
}
async function choose(downloadId, key) {
  await menuFor(downloadId);
  await popup.locator(`[data-menu-action="${key}"]`).click();
}
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await (
    await context.browser().newBrowserCDPSession()
  ).send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  id = new URL(worker.url()).hostname;
  await setTestLanguage(worker);
  diagnostics = await enableExtensionDiagnostics(context, id);
  await reloadExtension(context, worker, id);
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/manager.html`);
  await manager.waitForFunction(() => Number(document.querySelector('#ruleCount').textContent) > 0);
  await call('SET_SETTINGS', { settings: { autoOpenPanel: false } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await manager.evaluate(() => chrome.action.openPopup());
  const emptyPopup = await until(nativePopupGeometry, 'native empty toolbar popup');
  assert.equal(emptyPopup.count, 0);
  assert.ok(emptyPopup.height >= 220 && emptyPopup.height <= 580, JSON.stringify(emptyPopup));
  assert.equal(emptyPopup.bodyHeight, emptyPopup.height, JSON.stringify(emptyPopup));
  assert.equal(emptyPopup.footerBottom, emptyPopup.height, JSON.stringify(emptyPopup));
  await manager.evaluate(() =>
    chrome.extension
      .getViews({ type: 'popup' })[0]
      .document.querySelector('#popupThemeToggle')
      .click(),
  );
  await manager.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal((await nativePopupGeometry()).theme, 'dark');
  const originalUrl = base + '/redirect?ticket=test%2B123&filename=package.tgz';
  const file = await start(originalUrl);
  assert.ok(file.filename.startsWith(downloads + '/'));
  assert.deepEqual(await readFile(file.filename), small);
  const populatedPopup = await until(async () => {
    const value = await nativePopupGeometry();
    return value?.count === 1 ? value : null;
  }, 'native toolbar popup receives download');
  assert.equal(populatedPopup.height, emptyPopup.height);
  assert.equal(populatedPopup.footerBottom, emptyPopup.footerBottom);
  await manager.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].close());
  checks.push(
    'The actual Chrome toolbar popup fits within the available screen height and stays the same height after a real download; its theme button updates the open manager',
  );
  await openPopup();
  const singleGeometry = await popupGeometry();
  assert.equal(singleGeometry.height, 580);
  assert.equal(singleGeometry.footerBottom, 580);
  assert.equal(await popup.locator('html').getAttribute('data-theme'), 'dark');
  const report = await context.newPage();
  await report.goto(`chrome-extension://${id}/report.html?id=${file.id}`);
  await report.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await popup.locator('#popupThemeToggle').click();
  await Promise.all(
    [manager, report].map((page) =>
      page.waitForFunction(() => document.documentElement.dataset.theme === 'light'),
    ),
  );
  assert.equal(
    await popup.locator('#popupThemeToggle').getAttribute('aria-label'),
    '切换到深色模式',
  );
  await popup.screenshot({
    path: path.join(output, 'popup-fixed-light.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await manager.locator('#themeToggle').click();
  await Promise.all(
    [popup, report].map((page) =>
      page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'),
    ),
  );
  assert.equal(
    await popup.locator('#popupThemeToggle').getAttribute('aria-label'),
    '切换到浅色模式',
  );
  await popup.screenshot({
    path: path.join(output, 'popup-fixed-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await popup.close();
  await openPopup();
  assert.equal(await popup.locator('html').getAttribute('data-theme'), 'dark');
  await popup.locator('#popupThemeToggle').click();
  await report.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await report.close();
  checks.push(
    'Popup and manager theme controls synchronize all open extension pages including report, update their labels, and retain the choice when reopening',
  );
  assert.equal(await popup.locator('[data-preview]').count(), 0);
  await choose(file.id, 'copy-url');
  assert.equal(await popup.evaluate(() => navigator.clipboard.readText()), originalUrl);
  assert.match(await popup.locator('#popupToast').textContent(), /完整下载链接已复制/);
  await choose(file.id, 'copy-name');
  assert.equal(await popup.evaluate(() => navigator.clipboard.readText()), 'package.tgz');
  await choose(file.id, 'copy-path');
  assert.equal(await popup.evaluate(() => navigator.clipboard.readText()), file.filename);
  checks.push(
    'Real clipboard writes preserve the original URL and query through a redirect, and copy the exact filename and path',
  );

  await menuFor(file.id);
  assert.deepEqual(await popupGeometry(), singleGeometry);
  await popup.screenshot({
    path: path.join(output, 'more-menu.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await popup.keyboard.press('End');
  assert.equal(await popup.evaluate(() => document.activeElement.dataset.menuAction), 'delete');
  await popup.keyboard.press('Escape');
  assert.equal(await popup.evaluate(() => document.activeElement.dataset.more), String(file.id));
  await choose(file.id, 'delete');
  assert.deepEqual(await popupGeometry(), singleGeometry);
  assert.equal(await popup.locator('#deleteFilePath').textContent(), file.filename);
  assert.equal(await popup.evaluate(() => document.activeElement.id), 'cancelDeleteFile');
  await popup.screenshot({
    path: path.join(output, 'delete-confirmation.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await popup.locator('#cancelDeleteFile').click();
  await stat(file.filename);
  const rejected = await manager.evaluate(
    (id) => chrome.runtime.sendMessage({ type: 'DOWNLOAD_ACTION', action: 'delete', ids: [id] }),
    file.id,
  );
  assert.equal(rejected.ok, false);
  await stat(file.filename);
  checks.push(
    'Deletion shows the exact target path, focuses Cancel, and cancellation or missing confirmation leaves the file untouched',
  );
  await choose(file.id, 'delete');
  await popup.locator('#confirmDeleteFile').click();
  await popup.locator('#deleteFileDialog').waitFor({ state: 'hidden' });
  await assert.rejects(stat(file.filename), { code: 'ENOENT' });
  await until(async () => (await record(file.id))?.exists === false, 'deleted state');
  assert.equal((await record(file.id)).state, 'complete');
  assert.equal((await record(file.id)).trashedAt, '');
  await menuFor(file.id);
  assert.equal(await popup.locator('[data-menu-action="delete"]').isDisabled(), true);
  assert.equal(await popup.locator('[data-menu-action="open"]').isDisabled(), true);
  await popup.screenshot({
    path: path.join(output, 'after-file-deletion.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await choose(file.id, 'copy-url');
  assert.equal(await popup.evaluate(() => navigator.clipboard.readText()), originalUrl);
  await choose(file.id, 'retry');
  const replacement = await until(
    async () =>
      (await call('GET_STATE')).records.find((r) => r.id !== file.id && r.state === 'complete'),
    'retry after deletion',
  );
  assert.deepEqual(await readFile(replacement.filename), small);
  checks.push(
    'Confirming deletes the real fixture file but keeps its history and copyable link; retry recreates identical bytes',
  );

  await choose(replacement.id, 'trash');
  await until(async () => Boolean((await record(replacement.id)).trashedAt), 'remove task');
  assert.deepEqual(await readFile(replacement.filename), small);
  await call('UPDATE_RECORDS', { action: 'restore', ids: [replacement.id] });
  await until(
    async () => await popup.locator(`[data-more="${replacement.id}"]`).count(),
    'restore task',
  );
  checks.push(
    'Only remove task uses the reversible plugin recycle bin and leaves the disk file intact',
  );

  const running = await start(base + '/slow/video.mp4', 'in_progress');
  await menuFor(running.id);
  assert.equal(await popup.locator('[data-menu-action="delete"]').count(), 0);
  const focusKey = await popup.evaluate(() => document.activeElement.dataset.menuAction);
  await until(
    async () =>
      await popup
        .locator(`[data-popup-task="${running.id}"] .task-metrics`)
        .textContent()
        .then((text) => text.includes('/秒')),
    'progress refresh',
  );
  assert.equal(await popup.locator('#taskMenu').isVisible(), true);
  assert.equal(await popup.evaluate(() => document.activeElement.dataset.menuAction), focusKey);
  await popup.locator('[data-menu-action="pause"]').click();
  await until(async () => (await record(running.id)).paused, 'pause');
  await choose(running.id, 'resume');
  await until(async () => !(await record(running.id)).paused, 'resume');
  const blockedDelete = await call('DOWNLOAD_ACTION', {
    action: 'delete',
    ids: [running.id],
    confirmed: true,
  });
  assert.equal(blockedDelete.results[0].ok, false);
  await choose(running.id, 'cancel');
  await until(async () => (await record(running.id)).state === 'interrupted', 'cancel');
  await menuFor(running.id);
  assert.equal(await popup.locator('[data-menu-action="retry"]').isVisible(), true);
  checks.push(
    'Active menus survive progress refresh and preserve focus; pause/resume/cancel work, and the backend rejects deleting an unfinished file',
  );

  await popup.keyboard.press('Escape');
  for (let i = 0; i < 8; i++) await start(base + '/files/sample-' + i + '.txt');
  const manyGeometry = await popupGeometry();
  assert.equal(manyGeometry.height, singleGeometry.height);
  assert.equal(manyGeometry.footerBottom, singleGeometry.footerBottom);
  assert.ok(manyGeometry.listScrollHeight > manyGeometry.listHeight);
  await popup.locator('[data-more]').last().click();
  await popup.locator('#taskMenu').waitFor({ state: 'visible' });
  const bounds = await popup.locator('#taskMenu').boundingBox();
  assert.ok(
    bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= 440 &&
      bounds.y + bounds.height <= 580,
    JSON.stringify(bounds),
  );
  await popup.keyboard.press('Escape');
  await popup.locator('#popupThemeToggle').click();
  await manager.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await popup.locator('[data-more]').last().click();
  await popup.screenshot({
    path: path.join(output, 'more-menu-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  checks.push(
    'More downloads scroll only the list; menus and deletion dialogs do not resize the popup, and a bottom menu fits within 580 px in dark theme',
  );

  await choose(replacement.id, 'rule');
  await manager.locator('#ruleDialog').waitFor({ state: 'visible' });
  assert.equal(await manager.locator('#ruleForm [name="extensions"]').inputValue(), 'tgz');
  checks.push(
    'Create rule opens the existing manager with an editable draft derived from the selected download',
  );
  const browserErrors = await diagnostics.read();
  assert.deepEqual(browserErrors.runtimeErrors, []);
  assert.deepEqual(browserErrors.manifestErrors, []);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        extensionRoot,
        browser: context.browser().version(),
        nativePopup: { empty: emptyPopup, populated: populatedPopup },
        checks,
        browserErrors,
        errors,
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, 'artifacts/latest-popup-menu.json'),
    JSON.stringify({ output, checks: checks.length }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
} catch (error) {
  await popup
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
