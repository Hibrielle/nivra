import { t } from './i18n.js';
import {
  basename,
  sanitizedFilename,
  validateTemplate,
  validateFolder,
  displaySource,
} from './engine.js';
import { evaluateBackground } from './evaluator.js';
import { isCanceled } from './download-state.js';
export const MAX_BATCH = 1000;
export function expandUrls(text) {
  if (typeof text !== 'string' || text.length > 256000)
    throw new Error(t('链接输入最多 256000 个字符'));
  const output = [];
  function expand(line, depth = 0) {
    if (depth > 8) throw new Error(t('每个链接最多支持 8 个范围'));
    const match = line.match(/\[(-?\d+|[a-zA-Z]):(-?\d+|[a-zA-Z])(?::(\d+))?\]/);
    if (!match) {
      const url = new URL(line);
      if (url.href.length > 8192) throw new Error(t('单个链接不能超过 8192 个字符'));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error(t('仅支持不含账号密码的 HTTP(S) 链接'));
      output.push(url.href);
      if (output.length > MAX_BATCH) throw new Error(t('每批最多 1000 个链接'));
      return;
    }
    const numeric = /^-?\d+$/.test(match[1]);
    if (numeric !== /^-?\d+$/.test(match[2])) throw new Error(t('范围两端必须都是数字或都是字母'));
    const from = numeric ? Number(match[1]) : match[1].charCodeAt(0),
      to = numeric ? Number(match[2]) : match[2].charCodeAt(0),
      step = Number(match[3] || 1);
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      !Number.isSafeInteger(step) ||
      step < 1 ||
      Math.abs(to - from) / step > MAX_BATCH
    )
      throw new Error(t('链接范围过大或步长无效'));
    const direction = to >= from ? 1 : -1,
      width = numeric && /^0\d/.test(match[1]) ? match[1].length : 0;
    for (let value = from; direction > 0 ? value <= to : value >= to; value += step * direction) {
      const part = numeric ? String(value).padStart(width, '0') : String.fromCharCode(value);
      expand(
        line.slice(0, match.index) + part + line.slice(match.index + match[0].length),
        depth + 1,
      );
    }
  }
  for (const line of text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean))
    expand(line);
  return [...new Set(output)];
}
export function normalizeBatch(input) {
  const urls = input.items ? input.items.map((item) => item.url) : expandUrls(input.text || '');
  if (!urls.length || urls.length > MAX_BATCH) throw new Error(t('请选择 1–1000 个下载链接'));
  const seen = new Set(),
    items = [];
  const template = String(input.template || '').trim();
  if (template) validateTemplate(template);
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt).getTime() : 0;
  if (!Number.isFinite(scheduledAt)) throw new Error(t('计划时间无效'));
  for (let i = 0; i < urls.length; i++) {
    const url = expandUrls(urls[i]);
    if (url.length !== 1) throw new Error(t('资源链接不能含批量范围'));
    if (seen.has(url[0])) continue;
    seen.add(url[0]);
    const source = input.items?.[i] || {};
    const metadata = {};
    for (const field of [
      'filename',
      'pageTitle',
      'linkTitle',
      'linkText',
      'referrer',
      'tabUrl',
      'mime',
    ])
      if (typeof source[field] === 'string') metadata[field] = source[field].slice(0, 4096);
    items.push({
      id: crypto.randomUUID(),
      url: url[0],
      host: new URL(url[0]).host,
      state: 'waiting',
      createdAt: Date.now(),
      scheduledAt,
      template,
      metadata,
      batchIndex: i + 1,
    });
  }
  return items;
}
let lane = Promise.resolve();
function serial(operation) {
  const task = lane.then(operation);
  lane = task.catch(() => {});
  return task;
}
const readQueue = async () =>
  (await chrome.storage.local.get('downloadQueue')).downloadQueue || { paused: false, items: [] };
