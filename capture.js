import { t } from './i18n.js';
import { basename } from './engine.js';
let lane = Promise.resolve();
const serial = (fn) => {
  const job = lane.then(fn);
  lane = job.catch(() => {});
  return job;
};
const initial = () => ({ targets: [], resources: {} });
const read = async () => (await chrome.storage.session.get('capture')).capture || initial();
export function resourceKind(resource) {
  const type = resource.mime || '',
    ext = (resource.filename || resource.url.split('?')[0]).split('.').pop().toLowerCase();
  if (type.startsWith('image/') || /^(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/.test(ext))
    return 'image';
  if (type.startsWith('audio/') || /^(mp3|wav|flac|ogg|aac|m4a|opus)$/.test(ext)) return 'audio';
  if (type.includes('mpegurl') || type.includes('dash+xml') || /^(m3u8|mpd)$/.test(ext))
    return 'playlist';
  if (type.startsWith('video/') || /^(mp4|webm|mkv|mov|avi)$/.test(ext)) return 'video';
  if (type === 'application/pdf' || /^(pdf|txt|md|docx?|xlsx?|pptx?|csv)$/.test(ext))
    return 'document';
  if (/^(zip|rar|7z|gz|tar)$/.test(ext)) return 'archive';
  return 'other';
}
function merge(state, tabId, items) {
  const existing = new Map((state.resources[tabId] || []).map((r) => [r.url, r]));
  for (const item of items) {
    if (
      !/^https?:\/\//.test(item.url) ||
      item.url.length > 8192 ||
      (existing.size >= 3000 && !existing.has(item.url))
    )
      continue;
    let filename = item.filename;
    try {
      filename = filename || decodeURIComponent(basename(new URL(item.url).pathname));
    } catch {
      filename = filename || 'resource';
    }
    const previous = existing.get(item.url) || {};
    const merged = {
      ...previous,
      ...Object.fromEntries(
        Object.entries(item).filter(([, v]) => v !== '' && v !== undefined && v !== 0),
      ),
      filename,
      tabId,
      id: previous.id || crypto.randomUUID(),
    };
    merged.kind = resourceKind(merged);
    existing.set(item.url, merged);
  }
  state.resources[tabId] = [...existing.values()];
}
// This function runs in the isolated world of a page the user chose to inspect.
function scanPage() {
  const found = [],
    selection = window.getSelection();
  const add = (url, meta = {}) => {
    try {
      const parsed = new URL(url, document.baseURI);
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
      found.push({
        url: parsed.href,
        pageTitle: document.title,
        tabUrl: location.href,
        referrer: location.href,
        origin: 'page',
        ...meta,
      });
    } catch {}
  };
  const roots = [document];
  function selected(el) {
    try {
      return Boolean(selection?.rangeCount && selection.containsNode(el, true));
    } catch {
      return false;
    }
  }
  for (let r = 0; r < roots.length && r < 100; r++)
    for (const el of Array.from(roots[r].querySelectorAll('*')).slice(0, 10000)) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      const meta = {
        linkText: (el.textContent || el.getAttribute('alt') || '').trim().slice(0, 500),
        linkTitle: (el.getAttribute('title') || '').slice(0, 500),
        selected: selected(el),
      };
      if (el.matches('a[href],area[href]'))
        add(el.href, { ...meta, filename: el.getAttribute('download') || '' });
      if (el.matches('img')) {
        const dimensions = { width: el.naturalWidth, height: el.naturalHeight, mime: 'image/*' };
        add(el.currentSrc || el.src, { ...meta, ...dimensions });
        for (const value of [el.getAttribute('data-src'), el.getAttribute('data-original')])
          if (value) add(value, { ...meta, ...dimensions });
      }
      if (el.matches('audio,video,source'))
        add(el.currentSrc || el.src, {
          ...meta,
          mime: el.type || (el.matches('audio') ? 'audio/*' : el.matches('video') ? 'video/*' : ''),
        });
      if (el.matches('[srcset]'))
        for (const entry of el.getAttribute('srcset').split(',')) {
          const url = entry.trim().split(/\s+/)[0];
          if (url) add(url, meta);
        }
      for (const pseudo of [null, '::before', '::after']) {
        const css = getComputedStyle(el, pseudo).backgroundImage;
        for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g))
          add(match[1], { ...meta, mime: 'image/*', origin: 'css' });
      }
      if (found.length >= 3000) break;
    }
  for (const resource of performance.getEntriesByType('resource'))
    add(resource.name, { origin: 'performance', size: resource.encodedBodySize || 0 });
  return found.slice(0, 3000);
}
export async function scanTabs(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length > 30 || tabIds.some((id) => !Number.isInteger(id)))
    throw new Error(t('每次最多选择 30 个标签页'));
  const results = [],
    failures = [];
  for (const tabId of tabIds) {
    try {
      const frames = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: scanPage,
      });
      results.push({ tabId, items: frames.flatMap((f) => f.result || []) });
    } catch (error) {
      failures.push({ tabId, error: error.message });
    }
  }
  return serial(async () => {
    const state = await read();
    for (const result of results) merge(state, result.tabId, result.items);
    await chrome.storage.session.set({ capture: state });
    return { capture: state, failures };
  });
}
export const getCapture = () => serial(read);
export const CAPTURE_ORIGINS = ['http://*/*', 'https://*/*'];
let networkRegistration;
export async function setCapture(tabIds, enabled) {
  if (!Array.isArray(tabIds) || tabIds.length > 30 || tabIds.some((id) => !Number.isInteger(id)))
    throw new Error(t('每次最多选择 30 个标签页'));
  if (enabled && !(await networkRegistration?.synchronize()))
    throw new Error(t('网络捕获需要先授予 HTTP(S) 站点访问权限'));
  return serial(async () => {
    const state = await read();
    state.targets = enabled
      ? [...new Set([...state.targets, ...tabIds])]
      : state.targets.filter((id) => !tabIds.includes(id));
    await chrome.storage.session.set({ capture: state });
    return { capture: state };
  });
}
export const clearCapture = () =>
  serial(async () => {
    const state = initial();
    await chrome.storage.session.set({ capture: state });
    return { capture: state };
  });
