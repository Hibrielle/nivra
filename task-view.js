import { t } from './i18n.js';
import { basename, recordStatus } from './engine.js';
import { h, icon, fileIcon, formatBytes } from './ui.js';
import { classifyFile, TYPE_BY_ID } from './file-types.js';
import { downloadState, isCanceled } from './download-state.js';
export function downloadCategory(name) {
  return classifyFile(name)?.id || 'other';
}
export function taskName(record) {
  const name = record.filename || record.originalName;
  if (name) return basename(name);
  try {
    const path = new URL(record.matchContext?.url || record.source).pathname;
    if (!path.endsWith('/')) return decodeURIComponent(basename(path)) || t('未命名下载');
  } catch {}
  return t('未命名下载');
}
export function matchesTaskView(record, view) {
  if (view === 'trash') return Boolean(record.trashedAt);
  if (record.trashedAt) return false;
  if (view === 'all') return true;
  if (view === 'recent') return Date.now() - new Date(record.startTime).getTime() < 86400000;
  if (view === 'complete') return record.state === 'complete';
  if (view === 'paused') return record.state === 'in_progress' && record.paused;
  if (Object.hasOwn(TYPE_BY_ID, view) || view === 'other')
    return record.state === 'complete' && downloadCategory(record.filename) === view;
  if (view === 'unmatched') return ['unmatched', 'changed'].includes(recordStatus(record));
  return recordStatus(record) === view;
}
export function taskProgress(record, measurements) {
  const now = performance.now(),
    previous = measurements.get(record.id),
    state = downloadState(record),
    active = record.state === 'in_progress',
    complete = record.state === 'complete',
    paused = active && record.paused;
  let speed = previous?.speed || 0;
  if (!previous || !active || paused || previous.paused) {
    speed = 0;
    measurements.set(record.id, { at: now, bytes: record.bytesReceived || 0, speed: 0, paused });
  } else if (now - previous.at > 300) {
    speed = Math.max(
      0,
      ((record.bytesReceived || 0) - previous.bytes) / ((now - previous.at) / 1000),
    );
    measurements.set(record.id, { at: now, bytes: record.bytesReceived || 0, speed });
  }
  if (!active || paused) speed = 0;
  const percent = complete
    ? 100
    : record.totalBytes > 0
      ? Math.max(0, Math.min(100, ((record.bytesReceived || 0) / record.totalBytes) * 100))
      : 0;
  const remaining =
    speed > 0 && record.totalBytes > 0
      ? Math.max(0, Math.ceil((record.totalBytes - record.bytesReceived) / speed))
      : null;
  const eta =
    remaining === null
      ? ''
      : remaining < 60
        ? t('剩余 {0} 秒', remaining)
        : t('剩余 {0} 分 {1} 秒', Math.floor(remaining / 60), remaining % 60);
  // Chrome can reset bytesReceived when it cancels and discards a partial file.
  const size =
    state.kind === 'canceled'
      ? record.totalBytes > 0
        ? t('总大小 {0}', formatBytes(record.totalBytes))
        : t('大小未知')
      : !complete
        ? `${formatBytes(record.bytesReceived || 0)}${record.totalBytes > 0 ? ' / ' + formatBytes(record.totalBytes) : ''}`
        : formatBytes(record.totalBytes > 0 ? record.totalBytes : record.bytesReceived);
  const status = state.kind === 'active' && speed ? t('{0}/秒', formatBytes(speed)) : state.label;
  return { ...state, percent, speed, remaining, size, status, eta, active };
}
export function taskSymbol(record, facts) {
  const name = taskName(record),
    type = classifyFile(name),
    active = record.state === 'in_progress',
    complete = record.state === 'complete',
    paused = active && record.paused,
    missing = complete && record.exists === false,
    { label: status, symbol, kind } = downloadState(record),
    progress = active
      ? `aria-valuemin="0" aria-valuemax="100"${record.totalBytes > 0 ? ` aria-valuenow="${Math.round(facts.percent)}"` : ''} aria-valuetext="${status}${record.totalBytes > 0 ? ' · ' + Math.round(facts.percent) + '%' : ''}"`
      : '';
  return `<span class="task-ring ${active ? 'in_progress' : complete ? 'complete' : 'interrupted'} ${paused ? 'paused' : ''} ${missing ? 'missing' : ''} ${kind === 'canceled' ? 'canceled' : ''} ${active && !(record.totalBytes > 0) ? 'indeterminate' : ''}" style="--task-progress:${Math.round(facts.percent * 3.6)}deg" role="${active ? 'progressbar' : 'img'}" aria-label="${h(name)} · ${h(t(type?.name || '文件'))} · ${status}" ${progress}><span class="task-file-glyph" aria-hidden="true">${icon(fileIcon(name))}</span>${symbol ? `<span class="task-status-badge" aria-hidden="true">${icon(symbol)}</span>` : ''}</span>`;
}
export function taskMetrics(facts) {
  return `<span class="task-speed">${h(facts.status)}</span><span>${h(facts.size)}</span>${facts.eta ? `<span>${h(facts.eta)}</span>` : ''}`;
}
export function taskDescription(facts) {
  return facts.detail
    ? `<p class="task-message" title="${h(facts.detail)}">${h(facts.detail)}</p>`
    : '';
}
export function taskActionButtons(record, compact = false) {
  const button = (action, label, symbol, disabled = false) =>
    `<button class="${compact ? 'icon-button' : 'button'}" data-task-action="${action}" data-task-id="${record.id}" title="${label}" aria-label="${label} ${h(basename(record.filename))}" ${disabled ? 'disabled' : ''}>${compact ? icon(symbol) : label}</button>`;
  if (record.trashedAt) return button('restore', t('还原任务'), 'up');
  if (record.state === 'in_progress')
    return (
      button(
        record.paused ? 'resume' : 'pause',
        record.paused ? t('继续') : t('暂停'),
        record.paused ? 'play' : 'pause',
      ) + button('cancel', t('取消下载'), 'close')
    );
  if (record.state === 'interrupted')
    return (
      (record.canResume && !isCanceled(record) ? button('resume', t('继续'), 'play') : '') +
      button('retry', t('重新下载'), 'refresh')
    );
  return button('open', t('打开文件'), 'external', record.exists === false);
}
