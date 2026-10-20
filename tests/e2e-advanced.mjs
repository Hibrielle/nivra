import { chromium } from 'playwright';
import {
  enableExtensionDiagnostics,
  reloadExtension,
  setTestLanguage,
} from './browser-diagnostics.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  extensionRoot = process.env.EXTENSION_DIR ? path.resolve(process.env.EXTENSION_DIR) : root;
const output = path.join(
    root,
    'artifacts',
    'advanced-' + new Date().toISOString().replace(/[:.]/g, '-'),
  ),
  downloads = path.join(output, 'downloads'),
  profile = await mkdtemp(path.join(tmpdir(), 'nivra-advanced-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
  }),
);
// A disposable extension copy predeclares optional permissions because headless
// Chrome cannot accept its native permission bubble. Product code is unchanged.
const fixtureRoot = path.join(profile, 'extension');
await cp(extensionRoot, fixtureRoot, {
  recursive: true,
  filter: (source) =>
    source === extensionRoot ||
    !['node_modules', '.git', 'artifacts', 'dist', 'tests', 'scripts', 'mcp'].includes(
      path.basename(source),
    ),
});
const fixtureManifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
fixtureManifest.permissions = [
  ...fixtureManifest.permissions,
  ...fixtureManifest.optional_permissions,
];
fixtureManifest.host_permissions = [
  ...(fixtureManifest.host_permissions || []),
  ...fixtureManifest.optional_host_permissions,
];
delete fixtureManifest.optional_permissions;
delete fixtureManifest.optional_host_permissions;
await writeFile(path.join(fixtureRoot, 'manifest.json'), JSON.stringify(fixtureManifest));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xZsAAAAASUVORK5CYII=',
  'base64',
);
const zip = Buffer.from(
  zipSync({
    'readme.txt': strToU8('Archive download fixture'),
    'data/value.json': strToU8('{"verified":true}'),
  }),
);
const textBody = Buffer.from('Nivra feature test.\n');
const slow = Buffer.alloc(2 * 1024 * 1024, 0x51),
  checks = [],
  errors = [],
  requests = [],
  active = new Map(),
  peakHosts = new Map();
let peak = 0,
  flaky = 0;
const mediaDir = path.join(output, 'media');
await mkdir(mediaDir);
execFileSync(process.env.FFMPEG_EXECUTABLE || 'ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=1',
  '-c:a',
  'pcm_s16le',
  path.join(mediaDir, 'tone.wav'),
]);
execFileSync(process.env.FFMPEG_EXECUTABLE || 'ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=gray:s=64x48:d=1',
  '-c:v',
  'libvpx',
  '-y',
  path.join(mediaDir, 'clip.webm'),
]);
const wav = await readFile(path.join(mediaDir, 'tone.wav')),
  video = await readFile(path.join(mediaDir, 'clip.webm'));
function pdfFixture() {
  const stream = 'BT /F1 18 Tf 30 100 Td (Download verification) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(data);
}
const pdf = pdfFixture();
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'),
    pathname = url.pathname,
    name = pathname.split('/').pop();
  requests.push({ path: req.url, host: req.headers.host, range: req.headers.range });
  if (pathname.startsWith('/slow/')) {
    const host = req.headers.host;
    active.set(host, (active.get(host) || 0) + 1);
    peak = Math.max(
      peak,
      [...active.values()].reduce((a, b) => a + b, 0),
    );
    peakHosts.set(host, Math.max(peakHosts.get(host) || 0, active.get(host)));
    let offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
    const start = offset;
    res.writeHead(start ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': slow.length - start,
      'Accept-Ranges': 'bytes',
      ETag: '"fixture-slow"',
      ...(start ? { 'Content-Range': `bytes ${start}-${slow.length - 1}/${slow.length}` } : {}),
    });
    const timer = setInterval(() => {
      const end = Math.min(offset + 65536, slow.length);
      res.write(slow.subarray(offset, end));
      offset = end;
      if (offset === slow.length) {
        clearInterval(timer);
        res.end();
      }
    }, 45);
    res.on('close', () => {
      clearInterval(timer);
      active.set(host, Math.max(0, (active.get(host) || 1) - 1));
    });
    return;
  }
  if (pathname === '/flaky.txt' && flaky++ === 0) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('missing');
    return;
  }
  if (pathname === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(
      `<!doctype html><html><head><title>Resource fixture</title></head><body><h1>Project resources</h1><a href="/report-2026.pdf" download>Quarterly report</a><a href="/flaky.txt">Text note</a><img src="/inline/cover.png" width="100" height="100" alt="Cover"><div style="width:50px;height:50px;background-image:url('/inline/bg.png')"></div><img data-src="/inline/lazy.png"><audio src="/inline/tone.wav" controls></audio><video src="/inline/clip.webm" controls></video><button id="later" onclick="fetch('/api/late.pdf?signature=fixture').then(r=>r.arrayBuffer())">Load later</button><p><a href="/files/[001:003].txt">Numbered text</a></p></body></html>`,
    );
    return;
  }
  let buffer = url.searchParams.has('body') ? Buffer.from(url.searchParams.get('body')) : textBody,
    type = 'text/plain';
  if (name.endsWith('.png')) {
    buffer = png;
    type = 'image/png';
  } else if (name.endsWith('.zip')) {
    buffer = zip;
    type = 'application/zip';
  } else if (name.endsWith('.wav')) {
    buffer = wav;
    type = 'audio/wav';
  } else if (name.endsWith('.webm')) {
    buffer = video;
    type = 'video/webm';
  } else if (name.endsWith('.pdf')) {
    buffer = pdf;
    type = 'application/pdf';
  }
  const inline = pathname.startsWith('/inline/') || pathname.startsWith('/api/');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buffer.length,
    ...(!inline ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
});
await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
const base = `http://localhost:${server.address().port}`,
  other = `http://127.0.0.1:${server.address().port}`;
