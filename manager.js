import { t, getLocale } from './i18n.js';
import { basename, recordStatus, validateRule, extensionsOf } from './engine.js';
import {
  h,
  icon,
  request,
  fileIcon,
  formatBytes,
  formatTime,
  badge,
  applyTheme,
  toggleTheme,
} from './ui.js';
import { evaluateUI } from './evaluator.js';
import { initDownloadUI } from './download-ui.js';
import { matchesTaskView, taskName } from './task-view.js';
import { initFeatures } from './features.js';
import { initRuleWorkbench } from './rule-workbench.js';
import { FILE_TYPES, TYPE_BY_ID } from './file-types.js';
import { copyDownloadValue } from './download-info.js';
import { isTorrent } from './downloader.js';
import { sendTorrentFromUI } from './downloader-ui.js';
import { downloadState, isCanceled } from './download-state.js';
import { initTaskMenu } from './task-menu.js';
import { initOnboarding } from './onboarding.js';
applyTheme();
document.querySelectorAll('[data-icon]').forEach((el) => {
  el.innerHTML = icon(el.dataset.icon);
});
const $ = (selector) => document.querySelector(selector);
$('#appVersion').textContent = chrome.runtime.getManifest().version;
let state = { config: { enabled: true, rules: [] }, records: [] };
let current = location.hash.slice(1) || 'all';
let refreshPending = false;
let refreshAgain = false;
let toastTimer;
let previewStartTime;
let initialRuleFrom = new URL(location.href).searchParams.get('ruleFrom');
let initialTestFrom = new URL(location.href).searchParams.get('testFrom');
const views = {
  all: [t('所有任务'), 'download', ''],
  recent: [t('最近'), 'clock', ''],
  active: [t('下载中'), 'download', ''],
  paused: [t('已暂停'), 'pause', ''],
  complete: [t('已完成'), 'check', ''],
  image: [t('图片'), 'image', ''],
  video: [t('视频'), 'play', ''],
  audio: [t('音频'), 'play', ''],
  document: [t('文档'), 'file', ''],
  archive: [t('压缩包'), 'archive', ''],
  installer: [t('安装包'), 'app', ''],
  ...Object.fromEntries(
    FILE_TYPES.slice(6).map((type) => [type.id, [t(type.name), type.icon, '']]),
  ),
  other: [t('其他'), 'file', ''],
  failed: [t('中断'), 'info', ''],
  canceled: [t('已取消'), 'close', ''],
  trash: [t('回收站'), 'trash', ''],
  archived: [t('已归档'), 'folder', ''],
  unmatched: [t('未归档'), 'inbox', ''],
  batch: [t('新建任务与队列'), 'plus', t('粘贴链接或范围地址，按并发限制依次下载。')],
  resources: [t('资源嗅探'), 'search', t('选择网页，发现可下载的链接、图片和音视频。')],
  settings: [t('设置'), 'rules', t('下载界面、队列、通知与规则备份。')],
  rules: [t('归档规则'), 'rules', t('按条件设置文件的保存目录与名称。')],
};
const filteredFor = matchesTaskView;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 3500);
}
function renderNavigation() {
  const primary = [
    'all',
    'recent',
    'active',
    'paused',
    'complete',
    'image',
    'video',
    'audio',
    'document',
    'archive',
    'installer',
    'other',
    'failed',
    'canceled',
    'trash',
  ];
  const tools = ['resources', 'batch', 'settings'];
  const more = FILE_TYPES.slice(6).map((type) => type.id);
  const moreOpen = $('#moreFileTypes')?.open || more.includes(current);
  const link = (key) => {
    const [title, symbol] = views[key];
    const child = Object.hasOwn(TYPE_BY_ID, key) || key === 'other';
    return `<a class="nav-item ${child ? 'nav-child' : ''} ${current === key ? 'active' : ''}" href="#${key}" ${current === key ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${title}</span><span class="nav-count">${tools.includes(key) ? '' : state.records.filter((r) => filteredFor(r, key)).length}</span></a>`;
  };
  $('#navigation').innerHTML =
    primary
      .map(
        (key) =>
          (key === 'other'
            ? `<details id="moreFileTypes" ${moreOpen ? 'open' : ''}><summary>${t('更多类型')}</summary>${more.map(link).join('')}</details>`
            : '') + link(key),
      )
      .join('') +
    '<div class="nav-tools">' +
    tools.map(link).join('') +
    '</div>';
  $('#rulesNav').classList.toggle('active', current === 'rules');
  $('#rulesNav').setAttribute('aria-current', current === 'rules' ? 'page' : 'false');
  $('#ruleCount').textContent = state.config.rules.length;
  $('#autoToggle').setAttribute('aria-checked', String(state.config.enabled));
  $('#autoHint').textContent = state.config.enabled
    ? t('新下载自动放入对应目录')
    : t('新下载保持浏览器默认位置');
}
function render() {
  if (!views[current]) current = 'all';
  const [title, , description] = views[current];
  $('#pageTitle').textContent = title;
  $('#breadcrumbCurrent').textContent = title;
  $('#pageDescription').textContent = description;
  const rulesView = current === 'rules';
  const special = ['batch', 'resources', 'settings'].includes(current);
  $('#featureView').hidden = !special;
  $('#addRule').hidden = special;
  $('.list-toolbar').hidden = !rulesView;
  $('.page-heading').hidden = !rulesView && !special;
  document.body.classList.toggle('tasks-view', !rulesView && !special);
  $('#downloadsView').hidden = rulesView || special;
  $('#rulesView').hidden = !rulesView;
  $('#search').placeholder = rulesView ? t('搜索规则、类型或目录') : t('搜索文件、来源或目录');
  $('#search').setAttribute('aria-label', $('#search').placeholder);
  renderNavigation();
  if (rulesView) renderRules();
  else if (special) features.render(current);
  else downloads.render(current);
  workbench.renderTools();
  onboarding.render(current);
}
function conditions(rule) {
  return [
    rule.mime && `MIME：${rule.mime}`,
    rule.urlRegex && `URL：${rule.urlRegex}`,
    rule.condition && t('条件：{0}', rule.condition),
    rule.extensions &&
      rule.extensions
        .split(', ')
        .map((x) => `.${x}`)
        .join('  '),
    rule.domain && t('域名：{0}', rule.domain),
    rule.keyword && t('名称包含：{0}', rule.keyword),
    rule.regex && t('正则：{0}', rule.regex),
  ]
    .filter(Boolean)
    .join(' · ');
}
function renderRules() {
  $('#ruleOrderHint').textContent = t(
    '从上往下看，按{0}符合条件的规则保存。同一条规则里的条件都要满足。',
    state.config.matchMode === 'last' ? t('最后一条') : t('第一条'),
  );
  const query = $('#search').value.trim().toLowerCase();
  const rules = state.config.rules.filter((rule) =>
    [rule.name, rule.folder, conditions(rule)].some((s) => s.toLowerCase().includes(query)),
  );
  $('#listLabel').innerHTML =
    `${t('匹配优先级')}<span>${t('{0} 条已启用', state.config.rules.filter((r) => r.enabled).length)}</span>`;
  $('#ruleList').innerHTML = rules.length
    ? rules
        .map((rule) => {
          const index = state.config.rules.indexOf(rule);
          const symbol =
            {
              documents: 'file',
              images: 'image',
              archives: 'archive',
              installers: 'app',
              media: 'play',
            }[rule.id] || 'folder';
          return `<article class="rule-card ${rule.enabled ? '' : 'disabled'}"><span class="rule-order">${String(index + 1).padStart(2, '0')}</span><span class="rule-symbol">${icon(symbol)}</span><div class="rule-body"><div class="rule-heading"><h3>${h(rule.name)}</h3>${!rule.enabled ? `<span class="mini-label">${t('已停用')}</span>` : ''}</div><p class="rule-conditions">${h(conditions(rule))}</p><div class="rule-destination">${icon('arrow')}<span>${rule.action === 'keep' ? t('保留默认位置') : t('Chrome 下载文件夹 / ') + (state.config.archiveRoot ? h(state.config.archiveRoot) + ' / ' : '') + h(rule.pathTemplate || [rule.folder, rule.filenameTemplate || '{filename}'].filter(Boolean).join('/'))}</span></div></div><div class="rule-controls"><div class="move-controls"><button class="icon-button" data-move="${h(rule.id)}" data-direction="up" aria-label="${t('上移 {0}', h(rule.name))}" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button><button class="icon-button" data-move="${h(rule.id)}" data-direction="down" aria-label="${t('下移 {0}', h(rule.name))}" ${index === state.config.rules.length - 1 ? 'disabled' : ''}>${icon('down')}</button></div><button class="icon-button" data-edit="${h(rule.id)}" aria-label="${t('编辑 {0}', h(rule.name))}" title="${t('编辑规则')}">${icon('edit')}</button><button class="switch" role="switch" aria-label="${t('启用 {0} 规则', h(rule.name))}" aria-checked="${rule.enabled}" data-toggle="${h(rule.id)}"><span></span></button></div></article>`;
        })
        .join('')
    : `<div class="empty-state"><div class="empty-art">${icon('rules')}</div><h2>${query ? t('没有找到相关规则') : t('写下第一条归档规则')}</h2><p>${query ? t('换一个名称或目录试试。') : t('选择文件类型，再给它一个专属目录。')}</p><button class="button" data-add>${t('新建规则')}</button></div>`;
}
async function refresh() {
  if (refreshPending) {
    refreshAgain = true;
    return;
  }
  refreshPending = true;
  try {
    state = await request('GET_STATE');
    $('#loadError').hidden = true;
    render();
    if (initialRuleFrom !== null) {
      const record = state.records.find((item) => item.id === Number(initialRuleFrom));
      initialRuleFrom = null;
      const url = new URL(location.href);
      url.searchParams.delete('ruleFrom');
      history.replaceState(null, '', url);
      if (record) workbench.createFromRecord(record);
      else toast(t('这条下载记录已经不存在'));
    }
    if (initialTestFrom !== null) {
      const record = state.records.find((item) => item.id === Number(initialTestFrom));
      initialTestFrom = null;
      const url = new URL(location.href);
      url.searchParams.delete('testFrom');
      history.replaceState(null, '', url);
      if (record) workbench.openLab(record);
      else toast(t('这条下载记录已经不存在'));
    }
  } catch (error) {
    $('#loadError').hidden = false;
    $('#loadError').textContent = error.message;
  } finally {
    refreshPending = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}
async function mutate(type, payload, message) {
  try {
    await request(type, payload);
    await refresh();
    if (message) toast(message);
  } catch (error) {
    toast(error.message);
  }
}
function formRule(preview = false) {
  const values = Object.fromEntries(new FormData($('#ruleForm')));
  if (preview && !values.name.trim()) values.name = t('新规则');
  if ($('#ruleByMonth').checked && !/(^|\/)\{year\}-\{month\}$/.test(values.folder))
    values.folder = [values.folder.replace(/\/+$/, ''), '{year}-{month}'].filter(Boolean).join('/');
  values.enabled = values.enabled === 'true';
  values.asFilter = values.asFilter === 'true';
  return validateRule(values);
}
let previewGeneration = 0;
async function previewRule() {
  const generation = ++previewGeneration,
    output = $('#rulePreview');
  $('#ruleSampleName').textContent = t('示例：{0}', $('#sampleFilename').value || 'example.pdf');
  output.classList.remove('matched');
  try {
    const rule = formRule(true),
      item = {
        filename: $('#sampleFilename').value || 'example.pdf',
        url: $('#sampleSource').value,
        startTime: previewStartTime || new Date().toISOString(),
      };
    const draft = { ...rule, id: rule.id || '_draft' },
      rules = rule.id
        ? state.config.rules.map((r) => (r.id === rule.id ? draft : r))
        : [draft, ...state.config.rules];
    const { single: result, actual } = await evaluateUI('previewRule', {
      item,
      rule,
      config: { ...state.config, rules },
    });
    if (generation !== previewGeneration) return;
    output.textContent =
      result.kind === 'matched'
        ? t('会保存到：Chrome 下载文件夹 / {0}', result.target)
        : result.kind === 'excluded'
          ? t('会存到 Chrome 默认的下载文件夹')
          : result.kind === 'error'
            ? result.errors?.[0]?.error || result.error || t('规则执行失败')
            : t('这个文件不符合这条规则，可以换个文件或改一下条件。');
    if (result.kind === 'matched' && actual.kind === 'matched' && actual.ruleId !== draft.id)
      output.textContent += t(
        '。按现在的规则顺序，会用「{0}」。可以调整一下顺序。',
        actual.ruleName,
      );
    if (!rule.enabled) output.textContent += t(' 这条规则目前没开启。');
    if (!state.config.enabled) output.textContent += t(' 自动归档还没开启。');
    output.classList.toggle('matched', result.kind === 'matched');
  } catch (error) {
    if (generation === previewGeneration) output.textContent = error.message;
  }
}
function editRule(id, seed = {}, sample = {}) {
  const rule = state.config.rules.find((rule) => rule.id === id);
  const form = $('#ruleForm');
  form.reset();
  const initial = rule || {
    id: '',
    name: '',
    enabled: true,
    extensions: '',
    domain: '',
    keyword: '',
    regex: '',
    folder: '',
    ...seed,
  };
  for (const [key, value] of Object.entries(initial))
    if (form.elements.namedItem(key)) form.elements.namedItem(key).value = String(value);
  $('#ruleByMonth').checked = /(^|\/)\{year\}-\{month\}$/.test(initial.folder || '');
  if ($('#ruleByMonth').checked)
    form.elements.folder.value = initial.folder.replace(/\/?\{year\}-\{month\}$/, '');
  const extensions = extensionsOf(initial.extensions).join(',');
  $('#ruleFileType').value =
    FILE_TYPES.find((type) => extensionsOf(type.extensions).join(',') === extensions)?.id || '';
  $('#ruleScope').open = Boolean(initial.domain || initial.keyword);
  $('#ruleAdvancedMatch').open =
    [
      'regex',
      'mime',
      'urlRegex',
      'finalUrlRegex',
      'referrerRegex',
      'tabUrlRegex',
      'condition',
      'reference',
      'asFilter',
    ].some((key) => Boolean(initial[key])) ||
    Boolean(initial.regexFlags && initial.regexFlags !== 'i');
  $('#ruleAdvancedSave').open = Boolean(
    initial.pathTemplate ||
      (initial.filenameTemplate && initial.filenameTemplate !== '{filename}') ||
      (initial.action && initial.action !== 'archive') ||
      (initial.postAction && initial.postAction !== 'none') ||
      (initial.conflictAction && initial.conflictAction !== 'uniquify'),
  );
  $('#ruleSampleOptions').open = false;
  $('#sampleFilename').value =
    sample.filename || `example.${(initial.extensions || '').split(',')[0].trim() || 'pdf'}`;
  $('#sampleSource').value = sample.url || `https://${initial.domain || 'example.com'}/file`;
  previewStartTime = sample.startTime;
  $('#ruleDialogTitle').textContent = rule ? t('编辑归档规则') : t('新建归档规则');
  $('#deleteRule').hidden = !rule;
  $('#formError').textContent = '';
  $('#ruleDialog').showModal();
  previewRule();
  form.elements.namedItem('name').focus();
}
let detailedId = null,
  detailMarkup = '';
function showDetail(id, count = 1) {
  const sameTask = id === detailedId;
  if (!sameTask) {
    $('#detailDialog').scrollTop = 0;
    detailedId = id;
  }
  const record = state.records.find((record) => record.id === id);
  document.body.dataset.hasSelection = String(Boolean(record));
  if (!record) {
    detailMarkup = '';
    $('#detailContent').innerHTML =
      `<div class="inspector-empty">${icon('file')}<p>${t('选择一个任务')}</p><span>${t('查看路径、来源和操作')}</span></div>`;
    return;
  }
  const noteInput = sameTask ? $('#recordNote') : null;
  const draft = noteInput && noteInput.value !== noteInput.defaultValue ? noteInput.value : null;
  const expanded = sameTask && $('.inspector-more')?.open;
  const focused =
    sameTask && $('#detailContent').contains(document.activeElement)
      ? document.activeElement.id
      : null;
  const status = recordStatus(record),
    note =
      record.state === 'interrupted'
        ? downloadState(record).detail
        : status === 'changed'
          ? t('实际保存位置与归档规则不同。')
          : record.decision?.kind === 'error'
            ? t('归档计算失败，文件保存在默认位置。')
            : '';
  const facts = [
    [t('文件名'), taskName(record)],
    [t('下载地址'), record.source || t('浏览器未提供来源')],
    [t('保存位置'), record.filename || t('等待文件名')],
    [t('归档规则'), record.decision?.ruleName || t('未匹配')],
    [t('目标路径'), record.decision?.target || t('浏览器默认位置')],
    [t('添加时间'), new Date(record.startTime).toLocaleString(getLocale())],
    [t('文件大小'), formatBytes(record.totalBytes > 0 ? record.totalBytes : record.bytesReceived)],
    ...(!isCanceled(record) && record.state === 'interrupted' && record.error
      ? [[t('浏览器错误码'), record.error]]
      : []),
  ];
  const markup = `<div class="inspector-heading"><strong>${count > 1 ? t('已选择 ') + count + t(' 项') : t('任务详情')}</strong><button class="icon-button" id="clearSelection" aria-label="${t('关闭下载详情')}">${icon('close')}</button></div><div class="inspector-file"><span class="file-symbol">${icon(fileIcon(record.filename))}</span><h2>${h(taskName(record))}</h2></div>${badge(record)}${note ? `<p class="${isCanceled(record) ? 'inspector-note' : 'inspector-warning'}">${h(note)}</p>` : ''}<div class="inspector-actions">${downloads.actions(record)}<button class="button" data-show="${id}" ${record.exists === false || record.state !== 'complete' ? 'disabled' : ''}>${t('{0}在文件夹中显示', icon('folder'))}</button><button class="button" data-copy-source="${id}">${t('{0}复制下载链接', icon('copy'))}</button></div><dl class="detail-rows">${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${h(value)}</dd></div>`).join('')}</dl><label class="field">${t('备注')}<textarea id="recordNote" data-id="${id}" rows="3" maxlength="2000" placeholder="${t('添加备注…')}">${h(record.note || '')}</textarea></label><button class="text-button" id="saveRecordNote" data-id="${id}">${t('保存备注')}</button><details class="inspector-more"><summary>${t('归档与记录操作')}</summary><button class="text-button" data-create-rule="${id}">${t('按此创建归档规则')}</button><button class="text-button" data-test-rule="${id}">${t('测试规则')}</button><button class="text-button" data-task-action="${record.trashedAt ? 'restore' : 'trash'}" data-task-id="${id}" ${record.state === 'in_progress' ? 'disabled' : ''}>${record.trashedAt ? t('还原任务') : t('仅移除任务')}</button><button class="text-button" data-task-action="erase" data-task-id="${id}" ${record.state === 'in_progress' ? 'disabled' : ''}>${t('清除浏览器记录')}</button><button class="text-button danger" data-task-action="delete" data-task-id="${id}" ${record.state !== 'complete' || record.exists === false ? 'disabled' : ''}>${t('删除本地文件…')}</button></details>`;
  const signature = markup + (state.downloader?.bindingId || '');
  if (signature === detailMarkup) return;
  detailMarkup = signature;
  $('#detailContent').innerHTML = markup;
  if (draft !== null) $('#recordNote').value = draft;
  $('.inspector-more').open = Boolean(expanded);
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  const reportLink = document.createElement('a');
  reportLink.className = 'button';
  reportLink.href = chrome.runtime.getURL(`report.html?id=${id}`);
  reportLink.target = '_blank';
  reportLink.textContent = t('下载报告');
  $('#detailContent .inspector-actions').append(reportLink);
  if (record.state === 'complete' && isTorrent(record)) {
    $('#detailContent .inspector-actions').insertAdjacentHTML(
      'beforeend',
      `<button class="button" data-send-torrent="${id}" ${record.exists === false ? 'disabled' : ''}>${h(state.downloader ? t('发送到 ') + state.downloader.name : t('绑定下载器…'))}</button>`,
    );
  }
}
$('#ruleFileType').insertAdjacentHTML(
  'beforeend',
  FILE_TYPES.map((type) => `<option value="${type.id}">${h(t(type.name))}</option>`).join(''),
);
$('#ruleFileType').addEventListener('change', () => {
  const type = TYPE_BY_ID[$('#ruleFileType').value];
  if (!type) return;
  const form = $('#ruleForm');
  form.elements.extensions.value = extensionsOf(type.extensions).join(', ');
  if (!form.elements.name.value.trim()) form.elements.name.value = t(type.name);
  if (!form.elements.folder.value.trim()) form.elements.folder.value = t(type.name);
  $('#sampleFilename').value = `example.${extensionsOf(type.extensions)[0]}`;
  void previewRule();
});
$('#ruleByMonth').addEventListener('change', () => void previewRule());
$('#ruleForm').elements.extensions.addEventListener('input', () => {
  $('#ruleFileType').value = '';
  const extension = extensionsOf($('#ruleForm').elements.extensions.value)[0];
  if (extension && /^example\./.test($('#sampleFilename').value))
    $('#sampleFilename').value = `example.${extension}`;
});
$('#ruleForm').elements.domain.addEventListener('change', () => {
  const domain = $('#ruleForm').elements.domain.value.trim();
  $('#sampleSource').value = `https://${domain || 'example.com'}/file`;
  void previewRule();
});
$('#ruleForm').addEventListener('input', (event) => {
  if (event.target.id !== 'ruleByMonth') void previewRule();
});
$('#ruleForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#saveRule').disabled = true;
  try {
    const rule = formRule();
    const overwriteConfirmed =
      rule.conflictAction === 'overwrite'
        ? confirm(t('此规则会覆盖目标目录中的同名文件。确认保存并启用覆盖？'))
        : false;
    if (rule.conflictAction === 'overwrite' && !overwriteConfirmed) return;
    await request('SAVE_RULE', { rule, overwriteConfirmed });
    $('#ruleDialog').close();
    await refresh();
    toast(t('规则已保存，将用于之后的新下载'));
  } catch (error) {
    $('#formError').textContent = error.message;
  } finally {
    $('#saveRule').disabled = false;
  }
});
$('#deleteRule').addEventListener('click', async () => {
  const id = $('#ruleForm').elements.namedItem('id').value;
  if (!confirm(t('删除这条归档规则？已下载的文件不会改变。'))) return;
  try {
    await request('DELETE_RULE', { id });
    $('#ruleDialog').close();
    await refresh();
    toast(t('规则已删除'));
  } catch (error) {
    $('#formError').textContent = error.message;
  }
});
$('#autoToggle').addEventListener('click', () =>
  mutate(
    'SET_ENABLED',
    { enabled: !state.config.enabled },
    state.config.enabled ? t('自动归档已暂停') : t('自动归档已开启'),
  ),
);
$('#addRule').addEventListener('click', () => editRule());
$('#themeToggle').addEventListener('click', toggleTheme);
$('#howItWorks').addEventListener('click', () => $('#helpDialog').showModal());
$('#search').addEventListener('input', render);
window.addEventListener('hashchange', () => {
  current = location.hash.slice(1) || 'all';
  $('#search').value = '';
  render();
});
document.addEventListener('click', async (event) => {
  if (event.target.closest('input,select,textarea,label')) return;
  const target = event.target.closest('button, [data-detail]');
  if (!target) return;
  if (target.dataset.close) document.getElementById(target.dataset.close).close();
  if (target.hasAttribute('data-go-rules')) location.hash = 'rules';
  if (target.hasAttribute('data-add')) editRule();
  if (target.dataset.edit) editRule(target.dataset.edit);
  if (target.dataset.toggle) {
    const rule = state.config.rules.find((r) => r.id === target.dataset.toggle),
      enabled = target.getAttribute('aria-checked') !== 'true';
    const overwriteConfirmed =
      enabled && rule?.conflictAction === 'overwrite'
        ? confirm(t('启用后会覆盖同名文件，继续？'))
        : false;
    if (!enabled || rule?.conflictAction !== 'overwrite' || overwriteConfirmed)
      await mutate('TOGGLE_RULE', { id: target.dataset.toggle, enabled, overwriteConfirmed });
  }
  if (target.dataset.move)
    await mutate('MOVE_RULE', { id: target.dataset.move, direction: target.dataset.direction });
  if (target.dataset.createRule || target.dataset.testRule) {
    const record = state.records.find(
      (r) => r.id === Number(target.dataset.createRule || target.dataset.testRule),
    );
    if (record) {
      if (target.dataset.createRule) workbench.createFromRecord(record);
      else workbench.openLab(record);
    }
  }
  if (target.dataset.show) {
    try {
      await chrome.downloads.show(Number(target.dataset.show));
    } catch {
      toast(t('文件不可用，可能已被移动或删除'));
    }
  }
  if (target.id === 'saveRecordNote') {
    const result = await request('UPDATE_RECORDS', {
      ids: [Number(target.dataset.id)],
      action: 'note',
      note: $('#recordNote').value,
    });
    toast(result.results[0]?.ok ? t('备注已保存') : result.results[0]?.error || t('保存失败'));
  }
  if (target.dataset.copySource) {
    try {
      await copyDownloadValue(Number(target.dataset.copySource), 'url');
      toast(t('下载地址已复制'));
    } catch (error) {
      toast(error.message);
    }
  }
  if (target.dataset.sendTorrent) {
    try {
      await sendTorrentFromUI(Number(target.dataset.sendTorrent), {
        downloader: state.downloader,
        toast,
        configure: async () => {
          location.hash = 'settings';
        },
      });
    } catch (error) {
      toast(error.message);
    }
  }
});
document.addEventListener('keydown', (event) => {
  if (
    event.key === '/' &&
    !event.target.matches('input, textarea') &&
    !document.querySelector('dialog[open]')
  ) {
    event.preventDefault();
    $('#search').focus();
  }
});
document.querySelectorAll('dialog').forEach((dialog) =>
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  }),
);
if (globalThis.chrome?.storage) chrome.storage.onChanged.addListener(() => void refresh());
setInterval(() => {
  if (
    !document.hidden &&
    (current === 'batch' || state.records.some((r) => r.state === 'in_progress'))
  )
    void refresh();
}, 1500);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
const taskMenu = initTaskMenu({
  getState: () => state,
  refresh,
  toast,
  navigate: (type, id) => {
    if (type === 'settings') {
      location.hash = 'settings';
      return;
    }
    const record = state.records.find((item) => item.id === id);
    if (!record) throw new Error(t('这条下载记录已经不存在'));
    if (type === 'rule') workbench.createFromRecord(record);
    else if (type === 'test-rule') workbench.openLab(record);
    else downloads.select(id);
  },
});
const downloads = initDownloadUI({
  getState: () => state,
  refresh,
  toast,
  showDetail,
  menu: taskMenu,
});
const features = initFeatures({ getState: () => state, refresh, toast });
const workbench = initRuleWorkbench({ getState: () => state, refresh, editRule, toast });
const onboarding = initOnboarding({ getState: () => state, refresh, toast });
void refresh();
