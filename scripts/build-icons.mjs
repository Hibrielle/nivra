import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'icons/brand.svg'), 'utf8');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE,
  channel: process.env.CHROME_EXECUTABLE ? undefined : 'chromium',
});
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    const artwork =
      size === 128 ? svg.replace('viewBox="0 0 128 128"', 'viewBox="-16 -16 160 160"') : svg;
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${artwork}`,
    );
    await page.screenshot({ path: path.join(root, `icons/icon${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
