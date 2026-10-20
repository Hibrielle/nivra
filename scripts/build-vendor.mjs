import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'vendor'), { recursive: true });
const entries = {
  date: 'export { default } from "moment";',
  parser: 'export { default } from "jsep";',
  archive: 'export { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";',
};
for (const [name, contents] of Object.entries(entries))
  await build({
    stdin: { contents, resolveDir: root, sourcefile: `${name}.js` },
    outfile: path.join(root, `vendor/${name}.js`),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'inline',
  });
let licenses = '# Bundled dependencies\n\n';
for (const [name, file] of [
  ['moment', 'LICENSE'],
  ['jsep', 'LICENSE'],
  ['fflate', 'LICENSE'],
])
  licenses += `## ${name}\n\n${await readFile(path.join(root, 'node_modules', name, file), 'utf8')}\n\n`;
await writeFile(path.join(root, 'vendor/LICENSES.md'), licenses.trimEnd() + '\n');
console.log('Built local date, expression parser and archive modules.');
