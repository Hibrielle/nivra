import { t, getLocale } from './i18n.js';
import { classifyFile } from './file-types.js';
import { basename, recordStatus } from './engine.js';
const paths = {
  chart: '<path d="M4 3v17h17M7 14l4-5 4 3 5-7"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H4v13h4"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v10L12 22l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v10M7.5 5.2l9 4.6"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  inbox: '<path d="M4 4h16l2 10v6H2v-6zM2 14h6l2 3h4l2-3h6"/>',
  rules:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  external:
    '<path d="M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/>',
  file: '<path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  archive:
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M10 3h4v3h-4v3h4v3h-4v5h4v-5"/>',
  play: '<path d="m9 5 12 7-12 7z"/>',
  app: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M7 12h10M12 7v10"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  edit: '<path d="m15 4 5 5M4 15 16 3a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L9 20l-6 1z"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  moon: '<path d="M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
};
export const icon = (name, extra = '') =>
  `<svg class="icon ${extra}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
export const h = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export async function request(type, payload = {}) {
  if (!globalThis.chrome?.runtime?.id)
    throw new Error(t('请先在 Chrome 扩展程序中加载此文件夹，再打开管理页'));
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw new Error(result?.error || t('扩展暂时未响应，请重新打开页面'));
  return result;
}
export function fileIcon(filename) {
  return classifyFile(filename)?.icon || 'file';
}
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return t('大小未知');
  if (bytes < 1024) return `${bytes} B`;
  const n = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** n).toFixed(n === 1 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB'][n]}`;
}
export function formatTime(value) {
  const date = new Date(value);
  return date.toLocaleDateString() === new Date().toLocaleDateString()
    ? t(
        '今天 {0}',
        date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit', hour12: false }),
      )
    : date.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
}
export function stateLabel(record) {
  const state = recordStatus(record);
  return {
    archived: t('已归档'),
    changed: t('位置已更改'),
    failed: t('下载中断'),
    canceled: t('已取消'),
    unmatched:
      record.decision?.kind === 'paused'
        ? t('归档已暂停')
        : record.decision?.kind === 'error'
          ? t('归档未执行')
          : t('未匹配规则'),
    active: record.paused ? t('下载已暂停') : t('下载中'),
  }[state];
}
export const badge = (record) =>
  `<span class="badge ${recordStatus(record)}">${recordStatus(record) === 'archived' ? icon('check') : ''}${h(stateLabel(record))}</span>`;
export async function openManager() {
  await chrome.runtime.openOptionsPage();
}
let themeListening = false;
export function applyTheme() {
  const theme = localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    const label = theme === 'dark' ? t('切换到浅色模式') : t('切换到深色模式');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  }
  if (!themeListening) {
    themeListening = true;
    window.addEventListener('storage', (event) => {
      if (event.storageArea === localStorage && (event.key === 'theme' || event.key === null))
        applyTheme();
    });
  }
}
export function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', theme);
  applyTheme();
}
