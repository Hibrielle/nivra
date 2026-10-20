import { chromium } from 'playwright';
import {
  enableExtensionDiagnostics,
  reloadExtension,
  setTestLanguage,
} from './browser-diagnostics.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { makeRulePack, parseRulePack, RULE_TEMPLATES } from '../rules.js';

import { defaultRules } from '../file-types.js';
const DEFAULT_COUNT = defaultRules().length;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = process.env.EXTENSION_DIR ? path.resolve(process.env.EXTENSION_DIR) : root;
const runName = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(root, 'artifacts', runName);
const downloads = path.join(output, 'downloads');
const profile = await mkdtemp(path.join(tmpdir(), 'nivra-e2e-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
  }),
);

function pdf() {
  const stream = 'BT /F1 18 Tf 30 100 Td (Nivra test file) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const fixtures = {
  'report.pdf': ['application/pdf', pdf()],
  'cover.png': [
    'image/png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xZsAAAAASUVORK5CYII=',
      'base64',
    ),
  ],
  'assets.zip': ['application/zip', Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64')],
  'note.txt': ['text/plain', Buffer.from('Nivra: custom rule fixture.\n')],
  'unknown.log': ['text/plain', Buffer.from('Nivra: unmatched fixture.\n')],
  'paused.pdf': ['application/pdf', pdf()],
  'after-restart.pdf': ['application/pdf', pdf()],
};