async function saveQueue(queue) {
  await chrome.storage.local.set({ downloadQueue: queue });
}
export async function queueContext(item) {
  const queue = await readQueue();
  const task =
    queue.items.find((t) => t.downloadId === item.id) ||
    queue.items.find((t) => t.state === 'starting' && t.url === item.url);
  return task
    ? {
        ...task.metadata,
        batchIndex: task.batchIndex,
        queueTaskId: task.id,
        queueTemplate: task.template,
      }
    : {};
}
async function pumpNow() {
  const queue = await readQueue(),
    config = (await chrome.storage.local.get('config')).config || {};
  const live = await chrome.downloads.search({});
  let changed = false;
  for (const task of queue.items) {
    if (!['starting', 'running'].includes(task.state)) continue;
    const item =
      live.find((d) => d.id === task.downloadId) ||
      (task.state === 'starting'
        ? live.find(
            (d) =>
              d.url === task.url && new Date(d.startTime).getTime() >= (task.startedAt || 0) - 1000,
          )
        : undefined);
    if (item) {
      task.downloadId = item.id;
      const state =
        item.state === 'in_progress'
          ? 'running'
          : item.state === 'complete'
            ? 'complete'
            : isCanceled(item)
              ? 'canceled'
              : 'failed';
      if (task.state !== state) {
        task.state = state;
        changed = true;
      }
      const paused = state === 'running' && Boolean(item.paused);
      if (task.paused !== paused) changed = true;
      task.paused = paused;
      if (state === 'failed') task.error = item.error || t('下载中断');
      if (state === 'complete' || state === 'canceled') clearTaskUrls(task);
    } else if (Date.now() - (task.startedAt || 0) > 15000) {
      task.state = 'failed';
      task.error = t('浏览器重启后未找到对应下载，请手动重试');
      changed = true;
    }
  }
  if (!queue.paused) {
    const running = queue.items.filter(
      (t) => ['starting', 'running'].includes(t.state) && !t.paused,
    );
    const max = Math.max(1, Math.min(20, Number(config.queueConcurrency) || 3)),
      perHost = Math.max(1, Math.min(max, Number(config.perHostConcurrency) || 2));
    let slots = max - running.length;
    for (const task of queue.items) {
      if (slots <= 0) break;
      if (
        task.state !== 'waiting' ||
        task.scheduledAt > Date.now() ||
        running.filter((t) => t.host === task.host).length >= perHost
      )
        continue;
      task.state = 'starting';
      task.startedAt = Date.now();
      changed = true;
      await saveQueue(queue);
      try {
        const fallback = sanitizedFilename(decodeName(new URL(task.url).pathname));
        let filename;
        if (task.template) {
          filename = await evaluateBackground('template', {
            template: task.template,
            archiveRoot: config.archiveRoot,
            item: {
              ...task.metadata,
              filename: task.metadata.filename || fallback,
              url: task.url,
              batchIndex: task.batchIndex,
              startTime: new Date().toISOString(),
            },
          });
          validateFolder(filename);
        }
        task.downloadId = await chrome.downloads.download({
          url: task.url,
          ...(filename ? { filename } : {}),
          conflictAction: 'uniquify',
          saveAs: false,
        });
        task.state = 'running';
        running.push(task);
        slots--;
      } catch (error) {
        task.state = 'failed';
        task.error = error.message;
      }
      await saveQueue(queue);
    }
  }
  if (changed) await saveQueue(queue);
  return queue;
}
function decodeName(path) {
  try {
    return decodeURIComponent(basename(path));
  } catch {
    return basename(path);
  }
}
export const pumpQueue = () => serial(pumpNow);
export const getQueue = () => serial(readQueue);
function clearTaskUrls(task) {
  delete task.url;
  for (const field of ['referrer', 'tabUrl'])
    if (task.metadata?.[field]) task.metadata[field] = displaySource(task.metadata[field]);
}
export function addBatch(input) {
  return serial(async () => {
    const items = normalizeBatch(input),
      queue = await readQueue();
    queue.items = queue.items.filter((t) => !['complete', 'canceled'].includes(t.state));
    if (queue.items.length + items.length > 3000)
      throw new Error(t('队列最多保留 3000 个任务，请清理已结束任务'));
    queue.items.push(...items);
    await saveQueue(queue);
    await pumpNow();
    return { added: items.length };
  });
}
export function queueAction(action, ids = []) {
  return serial(async () => {
    const queue = await readQueue();
    if (action === 'pause') queue.paused = true;
    else if (action === 'resume') queue.paused = false;
    else if (action === 'clear')
      queue.items = queue.items.filter((t) => ['waiting', 'starting', 'running'].includes(t.state));
    else if (action === 'cancel') {
      for (const task of queue.items.filter((t) => ids.includes(t.id))) {
        if (task.state === 'running')
          await chrome.downloads.cancel(task.downloadId).catch(() => {});
        task.state = 'canceled';
        task.paused = false;
        delete task.error;
        clearTaskUrls(task);
      }
    } else if (action === 'retry') {
      for (const task of queue.items.filter((t) => ids.includes(t.id) && t.state === 'failed')) {
        if (!task.url && task.downloadId) {
          task.url = (await chrome.downloads.search({ id: task.downloadId }))[0]?.url;
        }
        if (task.url) {
          task.state = 'waiting';
          delete task.downloadId;
          delete task.error;
        }
      }
    } else throw new Error(t('未知队列操作'));
    await saveQueue(queue);
    await pumpNow();
    return {};
  });
}
export async function downloadAction(action, ids, confirmed = false) {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => !Number.isInteger(id)))
    throw new Error(t('下载编号无效'));
  if (['erase', 'delete'].includes(action) && confirmed !== true)
    throw new Error(t('清除记录或删除文件需要确认'));
  const results = [];
  for (const id of ids) {
    try {
      const item = (await chrome.downloads.search({ id }))[0];
      if (!item) throw new Error(t('浏览器中已无此下载'));
      if (action === 'pause') await chrome.downloads.pause(id);
      else if (action === 'resume') {
        if (isCanceled(item)) throw new Error(t('此任务已取消，请选择重新下载'));
        await chrome.downloads.resume(id);
      } else if (action === 'cancel') await chrome.downloads.cancel(id);
      else if (action === 'retry')
        await addBatch({ items: [{ url: item.url, filename: basename(item.filename) }] });
      else if (action === 'show') await chrome.downloads.show(id);
      else if (action === 'erase') await chrome.downloads.erase({ id });
      else if (action === 'delete') {
        if (item.state !== 'complete') throw new Error(t('请等待下载完成后再删除文件'));
        if (item.exists === false) throw new Error(t('本地文件已不存在，或已被移动'));
        await chrome.downloads.removeFile(id);
      } else throw new Error(t('未知下载操作'));
      results.push({ id, ok: true });
    } catch (error) {
      results.push({ id, ok: false, error: error.message });
    }
  }
  await pumpQueue();
  return { results };
}
