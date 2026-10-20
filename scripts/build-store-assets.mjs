import { chromium } from 'playwright';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { output } = JSON.parse(
  await readFile(path.join(root, 'artifacts/latest-i18n.json'), 'utf8'),
);
const assets = path.join(root, 'store/assets');
await mkdir(assets, { recursive: true });
for (const locale of ['en', 'zh-CN']) {
  const directory = path.join(assets, locale);
  await mkdir(directory, { recursive: true });
  for (const [index, name] of ['manager', 'setup', 'report'].entries()) {
    await copyFile(
      path.join(output, `${locale}-${name}.png`),
      path.join(directory, `${index + 1}-${name}.png`),
    );
  }
}
await copyFile(path.join(root, 'icons/icon128.png'), path.join(assets, 'icon128.png'));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE,
  channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
});
try {
  const page = await browser.newPage({
    viewport: { width: 440, height: 280 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(path.join(root, 'store/promo.html')).href);
  await page.screenshot({ path: path.join(assets, 'promo-440x280.png') });
} finally {
  await browser.close();
}
console.log(assets);
