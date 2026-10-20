import { t } from './i18n.js';
import { h, icon, request, applyTheme, toggleTheme } from './ui.js';
import { taskProgress, taskSymbol, taskMetrics, taskDescription, taskName } from './task-view.js';
import { isCanceled } from './download-state.js';
import { renderTaskList } from './task-list.js';
import { initTaskMenu } from './task-menu.js';
applyTheme();
document.querySelectorAll('[data-icon]').forEach((el) => {
  el.innerHTML = icon(el.dataset.icon);
});
if (new URL(location.href).searchParams.has('monitor')) {
  document.body.classList.add('monitor-window');
  document.documentElement.classList.add('monitor-document');
}
const $ = (s) => document.querySelector(s),
  measurements = new Map();
let enabled = true,
  onboardingDismissed = true,
  downloader = null,
  records = [],
  refreshing = false,
  again = false;
let toastTimer;
function toast(message) {
  $('#popupToast').textContent = message;
  $('#popupToast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#popupToast').hidden = true;
  }, 4500);
}
const safely = async (fn) => {
  try {
    await fn();
  } catch (error) {
    toast(error.message);
  }
};
async function refresh() {
  if (refreshing) {
    again = true;
    return;
  }
  refreshing = true;
  try {
    const state = await request('GET_STATE');
    enabled = state.config.enabled;
    onboardingDismissed = state.config.onboardingDismissed;
    downloader = state.downloader;
    records = state.records.filter((r) => !r.trashedAt);
    $('#popupToggle').setAttribute('aria-checked', String(enabled));
    $('#popupStatusText').textContent = enabled ? t('自动归档已开启') : t('自动归档已暂停');
    const active = records.filter((r) => r.state === 'in_progress');
    const downloading = active.filter((r) => !r.paused).length,
      pausedCount = active.length - downloading;
    $('#popupCount').textContent = downloading
      ? t('{0} 个下载中{1}', downloading, pausedCount ? t(' · {0} 个暂停', pausedCount) : '')
      : pausedCount
        ? t('{0} 个已暂停', pausedCount)
        : t('{0} 个任务', records.length);
    $('#popupPause').disabled = !active.some((r) => !r.paused);
    $('#popupResume').disabled = !records.some((r) => !isCanceled(r) && (r.paused || r.canResume));
    const sorted = [...active, ...records.filter((r) => r.state !== 'in_progress')].slice(0, 12);
    const markup = sorted.length
      ? sorted
          .map((record) => {
            const facts = taskProgress(record, measurements),
              name = taskName(record);
            return `<article class="popup-item" data-popup-task="${record.id}" data-task-key="${record.id}" data-task-state="${facts.kind}">${taskSymbol(record, facts)}<div class="task-copy"><button class="popup-task-name file-name" data-open-task="${record.id}" title="${h(name)}">${h(name)}</button><div class="task-source" title="${h(record.source)}">${h(record.source || t('浏览器下载'))}</div><div class="task-metrics">${taskMetrics(facts)}</div>${taskDescription(facts)}</div><div class="popup-item-actions">${taskMenu.rowActions(record)}</div></article>`;
          })
          .join('')
      : `<div class="popup-empty">${icon('download')}<p>${t('暂无下载任务')}</p><span>${t('在网页下载文件，进度会显示在这里。')}</span>${onboardingDismissed ? '' : `<button class="button" id="popupSetup">${t('先设置归档位置')}</button>`}</div>`;
    renderTaskList($('#popupList'), markup);
    taskMenu.update();
  } catch (error) {
    $('#popupStatusText').textContent = error.message;
  } finally {
    refreshing = false;
    if (again) {
      again = false;
      void refresh();
    }
  }
}
async function navigate(view = 'all', downloadId, createRule = false, testRule = false) {
  const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
    base = chrome.runtime.getURL('manager.html'),
    url = new URL(base);
  if (view === 'new') {
    url.searchParams.set('new', '1');
    view = 'all';
  }
  if (view === 'setup') {
    url.searchParams.set('setup', '1');
    view = 'all';
  }
  if (downloadId !== undefined) url.searchParams.set('download', downloadId);
  if (createRule) url.searchParams.set('ruleFrom', downloadId);
  if (testRule) url.searchParams.set('testFrom', downloadId);
  if (view === 'resources' && active?.id) url.searchParams.set('tab', active.id);
  url.hash = view;
  const existing = (await chrome.runtime.getContexts({ contextTypes: ['TAB'] })).find(
    (context) => !context.incognito && context.documentUrl?.startsWith(base),
  );
  if (existing) {
    await chrome.tabs.update(existing.tabId, { url: url.href, active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url: url.href });
  window.close();
}
$('#popupToggle').onclick = async () => {
  await request('SET_ENABLED', { enabled: !enabled });
  await refresh();
};
$('#openManager').onclick = () => void navigate();
$('#seeAll').onclick = () => void navigate();
$('#popupNew').onclick = () => void navigate('new');
$('#popupResources').onclick = () => void navigate('resources');
$('#popupSettings').onclick = () => void navigate('settings');
$('#popupThemeToggle').onclick = toggleTheme;
$('#popupPause').onclick = () =>
  void taskMenu.action(
    'pause',
    records.filter((r) => r.state === 'in_progress' && !r.paused).map((r) => r.id),
  );
$('#popupResume').onclick = () =>
  void taskMenu.action(
    'resume',
    records.filter((r) => !isCanceled(r) && (r.paused || r.canResume)).map((r) => r.id),
  );
const taskMenu = initTaskMenu({
  getState: () => ({ records, downloader }),
  refresh,
  toast,
  navigate: (type, id) =>
    type === 'settings'
      ? navigate('settings')
      : navigate('all', id, type === 'rule', type === 'test-rule'),
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.taskAction)
    void taskMenu.run(button.dataset.taskAction, Number(button.dataset.taskId));
  if (button.dataset.openTask) void safely(() => navigate('all', Number(button.dataset.openTask)));
  if (button.id === 'popupSetup') void safely(() => navigate('setup'));
  if (button.dataset.show) void taskMenu.run('show', Number(button.dataset.show));
});
chrome.storage.onChanged.addListener(() => void refresh());
setInterval(() => {
  if (records.some((r) => r.state === 'in_progress')) void refresh();
}, 900);
void refresh();
