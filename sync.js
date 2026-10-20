import { t } from './i18n.js';
import { gzipSync, gunzipSync, strToU8, strFromU8 } from './vendor/archive.js';
import { parseRulePack, makeRulePack } from './rules.js';
const digest = async (text) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', strToU8(text))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
export async function uploadRules(config) {
  const json = JSON.stringify(makeRulePack(config.rules));
  const bytes = gzipSync(strToU8(json));
  const encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  if (encoded.length > 36000) throw new Error(t('规则压缩后超过 36 KiB，改用 JSON 导出备份'));
  const all = await chrome.storage.sync.get(null),
    previous = all['rules:meta'];
  const generation = crypto.randomUUID(),
    chunks = {};
  for (let i = 0; i < encoded.length; i += 6000)
    chunks[`rules:${generation}:${i / 6000}`] = encoded.slice(i, i + 6000);
  const meta = {
    generation,
    count: Object.keys(chunks).length,
    hash: await digest(json),
    at: new Date().toISOString(),
    ruleCount: config.rules.length,
  };
  try {
    await chrome.storage.sync.set(chunks);
    await chrome.storage.sync.set({ 'rules:meta': meta });
  } catch (error) {
    await chrome.storage.sync.remove(Object.keys(chunks));
    throw error;
  }
  const old = Object.keys(all).filter((key) => key.startsWith('rules:') && key !== 'rules:meta');
  if (old.length) await chrome.storage.sync.remove(old);
  return { meta, previousAt: previous?.at || null };
}
export async function readCloudRules() {
  const all = await chrome.storage.sync.get(null),
    meta = all['rules:meta'];
  if (!meta) throw new Error(t('此浏览器账号还没有云端规则备份'));
  if (!Number.isInteger(meta.count) || meta.count < 1 || meta.count > 6)
    throw new Error(t('云端规则分块信息无效'));
  let encoded = '';
  for (let i = 0; i < meta.count; i++) {
    const chunk = all[`rules:${meta.generation}:${i}`];
    if (typeof chunk !== 'string') throw new Error(t('云端分块还未同步完整，请稍后重试'));
    encoded += chunk;
  }
  if (encoded.length > 36000) throw new Error(t('云端规则超出大小限制'));
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  // Gzip ISIZE is checked before decompression, and a fixed output buffer caps allocation.
  const size = new DataView(bytes.buffer).getUint32(bytes.length - 4, true);
  if (size > 131072) throw new Error(t('云端规则解压后超出限制'));
  const json = strFromU8(gunzipSync(bytes, { out: new Uint8Array(size) }));
  if ((await digest(json)) !== meta.hash) throw new Error(t('云端规则校验失败，请重新上传'));
  return { pack: parseRulePack(json), meta };
}
export async function clearCloudRules() {
  const all = await chrome.storage.sync.get(null);
  await chrome.storage.sync.remove(Object.keys(all).filter((key) => key.startsWith('rules:')));
  return {};
}
