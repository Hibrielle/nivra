import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
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
  'usability-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
const downloads = path.join(output, 'downloads');
const profile = await mkdtemp(path.join(tmpdir(), 'nivra-usability-'));
await mkdir(downloads, { recursive: true });
await mkdir(path.join(profile, 'Default'), { recursive: true });
await writeFile(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xZsAAAAASUVORK5CYII=',
  'base64',
);
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': png.length,
    'Content-Disposition': `attachment; filename="${name}"`,
  });
  res.end(png);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://localhost:${server.address().port}`;
const errors = [],
  checks = [];
let context, manager, popup, diagnostics, extensionId;
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out: ' + label);
}
async function call(type, payload = {}) {
  const response = await manager.evaluate((message) => chrome.runtime.sendMessage(message), {
    type,
    ...payload,
  });
  assert.equal(response?.ok, true, response?.error);
  return response;
}
async function completed(id) {
  return until(
    async () =>
      (await call('GET_STATE')).records.find((r) => r.id === id && r.state === 'complete'),
    'completed download ' + id,
  );
}
async function openMenu(page, id) {
  if (await page.locator('#taskMenu').isVisible()) await page.keyboard.press('Escape');
  await page.locator(`[data-more="${id}"]`).click();
  await page.locator('#taskMenu').waitFor({ state: 'visible' });
}
const menuContents = (page) =>
  page.locator('#taskMenu button').evaluateAll((buttons) =>
    buttons.map((b) => ({
      action: b.dataset.menuAction,
      label: b.textContent.trim(),
      disabled: b.disabled,
    })),
  );
