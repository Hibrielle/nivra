import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
  'details-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
const downloads = path.join(output, 'downloads');
const profile = await mkdtemp(path.join(tmpdir(), 'nivra-details-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);
const data = Buffer.alloc(1024 * 1024, 81);
let finishDownload;
const server = createServer((req, res) => {
  const filename = new URL(req.url, 'http://localhost').pathname.slice(1);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': data.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  if (filename === 'pending.bin') {
    res.write(data.subarray(0, 65536));
    finishDownload = () => res.end(data.subarray(65536));
  } else res.end(data);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://localhost:${server.address().port}`;
let context, manager, diagnostics, extensionId;
const checks = [],
  errors = [];
async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
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
async function start(name, state) {
  const id = await manager.evaluate((url) => chrome.downloads.download({ url }), base + '/' + name);
  return until(
    async () =>
      (await call('GET_STATE')).records.find((r) => r.id === id && r.state === state && r.filename),
    name,
  );
}
async function view(name) {
  await manager.evaluate((name) => {
    location.hash = name;
  }, name);
  await manager
    .locator(name === 'settings' ? '#settingsForm' : '#downloadList')
    .waitFor({ state: 'visible' });
}
async function openManager() {
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/manager.html`);
  await manager.locator('#pauseAll').waitFor();
}
function check(name, passed, evidence) {
  checks.push({ name, passed, evidence });
}
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: true,
    viewport: { width: 1440, height: 950 },
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await (
    await context.browser().newBrowserCDPSession()
  ).send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).hostname;
  await setTestLanguage(worker);
  diagnostics = await enableExtensionDiagnostics(context, extensionId);
  worker = await reloadExtension(context, worker, extensionId);
  await openManager();
  const brand = await manager.locator('.sidebar .product-mark').evaluate((image) => ({
    source: image.getAttribute('src'),
    loaded: image.complete && image.naturalWidth > 0,
  }));
  check(
    'Manager header displays the selected Nivra brand icon',
    brand.source === 'icons/brand.svg' && brand.loaded,
    brand,
  );
  await call('SET_SETTINGS', { settings: { autoOpenPanel: false } });
  const pdf = await start('notes.pdf', 'complete');
  const zip = await start('assets.zip', 'complete');
  const pending = await start('pending.bin', 'in_progress');
  await manager.locator(`[data-task-row="${pdf.id}"] .file-name`).click();
  await manager.locator('#recordNote').fill('未保存的备注草稿');
  await manager.locator('.inspector-heading strong').click();
  await manager.locator('.inspector-more summary').click();
  await call('SET_ENABLED', { enabled: false });
  await until(
    async () => (await manager.locator('#autoToggle').getAttribute('aria-checked')) === 'false',
    'storage refresh',
  );
  const detail = await manager.evaluate(() => ({
    note: document.querySelector('#recordNote').value,
    expanded: document.querySelector('.inspector-more').open,
  }));
  check(
    'Progress refresh preserves an unsaved note and the expanded inspector section',
    detail.note === '未保存的备注草稿' && detail.expanded,
    detail,
  );
  await manager.screenshot({ path: path.join(output, 'inspector.png'), animations: 'disabled' });
  // Saving must still use the visible draft after the background refresh.
  await manager.locator('#recordNote').fill('保存后的备注');
  await manager.locator('#saveRecordNote').click();
  await until(
    async () =>
      (await call('GET_STATE')).records.find((r) => r.id === pdf.id)?.note === '保存后的备注',
    'save note',
  );

  const existing = new Set(context.pages());
  await manager.locator('.inspector-actions a[href*="report.html"]').press('Enter');
  await until(
    () => context.pages().some((p) => !existing.has(p) && p.url().includes('/report.html')),
    'keyboard opens report',
  );
  const opened = context.pages().filter((p) => !existing.has(p));
  const urls = opened.map((p) => p.url());
  check(
    'Enter on an inspector link opens only that link in one page',
    urls.length === 1 && urls[0].includes('/report.html'),
    urls,
  );
  for (const page of opened) await page.close();
  await manager.bringToFront();

  const filters = [
    { name: 'PDF', condition: '*ext*.is("pdf")' },
    { name: 'ZIP', condition: '*ext*.is("zip")' },
  ];
  await call('SET_SETTINGS', { settings: { savedFilters: filters } });
  await until(
    async () =>
      (await manager.locator('#downloadFilter option').filter({ hasText: 'ZIP' }).count()) === 1,
    'custom filters',
  );
  await manager.locator('#downloadFilter').selectOption({ label: 'ZIP' });
  await until(async () => (await manager.locator('[data-task-row]').count()) === 1, 'ZIP filter');
  await view('settings');
  await manager.locator('[data-delete-filter="0"]').click();
  await until(
    async () => (await call('GET_STATE')).config.savedFilters.length === 1,
    'remove preceding filter',
  );
  await view('all');
  const firstFilter = {
    selected: await manager.locator('#downloadFilter').inputValue(),
    ids: await manager
      .locator('[data-task-row]')
      .evaluateAll((rows) => rows.map((r) => Number(r.dataset.taskRow))),
  };
  check(
    'Removing another saved filter preserves the selected filter and its results',
    firstFilter.ids.length === 1 && firstFilter.ids[0] === zip.id,
    firstFilter,
  );
  await manager.locator('#downloadFilter').selectOption({ label: 'ZIP' });
  await view('settings');
  await manager.locator('[data-delete-filter="0"]').click();
  await until(
    async () => (await call('GET_STATE')).config.savedFilters.length === 0,
    'remove selected filter',
  );
  await view('all');
  const secondFilter = {
    selected: await manager.locator('#downloadFilter').inputValue(),
    count: await manager.locator('[data-task-row]').count(),
  };
  check(
    'Removing the selected filter returns to all tasks instead of an empty list',
    secondFilter.selected === '' && secondFilter.count === 3,
    secondFilter,
  );

  // Finish a real download while the extension is disabled: no change event can be delivered.
  await diagnostics.page.evaluate((id) => chrome.management.setEnabled(id, false), extensionId);
  finishDownload();
  await until(async () => {
    const file = await readFile(pending.filename).catch(() => null);
    return file?.equals(data);
  }, 'download completes while extension is disabled');
  await diagnostics.page.evaluate((id) => chrome.management.setEnabled(id, true), extensionId);
  await manager.close();
  await openManager();
  const recovered = await until(async () => {
    const state = await call('GET_STATE');
    return state.records.length === 3 && state;
  }, 'existing task history');
  // Allow initialization to finish without requiring the expected state in the wait itself.
  await manager.waitForTimeout(1000);
  const record = (await call('GET_STATE')).records.find((r) => r.id === pending.id);
  check(
    'Re-enabling reconciles a download completed while the extension was disabled',
    record?.state === 'complete' && record.bytesReceived === data.length,
    { state: record?.state, bytesReceived: record?.bytesReceived },
  );
  assert.equal(recovered.records.find((r) => r.id === pdf.id)?.note, '保存后的备注');
  const browser = await diagnostics.read();
  const report = { passed: checks.filter((c) => c.passed).length, checks, browser, errors, output };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.ok(
    checks.every((c) => c.passed),
    checks
      .filter((c) => !c.passed)
      .map((c) => c.name)
      .join('\n'),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(browser.runtimeErrors, []);
  assert.deepEqual(browser.manifestErrors, []);
  await writeFile(
    path.join(root, 'artifacts/latest-details.json'),
    JSON.stringify(report, null, 2),
  );
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ error: error.stack, checks, errors }, null, 2),
  );
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
