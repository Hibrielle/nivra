import { defaultConfig } from '../engine.js';
import { defaultRules } from '../file-types.js';

// Existing regression fixtures use Chinese labels and default directory names.
export async function setTestLanguage(worker, locale = 'zh-CN') {
  await worker.evaluate(
    async ({ locale, defaults }) => {
      const saved = await chrome.storage.local.get(['uiLanguage', 'config']);
      if (saved.uiLanguage) return;
      await chrome.storage.local.set({
        uiLanguage: locale,
        config: { ...defaults, ...saved.config, rules: defaults.rules },
      });
    },
    { locale, defaults: { ...defaultConfig(), rules: defaultRules(locale) } },
  );
}

export async function enableExtensionDiagnostics(context, extensionId) {
  const page = await context.newPage();
  await page.goto('chrome://extensions');
  await page.evaluate(async (extensionId) => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    await chrome.developerPrivate.updateExtensionConfiguration({
      extensionId,
      errorCollection: true,
    });
  }, extensionId);
  return {
    page,
    read: () =>
      page.evaluate(async (extensionId) => {
        const info = (
          await chrome.developerPrivate.getExtensionsInfo({
            includeDisabled: true,
            includeTerminated: true,
          })
        ).find((info) => info.id === extensionId);
        return {
          enabled: info.errorCollection.isActive,
          version: info.version,
          runtimeErrors: info.runtimeErrors,
          manifestErrors: info.manifestErrors,
          runtimeWarnings: info.runtimeWarnings,
        };
      }, extensionId),
  };
}
export async function reloadExtension(context, worker, extensionId) {
  const replacement = context.waitForEvent('serviceworker', {
    predicate: (next) =>
      next !== worker && next.url().startsWith(`chrome-extension://${extensionId}/`),
    timeout: 15000,
  });
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  const ready = await replacement;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      await ready.evaluate(
        () =>
          chrome.downloads.onCreated.hasListeners() &&
          chrome.downloads.onDeterminingFilename.hasListeners(),
      )
    )
      return ready;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Extension reloaded but its download listeners did not become ready');
}