async function installOpenProbe(page) {
  await page.evaluate(() => {
    const request = chrome.permissions.request.bind(chrome.permissions);
    const open = chrome.downloads.open;
    window.openProbe = { allowed: true, error: '', requests: [], calls: [] };
    chrome.permissions.request = async (permissions) => {
      if (!permissions.permissions?.includes('downloads.open')) return request(permissions);
      window.openProbe.requests.push(permissions);
      return window.openProbe.allowed;
    };
    chrome.downloads.open = async (id) => {
      window.openProbe.calls.push({ id, active: navigator.userActivation.isActive });
      if (window.openProbe.error) throw new Error(window.openProbe.error);
    };
    window.restoreOpenProbe = () => {
      chrome.permissions.request = request;
      chrome.downloads.open = open;
    };
  });
}
async function expectOpen(page, operation) {
  const before = await page.evaluate(() => window.openProbe.calls.length);
  await operation();
  await until(
    async () => (await page.evaluate(() => window.openProbe.calls.length)) === before + 1,
    'one native-open API call',
  );
}
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_EXECUTABLE,
    channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
  await manager.goto(`chrome-extension://${extensionId}/manager.html`);
  await manager.locator('#setupBanner').waitFor({ state: 'visible' });
  await call('SET_SETTINGS', { settings: { autoOpenPanel: false } });
  const initialRules = (await call('GET_STATE')).config.rules;
  popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 580 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#popupSetup').click();
  await manager.locator('#setupDialog').waitFor({ state: 'visible' });
  assert.match(await manager.locator('#setupProgress').textContent(), /1 \/ 3/);
  await manager.locator('#setupRoot').fill('../outside');
  await manager.locator('#setupNext').click();
  assert.ok(await manager.locator('#setupError').textContent());
  assert.equal((await call('GET_STATE')).config.archiveRoot, '');
  await manager.locator('#setupRoot').fill('资料/下载');
  const settingsOpened = context.waitForEvent('page');
  await manager.locator('#setupChooseRoot').click();
  const settingsPage = await settingsOpened;
  await settingsPage.waitForURL('chrome://settings/downloads');
  await settingsPage.close();
  await manager.bringToFront();
  assert.equal(await manager.locator('#setupRoot').inputValue(), '资料/下载');
  await manager.screenshot({
    path: path.join(output, 'setup-location.png'),
    animations: 'disabled',
  });
  checks.push(
    'First-use entry works from the popup; invalid roots do not write settings and the real Chrome root-settings link preserves the draft',
  );

  await manager.locator('#setupNext').click();
  const themePopup = await context.newPage();
  await themePopup.goto(`chrome-extension://${extensionId}/popup.html`);
  for (const theme of ['light', 'dark']) {
    if ((await manager.locator('html').getAttribute('data-theme')) !== theme) {
      await themePopup.locator('#popupThemeToggle').click();
      await until(
        async () => (await manager.locator('html').getAttribute('data-theme')) === theme,
        'guide theme sync',
      );
    }
    for (const width of [1440, 360]) {
      await manager.setViewportSize({ width, height: 1000 });
      const options = await manager.locator('.setup-option').evaluateAll((labels) =>
        labels.map((label) => ({
          card: label.getBoundingClientRect().toJSON(),
          radio: label.querySelector('input').getBoundingClientRect().toJSON(),
          text: label.querySelector('span').getBoundingClientRect().toJSON(),
        })),
      );
      for (const { card, radio, text } of options) {
        assert.ok(radio.width <= 24 && radio.height <= 24, 'Choice control must stay compact');
        assert.ok(text.x - radio.right >= 0 && text.x - radio.right <= 20);
        assert.ok(text.width >= card.width * 0.6, 'Choice text must have room to wrap');
        assert.ok(Math.abs(text.y - radio.y) <= 8);
        assert.ok(card.x >= 0 && card.right <= width);
      }
      await manager.locator('.setup-option').click();
      const byType = manager.locator('#setupByType');
      assert.equal(await byType.isChecked(), false);
      assert.equal(await manager.locator('#setupOrderField').isVisible(), false);
      await byType.focus();
      await manager.keyboard.press('Space');
      assert.equal(await byType.isChecked(), true);
      await manager.locator('[name="setupDate"][value="day"]').check();
      await manager.keyboard.press('ArrowLeft');
      assert.equal(await manager.locator('[name="setupDate"][value="month"]').isChecked(), true);
      assert.equal(await manager.locator('[name="setupDate"]:checked').count(), 1);
      for (const radio of await manager.locator('#setupDateGroup input:visible').all()) {
        const box = await radio.boundingBox();
        assert.ok(box.width <= 24 && box.height <= 24);
      }
      await manager.locator('[name="setupDate"][value="month"]').click();
      await until(
        async () =>
          /文档\/\d{4}-\d{2}\/nivra-test.txt$/.test(
            await manager.locator('#setupExampleTree').getAttribute('data-path'),
          ),
        'type and month example',
      );
      await manager.locator('#setupDialog').screenshot({
        path: path.join(output, `setup-options-${theme}-${width}.png`),
        animations: 'disabled',
      });
    }
  }
  await themePopup.locator('#popupThemeToggle').click();
  await until(
    async () => (await manager.locator('html').getAttribute('data-theme')) === 'light',
    'restore light theme',
  );
  await themePopup.close();
  await manager.setViewportSize({ width: 1440, height: 1000 });
  checks.push(
    'Independent type and exclusive time controls stay compact in both themes and narrow windows; whole-card clicks, Space and arrow keys work',
  );
  await manager.locator('#setupByType').check();
  await manager.locator('#setupNext').click();
  await until(async () => !(await manager.locator('#setupTest').isDisabled()), 'setup preview');
  const preview = await manager.locator('#setupPreview').innerText();
  assert.match(preview, /资料\/下载\/文档\/\d{4}-\d{2}\/nivra-test.txt/);
  await manager.screenshot({
    path: path.join(output, 'setup-preview.png'),
    animations: 'disabled',
  });
  await manager.locator('#setupTest').click();
  await manager.locator('#setupDialog').waitFor({ state: 'hidden' });
  const testFile = await until(
    async () =>
      (await call('GET_STATE')).records.find(
        (r) => r.filename.endsWith('nivra-test.txt') && r.state === 'complete',
      ),
    'onboarding test file',
  );
  assert.match(testFile.filename, /\/资料\/下载\/文档\/\d{4}-\d{2}\/nivra-test.txt$/);
  assert.deepEqual(
    await readFile(testFile.filename),
    await readFile(path.join(root, 'examples/nivra-test.txt')),
  );
  const configured = (await call('GET_STATE')).config;
  assert.equal(configured.onboardingDismissed, true);
  assert.deepEqual(configured.rules, initialRules);
  assert.equal(configured.autoOpenPanel, false);
  await manager.reload();
  await manager.locator('#pauseAll').waitFor();
  assert.equal(await manager.locator('#setupBanner').isVisible(), false);
  checks.push(
    'The guide preview matches a real local test download, preserves rules/preferences, and stays dismissed after reload',
  );

  await manager.goto(`chrome-extension://${extensionId}/manager.html#settings`);
  await manager.locator('#featureView [data-open-setup]').click();
  await manager.locator('#setupNext').click();
  await manager.locator('#setupByType').uncheck();
  await manager.locator('[name="setupDate"][value="none"]').check();
  assert.equal(await manager.locator('#setupDateGroup').isVisible(), true);
  assert.equal(await manager.locator('#setupOrderField').isVisible(), false);
  await until(
    async () =>
      (await manager.locator('#setupExampleTree').getAttribute('data-path')) ===
      'Chrome 下载文件夹/nivra-test.txt',
    'unclassified folder example',
  );
  await manager.locator('#setupNext').click();
  await until(async () => !(await manager.locator('#setupSave').isDisabled()), 'keep-mode preview');
  assert.match(
    await manager.locator('#setupPreview').innerText(),
    /Chrome 下载文件夹 \/ nivra-test.txt/,
  );
  await manager.locator('#setupSave').click();
  await manager.locator('#setupDialog').waitFor({ state: 'hidden' });
  const plainId = await manager.evaluate(
    (url) => chrome.downloads.download({ url }),
    base + '/plain.png',
  );
  assert.equal((await completed(plainId)).filename, path.join(downloads, 'plain.png'));
  assert.deepEqual((await call('GET_STATE')).config.rules, initialRules);
  await call('SET_ENABLED', { enabled: true });
  checks.push(
    'The guide can be reopened; keeping the default location disables classification without deleting rules or changing existing files',
  );

  await call('SAVE_RULE', {
    rule: { ...initialRules.find((rule) => rule.id === 'installers'), folder: '工具/{year}' },
  });
  await call('SAVE_RULE', {
    rule: {
      id: 'custom-month',
      name: '手工分类',
      extensions: 'pdf',
      keyword: 'manual-only',
      folder: '手工/{year}-{month}',
      enabled: true,
    },
  });
  const beforeLayoutChoice = (await call('GET_STATE')).config.rules;
  async function openLayoutStep() {
    await manager.goto(`chrome-extension://${extensionId}/manager.html#settings`);
    await manager.locator('#featureView [data-open-setup]').click();
    await manager.locator('#setupNext').click();
  }
  await openLayoutStep();
  await manager.emulateMedia({ reducedMotion: 'no-preference' });
  await manager.evaluate(() => {
    const tree = document.querySelector('#setupExampleTree');
    window.exampleMotion = [];
    const observer = new MutationObserver(() => {
      window.exampleMotion = tree
        .getAnimations()
        .map((animation) => animation.effect.getTiming().duration);
      observer.disconnect();
    });
    observer.observe(tree, { attributes: true, attributeFilter: ['data-path'] });
  });
  await manager.locator('[name="setupDate"][value="none"]').check();
  await until(
    async () =>
      (await manager.locator('#setupExampleTree').getAttribute('data-path')) ===
      'Chrome 下载文件夹/资料/下载/文档/nivra-test.txt',
    'type-only live example',
  );
  assert.deepEqual(await manager.evaluate(() => window.exampleMotion), [160]);
  await manager.locator('#setupNext').click();
  await until(async () => !(await manager.locator('#setupSave').isDisabled()), 'type-only preview');
  assert.match(
    await manager.locator('#setupPreview').innerText(),
    /资料\/下载\/文档\/nivra-test.txt/,
  );
  await manager.locator('#closeSetup').click();
  assert.deepEqual((await call('GET_STATE')).config.rules, beforeLayoutChoice);

  const today = await manager.evaluate(() => {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
  });
  const month = today.slice(0, 7);
  let previous = { byType: true, date: 'month' };
  for (const [byType, date, order, folder] of [
    [true, 'none', 'type-first', '文档'],
    [false, 'month', 'type-first', month],
    [false, 'day', 'type-first', today],
    [true, 'month', 'type-first', `文档/${month}`],
    [true, 'day', 'type-first', `文档/${today}`],
    [true, 'month', 'date-first', `${month}/文档`],
    [true, 'day', 'date-first', `${today}/文档`],
  ]) {
    await openLayoutStep();
    assert.equal(await manager.locator('#setupByType').isChecked(), previous.byType);
    assert.equal(
      await manager.locator(`[name="setupDate"][value="${previous.date}"]`).isChecked(),
      true,
    );
    await manager.emulateMedia({ reducedMotion: date === 'day' ? 'reduce' : 'no-preference' });
    await manager.locator('#setupByType').setChecked(byType);
    await manager.locator(`[name="setupDate"][value="${date}"]`).check();
    assert.equal(await manager.locator('[name="setupDate"]:checked').count(), 1);
    if (byType && date !== 'none') await manager.locator('#setupOrder').selectOption(order);
    else assert.equal(await manager.locator('#setupOrderField').isVisible(), false);
    await until(
      async () =>
        (await manager.locator('#setupExampleTree').getAttribute('data-path')) ===
        `Chrome 下载文件夹/资料/下载/${folder}/nivra-test.txt`,
      'combined live example ' + folder,
    );
    if (date === 'day')
      assert.equal(
        await manager
          .locator('#setupExampleTree')
          .evaluate((element) => element.getAnimations().length),
        0,
      );
    await manager.locator('#setupDialog').screenshot({
      path: path.join(output, `setup-layout-${byType ? 'type' : 'no-type'}-${date}-${order}.png`),
      animations: 'disabled',
    });
    await manager.locator('#setupNext').click();
    await until(async () => !(await manager.locator('#setupTest').isDisabled()), 'layout preview');
    assert.ok(
      (await manager.locator('#setupPreview').innerText()).includes(
        `资料/下载/${folder}/nivra-test.txt`,
      ),
    );
    const lastId = Math.max(...(await call('GET_STATE')).records.map((record) => record.id));
    await manager.locator('#setupTest').click();
    await manager.locator('#setupDialog').waitFor({ state: 'hidden' });
    const file = await until(
      async () =>
        (await call('GET_STATE')).records.find(
          (record) => record.id > lastId && record.state === 'complete',
        ),
      'combined layout file ' + folder,
    );
    assert.equal(path.dirname(file.filename), path.join(downloads, '资料/下载', folder));
    assert.deepEqual(await readFile(file.filename), await readFile(testFile.filename));
    const rules = (await call('GET_STATE')).config.rules;
    for (const id of ['installers', 'custom-month'])
      assert.deepEqual(
        rules.find((rule) => rule.id === id),
        beforeLayoutChoice.find((rule) => rule.id === id),
      );
    previous = { byType, date };
  }
  await openLayoutStep();
  await manager.locator('#setupByType').check();
  await manager.locator('[name="setupDate"][value="month"]').check();
  await manager.locator('#setupOrder').selectOption('type-first');
  await manager.locator('#setupNext').click();
  await until(
    async () => !(await manager.locator('#setupSave').isDisabled()),
    'restore default layout',
  );
  await manager.locator('#setupSave').click();
  await manager.locator('#setupDialog').waitFor({ state: 'hidden' });
  assert.deepEqual((await call('GET_STATE')).config.rules, beforeLayoutChoice);
  await call('SAVE_RULE', {
    rule: {
      ...initialRules.find((rule) => rule.id === 'images'),
      folder: '图片/{year}-{month}-{day}',
    },
  });
  await openLayoutStep();
  assert.equal(await manager.locator('[name="setupDate"][value="keep"]').isChecked(), true);
  await manager.locator('#setupByType').uncheck();
  await manager.locator('#setupNext').click();
  await until(async () => !(await manager.locator('#setupSave').isDisabled()), 'mixed date layout');
  await manager.locator('#setupSave').click();
  await manager.locator('#setupDialog').waitFor({ state: 'hidden' });
  const mixed = (await call('GET_STATE')).config.rules;
  assert.equal(mixed.find((rule) => rule.id === 'documents').folder, '{year}-{month}');
  assert.equal(mixed.find((rule) => rule.id === 'images').folder, '{year}-{month}-{day}');
  await call('SET_SETTINGS', {
    settings: { defaultFolderLayout: { byType: true, date: 'month', order: 'type-first' } },
  });
  await manager.emulateMedia({ reducedMotion: 'no-preference' });
  checks.push(
    'Type, month, day and both folder orders match real downloads; time choices are exclusive, saved choices reopen correctly, canceled edits and custom paths survive, mixed dates stay independent and reduced motion disables the example animation',
  );

  await manager.goto(`chrome-extension://${extensionId}/manager.html#rules`);
  await manager.locator('#addRule').click();
  await manager.locator('#ruleFileType').selectOption('image');
  assert.equal(await manager.locator('#ruleForm [name="name"]').inputValue(), '图片');
  assert.equal(await manager.locator('#ruleAdvancedMatch').getAttribute('open'), null);
  assert.equal(await manager.locator('#ruleAdvancedSave').getAttribute('open'), null);
  await manager.locator('#ruleForm [name="extensions"]').fill('png');
  await manager.locator('#ruleForm [name="name"]').fill('项目图片');
  await manager.locator('#ruleForm [name="folder"]').fill('项目图片');
  await manager.locator('#ruleByMonth').check();
  await until(
    async () =>
      /资料\/下载\/项目图片\/\d{4}-\d{2}\/example.png/.test(
        await manager.locator('#rulePreview').textContent(),
      ),
    'simple rule preview',
  );
  await manager.screenshot({
    path: path.join(output, 'rule-simple-light.png'),
    animations: 'disabled',
  });
  await manager.locator('#saveRule').click();
  await manager.locator('#ruleDialog').waitFor({ state: 'hidden' });
  const url = base + '/project.png?ticket=full-link';
  const imageId = await manager.evaluate((url) => chrome.downloads.download({ url }), url);
  const image = await completed(imageId);
  assert.match(image.filename, /\/资料\/下载\/项目图片\/\d{4}-\d{2}\/project.png$/);
  assert.deepEqual(await readFile(image.filename), png);
  checks.push(
    'Simple type/folder/month controls produce a preview that matches real downloaded bytes and the final archive path',
  );

  const advancedRule = {
    name: '高级 PDF',
    enabled: true,
    extensions: 'pdf',
    regex: '^report',
    domain: 'example.com',
    filenameTemplate: '{name}.{ext}',
    pathTemplate: '高级/{filename}',
    postAction: 'reveal',
  };
  await call('SAVE_RULE', { rule: advancedRule });
  const advanced = (await call('GET_STATE')).config.rules.find((r) => r.name === advancedRule.name);
  await manager.locator(`[data-edit="${advanced.id}"]`).click();
  for (const section of ['ruleScope', 'ruleAdvancedMatch', 'ruleAdvancedSave'])
    assert.equal(await manager.locator('#' + section).evaluate((el) => el.open), true);
  await manager.locator('#saveRule').click();
  await manager.locator('#ruleDialog').waitFor({ state: 'hidden' });
  assert.deepEqual(
    (await call('GET_STATE')).config.rules.find((r) => r.id === advanced.id),
    advanced,
  );
  await manager.locator('#themeToggle').click();
  await manager.setViewportSize({ width: 700, height: 850 });
  const simple = (await call('GET_STATE')).config.rules.find((r) => r.name === '项目图片');
  await manager.locator(`[data-edit="${simple.id}"]`).click();
  await manager.screenshot({
    path: path.join(output, 'rule-simple-dark-narrow.png'),
    animations: 'disabled',
  });
  const bounds = await manager.locator('#ruleDialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 701);
  await manager.locator('[data-close="ruleDialog"]').first().click();
  await manager.setViewportSize({ width: 1440, height: 1000 });
  await manager.locator('#themeToggle').click();
  checks.push(
    'Existing advanced conditions open visibly and survive a save unchanged; the simple editor fits dark mode and a narrow viewport',
  );

  await manager.goto(`chrome-extension://${extensionId}/manager.html#all`);
  popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 580 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await openMenu(popup, imageId);
  const popupMenu = await menuContents(popup);
  await manager.bringToFront();
  await openMenu(manager, imageId);
  assert.deepEqual(await menuContents(manager), popupMenu);
  assert.ok(popupMenu.some((item) => item.action === 'show'));
  assert.ok(popupMenu.some((item) => item.action === 'open'));
  assert.equal(
    popupMenu.some((item) => item.action === 'preview'),
    false,
  );
  await manager.locator('[data-menu-action="copy-url"]').click();
  await until(
    async () => (await manager.evaluate(() => navigator.clipboard.readText())) === url,
    'manager copies full link',
  );
  await openMenu(manager, imageId);
  await manager.keyboard.press('Escape');
  assert.equal(await manager.evaluate(() => document.activeElement?.dataset.more), String(imageId));
  // Intercept the OS handoff; exercise real UI clicks without launching desktop apps.
  await installOpenProbe(manager);
  await installOpenProbe(popup);
  await expectOpen(popup, async () => {
    await openMenu(popup, imageId);
    await popup.locator('[data-menu-action="open"]').click();
  });
  await expectOpen(manager, async () => {
    await openMenu(manager, imageId);
    await manager.locator('[data-menu-action="open"]').click();
  });
  const row = manager.locator(`[data-task-row="${imageId}"]`);
  await row.locator('.file-name').click();
  const openButton = manager.locator('.inspector-actions [data-task-action="open"]');
  await expectOpen(manager, () => openButton.click());
  await expectOpen(manager, () => row.locator('.file-name').dblclick());
  await expectOpen(manager, () => row.press('Enter'));
  await expectOpen(manager, () => openButton.press('Enter'));
  let openedCount = await manager.evaluate(() => window.openProbe.calls.length);
  const reportOpened = context.waitForEvent('page');
  await manager.locator('.inspector-actions a[href*="report.html"]').press('Enter');
  const reportPage = await reportOpened;
  await reportPage.waitForURL(/\/report.html/);
  await reportPage.close();
  assert.equal(await manager.evaluate(() => window.openProbe.calls.length), openedCount);
  await manager.evaluate(() => (window.openProbe.allowed = false));
  await openButton.click();
  await until(
    async () => (await manager.locator('#toast').textContent()).includes('未获得打开文件的权限'),
    'permission refusal feedback',
  );
  assert.equal(await manager.evaluate(() => window.openProbe.calls.length), openedCount);
  await manager.evaluate(() => {
    window.openProbe.allowed = true;
    window.openProbe.error = '系统未能打开文件';
  });
  await expectOpen(manager, () => openButton.click());
  await until(
    async () => (await manager.locator('#toast').textContent()).includes('系统未能打开文件'),
    'native-open failure feedback',
  );
  await manager.evaluate(() => (window.openProbe.error = ''));
  for (const page of [manager, popup]) {
    const proof = await page.evaluate(() => window.openProbe);
    assert.ok(proof.requests.every((request) => request.permissions.join() === 'downloads.open'));
    assert.ok(proof.calls.every((call) => call.id === imageId && call.active));
  }
  checks.push(
    'Popup/menu/detail/double-click/Enter all request permission and call downloads.open once; refusal and errors give feedback, while Enter on a report link does not open a file. OS API calls are intercepted; desktop apps are not launched',
  );
  await openMenu(manager, imageId);
  await manager.screenshot({ path: path.join(output, 'manager-menu.png'), animations: 'disabled' });
  await manager.locator('[data-menu-action="delete"]').click();
  const managerConfirmation = await manager.locator('#deleteFileDialog').innerText();
  assert.equal(await manager.locator('#deleteFilePath').textContent(), image.filename);
  await manager.locator('#cancelDeleteFile').click();
  await access(image.filename);
  await popup.bringToFront();
  await openMenu(popup, imageId);
  await popup.locator('[data-menu-action="delete"]').click();
  assert.equal(await popup.locator('#deleteFileDialog').innerText(), managerConfirmation);
  await popup.locator('#cancelDeleteFile').click();
  await access(image.filename);
  await manager.bringToFront();
  await openMenu(manager, imageId);
  await manager.locator('[data-menu-action="delete"]').click();
  await manager.locator('#confirmDeleteFile').click();
  await manager.locator('#deleteFileDialog').waitFor({ state: 'hidden' });
  await assert.rejects(access(image.filename));
  await until(
    async () => (await call('GET_STATE')).records.find((r) => r.id === imageId)?.exists === false,
    'missing file state',
  );
  await until(async () => await openButton.isDisabled(), 'missing file open disabled');
  openedCount = await manager.evaluate(() => window.openProbe.calls.length);
  await row.locator('.file-name').dblclick();
  await row.press('Enter');
  assert.equal(await manager.evaluate(() => window.openProbe.calls.length), openedCount);
  await openMenu(manager, imageId);
  assert.equal(await manager.locator('[data-menu-action="open"]').isDisabled(), true);
  await manager.keyboard.press('Escape');
  for (const page of [manager, popup]) await page.evaluate(() => window.restoreOpenProbe());
  checks.push(
    'Popup and manager menus have identical commands/states, full-link copying, keyboard focus and the same cancel-safe file deletion dialog',
  );

  const browser = await diagnostics.read();
  assert.deepEqual(errors, []);
  assert.deepEqual(browser.runtimeErrors, []);
  assert.deepEqual(browser.manifestErrors, []);
  const report = { passed: checks.length, checks, browser, output };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(
    path.join(root, 'artifacts/latest-usability.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      { error: error.stack, checks, errors, browser: await diagnostics?.read().catch(() => null) },
      null,
      2,
    ),
  );
  await manager
    ?.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' })
    .catch(() => {});
  throw error;
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
