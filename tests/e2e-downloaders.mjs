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
import { torrentFixture } from './torrent-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = process.env.EXTENSION_DIR ? path.resolve(process.env.EXTENSION_DIR) : root;
if (!process.env.DOWNLOADER_LAB)
  throw new Error('Set DOWNLOADER_LAB to the temporary lab directory');
const clients = JSON.parse(
  await readFile(path.join(process.env.DOWNLOADER_LAB, 'credentials.json'), 'utf8'),
);
const output = path.join(
  root,
  'artifacts',
  'downloaders-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
const downloads = path.join(output, 'downloads');
const profile = await mkdtemp(path.join(tmpdir(), 'mate-downloader-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);
const fixture = torrentFixture('Nivra ' + Date.now() + '.txt');
const directFixture = torrentFixture('Nivra direct ' + Date.now() + '.txt');
const torrentName = 'nivra-test.torrent';
const server = createServer((req, res) => {
  const pdf = req.url.startsWith('/ordinary');
  const content = pdf
    ? Buffer.from('ordinary file')
    : req.url.startsWith('/direct')
      ? directFixture.bytes
      : fixture.bytes;
  res.writeHead(200, {
    'Content-Type': pdf ? 'application/pdf' : 'application/x-bittorrent',
    'Content-Length': content.length,
    'Content-Disposition': 'attachment; filename="' + (pdf ? 'ordinary.pdf' : torrentName) + '"',
  });
  res.end(content);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let context, manager, popup, diagnostics, extensionId;
const checks = [],
  versions = {},
  errors = [];
async function until(fn, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
async function raw(message) {
  return manager.evaluate((message) => chrome.runtime.sendMessage(message), message);
}
async function call(type, payload = {}) {
  const result = await raw({ type, ...payload });
  assert.equal(result.ok, true, result.error);
  return result;
}
async function actualTasks(config) {
  const options = { signal: AbortSignal.timeout(10000) };
  if (config.type === 'qbittorrent') {
    const login = await fetch(config.url + '/api/v2/auth/login', {
      ...options,
      method: 'POST',
      headers: { Origin: new URL(config.url).origin, Referer: config.url + '/' },
      body: new URLSearchParams({ username: config.username, password: config.secret }),
    });
    assert.equal((await login.text()).trim(), 'Ok.');
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    const response = await fetch(config.url + '/api/v2/torrents/info', {
      ...options,
      headers: { Cookie: cookie },
    });
    return (await response.json()).map((item) => ({
      name: item.name,
      hash: item.hash,
      directory: item.save_path,
    }));
  }
  if (config.type === 'transmission') {
    const headers = {
      Authorization:
        'Basic ' + Buffer.from(config.username + ':' + config.secret).toString('base64'),
      'Content-Type': 'application/json',
    };
    const request = () =>
      fetch(config.url + '/transmission/rpc', {
        ...options,
        method: 'POST',
        headers,
        body: JSON.stringify({
          method: 'torrent-get',
          arguments: { fields: ['name', 'hashString', 'downloadDir'] },
        }),
      });
    let response = await request();
    if (response.status === 409) {
      headers['X-Transmission-Session-Id'] = response.headers.get('X-Transmission-Session-Id');
      response = await request();
    }
    return (await response.json()).arguments.torrents.map((item) => ({
      name: item.name,
      hash: item.hashString,
      directory: item.downloadDir,
    }));
  }
  const response = await fetch(config.url + '/jsonrpc', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      ['tellActive', 'tellWaiting', 'tellStopped'].map((method, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'aria2.' + method,
        params: ['token:' + config.secret, ...(method === 'tellActive' ? [] : [0, 100])],
      })),
    ),
  });
  const value = await response.json();
  assert.ok(value.every((item) => Array.isArray(item.result)));
  return value
    .flatMap((item) => item.result)
    .map((item) => ({
      name: item.bittorrent?.info?.name,
      hash: item.infoHash,
      directory: item.dir,
    }));
}
async function menu(id) {
  if (await popup.locator('#taskMenu').isVisible()) await popup.keyboard.press('Escape');
  await popup.locator(`[data-more="${id}"]`).click();
  await popup.locator('#taskMenu').waitFor({ state: 'visible' });
}

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: true,
    viewport: { width: 1280, height: 1000 },
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
  manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/manager.html#settings`);
  await manager.locator('#downloaderForm').waitFor();
  await call('SET_SETTINGS', { settings: { autoOpenPanel: false } });
  assert.equal((await call('GET_DOWNLOADER')).downloader, null);
  const id = await manager.evaluate((url) => chrome.downloads.download({ url }), base + '/fixture');
  const record = await until(
    async () =>
      (await call('GET_STATE')).records.find((item) => item.id === id && item.state === 'complete'),
    'torrent browser download',
  );
  assert.deepEqual(await readFile(record.filename), fixture.bytes);
  popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 580 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator(`[data-more="${id}"]`).waitFor();
  await menu(id);
  assert.equal(
    await popup.locator('[data-menu-action="send-torrent"]').textContent(),
    '绑定下载器…',
  );
  await popup.locator('[data-menu-action="send-torrent"]').click();
  await until(() => popup.isClosed(), 'unbound action opens settings');
  assert.equal(manager.url().endsWith('#settings'), true);
  checks.push(
    'Real .torrent download is classified; an unbound popup action opens the existing settings page',
  );

  for (const [type, config] of Object.entries(clients)) {
    await manager.goto(`chrome-extension://${extensionId}/manager.html#settings`);
    await manager.locator('#downloaderForm').waitFor();
    await manager.locator('[name="clientType"]').selectOption(type);
    // Set fixture credentials without including their value in Playwright action logs.
    await manager.evaluate((config) => {
      const form = document.querySelector('#downloaderForm');
      form.endpoint.value = config.url;
      form.username.value = config.username;
      form.secret.value = config.secret;
      form.dispatchEvent(new Event('input', { bubbles: true }));
    }, config);
    await manager.locator('#testDownloader').click();
    await until(async () => {
      const text = await manager.locator('#downloaderStatus').textContent();
      if (
        (await manager.locator('#downloaderStatus').getAttribute('class'))?.includes('form-error')
      )
        throw new Error(type + ': ' + text);
      return text.includes('连接成功') ? text : null;
    }, type + ' authenticated connection');
    versions[type] = await manager.locator('#downloaderStatus').textContent();
    await manager.locator('#downloaderForm button[type="submit"]').click();
    await until(
      async () => (await manager.locator('#downloaderStatus').textContent()).startsWith('已绑定'),
      'save binding',
    );
    assert.equal(await manager.locator('[name="secret"]').inputValue(), '');
    const state = await call('GET_STATE');
    assert.equal(state.downloader.type, type);
    assert.equal(state.downloader.hasSecret, true);
    assert.equal(JSON.stringify(state).includes(config.secret), false);
    const saved = (await call('GET_DOWNLOADER')).downloader;
    assert.equal(Object.hasOwn(saved, 'secret'), false);
    const bad = await raw({
      type: 'TEST_DOWNLOADER',
      downloader: { ...config, secret: 'deliberately-wrong-test-secret' },
    });
    assert.equal(bad.ok, false, type + ' accepted wrong credentials');
    const retained = await call('TEST_DOWNLOADER', {
      downloader: { type, url: config.url, username: config.username },
    });
    assert.ok(retained.version);
    assert.deepEqual(
      await manager.evaluate(() => chrome.declarativeNetRequest.getSessionRules()),
      [],
    );
    if (type === 'qbittorrent')
      await manager
        .locator('#downloaderSettings')
        .screenshot({ path: path.join(output, 'downloader-settings.png'), animations: 'disabled' });
    popup = await context.newPage();
    await popup.setViewportSize({ width: 440, height: 580 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator(`[data-more="${id}"]`).waitFor();
    await menu(id);
    assert.match(
      await popup.locator('[data-menu-action="send-torrent"]').textContent(),
      new RegExp('发送到 ' + saved.name),
    );
    if (type === 'qbittorrent')
      await popup.screenshot({
        path: path.join(output, 'torrent-menu.png'),
        animations: 'disabled',
      });
    if (type === 'qbittorrent') {
      await popup.locator('#popupThemeToggle').click();
      await menu(id);
      await popup.screenshot({
        path: path.join(output, 'torrent-menu-dark.png'),
        animations: 'disabled',
      });
      await manager.locator('#downloaderSettings').screenshot({
        path: path.join(output, 'downloader-settings-dark.png'),
        animations: 'disabled',
      });
    }
    await popup.locator('[data-menu-action="send-torrent"]').click();
    await popup.locator('#torrentFileDialog').waitFor({ state: 'visible' });
    if (type === 'qbittorrent') {
      await popup.screenshot({
        path: path.join(output, 'torrent-file-dialog-dark.png'),
        animations: 'disabled',
      });
      await popup.locator('#torrentFileInput').setInputFiles({
        name: torrentName,
        mimeType: 'application/x-bittorrent',
        buffer: Buffer.from('<html>not a torrent</html>'),
      });
      await popup.locator('#submitTorrentFile').click();
      await until(
        async () => (await popup.locator('#torrentFileError').textContent()).includes('有效'),
        'malformed torrent rejection',
      );
      assert.equal(
        (await actualTasks(config)).some((item) => item.hash === fixture.hash),
        false,
      );
    }
    await popup.locator('#torrentFileInput').setInputFiles({
      name: torrentName,
      mimeType: 'application/x-bittorrent',
      buffer: fixture.bytes,
    });
    await popup.locator('#submitTorrentFile').click();
    await until(async () => {
      const error = (await popup.locator('#torrentFileError').count())
        ? await popup.locator('#torrentFileError').textContent()
        : '';
      if (error) throw new Error(type + ': ' + error);
      return (await popup.locator('#popupToast').textContent()).startsWith('已提交到');
    }, type + ' submitted from popup');
    const tasks = await until(async () => {
      const items = await actualTasks(config);
      return items.some((item) => item.hash?.toLowerCase() === fixture.hash) ? items : null;
    }, type + ' actual client task');
    const accepted = tasks.find((item) => item.hash?.toLowerCase() === fixture.hash);
    assert.equal(accepted.name, fixture.name);
    assert.match(accepted.directory, /^\/downloads\/?$/);
    const duplicate = await call('SEND_TORRENT', { id, bindingId: saved.bindingId });
    assert.equal(duplicate.duplicate, true);
    assert.equal(
      (await actualTasks(config)).filter((item) => item.hash?.toLowerCase() === fixture.hash)
        .length,
      1,
    );
    assert.deepEqual(
      await manager.evaluate(() => chrome.declarativeNetRequest.getSessionRules()),
      [],
    );
    checks.push(
      `${saved.name}: UI connection, real authentication rejection, secret retention/redaction, popup upload, remote infohash/default directory and duplicate prevention`,
    );
    await popup.close();
  }
  await diagnostics.page.evaluate(async (extensionId) => {
    await chrome.developerPrivate.updateExtensionConfiguration({ extensionId, fileAccess: true });
  }, extensionId);
  await manager.goto(`chrome-extension://${extensionId}/manager.html#settings`);
  await manager.locator('#downloaderSettings summary').click();
  await manager.locator('#downloaderFilePermission').click();
  await until(
    () => manager.evaluate(() => chrome.permissions.contains({ origins: ['file:///*'] })),
    'file host grant through the product button',
  );
  const directId = await manager.evaluate(
    (url) => chrome.downloads.download({ url }),
    base + '/direct',
  );
  const directRecord = await until(
    async () =>
      (await call('GET_STATE')).records.find(
        (item) => item.id === directId && item.state === 'complete',
      ),
    'direct local torrent download',
  );
  assert.deepEqual(await readFile(directRecord.filename), directFixture.bytes);
  await manager.goto(`chrome-extension://${extensionId}/manager.html#all`);
  await manager.locator(`[data-task-row="${directId}"]`).click();
  await manager.locator(`[data-send-torrent="${directId}"]`).click();
  await until(async () => {
    if (await manager.locator('#torrentFileDialog').count())
      throw new Error('Authorized local file unexpectedly needs manual selection');
    return (await manager.locator('#toast').textContent()).startsWith('已提交到');
  }, 'authorized local torrent submission from manager');
  assert.ok((await actualTasks(clients.aria2)).some((item) => item.hash === directFixture.hash));
  checks.push(
    'The shipping manifest grants file access through the product button after Chrome file access is enabled; the manager sends the actual local file without a picker',
  );
  const normalId = await manager.evaluate(
    (url) => chrome.downloads.download({ url }),
    base + '/ordinary',
  );
  await until(
    async () =>
      (await call('GET_STATE')).records.some(
        (item) => item.id === normalId && item.state === 'complete',
      ),
    'ordinary file',
  );
  const saved = (await call('GET_DOWNLOADER')).downloader;
  assert.equal(
    (await raw({ type: 'SEND_TORRENT', id: normalId, bindingId: saved.bindingId })).ok,
    false,
  );
  assert.equal((await raw({ type: 'SEND_TORRENT', id, bindingId: 'stale-binding' })).ok, false);
  checks.push('Backend rejects ordinary files and a changed downloader binding');
  await call('SYNC_UPLOAD');
  const synced = await manager.evaluate(() => chrome.storage.sync.get(null));
  for (const config of Object.values(clients))
    assert.equal(JSON.stringify(synced).includes(config.secret), false);
  await call('CLEAR_DOWNLOADER');
  const local = await manager.evaluate(() => chrome.storage.local.get(null));
  assert.equal(local.externalDownloader, undefined);
  assert.equal(local.torrentSubmissions, undefined);
  checks.push(
    'Cloud backup contains no credentials; unbinding removes saved credentials and receipts',
  );
  const browser = await diagnostics.read();
  assert.deepEqual(errors, []);
  assert.deepEqual(browser.manifestErrors, []);
  assert.deepEqual(browser.runtimeErrors, []);
  const report = {
    passed: checks.length,
    checks,
    versions,
    browser: {
      version: browser.version,
      runtimeErrors: browser.runtimeErrors,
      manifestErrors: browser.manifestErrors,
    },
    infoHash: fixture.hash,
    output,
  };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(
    path.join(root, 'artifacts', 'latest-downloaders.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const browser = diagnostics ? await diagnostics.read().catch(() => null) : null;
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ error: error.message, checks, versions, errors, browser }, null, 2),
  );
  if (popup && !popup.isClosed())
    await popup
      .screenshot({ path: path.join(output, 'failure-popup.png'), animations: 'disabled' })
      .catch(() => {});
  if (manager && !manager.isClosed())
    await manager
      .screenshot({ path: path.join(output, 'failure-manager.png'), animations: 'disabled' })
      .catch(() => {});
  throw error;
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
