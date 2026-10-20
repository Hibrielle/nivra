import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDownloader,
  validateTorrent,
  decodeTorrent,
  bytesToBase64,
  MAX_TORRENT_BYTES,
  testDownloader,
} from '../downloader.js';
import { taskMenuGroups } from '../download-info.js';
import { torrentFixture } from './torrent-fixture.mjs';

test('downloader endpoints exclude embedded credentials, query tokens and unsupported protocols', () => {
  const base = {
    type: 'qbittorrent',
    url: 'https://nas.example/qbt/',
    username: ' alice ',
    secret: ' space ',
  };
  assert.deepEqual(normalizeDownloader(base), {
    ...base,
    url: 'https://nas.example/qbt',
    username: 'alice',
  });
  for (const url of [
    'file:///tmp/a',
    'javascript:alert(1)',
    'https://user:secret@host',
    'https://host?token=secret',
    'https://host/#secret',
    'not-an-address',
  ])
    assert.throws(() => normalizeDownloader({ ...base, url }));
  assert.throws(() => normalizeDownloader({ ...base, type: 'custom-script' }));
  assert.throws(() => normalizeDownloader({ ...base, username: 'a:b' }));
});

test('binary torrent metadata survives transport and malformed, oversized or deeply nested files are rejected', () => {
  const { bytes } = torrentFixture('种子文件.txt');
  assert.deepEqual(Buffer.from(decodeTorrent(bytesToBase64(bytes))), bytes);
  for (const data of [
    Buffer.from('<html>login</html>'),
    Buffer.from('d4:info3:fooe'),
    bytes.subarray(0, bytes.length - 1),
    Buffer.concat([bytes, Buffer.from('x')]),
    Buffer.from('d4:info' + 'l'.repeat(60) + 'e'.repeat(60) + 'e'),
    new Uint8Array(MAX_TORRENT_BYTES + 1),
  ])
    assert.throws(() => validateTorrent(data));
  assert.throws(() => decodeTorrent('%%%'));
});

test('only completed torrent tasks expose the configured handoff action; absent files remain disabled', () => {
  const actions = (item, config) =>
    taskMenuGroups(item, config)
      .flat()
      .find((a) => a.key === 'send-torrent');
  assert.equal(actions({ filename: 'a.pdf', state: 'complete' }), undefined);
  assert.equal(actions({ filename: 'a.torrent', state: 'in_progress' }), undefined);
  assert.equal(actions({ filename: 'a.TORRENT', state: 'complete' }).label, '绑定下载器…');
  assert.equal(
    actions(
      { filename: 'a', mime: 'application/x-bittorrent', state: 'complete' },
      { name: 'Transmission' },
    ).label,
    '发送到 Transmission',
  );
  assert.equal(actions({ filename: 'a.torrent', state: 'complete', exists: false }).disabled, true);
});

test('qBittorrent HTTP 200 with Fails is an authentication failure, never a successful connection', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('Fails.', { status: 200 });
  try {
    await assert.rejects(
      testDownloader({
        type: 'qbittorrent',
        url: 'http://localhost:8080',
        username: 'u',
        secret: 'bad',
      }),
      /登录失败/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
