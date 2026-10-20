import { t } from './i18n.js';
import { basename } from './engine.js';
import { h, icon, formatTime, request } from './ui.js';
import { evaluateUI } from './evaluator.js';
import {
  downloadCategory,
  matchesTaskView,
  taskProgress,
  taskSymbol,
  taskMetrics,
  taskActionButtons,
  taskDescription,
  taskName,
} from './task-view.js';
import { isCanceled } from './download-state.js';
import { renderTaskList } from './task-list.js';
export function initDownloadUI({ getState, refresh, toast, showDetail, menu }) {
  const $ = (s) => document.querySelector(s),
    selected = new Set(),
    measurements = new Map();
  let initialTask = new URL(location.href).searchParams.get('download');
  let view = 'all',
    mode = 'table',
    sort = 'newest',
    filter = '',
    filterOptions = '',
    generation = 0,
    shown = [],
    anchor = null,
    focusedId = null;
  const controls = document.createElement('div');
  controls.className = 'download-controls';
  controls.innerHTML = `<div class="task-toolbar" role="toolbar" aria-label="${t('下载任务操作')}"><button class="button toolbar-new" id="newBatch">${t('{0}新建任务', icon('plus'))}</button>${[
    ['resume', t('继续'), 'play'],
    ['pause', t('暂停'), 'pause'],
    ['retry', t('重新下载'), 'refresh'],
    ['cancel', t('取消'), 'close'],
    ['trash', t('移入回收站'), 'trash'],
    ['restore', t('还原'), 'up'],
  ]
    .map(
      ([action, label, symbol]) =>
        `<button class="button" data-selected-action="${action}" title="${label}">${icon(symbol)}<span>${label}</span></button>`,
    )
    .join(
      '',
    )}<span class="toolbar-divider"></span><button class="button" id="pauseAll">${t('{0}全部暂停', icon('pause'))}</button><button class="button" id="resumeAll">${t('{0}全部继续', icon('play'))}</button><div class="spacer"></div><a class="button" href="#resources">${t('{0}资源嗅探', icon('search'))}</a><button class="icon-button" id="openDownloadsFolder" title="${t('打开下载目录')}" aria-label="${t('打开下载目录')}">${icon('folder')}</button></div><div class="task-filterbar"><label class="select-all"><input type="checkbox" id="selectVisible" aria-label="${t('选择当前列表全部任务')}"><span id="selectionCount">${t('0 项')}</span></label><select id="downloadFilter" aria-label="${t('自定义下载筛选')}"><option value="">${t('全部文件类型')}</option><option value="image">${t('图片')}</option><option value="video">${t('视频')}</option><option value="audio">${t('音频')}</option><option value="document">${t('文档')}</option><option value="archive">${t('压缩包')}</option><option value="installer">${t('安装包')}</option><option value="other">${t('其他')}</option></select><select id="downloadSort" aria-label="${t('下载排序')}"><option value="newest">${t('按添加时间')}</option><option value="oldest">${t('最早添加')}</option><option value="name">${t('按文件名称')}</option><option value="size">${t('按文件大小')}</option></select><button id="downloadLayout" class="text-button" aria-label="${t('切换网格视图')}">${t('网格')}</button><div class="spacer"></div><button id="importHistory" class="text-button">${t('导入历史')}</button><button id="clearTrash" class="text-button danger" hidden>${t('清空回收站')}</button></div>`;
  $('#downloadsView').prepend(controls);
  function eligible(action, record) {
    if (action === 'pause') return record.state === 'in_progress' && !record.paused;
    if (action === 'resume') return !isCanceled(record) && (record.paused || record.canResume);
    if (action === 'cancel') return record.state === 'in_progress';
    if (action === 'retry') return record.state !== 'in_progress';
    if (action === 'trash') return record.state !== 'in_progress' && !record.trashedAt;
    if (action === 'restore') return Boolean(record.trashedAt);
    return true;
  }
  function selectionChanged() {
    const rows = getState().records.filter((r) => selected.has(r.id));
    $('#selectionCount').textContent = selected.size
      ? t('已选 {0} / {1} 项', selected.size, shown.length)
      : t('{0} 项', shown.length);
    $('#selectVisible').checked = shown.length > 0 && shown.every((r) => selected.has(r.id));
    $('#selectVisible').indeterminate = selected.size > 0 && !$('#selectVisible').checked;
    document.querySelectorAll('[data-selected-action]').forEach((button) => {
      button.disabled = !rows.some((r) => eligible(button.dataset.selectedAction, r));
      button.hidden =
        button.dataset.selectedAction === 'restore'
          ? view !== 'trash'
          : button.dataset.selectedAction === 'trash' && view === 'trash';
    });
    $('#clearTrash').hidden = view !== 'trash';
    $('#pauseAll').disabled = !getState().records.some((r) => eligible('pause', r));
    $('#resumeAll').disabled = !getState().records.some((r) => eligible('resume', r));
    document.querySelectorAll('[data-task-row]').forEach((row) => {
      const checked = selected.has(Number(row.dataset.taskRow));
      row.classList.toggle('selected', checked);
      row.setAttribute('aria-selected', String(checked));
      row.querySelector('[data-select-download]').checked = checked;
    });
    if (focusedId === null || !selected.has(focusedId)) focusedId = [...selected].at(-1) ?? null;
    if (document.activeElement?.id !== 'recordNote') showDetail(focusedId, selected.size);
  }
  function selectRecord(id, event = {}) {
    if (event.shiftKey && anchor !== null) {
      const a = shown.findIndex((r) => r.id === anchor),
        b = shown.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) {
        if (!event.ctrlKey && !event.metaKey) selected.clear();
        for (const row of shown.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(row.id);
      }
    } else if (event.ctrlKey || event.metaKey) {
      selected.has(id) ? selected.delete(id) : selected.add(id);
      anchor = id;
    } else {
      selected.clear();
      selected.add(id);
      anchor = id;
    }
    focusedId = id;
    selectionChanged();
  }
  async function render(current) {
    if (view !== current) {
      selected.clear();
      focusedId = null;
      anchor = null;
    }
    view = current;
    const token = ++generation,
      { records, config } = getState();
    const custom = [
      ...(config.savedFilters || []).map((f) => ({ ...f, value: `saved:${f.condition}` })),
      ...config.rules
        .filter((r) => r.asFilter && r.condition)
        .map((r) => ({ name: r.name, condition: r.condition, value: `rule:${r.id}` })),
    ];
    const select = $('#downloadFilter'),
      base = Array.from(select.options)
        .filter((o) => !o.value.includes(':'))
        .map((o) => o.outerHTML)
        .join('');
    const options =
      base + custom.map((f) => `<option value="${h(f.value)}">${h(f.name)}</option>`).join('');
    if (filterOptions !== options) {
      select.innerHTML = options;
      filterOptions = options;
    }
    if (filter && !Array.from(select.options).some((option) => option.value === filter))
      filter = '';
    select.value = filter;
    let allowed;
    if (filter.includes(':')) {
      const match = custom.find((f) => f.value === filter);
      if (match)
        try {
          allowed = new Set(
            await evaluateUI('filter', {
              items: records.map((r) => ({ ...r, ...r.matchContext })),
              condition: match.condition,
              config,
            }),
          );
        } catch (error) {
          if (token === generation) toast(error.message);
          allowed = new Set();
        }
    }
    if (token !== generation) return;
    const query = $('#search').value.trim().toLowerCase();
    shown = records.filter(
      (r) =>
        matchesTaskView(r, view) &&
        (!filter || (allowed ? allowed.has(r.id) : downloadCategory(r.filename) === filter)) &&
        [r.filename, r.source, r.decision?.target, r.decision?.ruleName, r.note].some((text) =>
          String(text || '')
            .toLowerCase()
            .includes(query),
        ),
    );
    shown.sort((a, b) =>
      sort === 'name'
        ? basename(a.filename).localeCompare(basename(b.filename))
        : sort === 'size'
          ? (b.totalBytes || b.bytesReceived) - (a.totalBytes || a.bytesReceived)
          : sort === 'oldest'
            ? a.startTime.localeCompare(b.startTime)
            : b.startTime.localeCompare(a.startTime),
    );
    if (initialTask !== null && shown.some((r) => r.id === Number(initialTask))) {
      selected.add(Number(initialTask));
      focusedId = Number(initialTask);
      initialTask = null;
    }
    for (const id of selected) if (!shown.some((r) => r.id === id)) selected.delete(id);
    $('#listLabel').textContent = t('{0} 个任务', shown.length);
    $('#downloadList').classList.toggle('download-grid', mode === 'grid');
    const markup = shown.length
      ? `<div class="task-list ${mode === 'grid' ? 'task-grid' : ''}" role="listbox" aria-multiselectable="true" aria-label="${t('下载任务')}">${shown
          .map((r) => {
            const facts = taskProgress(r, measurements),
              name = taskName(r),
              folder = r.decision?.folder;
            return `<article class="task-row ${mode === 'grid' ? 'download-card' : ''} ${selected.has(r.id) ? 'selected' : ''}" data-task-row="${r.id}" data-task-key="${r.id}" data-task-state="${facts.kind}" data-detail="${r.id}" tabindex="0" role="option" aria-selected="${selected.has(r.id)}" aria-label="${t('查看 {0} 详情', h(name))}"><input type="checkbox" data-select-download="${r.id}" aria-label="${t('选择 {0}', h(name))}" ${selected.has(r.id) ? 'checked' : ''}>${taskSymbol(r, facts)}<div class="task-copy"><div class="task-name-line"><span class="file-name" title="${h(name)}">${h(name)}</span>${r.note ? `<span class="note-dot" title="${h(r.note)}">${t('备注')}</span>` : ''}</div><div class="task-source" title="${h(r.source)}">${h(r.source || t('浏览器下载'))}${folder ? `<span class="task-folder"> → ${h(folder)}</span>` : ''}</div><div class="task-metrics ${r.paused ? 'paused' : ''}">${taskMetrics(facts)}</div>${taskDescription(facts)}</div><div class="task-row-end"><time>${h(formatTime(r.startTime))}</time><span class="row-actions">${menu.rowActions(r)}</span></div></article>`;
          })
          .join('')}</div>`
      : `<div class="task-empty">${icon(view === 'trash' ? 'trash' : 'download')}<h2>${view === 'trash' ? t('回收站为空') : query || filter ? t('没有符合条件的任务') : t('暂无下载任务')}</h2><p>${view === 'trash' ? t('移入这里的任务可以还原，磁盘文件会保留。') : t('在网页下载文件，或点击上方“新建任务”。')}</p></div>`;
    renderTaskList($('#downloadList'), markup, [view, mode, sort, filter, query].join('|'));
    selectionChanged();
    menu.update();
  }
  async function perform(action, ids) {
    const destructive = action === 'erase';
    if (destructive && !confirm(t('清除这 {0} 条浏览器下载记录？磁盘文件保留。', ids.length)))
      return;
    try {
      const { results } = await request(
        ['trash', 'restore'].includes(action) ? 'UPDATE_RECORDS' : 'DOWNLOAD_ACTION',
        { action, ids, confirmed: destructive },
      );
      const failed = results.filter((r) => !r.ok);
      toast(
        failed.length
          ? t('{0} 项成功；{1}', results.length - failed.length, failed[0].error)
          : action === 'trash'
            ? t('已移入回收站 {0} 项，文件保留', ids.length)
            : t('已处理 {0} 项', results.length),
      );
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  }
  document.addEventListener('change', (event) => {
    const input = event.target;
    if (input.dataset.selectDownload) {
      const id = Number(input.dataset.selectDownload);
      input.checked ? selected.add(id) : selected.delete(id);
      focusedId = id;
      anchor = id;
      selectionChanged();
    }
  });
  document.addEventListener('click', async (event) => {
    const row = event.target.closest('[data-task-row]');
    if (row && !event.target.closest('button,input,label,a'))
      selectRecord(Number(row.dataset.taskRow), event);
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.taskAction)
      await menu.run(button.dataset.taskAction, Number(button.dataset.taskId));
    if (button.dataset.selectedAction) {
      const action = button.dataset.selectedAction,
        ids = getState()
          .records.filter((r) => selected.has(r.id) && eligible(action, r))
          .map((r) => r.id);
      await perform(action, ids);
    }
    if (button.id === 'clearSelection') {
      selected.clear();
      focusedId = null;
      selectionChanged();
    }
  });
  $('#downloadList').addEventListener('dblclick', (event) => {
    const row = event.target.closest('[data-task-row]');
    if (row && !event.target.closest('button,input,label,a,select,textarea,summary')) {
      const record = getState().records.find((r) => r.id === Number(row.dataset.taskRow));
      if (record?.state === 'complete' && record.exists !== false) void menu.run('open', record.id);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (
      event.target.closest('input,textarea,select,button,a,summary') ||
      document.querySelector('dialog[open]') ||
      $('#downloadsView').hidden
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      shown.forEach((r) => selected.add(r.id));
      selectionChanged();
    }
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const at = shown.findIndex((r) => r.id === focusedId),
        next = Math.max(0, Math.min(shown.length - 1, at + (event.key === 'ArrowUp' ? -1 : 1)));
      if (shown[next]) {
        selectRecord(shown[next].id, event);
        $(`[data-task-row="${shown[next].id}"]`)?.focus();
      }
    }
    if (event.key === 'Delete' && selected.size) {
      event.preventDefault();
      void perform(view === 'trash' ? 'erase' : 'trash', [...selected]);
    }
    if (event.key === 'Enter' && !event.repeat && focusedId !== null) {
      const record = getState().records.find((r) => r.id === focusedId);
      if (record?.state === 'complete' && record.exists !== false) {
        event.preventDefault();
        void menu.run('open', focusedId);
      }
    }
  });
  $('#selectVisible').onchange = (event) => {
    if (event.target.checked) shown.forEach((r) => selected.add(r.id));
    else selected.clear();
    selectionChanged();
  };
  function openNewTask() {
    $('#newTaskError').textContent = '';
    $('#taskQueueHint').textContent = getState().queue?.paused
      ? t('队列已暂停，新任务会等待派发。')
      : '';
    $('#taskDialog').showModal();
    $('#taskUrls').focus();
  }
  $('#newBatch').onclick = openNewTask;
  $('#newTaskForm').onsubmit = async (event) => {
    event.preventDefault();
    $('#submitTask').disabled = true;
    try {
      const result = await request('ADD_BATCH', {
        text: $('#taskUrls').value,
        template: $('#taskTemplate').value,
      });
      $('#taskDialog').close();
      $('#newTaskForm').reset();
      toast(t('已加入 {0} 个下载任务', result.added));
      location.hash = getState().queue?.paused ? 'batch' : 'all';
      await refresh();
    } catch (error) {
      $('#newTaskError').textContent = error.message;
    } finally {
      $('#submitTask').disabled = false;
    }
  };
  const initialUrl = new URL(location.href);
  if (initialUrl.searchParams.has('new')) {
    initialUrl.searchParams.delete('new');
    history.replaceState(null, '', initialUrl);
    openNewTask();
  }
  $('#downloadFilter').onchange = (event) => {
    filter = event.target.value;
    void render(view);
  };
  $('#downloadSort').onchange = (event) => {
    sort = event.target.value;
    void render(view);
  };
  $('#downloadLayout').onclick = () => {
    mode = mode === 'table' ? 'grid' : 'table';
    $('#downloadLayout').textContent = mode === 'table' ? t('网格') : t('列表');
    void render(view);
  };
  $('#pauseAll').onclick = () =>
    void perform(
      'pause',
      getState()
        .records.filter((r) => eligible('pause', r))
        .map((r) => r.id),
    );
  $('#resumeAll').onclick = () =>
    void perform(
      'resume',
      getState()
        .records.filter((r) => eligible('resume', r))
        .map((r) => r.id),
    );
  $('#openDownloadsFolder').onclick = () => chrome.downloads.showDefaultFolder();
  $('#clearTrash').onclick = () =>
    void perform(
      'erase',
      getState()
        .records.filter((r) => r.trashedAt)
        .map((r) => r.id),
    );
  $('#importHistory').onclick = async () => {
    try {
      const { added } = await request('IMPORT_HISTORY');
      toast(t('已导入 {0} 条历史记录', added));
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  return { render, actions: taskActionButtons, select: (id) => selectRecord(id) };
}
