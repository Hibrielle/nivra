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
  'reports-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
const downloads = path.join(output, 'downloads');
const profile = await mkdtemp(path.join(tmpdir(), 'nivra-reports-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);
const data = Buffer.alloc(8 * 1024 * 1024, 78),
  streams = new Map();
let base;
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/redirect') {
    res.writeHead(302, {
      Location:
        base.replace('localhost', '127.0.0.1') + '/slow/archive.zip?signature=REPORT_SECRET',
    });
    res.end();
    return;
  }
  if (name === '/failure.pdf') {
    res.writeHead(404);
    res.end('missing');
    return;
  }
  let offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0),
    ticks = 0;
  res.writeHead(offset ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name.split('/').pop()}"`,
    'Content-Length': data.length - offset,
    'Accept-Ranges': 'bytes',
    ETag: '"report-fixture"',
    ...(offset ? { 'Content-Range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {}),
  });
  const timer = setInterval(() => {
    if (offset >= data.length * 0.8) return;
    const end = Math.min(data.length, offset + (ticks++ < 20 ? 32768 : 8192));
    res.write(data.subarray(offset, end));
    offset = end;
  }, 100);
  const entry = {
    finish() {
      clearInterval(timer);
      res.end(data.subarray(offset));
    },
  };
  if (!streams.has(name)) streams.set(name, new Set());
  streams.get(name).add(entry);
  res.on('close', () => {
    clearInterval(timer);
    streams.get(name).delete(entry);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = 'http://localhost:' + server.address().port;
const ipv6 = createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="ipv6.bin"',
    'Content-Length': 32768,
  });
  res.end(data.subarray(0, 32768));
});
await new Promise((resolve, reject) => {
  ipv6.once('error', reject);
  ipv6.listen(0, '::1', resolve);
});
let context, manager, reportPage, diagnostics, extensionId;
const checks = [],
  errors = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw Error('Timed out: ' + label);
}
async function call(type, payload = {}) {
  const page = manager?.isClosed() ? reportPage : manager;
  const result = await page.evaluate((message) => chrome.runtime.sendMessage(message), {
    type,
    ...payload,
  });
  assert.equal(result.ok, true, result.error);
  return result;
}
async function fetchReport(id) {
  return (await call('GET_REPORT', { id })).report;
}
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1200, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  context.on('page', (page) => page.on('pageerror', (e) => errors.push(e.message)));
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
  const id = await manager.evaluate(
    (url) => chrome.downloads.download({ url }),
    base + '/redirect?secret=ORIGINAL_SECRET',
  );
  await until(async () => (await fetchReport(id))?.samples.length >= 2, 'first samples');
  let report = await fetchReport(id);
  await writeFile(path.join(output, 'initial-report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.network.status, 'observed', JSON.stringify(report.network));
  assert.ok(report.network.hops.some((h) => h.kind === 'redirect'));
  assert.ok(report.network.hops.some((h) => h.ip === '127.0.0.1'));
  assert.equal(JSON.stringify(report).includes('REPORT_SECRET'), false);
  assert.equal(JSON.stringify(report).includes('ORIGINAL_SECRET'), false);
  assert.equal('urlHashes' in report, false);
  checks.push(
    'A real HTTP redirect records original/final domains and browser-observed IPv4; reports expose no query secrets or matching fingerprints',
  );
  const before = report.samples.length;
  await manager.close();
  // No extension UI, polling, or diagnostic API calls during this interval.
  await delay(35000);
  reportPage = await context.newPage();
  await reportPage.goto(`chrome-extension://${extensionId}/report.html?id=${id}`);
  await reportPage.locator('#reportBody').waitFor({ state: 'visible' });
  report = await fetchReport(id);
  assert.ok(report.samples.length >= before + 25);
  assert.ok(report.peak > 0);
  assert.ok(report.measuredBytes > 0);
  const rates = report.samples.filter((s) => s.kind === 'run').map((s) => s.rate);
  assert.ok(Math.max(...rates) > Math.min(...rates.filter((n) => n > 0)) * 1.4);
  checks.push(
    'Background sampling continues for 35 seconds without any extension UI; the persisted curve records real changing transfer rates',
  );
  const hopCount = report.network.hops.length;
  await reportPage.evaluate(
    async (url) => {
      const controller = new AbortController();
      await fetch(url, { signal: controller.signal });
      controller.abort();
    },
    base.replace('localhost', '127.0.0.1') + '/slow/archive.zip?signature=REPORT_SECRET',
  );
  await delay(1200);
  assert.equal((await fetchReport(id)).network.hops.length, hopCount);
  checks.push(
    'An unrelated fetch of the same URL outside the start/resume window is not attached to the download report',
  );
  await call('DOWNLOAD_ACTION', { action: 'pause', ids: [id] });
  await delay(2200);
  await call('DOWNLOAD_ACTION', { action: 'resume', ids: [id] });
  await delay(1500);
  report = await fetchReport(id);
  assert.ok(report.samples.some((s) => s.kind === 'paused'));
  assert.ok(report.events.some((e) => e.kind === 'resume'));
  assert.ok(report.pausedMs >= 1500);
  await reportPage.locator('#speedChart').focus();
  await reportPage.keyboard.press('End');
  assert.match(await reportPage.locator('#chartTooltip').textContent(), /采样时已接收/);
  await reportPage.screenshot({
    animations: 'disabled',
    path: path.join(output, 'report-live-light.png'),
    fullPage: true,
  });
  // A forced worker termination verifies recovery even when DevTools automation attaches to workers.
  const stopSession = await context.newCDPSession(diagnostics.page);
  await stopSession.send('ServiceWorker.enable');
  await reportPage.close();
  await stopSession.send('ServiceWorker.stopAllWorkers');
  await delay(4500);
  reportPage = await context.newPage();
  await reportPage.goto(`chrome-extension://${extensionId}/report.html?id=${id}`);
  await reportPage.locator('#reportBody').waitFor({ state: 'visible' });
  report = await fetchReport(id);
  assert.ok(report.partial);
  assert.ok(report.samples.some((s) => s.kind === 'gap'));
  assert.ok(report.events.some((e) => e.kind === 'gap'));
  for (const stream of streams.get('/slow/archive.zip') || []) stream.finish();
  await until(async () => (await fetchReport(id))?.state === 'complete', 'completion');
  report = await fetchReport(id);
  const item = await reportPage.evaluate(
    async (id) => (await chrome.downloads.search({ id }))[0],
    id,
  );
  assert.deepEqual(await readFile(item.filename), data);
  checks.push(
    'Pause/resume is marked separately, forced worker restart preserves history and marks the gap, and the completed file matches expected bytes',
  );
  await reportPage.reload();
  await reportPage.locator('#reportState').filter({ hasText: '已完成' }).waitFor();
  await reportPage.locator('#reportTheme').click();
  await reportPage.screenshot({
    animations: 'disabled',
    path: path.join(output, 'report-complete-dark.png'),
    fullPage: true,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await reportPage.locator('#copyReport').click();
  const summary = await reportPage.evaluate(() => navigator.clipboard.readText());
  assert.match(summary, /127\.0\.0\.1/);
  assert.equal(summary.includes('REPORT_SECRET'), false);
  assert.equal(summary.includes(downloads), false);
  checks.push(
    'Report survives reopening, supports dark mode and keyboard chart inspection, and copies a domain-only diagnostic summary',
  );
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 580 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  assert.equal(
    await popup
      .locator('.brand')
      .textContent()
      .then((s) => s.trim()),
    'Nivra',
  );
  await popup.locator(`[data-more="${id}"]`).click();
  await popup.screenshot({
    animations: 'disabled',
    path: path.join(output, 'nivra-popup-report-menu.png'),
  });
  const opened = context.waitForEvent('page');
  await popup.locator('[data-menu-action="report"]').click();
  const linkedReport = await opened;
  await linkedReport.waitForURL(`**/report.html?id=${id}`);
  await linkedReport.locator('#reportBody').waitFor({ state: 'visible' });
  await linkedReport.close();
  await popup.close();
  checks.push(
    'Nivra branding and the task menu open the persisted report for the selected download',
  );
  const ids = await reportPage.evaluate(
    async (url) =>
      Promise.all([chrome.downloads.download({ url }), chrome.downloads.download({ url })]),
    base + '/slow/same.zip',
  );
  await until(
    async () =>
      (await Promise.all(ids.map(fetchReport))).every((r) => r?.network.status === 'ambiguous'),
    'same-link ambiguity',
  );
  for (const same of await Promise.all(ids.map(fetchReport)))
    assert.deepEqual(same.network.hops, []);
  await call('DOWNLOAD_ACTION', { action: 'cancel', ids });
  checks.push(
    'Two concurrent downloads of the same URL are both marked ambiguous without attributing an IP to either task',
  );
  const ipv6Id = await reportPage.evaluate(
    (url) => chrome.downloads.download({ url }),
    `http://[::1]:${ipv6.address().port}/ipv6.bin`,
  );
  const ipv6Report = await until(async () => {
    const value = await fetchReport(ipv6Id);
    return value?.state === 'complete' && value.network.status === 'observed' && value;
  }, 'IPv6 download');
  assert.ok(ipv6Report.network.hops.some((hop) => hop.ip.replace(/[[\]]/g, '') === '::1'));
  checks.push('A real loopback IPv6 download records the IPv6 endpoint without DNS lookup');
  const bad = await reportPage.evaluate(
    (url) => chrome.downloads.download({ url }),
    base + '/failure.pdf',
  );
  await until(async () => (await fetchReport(bad))?.state === 'failed', 'real failure');
  await reportPage.goto(`chrome-extension://${extensionId}/report.html?id=${bad}`);
  await reportPage.locator('#reportState').filter({ hasText: '下载中断' }).waitFor();
  assert.ok(await reportPage.locator('#reportEvents').textContent());
  await call('DOWNLOAD_ACTION', { action: 'erase', ids: [bad], confirmed: true });
  await until(async () => !(await fetchReport(bad)), 'erase removes report');
  await reportPage.reload();
  await reportPage.getByText('暂无下载报告', { exact: true }).waitFor();
  checks.push(
    'A real HTTP failure is recorded with its event, erasing history removes its report, and missing reports show an honest empty state',
  );
  const browser = await diagnostics.read();
  assert.deepEqual(errors, []);
  assert.deepEqual(browser.runtimeErrors, []);
  assert.deepEqual(browser.manifestErrors, []);
  const result = { passed: checks.length, checks, output, browser };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  await writeFile(
    path.join(root, 'artifacts/latest-reports.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ error: error.stack, checks, errors }, null, 2),
  );
  await reportPage
    ?.screenshot({ animations: 'disabled', path: path.join(output, 'failure.png'), fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  ipv6.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => ipv6.close(r));
  await rm(profile, { recursive: true, force: true });
}
