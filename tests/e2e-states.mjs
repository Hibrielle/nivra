import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
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
  'states-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
const downloads = path.join(output, 'downloads');
const profile = await mkdtemp(path.join(tmpdir(), 'mate-states-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);
const data = Buffer.alloc(1024 * 1024, 65),
  streams = new Map();
let recovered = false;
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const fail = name.startsWith('/failure/') && !recovered;
  const hold = name.startsWith('/hold/') || name.startsWith('/unknown/');
  let offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
  res.writeHead(fail ? 404 : offset ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name.split('/').pop()}"`,
    ...(!name.startsWith('/unknown/') ? { 'Content-Length': data.length - offset } : {}),
    'Accept-Ranges': 'bytes',
    ETag: '"states-fixture"',
    ...(offset ? { 'Content-Range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {}),
  });
  if (!hold || fail) {
    res.end(data.subarray(offset));
    return;
  }
  const entry = {
    finish: () => {
      clearInterval(timer);
      res.end(data.subarray(offset));
    },
  };
  const timer = setInterval(() => {
    if (offset >= data.length / 2) return;
    const end = offset + 16384;
    res.write(data.subarray(offset, end));
    offset = end;
  }, 100);
  if (!streams.has(name)) streams.set(name, new Set());
  streams.get(name).add(entry);
  res.on('close', () => {
    clearInterval(timer);
    streams.get(name).delete(entry);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://localhost:' + server.address().port;
const checks = [],
  errors = [];
let context, manager, popup, diagnostics, extensionId;
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
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
async function start(name, state = 'in_progress') {
  const id = await manager.evaluate((url) => chrome.downloads.download({ url }), base + name);
  return until(
    async () => (await call('GET_STATE')).records.find((r) => r.id === id && r.state === state),
    name,
  );
}
const row = (id) => popup.locator(`[data-task-key="${id}"]`);
const stateOf = (id) => row(id).getAttribute('data-task-state');
async function menu(id, action) {
  if (await popup.locator('#taskMenu').isVisible()) await popup.keyboard.press('Escape');
  await popup.locator(`[data-more="${id}"]`).click();
  await popup.locator(`[data-menu-action="${action}"]`).click();
}
async function animations(id, state) {
  return popup.evaluate(
    ({ id, state }) =>
      window.taskAnimations.filter((a) => a.id === String(id) && (!state || a.state === state)),
    { id, state },
  );
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
  await context.addInitScript(() => {
    window.taskAnimations = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const row = this.closest('[data-task-key]');
      if (row)
        window.taskAnimations.push({
          id: row.dataset.taskKey,
          state: row.dataset.taskState,
          target: this.className,
          duration: options?.duration,
        });
      return animate.call(this, frames, options);
    };
  });
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  await (
    await context.browser().newBrowserCDPSession()
  ).send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).hostname;
  await setTestLanguage(worker);
  diagnostics = await enableExtensionDiagnostics(context, extensionId);
  worker = await reloadExtension(context, worker, extensionId);
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/manager.html`);
  await manager.locator('#pauseAll').waitFor();
  await call('SET_SETTINGS', { settings: { autoOpenPanel: false } });
  popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 580 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('.popup-empty').waitFor();
  await popup.bringToFront();
  const running = await start('/hold/package.zip');
  await until(async () => await row(running.id).count(), 'new row');
  await until(async () => (await animations(running.id)).length > 0, 'new row animation');
  assert.ok((await animations(running.id)).every((a) => a.duration <= 180));
  await popup.locator(`[data-task-id="${running.id}"]`).focus();
  await popup.evaluate((id) => {
    window.savedRow = document.querySelector(`[data-task-key="${id}"]`);
    window.savedRing = window.savedRow.querySelector('.task-ring');
    window.savedControl = document.activeElement;
    window.firstBytes = window.savedRing.getAttribute('aria-valuenow');
  }, running.id);
  await until(
    () => popup.evaluate(() => savedRing.getAttribute('aria-valuenow') !== firstBytes),
    'next real progress update',
  );
  assert.equal(
    await popup.evaluate(
      () =>
        savedRow.isConnected && savedRing.isConnected && document.activeElement === savedControl,
    ),
    true,
  );
  const transition = await popup.evaluate(() => ({
    property: getComputedStyle(savedRing).transitionProperty,
    duration: getComputedStyle(savedRing).transitionDuration,
    running: savedRing
      .getAnimations()
      .some(
        (animation) =>
          animation.transitionProperty === '--task-progress' && animation.playState === 'running',
      ),
  }));
  assert.match(transition.property, /--task-progress/);
  assert.equal(transition.duration, '0.18s');
  assert.equal(
    transition.running,
    true,
    'real progress has an active interpolating CSS transition',
  );
  checks.push(
    'Real progress updates preserve row, ring and keyboard focus; new rows animate once and progress interpolates over 180 ms',
  );

  await popup.locator(`[data-task-id="${running.id}"]`).click();
  await until(async () => (await stateOf(running.id)) === 'paused', 'pause UI');
  assert.equal(await row(running.id).locator('.task-ring').getAttribute('role'), 'progressbar');
  await popup.screenshot({ path: path.join(output, 'paused.png'), animations: 'disabled' });
  await popup.locator(`[data-task-id="${running.id}"]`).click();
  await until(async () => (await stateOf(running.id)) === 'active', 'resume UI');
  for (const stream of streams.get('/hold/package.zip') || []) stream.finish();
  await until(async () => (await stateOf(running.id)) === 'complete', 'completed UI');
  const completed = (await call('GET_STATE')).records.find((r) => r.id === running.id);
  assert.deepEqual(await readFile(completed.filename), data);
  assert.equal(await row(running.id).locator('.task-ring').getAttribute('role'), 'img');
  assert.equal((await animations(running.id, 'complete')).length, 1);
  await popup.screenshot({ path: path.join(output, 'complete.png'), animations: 'disabled' });
  checks.push(
    'Pause, resume and a real completion update in place; completion plays its badge once and preserves actual file bytes',
  );

  const queued = await call('ADD_BATCH', { text: base + '/hold/canceled.zip' });
  assert.equal(queued.added, 1);
  const canceled = await until(
    async () =>
      (await call('GET_STATE')).records.find(
        (r) =>
          r.filename.endsWith('canceled.zip') && r.state === 'in_progress' && r.bytesReceived > 0,
      ),
    'queued download',
  );
  await menu(canceled.id, 'cancel');
  await until(async () => (await stateOf(canceled.id)) === 'canceled', 'canceled UI');
  assert.match(await row(canceled.id).locator('.task-speed').textContent(), /已取消/);
  assert.match(await row(canceled.id).locator('.task-metrics').textContent(), /总大小 1\.0 MB/);
  await until(
    async () =>
      (await call('GET_QUEUE')).queue.items.some(
        (q) => q.downloadId === canceled.id && q.state === 'canceled' && !q.url,
      ),
    'canceled queue and cleared URL',
  );
  await manager.goto(`chrome-extension://${extensionId}/manager.html#canceled`);
  await manager.locator(`[data-task-row="${canceled.id}"]`).waitFor();
  assert.equal(await manager.locator(`[data-task-row="${running.id}"]`).count(), 0);
  await manager.goto(`chrome-extension://${extensionId}/manager.html#failed`);
  await manager.waitForFunction(() => document.querySelector('#pageTitle').textContent === '中断');
  assert.equal(await manager.locator(`[data-task-row="${canceled.id}"]`).count(), 0);
  await popup.bringToFront();
  const failed = await start('/failure/report.pdf', 'interrupted');
  await until(async () => (await stateOf(failed.id)) === 'failed', 'failure UI');
  assert.ok(await row(failed.id).locator('.task-message').textContent());
  assert.notEqual(await row(failed.id).locator('.popup-task-name').textContent(), '');
  await popup.screenshot({
    path: path.join(output, 'canceled-and-failed-light.png'),
    animations: 'disabled',
  });
  await popup.locator('#popupThemeToggle').click();
  await popup.screenshot({
    path: path.join(output, 'canceled-and-failed-dark.png'),
    animations: 'disabled',
  });
  recovered = true;
  await menu(failed.id, 'retry');
  const retried = await until(
    async () =>
      (await call('GET_STATE')).records.find(
        (r) => r.id !== failed.id && r.filename.endsWith('report.pdf') && r.state === 'complete',
      ),
    'retry downloads recovered resource',
  );
  assert.deepEqual(await readFile(retried.filename), data);
  checks.push(
    'Cancel is neutral, labels total size without inventing received bytes and has its own filter/queue state; a real HTTP failure explains the problem and retry succeeds',
  );

  await call('ADD_BATCH', { text: base + '/unknown/live.bin' });
  const unknown = await until(
    async () =>
      (await call('GET_STATE')).records.find(
        (r) => r.filename.endsWith('live.bin') && r.state === 'in_progress',
      ),
    'unknown-size queued download',
  );
  await until(
    async () => await row(unknown.id).locator('.indeterminate').count(),
    'unknown-size download',
  );
  assert.equal(await row(unknown.id).locator('.task-ring').getAttribute('aria-valuenow'), null);
  assert.equal(
    await row(unknown.id)
      .locator('.task-ring')
      .evaluate((el) => getComputedStyle(el, '::before').animationName),
    'task-wait',
  );
  await menu(unknown.id, 'pause');
  await until(async () => (await stateOf(unknown.id)) === 'paused', 'unknown paused');
  assert.equal(
    await row(unknown.id)
      .locator('.task-ring')
      .evaluate((el) => getComputedStyle(el, '::before').animationPlayState),
    'paused',
  );
  const count = (await animations(running.id, 'complete')).length;
  await call('SET_ENABLED', { enabled: false });
  await until(
    async () => (await popup.locator('#popupToggle').getAttribute('aria-checked')) === 'false',
    'first live refresh',
  );
  await call('SET_ENABLED', { enabled: true });
  await until(
    async () => (await popup.locator('#popupToggle').getAttribute('aria-checked')) === 'true',
    'second live refresh',
  );
  assert.equal((await animations(running.id, 'complete')).length, count);
  assert.match(await popup.locator('#popupCount').textContent(), /已暂停/);
  await popup.emulateMedia({ reducedMotion: 'reduce' });
  await until(
    async () =>
      await row(unknown.id)
        .locator('.task-ring')
        .evaluate((el) => getComputedStyle(el, '::before').animationName === 'none'),
    'reduced motion stops spinner',
  );
  await popup.evaluate(() => {
    window.motionStart = window.taskAnimations.length;
  });
  const queuedUnknown = (await call('GET_QUEUE')).queue.items.find(
    (task) => task.downloadId === unknown.id,
  );
  await call('QUEUE_ACTION', { action: 'cancel', ids: [queuedUnknown.id] });
  await until(async () => (await stateOf(unknown.id)) === 'canceled', 'reduced motion cancel');
  const canceledUnknown = (await call('GET_QUEUE')).queue.items.find(
    (task) => task.id === queuedUnknown.id,
  );
  assert.equal(canceledUnknown.state, 'canceled');
  assert.equal(canceledUnknown.paused, false);
  assert.equal(canceledUnknown.url, undefined);
  assert.equal(await popup.evaluate(() => taskAnimations.length === motionStart), true);
  assert.equal(
    await popup.evaluate(() =>
      document.getAnimations().some((animation) => animation.playState === 'running'),
    ),
    false,
  );
  assert.equal((await animations(running.id, 'complete')).length, count);
  checks.push(
    'Unknown sizes use an indeterminate indicator, pausing stops it, reduced-motion disables CSS and JS motion, and refresh never replays completion',
  );
  const browser = await diagnostics.read();
  assert.deepEqual(errors, []);
  assert.deepEqual(browser.runtimeErrors, []);
  assert.deepEqual(browser.manifestErrors, []);
  const report = { passed: checks.length, checks, browser, output };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(root, 'artifacts/latest-states.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      { error: error.stack, errors, checks, browser: await diagnostics?.read().catch(() => null) },
      null,
      2,
    ),
  );
  await popup
    ?.screenshot({ path: path.join(output, 'failure-popup.png'), animations: 'disabled' })
    .catch(() => {});
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