const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
  if (name === 'missing.pdf') {
    res.writeHead(404, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="missing.pdf"',
    });
    res.end('Not found');
  } else if (fixtures[name]) {
    const [type, buffer] = fixtures[name];
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
    });
    res.end(buffer);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<html><head><title>Nivra isolated fixtures</title></head><body><h1>Nivra isolated fixtures</h1>${Object.keys(
        fixtures,
      )
        .map(
          (file) => `<p><a href="/${file}?signature=test-only" data-file="${file}">${file}</a></p>`,
        )
        .join('')}</body></html>`,
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://localhost:${server.address().port}`;
const errors = [];
const checks = [];
let context;
let extensionId;
let manager;
let fixturePage;
let diagnostics;
const launch = async () => {
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  // Playwright's default GUID download mode would bypass Chrome's ordinary
  // download destination. Restore the real browser behavior and preferences.
  const cdp = await ctx.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  const worker =
    ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  extensionId = new URL(worker.url()).hostname;
  await setTestLanguage(worker);
  diagnostics = await enableExtensionDiagnostics(ctx, extensionId);
  await reloadExtension(ctx, worker, extensionId);
  ctx.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  return ctx;
};
async function openManager() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await page.waitForFunction(
    (count) => Number(document.querySelector('#ruleCount').textContent) >= count,
    DEFAULT_COUNT,
  );
  return page;
}
async function getState() {
  return manager.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
}
async function waitForState(predicate, message) {
  const end = Date.now() + 15000;
  let last;
  while (Date.now() < end) {
    last = await getState();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}
async function download(name) {
  const before = new Set((await getState()).records.map((r) => r.id));
  await fixturePage.locator(`[data-file="${name}"]`).click();
  const state = await waitForState(
    (s) => s.records.some((r) => !before.has(r.id) && r.state === 'complete'),
    `download ${name}`,
  );
  const record = state.records.find((r) => !before.has(r.id));
  assert.equal(record.state, 'complete');
  assert.ok(
    record.filename.startsWith(downloads + path.sep),
    'download must stay inside the isolated test directory',
  );
  const actual = await readFile(record.filename);
  assert.deepEqual(actual, fixtures[name][1], `${name} bytes must be unchanged`);
  return record;
}

try {
  context = await launch();
  manager = await openManager();
  await manager.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { autoOpenPanel: false } }),
  );
  assert.equal((await getState()).records.length, 0, 'existing browser downloads are not imported');
  await manager.screenshot({ path: path.join(output, 'empty-state.png'), fullPage: true });
  checks.push('Extension boots with the complete default catalogue and zero imported history');

  await manager.getByRole('button', { name: '新建规则', exact: true }).click();
  await manager.locator('[name="name"]').fill('工作笔记');
  await manager.locator('[name="extensions"]').fill('txt');
  await manager.locator('#ruleScope > summary').click();
  await manager.locator('[name="domain"]').fill('localhost');
  await manager.locator('[name="keyword"]').fill('note');
  await manager.locator('[name="folder"]').fill('笔记/{year}-{month}');
  await manager.locator('#ruleSampleOptions > summary').click();
  await manager.locator('#sampleFilename').fill('note.txt');
  await manager.locator('#sampleSource').fill(baseUrl + '/note.txt');
  await manager.waitForFunction(() =>
    document.querySelector('#rulePreview').textContent.includes('会保存到'),
  );
  await manager.screenshot({ path: path.join(output, 'rule-editor.png'), fullPage: true });
  await manager.getByRole('button', { name: '保存规则', exact: true }).click();
  await manager.locator('#ruleDialog').waitFor({ state: 'hidden' });
  const saved = await waitForState(
    (s) => s.config.rules.length === DEFAULT_COUNT + 1,
    'rule saved',
  );
  const customId = saved.config.rules[0].id;
  await manager.locator('#rulesNav').click();
  await manager.getByRole('button', { name: '下移 工作笔记' }).click();
  await waitForState((s) => s.config.rules[1].id === customId, 'rule reordered down');
  await manager.getByRole('button', { name: '上移 工作笔记' }).click();
  await waitForState((s) => s.config.rules[0].id === customId, 'rule reordered up');
  await manager.screenshot({ path: path.join(output, 'rules.png'), fullPage: true });
  checks.push('Visual rule editor validates, previews, saves and reorders a custom rule');

  fixturePage = await context.newPage();
  await fixturePage.goto(baseUrl);
  const expectedFolders = {
    'report.pdf': '文档',
    'cover.png': '图片',
    'assets.zip': '压缩包',
    'note.txt': '笔记',
  };
  for (const [name, expected] of Object.entries(expectedFolders)) {
    const record = await download(name);
    assert.equal(record.decision.kind, 'matched');
    assert.ok(record.filename.includes(`/${expected}/`), `${name} should be saved in ${expected}`);
  }
  checks.push('Four real file types reach the expected directories with identical bytes');
  const unknown = await download('unknown.log');
  assert.equal(unknown.decision.kind, 'unmatched');
  assert.equal(path.dirname(unknown.filename), downloads);
  checks.push('Unmatched downloads preserve the browser default directory');

  const duplicate = await download('report.pdf');
  assert.match(path.basename(duplicate.filename), /report \(1\)\.pdf/);
  assert.deepEqual(
    await readFile(path.join(path.dirname(duplicate.filename), 'report.pdf')),
    fixtures['report.pdf'][1],
  );
  checks.push('Duplicate names receive a numeric suffix; original bytes are preserved');

  await manager.locator('#autoToggle').click();
  await waitForState((s) => !s.config.enabled, 'automation paused');
  const paused = await download('paused.pdf');
  assert.equal(paused.decision.kind, 'paused');
  assert.equal(path.dirname(paused.filename), downloads);
  await manager.locator('#autoToggle').click();
  await waitForState((s) => s.config.enabled, 'automation resumed');
  await manager.getByRole('switch', { name: '启用 工作笔记 规则' }).click();
  await waitForState(
    (s) => !s.config.rules.find((r) => r.id === customId).enabled,
    'custom rule disabled',
  );
  const fallback = await download('note.txt');
  assert.equal(fallback.decision.ruleId, 'documents');
  await manager.getByRole('switch', { name: '启用 工作笔记 规则' }).click();
  await waitForState(
    (s) => s.config.rules.find((r) => r.id === customId).enabled,
    'custom rule reenabled',
  );
  checks.push('Global pause and per-rule toggles change actual subsequent download destinations');

  await manager.goto(`chrome-extension://${extensionId}/manager.html#all`);
  await manager.getByRole('searchbox').fill('cover.png');
  await manager.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1);
  await manager.locator('[data-detail]').click();
  assert.match(await manager.locator('#detailContent').innerText(), /图片/);
  assert.match(await manager.locator('#detailContent').innerText(), /已归档/);
  await manager.getByRole('button', { name: '关闭下载详情' }).click();
  await manager.getByRole('searchbox').fill('');
  await manager.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 8);
  await manager.locator('#toast').waitFor({ state: 'hidden' });
  await manager.screenshot({ path: path.join(output, 'manager.png'), fullPage: true });
  await manager.locator('#themeToggle').click();
  await manager.screenshot({ path: path.join(output, 'manager-dark.png'), fullPage: true });
  await manager.locator('#themeToggle').click();
  await manager.setViewportSize({ width: 760, height: 1000 });
  assert.ok(
    await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'narrow layout has no horizontal overflow',
  );
  await manager.setViewportSize({ width: 1440, height: 1000 });
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 388, height: 650 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => document.querySelectorAll('.popup-item').length === 8);
  await popup.screenshot({ path: path.join(output, 'popup.png'), fullPage: true });
  checks.push('Management UI search, details, dark theme, narrow layout and live task popup work');

  await context.close();
  context = await launch();
  // Download before opening any extension page: the background worker must work
  // independently, including after a full browser restart.
  fixturePage = await context.newPage();
  await fixturePage.goto(baseUrl);
  await fixturePage.locator('[data-file="after-restart.pdf"]').click();
  manager = await openManager();
  const restarted = await waitForState(
    (s) =>
      s.records.some((r) => r.filename.endsWith('after-restart.pdf') && r.state === 'complete'),
    'download after restart',
  );
  assert.equal(restarted.config.rules.length, DEFAULT_COUNT + 1);
  assert.equal(restarted.config.rules[0].id, customId);
  assert.equal(restarted.config.rules[0].enabled, true);
  const finalRecord = restarted.records.find((r) => r.filename.endsWith('after-restart.pdf'));
  assert.ok(finalRecord.filename.includes('/文档/'));
  assert.deepEqual(await readFile(finalRecord.filename), fixtures['after-restart.pdf'][1]);
  assert.equal(restarted.records.length, 9);
  assert.ok(
    restarted.records.every((r) => !r.source.includes('?') && !r.source.includes('signature=')),
  );
  checks.push(
    'Rules and history survive a full browser restart; background archiving works with the manager closed',
  );

  await manager.evaluate(async (url) => {
    try {
      await chrome.downloads.download({ url });
    } catch {
      /* The failure should still appear in activity. */
    }
  }, baseUrl + '/missing.pdf');
  const failed = await waitForState(
    (s) => s.records.some((r) => r.state === 'interrupted'),
    'HTTP 404 appears in activity',
  );
  const failedRecord = failed.records.find((r) => r.state === 'interrupted');
  assert.ok(failedRecord.error, 'failure includes a browser error reason');
  await manager.locator('#navigation a[href="#failed"]').click();
  await manager.locator('[data-detail]').click();
  const failureDetail = await manager.locator('#detailContent').innerText();
  assert.match(failureDetail, /服务器.*可重新下载/);
  assert.match(failureDetail, /浏览器错误码/);
  assert.ok(failureDetail.includes(failedRecord.error));
  checks.push(
    'Downloads that fail before filename determination remain visible with the browser error',
  );

  await manager.getByRole('button', { name: '关闭下载详情' }).click();
  await manager.goto(`chrome-extension://${extensionId}/manager.html#all`);
  await manager.getByRole('searchbox').fill('cover.png');
  await manager.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 1);
  await manager.locator('[data-detail]').click();
  await manager.locator('.inspector-more>summary').click();
  await manager.getByRole('button', { name: '按此创建归档规则' }).click();
  assert.equal(await manager.locator('[name="extensions"]').inputValue(), 'png');
  assert.equal(await manager.locator('[name="domain"]').inputValue(), 'localhost');
  await manager.waitForFunction(() =>
    document.querySelector('#rulePreview').textContent.includes('会保存到'),
  );
  await manager.getByRole('button', { name: '保存规则', exact: true }).click();
  await manager.locator('#ruleDialog').waitFor({ state: 'hidden' });
  await waitForState((s) => s.config.rules.length === DEFAULT_COUNT + 2, 'derived rule saved');
  const derived = await download('cover.png');
  assert.ok(derived.filename.includes('/localhost/'));
  await manager.locator('#rulesNav').click();
  manager.once('dialog', (dialog) => dialog.accept());
  await manager.locator('#undoRules').click();
  await waitForState(
    (s) => s.config.rules.length === DEFAULT_COUNT + 1 && !s.config.ruleBackup,
    'derived rule undone',
  );
  checks.push(
    'A rule derived from a real download changes the next download destination and can be undone',
  );

  await manager.locator('#openTemplates').click();
  assert.equal(await manager.locator('.template-card').count(), RULE_TEMPLATES.length);
  await manager.screenshot({ path: path.join(output, 'template-gallery.png'), fullPage: true });
  await manager.locator('[data-use-template="invoice"]').first().click();
  assert.equal(await manager.locator('[name="keyword"]').inputValue(), '发票');
  await manager.getByRole('button', { name: '保存规则', exact: true }).click();
  await manager.locator('#ruleDialog').waitFor({ state: 'hidden' });
  await waitForState((s) => s.config.rules.length === DEFAULT_COUNT + 2, 'invoice template saved');
  await manager.locator('#openLab').click();
  await manager.locator('#labFilename').fill('出行发票.pdf');
  await manager.waitForFunction(() =>
    document.querySelector('#labResult').textContent.includes('采用「电子发票」'),
  );
  assert.ok((await manager.locator('.trace-row.shadowed').count()) > 0);
  await manager.screenshot({ path: path.join(output, 'rule-lab.png'), fullPage: true });
  await manager.locator('#labFilename').fill('other.pdf');
  await manager.waitForFunction(() =>
    document.querySelector('#labResult').textContent.includes('采用「文档」'),
  );
  assert.match(await manager.locator('.trace-row').first().innerText(), /× 文件名包含：发票/);
  await manager.getByRole('button', { name: '关闭规则测试' }).click();
  manager.once('dialog', (dialog) => dialog.accept());
  await manager.locator('#undoRules').click();
  await waitForState((s) => s.config.rules.length === DEFAULT_COUNT + 1, 'template save undone');
  checks.push(
    'Templates are editable drafts; the simulator exposes matching conditions and priority conflicts',
  );

  await manager.locator('#openImport').click();
  await manager.locator('.ai-helper>summary').click();
  await manager.locator('#aiGoal').fill('来自 localhost 的 PDF 按月放到 AI文档');
  await manager.locator('#copyAiPrompt').click();
  const prompt = await manager.locator('#aiPromptOutput').inputValue();
  assert.match(prompt, /来自 localhost/);
  assert.match(prompt, /nivra-rules/);
  assert.ok(!prompt.includes(downloads));
  await manager.locator('.ai-helper>summary').click();
  const beforeInvalid = (await getState()).config;
  const invalidPack = {
    format: 'nivra-rules',
    version: 1,
    rules: [
      { name: '有效', extensions: 'pdf', folder: '有效' },
      { name: '越界', extensions: 'pdf', folder: '../out' },
    ],
  };
  await manager.locator('#importText').fill(JSON.stringify(invalidPack));
  await manager.locator('#previewImport').click();
  await manager.waitForFunction(() =>
    document.querySelector('#importError').textContent.includes('第 2 条'),
  );
  assert.equal(await manager.locator('#applyImport').isDisabled(), true);
  assert.deepEqual((await getState()).config, beforeInvalid);
  checks.push(
    'AI prompt contains only requested configuration context; an invalid pack cannot partially mutate rules',
  );

  const mcp = new Client({ name: 'nivra-browser-e2e', version: '0.2.0' });
  let aiJson;
  try {
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, 'mcp/server.mjs')],
        stderr: 'pipe',
      }),
    );
    const documents = (await getState()).config.rules.find((r) => r.id === 'documents');
    const proposed = makeRulePack([
      documents,
      { name: 'AI 文档', extensions: 'pdf', domain: 'localhost', folder: 'AI文档/{year}-{month}' },
    ]);
    const generated = await mcp.callTool({
      name: 'nivra_create_pack',
      arguments: { rules: proposed.rules },
    });
    assert.equal(generated.isError, undefined);
    aiJson = generated.structuredContent.json;
  } finally {
    await mcp.close();
  }
  await manager.locator('#importFile').setInputFiles({
    name: 'ai-rules.json',
    mimeType: 'application/json',
    buffer: Buffer.from(aiJson),
  });
  await manager.waitForFunction(() =>
    document.querySelector('#importText').value.includes('AI 文档'),
  );
  await manager.locator('#previewImport').click();
  await manager.waitForFunction(() =>
    document.querySelector('#importPreview').textContent.includes('新增 1 条'),
  );
  assert.match(await manager.locator('#importPreview').innerText(), /跳过 1 条/);
  const oldRevision = (await getState()).config.revision;
  await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: true }));
  const staleApply = await manager.evaluate(
    ({ pack, revision }) =>
      chrome.runtime.sendMessage({ type: 'IMPORT_RULES', pack, position: 'first', revision }),
    { pack: aiJson, revision: oldRevision },
  );
  assert.equal(staleApply.ok, false);
  assert.match(staleApply.error, /规则已经变化/);
  await manager.locator('#previewImport').click();
  await manager.waitForFunction(() => !document.querySelector('#applyImport').disabled);
  await manager.locator('#toast').waitFor({ state: 'hidden' });
  await manager.screenshot({ path: path.join(output, 'import-preview.png'), fullPage: true });
  await manager.locator('#applyImport').click();
  await manager.locator('#importDialog').waitFor({ state: 'hidden' });
  await waitForState(
    (s) => s.config.rules.length === DEFAULT_COUNT + 2 && s.config.rules[0].name === 'AI 文档',
    'MCP pack imported',
  );
  const aiDownload = await download('report.pdf');
  assert.ok(aiDownload.filename.includes('/AI文档/'));
  assert.deepEqual(
    await readFile(finalRecord.filename),
    fixtures['after-restart.pdf'][1],
    'older download stays untouched',
  );
  checks.push(
    'A real MCP-generated pack imports through UI, rejects stale previews, and routes a real download correctly',
  );

  await manager.locator('#exportRules').click();
  const withExport = await waitForState(
    (s) => s.records.some((r) => r.filename.endsWith('nivra-rules.json') && r.state === 'complete'),
    'export JSON download',
  );
  const exportRecord = withExport.records.find((r) => r.filename.endsWith('nivra-rules.json'));
  const exported = parseRulePack(await readFile(exportRecord.filename, 'utf8'));
  assert.equal(exported.rules.length, DEFAULT_COUNT + 2);
  assert.ok(!JSON.stringify(exported).includes('installedAt'));
  await manager.locator('#openImport').click();
  await manager.locator('#importText').fill(JSON.stringify(exported));
  await manager.locator('#previewImport').click();
  await manager.waitForFunction(() =>
    document.querySelector('#importPreview').textContent.includes('新增 0 条'),
  );
  assert.equal(await manager.locator('#applyImport').isDisabled(), true);
  await manager.getByRole('button', { name: '关闭规则导入' }).click();
  manager.once('dialog', (dialog) => dialog.accept());
  await manager.locator('#undoRules').click();
  await waitForState(
    (s) => s.config.rules.length === DEFAULT_COUNT + 1 && !s.config.ruleBackup,
    'import transaction undone',
  );
  await manager.locator('#toast').waitFor({ state: 'hidden' });
  await manager.screenshot({ path: path.join(output, 'rules-workbench.png'), fullPage: true });
  checks.push(
    'Rule export round-trips, repeat import is a no-op, and undo restores the complete previous rule set',
  );

  assert.deepEqual(errors, [], 'no uncaught page errors');
  const browserErrors = await diagnostics.read();
  assert.equal(browserErrors.enabled, true);
  assert.deepEqual(browserErrors.runtimeErrors, []);
  assert.deepEqual(browserErrors.manifestErrors, []);
  checks.push('Chrome extension error collection stays empty with the shipping manifest');
  const finalState = await getState();
  const evidence = await Promise.all(
    finalState.records
      .filter((r) => r.state === 'complete')
      .map(async (r) => ({
        id: r.id,
        state: r.state,
        rule: r.decision.ruleName || r.decision.kind,
        path: r.filename,
        bytes: (await stat(r.filename)).size,
        sha256: createHash('sha256')
          .update(await readFile(r.filename))
          .digest('hex'),
      })),
  );
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        browser: context.browser().version(),
        extensionId,
        checks,
        evidence,
        errors,
        browserErrors,
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, 'artifacts', 'latest.json'),
    JSON.stringify({ output, checks: checks.length }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
} catch (error) {
  if (manager && !manager.isClosed())
    await manager
      .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
      .catch(() => {});
  await writeFile(
    path.join(output, 'failure.txt'),
    `${error.stack}\n${JSON.stringify({ errors, checks, browserErrors: await diagnostics?.read().catch(() => null) }, null, 2)}`,
  );
  throw error;
} finally {
  await context?.close().catch(() => {});
  server.close();
  await rm(profile, { recursive: true, force: true });
}