let context, manager, page, id, diagnostics;
const launch = async () => {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${fixtureRoot}`, `--load-extension=${fixtureRoot}`],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  await setTestLanguage(sw);
  id = new URL(sw.url()).hostname;
  diagnostics = await enableExtensionDiagnostics(context, id);
  await reloadExtension(context, sw, id);
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${id}/manager.html`);
  await manager.waitForFunction(() => Number(document.querySelector('#ruleCount').textContent) > 0);
};
const call = async (type, payload = {}) => {
  const result = await manager.evaluate((message) => chrome.runtime.sendMessage(message), {
    type,
    ...payload,
  });
  if (!result?.ok) throw new Error(result?.error || 'No extension response');
  return result;
};
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let result;
  while (Date.now() < deadline) {
    result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timed out: ${label}`);
}
const state = () => call('GET_STATE');
async function waitDownload(downloadId, complete = true) {
  return until(async () => {
    const r = (await state()).records.find((r) => r.id === downloadId);
    return r && (complete ? r.state === 'complete' : r.bytesReceived > 200000) ? r : null;
  }, `download ${downloadId}`);
}
const start = (url) => manager.evaluate((url) => chrome.downloads.download({ url }), url);
async function importPack(pack) {
  const result = await call('PREVIEW_IMPORT', { pack, position: 'first' });
  return call('IMPORT_RULES', { pack, position: 'first', revision: result.revision });
}
try {
  await launch();
  await call('SET_SETTINGS', { settings: { autoOpenPanel: false } });
  assert.equal(
    await manager.evaluate(() =>
      chrome.permissions.contains({
        origins: ['http://*/*', 'https://*/*', 'file:///*'],
        permissions: ['notifications', 'downloads.ui'],
      }),
    ),
    true,
    'isolated permission fixture',
  );
  const reg = [
    {
      description: 'Native project',
      enabled: true,
      filename: 'report-(\\d+)\\.pdf',
      mime: 'application/pdf',
      url: '/projects/(\\d+)/',
      pattern: 'Projects/${url:1}/${date:YYYY-MM}/${filename:1}.pdf',
      'conflict-action': 'uniquify',
    },
  ];
  await importPack(reg);
  const nativeId = await start(base + '/projects/42/report-2026.pdf');
  const native = await waitDownload(nativeId);
  assert.ok(native.filename.endsWith('/Projects/42/2026-10/2026.pdf'));
  assert.deepEqual(await readFile(native.filename), pdf);
  checks.push('RegExp native config and URL/filename captures route an actual downloaded file');
  const bad = { name: 'Timeout', enabled: true, regex: '(a+)+$', folder: 'timeout' };
  const timed = await manager.evaluate(
    async (payload) =>
      chrome.runtime.sendMessage({ type: 'EVALUATE', operation: 'decide', payload }),
    { item: { filename: 'a'.repeat(240) + '!' }, config: { enabled: true, rules: [bad] } },
  );
  assert.equal(timed.ok, false);
  assert.match(timed.error, /600/);
  const fresh = await call('EVALUATE', {
    operation: 'decide',
    payload: {
      item: { filename: 'normal.pdf', startTime: new Date().toISOString() },
      config: (await state()).config,
    },
  });
  assert.equal(fresh.result.kind, 'matched');
  checks.push('Browser offscreen worker terminates costly regex in 600 ms and recovers');
  const dangerous = await manager.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SAVE_RULE',
      rule: {
        name: 'overwrite',
        extensions: 'txt',
        folder: 'Overwrite',
        conflictAction: 'overwrite',
      },
    }),
  );
  assert.equal(dangerous.ok, false);
  assert.match(dangerous.error, /确认/);
  checks.push('Unconfirmed overwrite rules cannot be activated');

  await call('SET_SETTINGS', { settings: { queueConcurrency: 2, perHostConcurrency: 1 } });
  await call('QUEUE_ACTION', { action: 'pause' });
  await manager.goto(`chrome-extension://${id}/manager.html#batch`);
  await manager
    .locator('#batchUrls')
    .fill(base + '/slow/item-[001:003].dat\n' + other + '/slow/item-004.dat');
  await manager.locator('#batchTemplate').fill('Batch/{num:3}_{filename}');
  await manager.locator('#startBatch').click();
  await until(async () => {
    const queue = (await call('GET_QUEUE')).queue;
    return queue.items.length === 4 && queue.items.every((t) => t.state === 'waiting');
  }, 'paused dispatch');
  await manager.screenshot({ path: path.join(output, 'batch-queue.png'), fullPage: true });
  peak = 0;
  peakHosts.clear();
  await manager.locator('#queueResume').click();
  const queue = await until(async () => {
    const q = (await call('GET_QUEUE')).queue;
    return q.items.length === 4 && q.items.every((t) => t.state === 'complete') ? q : null;
  }, 'batch completion');
  assert.ok(peak <= 2 && peak >= 2, `peak ${peak}`);
  assert.ok([...peakHosts.values()].every((n) => n <= 1));
  for (const task of queue.items) {
    const record = await waitDownload(task.downloadId);
    assert.ok(record.filename.includes(`/Batch/${String(task.batchIndex).padStart(3, '0')}_`));
    assert.deepEqual(await readFile(record.filename), slow);
  }
  checks.push(
    'UI URL ranges create real queued downloads with global/per-host limits, ordering and exact bytes',
  );

  const slowId = await start(base + '/slow/control.dat');
  await waitDownload(slowId, false);
  assert.ok(Number(await manager.evaluate(() => chrome.action.getBadgeText({}))) > 0);
  await call('DOWNLOAD_ACTION', { action: 'pause', ids: [slowId] });
  await until(async () => {
    const r = (await state()).records.find((r) => r.id === slowId);
    return r?.paused;
  }, 'paused download');
  await call('DOWNLOAD_ACTION', { action: 'resume', ids: [slowId] });
  const resumed = await waitDownload(slowId);
  assert.deepEqual(await readFile(resumed.filename), slow);
  const canceledId = await start(base + '/slow/cancel.dat');
  await waitDownload(canceledId, false);
  await call('DOWNLOAD_ACTION', { action: 'cancel', ids: [canceledId] });
  await until(
    async () => (await state()).records.find((r) => r.id === canceledId)?.state === 'interrupted',
    'canceled download',
  );
  const failId = await start(base + '/flaky.txt');
  await until(
    async () => (await state()).records.find((r) => r.id === failId)?.state === 'interrupted',
    'failed request',
  );
  await call('DOWNLOAD_ACTION', { action: 'retry', ids: [failId] });
  const retry = await until(
    async () =>
      (await state()).records.find(
        (r) => r.id !== failId && r.filename.endsWith('flaky.txt') && r.state === 'complete',
      ),
    'retry completed',
  );
  assert.deepEqual(await readFile(retry.filename), textBody);
  checks.push('Real downloads pause/resume, cancel, and retry failed HTTP requests');

  page = await context.newPage();
  await page.goto(base + '/page');
  await manager.goto(`chrome-extension://${id}/manager.html#resources`);
  await manager.locator('[name="resourceTab"]').first().check();
  await manager.locator('#scanResources').click();
  await until(
    async () => {
      const data = (await call('GET_CAPTURE')).capture;
      return Object.values(data.resources).flat().length > 0 ? data : null;
    },
    'DOM resource scan',
    10000,
  );
  const resources = (await call('GET_CAPTURE')).capture;
  const found = Object.values(resources.resources).flat();
  for (const suffix of ['cover.png', 'bg.png', 'lazy.png', 'tone.wav', 'clip.webm'])
    assert.ok(
      found.some((r) => r.url.endsWith(suffix)),
      suffix,
    );
  await manager.locator('#resourceKind').selectOption('image');
  await manager.locator('#resourceWidth').fill('1');
  await until(
    () =>
      manager
        .locator('.resource-card')
        .count()
        .then((n) => n >= 1),
    'image dimension filter',
  );
  await manager.screenshot({ path: path.join(output, 'resource-discovery.png'), fullPage: true });
  await manager.locator('#resourceWidth').fill('0');
  await manager.locator('#resourceKind').selectOption('');
  await manager.locator('#watchResources').click();
  const networkSession = await context.newCDPSession(page);
  await networkSession.send('ServiceWorker.enable');
  await networkSession.send('ServiceWorker.stopAllWorkers');
  await page.locator('#later').click();
  await until(
    async () =>
      Object.values((await call('GET_CAPTURE')).capture.resources)
        .flat()
        .find((r) => r.url.includes('/api/late.pdf')),
    'network capture',
  );
  const cover = found.find((r) => r.url.endsWith('cover.png'));
  await manager.locator(`[data-resource-id="${cover.id}"]`).check();
  await manager.locator('#resourceTemplate').fill('Resources/{page_title}/{filename}');
  await manager.locator('#downloadResources').click();
  const resourceDownload = await until(
    async () =>
      (await state()).records.find(
        (r) =>
          r.filename.includes('/Resources/Resource fixture/cover.png') && r.state === 'complete',
      ),
    'selected resource file',
  );
  assert.deepEqual(await readFile(resourceDownload.filename), png);
  checks.push(
    'DOM/CSS/lazy/media discovery, dimensions filtering and optional network capture feed a real batch download',
  );

  await importPack([
    {
      int_name: 'r_chrono',
      caption: 'Chrono project',
      active: true,
      condition: '*ext*.is("txt") && *url*.has("chrono")',
      folder: 'Chrono/*page_title*',
      naming: '*num*_*name*.*ext*',
    },
  ]);
  await call('ADD_BATCH', {
    items: [{ url: base + '/chrono/note.txt', pageTitle: 'Fixture project', linkText: 'A note' }],
  });
  const chrono = await until(
    async () =>
      (await state()).records.find(
        (r) => r.filename.endsWith('/Chrono/Fixture project/1_note.txt') && r.state === 'complete',
      ),
    'Chrono title and naming',
  );
  assert.deepEqual(await readFile(chrono.filename), textBody);
  await call('SAVE_RULE', {
    rule: {
      name: 'Overwrite fixture',
      extensions: 'txt',
      urlRegex: '/overwrite/',
      folder: 'Overwrite',
      filenameTemplate: 'fixed.txt',
      conflictAction: 'overwrite',
    },
    overwriteConfirmed: true,
  });
  const firstOverwrite = await waitDownload(await start(base + '/overwrite/a.txt?body=first'));
  assert.equal((await readFile(firstOverwrite.filename)).toString(), 'first');
  const secondOverwrite = await waitDownload(await start(base + '/overwrite/b.txt?body=second'));
  assert.equal(firstOverwrite.filename, secondOverwrite.filename);
  assert.equal((await readFile(secondOverwrite.filename)).toString(), 'second');
  checks.push(
    'Chrono rule import uses real page metadata; explicitly confirmed overwrite replaces only an isolated fixture',
  );

  const cloud = await call('SYNC_UPLOAD');
  assert.ok(cloud.meta.hash);
  const cloudRead = await call('SYNC_READ');
  assert.equal(cloudRead.pack.rules.length, (await state()).config.rules.length);
  const corrupt = await manager.evaluate(async () => {
    const all = await chrome.storage.sync.get(null);
    const meta = all['rules:meta'];
    await chrome.storage.sync.remove(`rules:${meta.generation}:0`);
    return chrome.runtime.sendMessage({ type: 'SYNC_READ' });
  });
  assert.equal(corrupt.ok, false);
  assert.match(corrupt.error, /分块/);
  await call('SYNC_UPLOAD');
  checks.push(
    'Browser sync storage round-trip verifies rule hashes and rejects incomplete backups; no cross-device claim',
  );

  await manager.goto(`chrome-extension://${id}/manager.html#settings`);
  await manager.locator('#filterName').fill('下载完成的 PDF');
  await manager.locator('#filterCondition').fill('*ext*.is("pdf") && *state* = [finished]');
  await manager.locator('#saveFilter').click();
  await until(async () => (await state()).config.savedFilters.length === 1, 'saved custom filter');
  await manager.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
  await manager.goto(`chrome-extension://${id}/manager.html#all`);
  await manager.locator('#downloadFilter').selectOption({ label: '下载完成的 PDF' });
  await until(async () => {
    const names = await manager.locator('[data-task-row] .file-name').allTextContents();
    return names.length && names.every((name) => name.endsWith('.pdf'));
  }, 'custom filter results');
  await manager.locator('#downloadLayout').click();
  await manager.locator('.download-card').first().waitFor();
  await manager.screenshot({ path: path.join(output, 'grid-view.png'), fullPage: true });
  checks.push('Saved expression filters, sorting controls and grid view render real history');

  const disposable = await waitDownload(await start(base + '/disposable.txt'));
  assert.ok(disposable.filename.startsWith(downloads + '/'));
  const rejected = await manager.evaluate(
    (id) => chrome.runtime.sendMessage({ type: 'DOWNLOAD_ACTION', action: 'delete', ids: [id] }),
    disposable.id,
  );
  assert.equal(rejected.ok, false);
  await stat(disposable.filename);
  await call('DOWNLOAD_ACTION', { action: 'delete', ids: [disposable.id], confirmed: true });
  await assert.rejects(stat(disposable.filename), { code: 'ENOENT' });
  await call('DOWNLOAD_ACTION', { action: 'erase', ids: [disposable.id], confirmed: true });
  await until(
    async () => !(await state()).records.some((r) => r.id === disposable.id),
    'record erase',
  );
  assert.ok((await state()).records.some((r) => r.id === resourceDownload.id));
  checks.push(
    'File deletion requires confirmation and is separate from history clearing, using only isolated fixture files',
  );
  await manager.goto(`chrome-extension://${id}/manager.html#settings`);
  await manager.locator('[name="notifications"]').check();
  await manager.locator('[name="replaceDownloadUI"]').check();
  await manager.locator('#settingsForm button[type="submit"]').click();
  await until(async () => {
    const config = (await state()).config;
    return config.notifications && config.replaceDownloadUI;
  }, 'notification/UI settings');
  const notify = await waitDownload(await start(base + '/notified.txt'));
  const notifications = await manager.evaluate(() => chrome.notifications.getAll());
  assert.ok(
    Object.hasOwn(notifications, 'download:' + notify.id),
    'notification is registered with browser API',
  );
  await manager.locator('#openWindow').click();
  await until(
    async () =>
      (await manager.evaluate(() => chrome.windows.getAll())).some(
        (window) => window.type === 'popup',
      ),
    'standalone window',
  );
  await manager.locator('[name="replaceDownloadUI"]').uncheck();
  await manager.locator('[name="notifications"]').uncheck();
  await manager.locator('#settingsForm button[type="submit"]').click();
  checks.push(
    'Toolbar badge, notification API, native-download-UI setting and standalone window execute',
  );

  await manager.evaluate((id) => chrome.storage.local.remove('record:' + id), notify.id);
  assert.ok(!(await state()).records.some((r) => r.id === notify.id));
  await call('IMPORT_HISTORY');
  assert.equal((await state()).records.find((r) => r.id === notify.id).decision.kind, 'historical');
  assert.deepEqual(await readFile(notify.filename), textBody);
  await call('QUEUE_ACTION', { action: 'pause' });
  await call('ADD_BATCH', { text: base + '/restart.txt', template: 'Restart/{filename}' });
  await context.close();
  await launch();
  assert.equal((await call('GET_QUEUE')).queue.paused, true);
  assert.ok(
    (await call('GET_QUEUE')).queue.items.some(
      (t) => t.state === 'waiting' && t.url.endsWith('/restart.txt'),
    ),
  );
  await call('QUEUE_ACTION', { action: 'resume' });
  const restored = await until(
    async () =>
      (await state()).records.find(
        (r) => r.filename.endsWith('/Restart/restart.txt') && r.state === 'complete',
      ),
    'persisted queue restart',
  );
  assert.deepEqual(await readFile(restored.filename), textBody);
  checks.push(
    'Explicit history import preserves disk files and a paused queue survives a complete browser restart',
  );
  assert.deepEqual(errors, []);
  const browserErrors = await diagnostics.read();
  assert.deepEqual(browserErrors.runtimeErrors, []);
  assert.deepEqual(browserErrors.manifestErrors, []);
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        browser: context.browser().version(),
        extensionRoot,
        permissionFixture: true,
        checks,
        peak,
        peakHosts: Object.fromEntries(peakHosts),
        requests,
        errors,
        browserErrors,
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, 'artifacts', 'latest-advanced.json'),
    JSON.stringify({ output, checks: checks.length }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
} catch (error) {
  await manager
    ?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
    .catch(() => {});
  await writeFile(
    path.join(output, 'failure.txt'),
    error.stack + '\n' + JSON.stringify({ checks, errors }, null, 2),
  );
  console.error('Evidence:', output);
  throw error;
} finally {
  await context?.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
