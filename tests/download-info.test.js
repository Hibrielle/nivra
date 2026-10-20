import test from 'node:test';
import assert from 'node:assert/strict';
import { copyDownloadValue, localFileUrl } from '../download-info.js';

test('local file URLs preserve POSIX, Windows drive and network paths while escaping filename characters', () => {
  assert.equal(
    localFileUrl('/Downloads/报告 #1%.pdf'),
    'file:///Downloads/%E6%8A%A5%E5%91%8A%20%231%25.pdf',
  );
  assert.equal(
    localFileUrl('C:\\Users\\Nivra\\my file.pdf'),
    'file:///C:/Users/Nivra/my%20file.pdf',
  );
  assert.equal(
    localFileUrl('D:/Downloads/下载.torrent'),
    'file:///D:/Downloads/%E4%B8%8B%E8%BD%BD.torrent',
  );
  assert.equal(localFileUrl('\\\\nas\\share\\a #b.zip'), 'file://nas/share/a%20%23b.zip');
});

test('copying uses the original full URL, and missing history never overwrites the clipboard with empty text', async () => {
  const oldChrome = globalThis.chrome;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const writes = [];
  let item = {
    url: 'https://example.com/download?ticket=test%2Btoken&file=a.tgz',
    finalUrl: 'https://cdn.example.com/a.tgz',
    filename: '/Downloads/a.tgz',
    state: 'complete',
  };
  globalThis.chrome = { downloads: { search: async () => (item ? [item] : []) } };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (value) => writes.push(value) } },
  });
  try {
    await copyDownloadValue(1, 'url');
    assert.deepEqual(writes, [item.url]);
    await copyDownloadValue(1, 'path');
    assert.equal(writes.at(-1), '/Downloads/a.tgz');
    item = undefined;
    await assert.rejects(copyDownloadValue(1, 'url'), /已清除/);
    assert.equal(writes.length, 2);
    item = { url: '', filename: '', state: 'in_progress' };
    for (const field of ['url', 'name', 'path'])
      await assert.rejects(copyDownloadValue(1, field), /没有可复制/);
    assert.equal(writes.length, 2);
  } finally {
    if (oldChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = oldChrome;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else delete globalThis.navigator;
  }
});