// Installation hosts permit synchronous registration. Optional-only contexts
// must wait for grants. Keep the callback stable across permission events.
export function createCaptureRegistration(api, handler, onRevoked = async () => {}) {
  let pending = Promise.resolve();
  const remove = () => {
    if (api.webRequest.onHeadersReceived.hasListener(handler))
      api.webRequest.onHeadersReceived.removeListener(handler);
  };
  // Declared installation hosts allow synchronous registration, so the first
  // response that wakes an idle service worker cannot arrive before its listener.
  const declared = api.runtime?.getManifest?.().host_permissions || [];
  if (CAPTURE_ORIGINS.every((origin) => declared.includes(origin))) {
    api.webRequest.onHeadersReceived.addListener(handler, { urls: CAPTURE_ORIGINS }, [
      'responseHeaders',
    ]);
  }
  function synchronize() {
    const task = pending.then(async () => {
      const allowed = await api.permissions.contains({ origins: CAPTURE_ORIGINS });
      if (allowed) {
        if (!api.webRequest.onHeadersReceived.hasListener(handler))
          api.webRequest.onHeadersReceived.addListener(handler, { urls: CAPTURE_ORIGINS }, [
            'responseHeaders',
          ]);
      } else {
        remove();
        await onRevoked();
      }
      return allowed;
    });
    pending = task.catch(() => {});
    return task;
  }
  const changed = () => {
    void synchronize().catch((error) =>
      console.warn('Network capture permissions:', error.message),
    );
  };
  api.permissions.onAdded.addListener(changed);
  api.permissions.onRemoved.addListener((change) => {
    if (change.origins?.some((origin) => /^https?:/.test(origin) || origin === '<all_urls>'))
      remove();
    changed();
  });
  const ready = synchronize();
  return { ready, synchronize };
}
export function registerCapture() {
  const onHeaders = (details) => {
    if (details.tabId < 0 || details.statusCode < 200 || details.statusCode >= 300) return;
    void serial(async () => {
      const state = await read();
      if (!state.targets.includes(details.tabId)) return;
      const headers = Object.fromEntries(
        (details.responseHeaders || []).map((h) => [h.name.toLowerCase(), h.value]),
      );
      const mime = (headers['content-type'] || '').split(';')[0];
      const disposition = headers['content-disposition'] || '';
      const filename = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i)?.[1] || '';
      const tab = await chrome.tabs.get(details.tabId).catch(() => ({}));
      if (tab.incognito) return;
      merge(state, details.tabId, [
        {
          url: details.url,
          mime,
          filename,
          size: Number(headers['content-length']) || 0,
          origin: 'network',
          pageTitle: tab.title || '',
          tabUrl: tab.url || '',
          referrer: details.initiator || '',
          seenAt: Date.now(),
        },
      ]);
      await chrome.storage.session.set({ capture: state });
    }).catch(() => {});
  };
  networkRegistration = createCaptureRegistration(chrome, onHeaders, () =>
    serial(async () => {
      const state = await read();
      if (state.targets.length) {
        state.targets = [];
        await chrome.storage.session.set({ capture: state });
      }
    }),
  );
  void networkRegistration.ready.catch((error) =>
    console.warn('Network capture permissions:', error.message),
  );
  chrome.tabs.onRemoved.addListener((tabId) => {
    void serial(async () => {
      const state = await read();
      state.targets = state.targets.filter((id) => id !== tabId);
      delete state.resources[tabId];
      await chrome.storage.session.set({ capture: state });
    });
  });
}
