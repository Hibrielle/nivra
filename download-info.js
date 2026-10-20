import { t } from './i18n.js';
import { basename } from './engine.js';
import { isTorrent } from './downloader.js';
import { isCanceled } from './download-state.js';
export function localFileUrl(filename) {
  const path = filename.replaceAll('\\', '/');
  const encoded = path
    .split('/')
    .map(encodeURIComponent)
    .join('/')
    .replace(/^([/]?[A-Za-z])%3A/, '$1:');
  return path.startsWith('//')
    ? 'file:' + encoded
    : 'file://' + (path.startsWith('/') ? '' : '/') + encoded;
}
export async function liveDownload(id) {
  if (!Number.isInteger(id) || id < 0) throw new Error(t('下载编号无效'));
  const item = (await chrome.downloads.search({ id }))[0];
  if (!item) throw new Error(t('浏览器已清除此下载记录，无法获取原始链接或操作文件'));
  return item;
}
export async function copyDownloadValue(id, field) {
  const item = await liveDownload(id);
  let value;
  if (field === 'url') value = item.url;
  else if (field === 'name') value = item.filename ? basename(item.filename) : '';
  else if (field === 'path') value = item.state === 'complete' ? item.filename : '';
  else throw new Error(t('未知复制操作'));
  if (!value) throw new Error(t('此下载没有可复制的信息'));
  await navigator.clipboard.writeText(value);
}
export function taskMenuGroups(record, downloader) {
  const complete = record.state === 'complete';
  const active = record.state === 'in_progress';
  const available = complete && record.exists !== false;
  const action = (key, label, symbol, extra = {}) => ({ key, label, symbol, ...extra });
  const copy = [
    action('copy-url', t('复制下载链接'), 'copy'),
    action('copy-name', t('复制文件名'), 'file'),
  ];
  if (complete) copy.push(action('copy-path', t('复制本地路径'), 'folder'));
  const controls = active
    ? [
        action(
          record.paused ? 'resume' : 'pause',
          record.paused ? t('继续下载') : t('暂停下载'),
          record.paused ? 'play' : 'pause',
        ),
        action('cancel', t('取消下载'), 'close'),
      ]
    : [
        ...(complete
          ? [
              action('open', t('打开文件'), 'external', { disabled: !available }),
              action('show', t('在文件夹中显示'), 'folder', { disabled: !available }),
            ]
          : []),
        ...(!complete && record.canResume && !isCanceled(record)
          ? [action('resume', t('继续下载'), 'play')]
          : []),
        action('retry', t('重新下载'), 'refresh'),
      ];
  if (/^https?:\/\//.test(record.matchContext?.referrer || ''))
    controls.push(action('source', t('打开来源网页'), 'external'));
  const manage = [
    action('report', t('下载报告'), 'chart'),
    ...(complete && isTorrent(record)
      ? [
          action(
            'send-torrent',
            downloader ? t('发送到 {0}', downloader.name) : t('绑定下载器…'),
            'external',
            { disabled: !available },
          ),
        ]
      : []),
    action('rule', t('按此创建归档规则'), 'rules'),
    action('test-rule', t('测试规则'), 'play'),
    action('detail', t('查看任务详情'), 'info'),
  ];
  const removal = active
    ? []
    : [
        record.trashedAt
          ? action('restore', t('还原任务'), 'up')
          : action('trash', t('仅移除任务'), 'inbox', { hint: t('保留文件') }),
        action('erase', t('清除浏览器记录…'), 'close', { hint: t('保留文件') }),
      ];
  if (complete)
    removal.push(
      action('delete', t('删除本地文件…'), 'trash', {
        danger: true,
        disabled: !available,
        hint: available ? t('需确认') : t('文件不存在'),
      }),
    );
  return [copy, controls, manage, removal].filter((group) => group.length);
}
