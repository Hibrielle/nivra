import { t } from './i18n.js';
import { basename } from './engine.js';
import { localFileUrl } from './download-info.js';
import {
  normalizeDownloader,
  DOWNLOADERS,
  isTorrent,
  decodeTorrent,
  validateTorrent,
  MAX_TORRENT_BYTES,
  testDownloader,
  submitTorrent,
} from './downloader.js';
const CONFIG_KEY = 'externalDownloader';
const RECEIPTS_KEY = 'torrentSubmissions';
const ORIGIN_RULE = 7101;
const LOGIN_RULE = 7102;
let serial = Promise.resolve();
const sending = new Set();
export function downloaderSummary(config) {
  if (!config || !Object.hasOwn(DOWNLOADERS, config.type)) return null;
  return {
    bindingId: config.bindingId,
    type: config.type,
    name: DOWNLOADERS[config.type].name,
    url: config.url,
    username: config.username,
    hasSecret: Boolean(config.secret),
  };
}
async function savedConfig() {
  return (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
}
async function draftConfig(draft) {
  const saved = await savedConfig();
  const value = normalizeDownloader(draft);
  if (
    draft.secret === undefined &&
    saved &&
    value.type === saved.type &&
    value.url === saved.url &&
    value.username === saved.username
  )
    value.secret = saved.secret;
  return value;
}

// Only our requests to the explicitly configured qBittorrent API get its Origin.
// Keep the server's CSRF protection enabled; no site traffic or credentials are rewritten.
async function withClient(config, operation) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ORIGIN_RULE, LOGIN_RULE],
  });
  if (config.type === 'qbittorrent') {
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: ORIGIN_RULE,
          priority: 1,
          condition: {
            regexFilter: '^' + escape(config.url + '/api/v2/') + '[a-zA-Z/]+(?:\\?|$)',
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ['xmlhttprequest'],
          },
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: new URL(config.url).origin },
              { header: 'Referer', operation: 'set', value: config.url + '/' },
            ],
          },
        },
        {
          id: LOGIN_RULE,
          priority: 2,
          condition: {
            regexFilter: '^' + escape(config.url + '/api/v2/auth/login') + '(?:\\?|$)',
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ['xmlhttprequest'],
          },
          // qBittorrent skips password validation when an existing SID is sent.
          // Omit only the outgoing login cookie, while accepting the new SID.
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Cookie', operation: 'remove' }],
          },
        },
      ],
    });
  }
  try {
    return await operation();
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ORIGIN_RULE, LOGIN_RULE],
    });
  }
}
async function readLocalTorrent(item) {
  const access = await chrome.extension.isAllowedFileSchemeAccess();
  if (!access || !(await chrome.permissions.contains({ origins: ['file:///*'] }))) return null;
  if (item.fileSize > MAX_TORRENT_BYTES) throw new Error(t('种子文件超过 4 MB'));
  let response;
  try {
    response = await fetch(localFileUrl(item.filename));
  } catch {
    return null;
  }
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader(),
    chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_TORRENT_BYTES) {
      await reader.cancel();
      throw new Error(t('种子文件超过 4 MB'));
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return validateTorrent(bytes);
}
async function send(message) {
  const config = await savedConfig();
  if (!config) return { needsBinding: true };
  if (message.bindingId !== config.bindingId)
    throw new Error(t('下载器绑定已变化，请重新点击发送'));
  if (!Number.isInteger(message.id) || message.id < 0) throw new Error(t('下载编号无效'));
  const item = (await chrome.downloads.search({ id: message.id }))[0];
  if (!item || item.incognito || !isTorrent(item))
    throw new Error(t('只能发送浏览器记录中的种子文件'));
  if (item.state !== 'complete' || item.exists === false)
    throw new Error(t('种子尚未下载完成，或本地文件已不存在'));
  const { [RECEIPTS_KEY]: receipts = {} } = await chrome.storage.local.get(RECEIPTS_KEY);
  const receiptKey = config.bindingId + ':' + item.id;
  if (receipts[receiptKey]) return { name: DOWNLOADERS[config.type].name, duplicate: true };
  let bytes;
  if (message.data !== undefined) {
    if (message.filename !== basename(item.filename))
      throw new Error(t('所选文件名与此下载不一致，请选择对应种子'));
    bytes = decodeTorrent(message.data);
  } else bytes = await readLocalTorrent(item);
  if (!bytes)
    return {
      needsFile: true,
      filename: basename(item.filename),
      name: DOWNLOADERS[config.type].name,
    };
  const result = await withClient(config, () =>
    submitTorrent(config, bytes, basename(item.filename)),
  );
  receipts[receiptKey] = { at: new Date().toISOString(), name: result.name };
  const recent = Object.entries(receipts)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .slice(0, 200);
  await chrome.storage.local.set({ [RECEIPTS_KEY]: Object.fromEntries(recent) });
  return result;
}
export function handleDownloader(message) {
  if (message.type === 'SEND_TORRENT' && sending.has(message.id))
    return Promise.reject(new Error(t('这个种子正在发送，请等待结果')));
  if (message.type === 'SEND_TORRENT') sending.add(message.id);
  const operation = serial.then(async () => {
    if (message.type === 'GET_DOWNLOADER')
      return { downloader: downloaderSummary(await savedConfig()) };
    if (message.type === 'SAVE_DOWNLOADER') {
      const config = await draftConfig(message.downloader);
      const previous = await savedConfig();
      config.bindingId =
        previous && ['type', 'url', 'username'].every((key) => previous[key] === config[key])
          ? previous.bindingId
          : crypto.randomUUID();
      await chrome.storage.local.set({ [CONFIG_KEY]: config });
      return { downloader: downloaderSummary(config) };
    }
    if (message.type === 'CLEAR_DOWNLOADER') {
      await chrome.storage.local.remove([CONFIG_KEY, RECEIPTS_KEY]);
      return { downloader: null };
    }
    if (message.type === 'TEST_DOWNLOADER') {
      const config = await draftConfig(message.downloader);
      return withClient(config, () => testDownloader(config));
    }
    if (message.type === 'SEND_TORRENT') return send(message);
    throw new Error(t('未知下载器操作'));
  });
  serial = operation.catch(() => {});
  return operation.finally(() => {
    if (message.type === 'SEND_TORRENT') sending.delete(message.id);
  });
}
