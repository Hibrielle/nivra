import { t } from './i18n.js';
import { basename } from './engine.js';
import { h, icon, request, formatBytes } from './ui.js';
import { taskName } from './task-view.js';
import { isCanceled } from './download-state.js';
import { liveDownload, copyDownloadValue, taskMenuGroups } from './download-info.js';
import { sendTorrentFromUI } from './downloader-ui.js';
export function initTaskMenu({ getState, refresh, toast, navigate }) {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="taskMenu" class="popup-task-menu" role="menu" aria-label="${t('任务操作')}" hidden></div>
<dialog
      id="deleteFileDialog"
      class="popup-delete-dialog"
      aria-labelledby="deleteFileTitle"
      aria-describedby="deleteFileWarning"
    >
      <form id="deleteFileForm">
        <h2 id="deleteFileTitle">${t('删除本地文件？')}</h2>
        <p id="deleteFileName" class="delete-file-name"></p>
        <p id="deleteFileSize" class="field-hint"></p>
        <div class="delete-location">
          <span>${t('实际保存位置')}</span><code id="deleteFilePath"></code>
        </div>
        <p id="deleteFileWarning">${t('\n          将直接删除磁盘上的文件，插件无法撤销。任务与下载链接保留，之后仍可重新下载。\n        ')}</p>
        <p id="deleteFileError" class="form-error" role="alert"></p>
        <div class="delete-buttons">
          <button type="button" class="button" id="cancelDeleteFile" autofocus>${t('取消')}</button
          ><button type="submit" class="button delete-confirm" id="confirmDeleteFile">${t('\n            删除文件\n          ')}</button>
        </div>
      </form>
    </dialog>`,
  );
  const $ = (selector) => document.querySelector(selector),
    menu = $('#taskMenu');
  let menuId = null,
    anchor,
    menuMarkup = '',
    pendingDelete = null;
  const safely = async (fn) => {
    try {
      await fn();
    } catch (error) {
      toast(error.message);
    }
  };
  function rowActions(record, name) {
    const more = `<button class="icon-button" data-more="${record.id}" aria-label="${t('更多操作 {0}', h(name))}" title="${t('更多操作')}" aria-haspopup="menu" aria-controls="taskMenu" aria-expanded="${record.id === menuId}">${icon('more')}</button>`;
    if (record.trashedAt)
      return (
        more +
        `<button class="icon-button" data-task-action="restore" data-task-id="${record.id}" aria-label="${t('还原任务 {0}', h(name))}" title="${t('还原任务')}">${icon('up')}</button>`
      );
    if (record.state === 'complete')
      return (
        more +
        `<button class="icon-button" data-show="${record.id}" title="${t('在文件夹中显示')}" aria-label="${t('在文件夹中显示 {0}', h(name))}" ${record.exists === false ? 'disabled' : ''}>${icon('folder')}</button>`
      );
    const type =
      record.state === 'in_progress'
        ? record.paused
          ? 'resume'
          : 'pause'
        : record.canResume && !isCanceled(record)
          ? 'resume'
          : 'retry';
    const label = { resume: t('继续'), pause: t('暂停'), retry: t('重新下载') }[type];
    return (
      more +
      `<button class="icon-button" data-task-action="${type}" data-task-id="${record.id}" aria-label="${label} ${h(name)}" title="${label}">${icon(
        { resume: 'play', pause: 'pause', retry: 'refresh' }[type],
      )}</button>`
    );
  }
  function closeMenu(restoreFocus = false) {
    menuId = null;
    menu.hidden = true;
    const button = anchor;
    button?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button?.focus();
  }
  function positionMenu() {
    if (menuId === null || menu.hidden) return;
    const button = anchor?.isConnected ? anchor : document.querySelector(`[data-more="${menuId}"]`);
    if (!button) return closeMenu();
    const r = button.getBoundingClientRect();
    const height = Math.min(innerHeight, document.body.getBoundingClientRect().height);
    menu.style.maxHeight = `${Math.max(100, height - 16)}px`;
    const box = menu.getBoundingClientRect();
    const below = r.bottom + 5;
    const top = below + box.height <= height - 8 ? below : Math.max(8, r.top - box.height - 5);
    menu.style.top = `${Math.min(top, Math.max(8, height - box.height - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - box.width, innerWidth - box.width - 8))}px`;
  }
  function updateMenu() {
    if (menuId === null) return;
    const { records, downloader } = getState();
    const record = records.find((item) => item.id === menuId);
    if (!record || !document.querySelector(`[data-more="${menuId}"]`)) return closeMenu();
    const markup = taskMenuGroups(record, downloader)
      .map((group) =>
        group
          .map(
            (item) =>
              `<button role="menuitem" data-menu-action="${item.key}" class="${item.danger ? 'danger' : ''}" ${item.disabled ? 'disabled' : ''}>${icon(item.symbol)}<span>${h(item.label)}</span>${item.hint ? `<small>${h(item.hint)}</small>` : ''}</button>`,
          )
          .join(''),
      )
      .join('<div role="separator"></div>');
    if (menuMarkup !== markup) {
      const focused = document.activeElement?.dataset.menuAction;
      menu.innerHTML = markup;
      menuMarkup = markup;
      if (focused)
        (
          menu.querySelector(`[data-menu-action="${focused}"]:not(:disabled)`) ||
          menu.querySelector('button:not(:disabled)')
        )?.focus();
    }
    positionMenu();
  }
  function openMenu(id, button) {
    if (menuId === id) return closeMenu(true);
    closeMenu();
    menuId = id;
    anchor = button;
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    updateMenu();
    menu.querySelector('button:not(:disabled)')?.focus();
    requestAnimationFrame(positionMenu);
  }
  async function action(type, ids) {
    if (type === 'erase' && !confirm(t('清除这 {0} 条浏览器下载记录？磁盘文件保留。', ids.length)))
      return;
    const { results } = await request(
      ['trash', 'restore'].includes(type) ? 'UPDATE_RECORDS' : 'DOWNLOAD_ACTION',
      { action: type, ids, confirmed: type === 'erase' },
    );
    const failed = results.filter((result) => !result.ok);
    await refresh();
    if (failed.length) throw new Error(failed[0].error);
    toast(
      {
        pause: t('下载已暂停'),
        resume: t('下载已继续'),
        cancel: t('下载已取消，可重新下载'),
        retry: t('已加入重新下载队列'),
        trash: t('任务已移到插件回收站，磁盘文件保留'),
        restore: t('任务已还原'),
        erase: t('浏览器下载记录已清除，磁盘文件保留'),
      }[type] || t('操作已完成'),
    );
  }
  async function openDeleteFile(id) {
    const item = await liveDownload(id);
    if (item.state !== 'complete') throw new Error(t('请等待下载完成后再删除文件'));
    if (item.exists === false) throw new Error(t('本地文件已不存在，或已被移动'));
    pendingDelete = { id, filename: item.filename };
    $('#deleteFileName').textContent = basename(item.filename);
    $('#deleteFilePath').textContent = item.filename;
    $('#deleteFileSize').textContent = formatBytes(
      item.fileSize >= 0 ? item.fileSize : item.totalBytes,
    );
    $('#deleteFileError').textContent = '';
    document.querySelectorAll('#popupToast,#toast').forEach((el) => (el.hidden = true));
    $('#deleteFileDialog').showModal();
    $('#cancelDeleteFile').focus();
  }
  $('#cancelDeleteFile').onclick = () => $('#deleteFileDialog').close();
  $('#deleteFileDialog').addEventListener('close', () => {
    pendingDelete = null;
  });
  $('#deleteFileDialog').addEventListener('cancel', (event) => {
    if ($('#confirmDeleteFile').disabled) event.preventDefault();
  });
  $('#deleteFileForm').onsubmit = async (event) => {
    event.preventDefault();
    if (!pendingDelete || $('#confirmDeleteFile').disabled) return;
    const target = { ...pendingDelete };
    $('#confirmDeleteFile').disabled = true;
    $('#cancelDeleteFile').disabled = true;
    $('#confirmDeleteFile').textContent = t('正在删除…');
    try {
      const item = await liveDownload(target.id);
      if (item.filename !== target.filename)
        throw new Error(t('保存位置已经变化，请取消并重新确认'));
      const { results } = await request('DOWNLOAD_ACTION', {
        action: 'delete',
        ids: [target.id],
        confirmed: true,
      });
      if (!results[0]?.ok) throw new Error(results[0]?.error || t('文件未能删除'));
      $('#deleteFileDialog').close();
      toast(t('本地文件已删除，任务和下载链接已保留'));
      await refresh();
    } catch (error) {
      $('#deleteFileError').textContent = error.message;
    } finally {
      $('#confirmDeleteFile').disabled = false;
      $('#cancelDeleteFile').disabled = false;
      $('#confirmDeleteFile').textContent = t('删除文件');
    }
  };
  async function menuAction(type, id) {
    const { downloader } = getState();
    if (type === 'send-torrent') {
      await sendTorrentFromUI(id, { downloader, toast, configure: () => navigate('settings') });
    } else if (type.startsWith('copy-')) {
      await copyDownloadValue(id, type.slice(5));
      toast(
        {
          'copy-url': t('完整下载链接已复制'),
          'copy-name': t('文件名已复制'),
          'copy-path': t('本地路径已复制'),
        }[type],
      );
    } else if (type === 'delete') await openDeleteFile(id);
    else if (type === 'show') await chrome.downloads.show(id);
    else if (type === 'open') {
      if (!(await chrome.permissions.request({ permissions: ['downloads.open'] })))
        throw new Error(t('未获得打开文件的权限'));
      await chrome.downloads.open(id);
    } else if (type === 'source') {
      const item = await liveDownload(id);
      if (!/^https?:\/\//.test(item.referrer || ''))
        throw new Error(t('此下载没有记录可打开的来源网页'));
      await chrome.tabs.create({ url: item.referrer });
    } else if (type === 'report')
      await chrome.tabs.create({ url: chrome.runtime.getURL(`report.html?id=${id}`) });
    else if (['detail', 'rule', 'test-rule'].includes(type)) await navigate(type, id);
    else await action(type, [id]);
  }
  document.addEventListener('pointerdown', (event) => {
    if (menuId !== null && !event.target.closest('#taskMenu,[data-more]')) closeMenu();
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.more) return openMenu(Number(button.dataset.more), button);
    if (button.dataset.menuAction && menuId !== null) {
      const id = menuId,
        type = button.dataset.menuAction;
      closeMenu(true);
      void safely(() => menuAction(type, id));
    }
  });
  document.addEventListener('keydown', (event) => {
    if (menuId === null) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu(true);
      return;
    }
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
    if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  });
  document.addEventListener('scroll', positionMenu, true);
  document.addEventListener(
    'wheel',
    (event) => {
      if (!menu.contains(event.target)) closeMenu();
    },
    { passive: true },
  );
  document.addEventListener(
    'touchmove',
    (event) => {
      if (!menu.contains(event.target)) closeMenu();
    },
    { passive: true },
  );
  window.addEventListener('resize', positionMenu);
  return {
    rowActions: (record) => rowActions(record, taskName(record)),
    update: updateMenu,
    close: closeMenu,
    run: (type, id) => safely(() => menuAction(type, id)),
    action: (type, ids) => safely(() => action(type, ids)),
  };
}
