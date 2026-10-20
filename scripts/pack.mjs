import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RULE_PACK_SCHEMA } from '../rules.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const dist = path.join(root, 'dist');
const unpacked = path.join(dist, 'unpacked');
await mkdir(dist, { recursive: true });
await rm(unpacked, { recursive: true, force: true });
await mkdir(unpacked);
const files = [
  'manifest.json',
  'LICENSE',
  '_locales',
  'boot.js',
  'i18n.js',
  'i18n-messages.js',
  'background.js',
  'report-core.js',
  'report-service.js',
  'report-store.js',
  'report-ui.js',
  'report.html',
  'report.css',
  'download-surface.js',
  'task-view.js',
  'task-menu.js',
  'onboarding.js',
  'download-state.js',
  'task-list.js',
  'manager-layout.css',
  'tasks.js',
  'capture.js',
  'sync.js',
  'expressions.js',
  'evaluation-core.js',
  'evaluation-worker.js',
  'evaluator.js',
  'worker-pool.js',
  'offscreen.html',
  'offscreen.js',
  'vendor',
  'download-ui.js',
  'download-info.js',
  'downloader.js',
  'downloader-service.js',
  'downloader-ui.js',
  'features.js',
  'engine.js',
  'file-types.js',
  'rules.js',
  'rule-workbench.js',
  'manager.html',
  'manager.js',
  'popup.html',
  'popup.js',
  'ui.js',
  'style.css',
  'tokens.css',
  'icons',
  'examples',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'PARITY.md',
  'privacy.html',
];
for (const file of files)
  await cp(path.join(root, file), path.join(unpacked, file), { recursive: true });
await writeFile(
  path.join(unpacked, 'rule-pack.schema.json'),
  JSON.stringify(RULE_PACK_SCHEMA, null, 2),
);
const archive = path.join(dist, `nivra-${manifest.version}.zip`);
await rm(archive, { force: true });
await run('zip', ['-q', '-r', archive, '.'], { cwd: unpacked });
const checksum = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
await writeFile(path.join(dist, 'SHA256SUMS.txt'), `${checksum}  ${path.basename(archive)}\n`);
console.log(`Load unpacked: ${unpacked}\nZIP: ${archive}\nSHA-256: ${checksum}`);
