import { t, getLocale, getLanguagePreference, setLanguagePreference } from './i18n.js';
import { h, formatBytes, request } from './ui.js';
import { expandUrls } from './tasks.js';
import { evaluateUI } from './evaluator.js';
import { validateArchiveRoot } from './engine.js';
import { defaultRules } from './file-types.js';
import { downloaderSettingsMarkup, bindDownloaderSettings } from './downloader-ui.js';
export function initFeatures({ getState, refresh, toast }) {
  const $ = (s) => document.querySelector(s);
  let mounted = '',
    tabs = [],
    capture = { targets: [], resources: {} },
    resourceGeneration = 0,
    visibleResources = [],
    resourceSelection = new Set();
  const run = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      toast(error.message);
      return null;
    }
  };
  function batchMarkup() {
    return `<div class="feature-columns"><section class="feature-panel"><h2>${t('新建一批下载')}</h2><label class="field">${t('每行一个链接')}<textarea id="batchUrls" rows="7" maxlength="256000" spellcheck="false" placeholder="https://example.com/report-[001:020].pdf"></textarea><span class="field-hint">${t('支持 [001:020]、[a:z]、[1:20:2]；最多 1000 个链接，自动去重。')}</span></label><div class="row wrap"><button id="pasteUrls" class="button">${t('从剪贴板粘贴')}</button><label class="button file-label">${t('导入链接文件')}<input id="urlFile" type="file" accept=".txt,.csv,.json"></label></div><label class="field">${t('本批保存路径模板')}<input id="batchTemplate" placeholder="${t('留空遵循归档规则；例如 项目/{num:3}_{filename}')}"><span class="field-hint">${t('填写后本批优先使用这个路径。会自动加上设置中的归档子目录。')}</span></label><label class="field">${t('开始时间')}<input id="batchSchedule" type="datetime-local"><span class="field-hint">${t('留空立即入队；定时任务在浏览器运行时触发，可能延迟约 1 分钟。')}</span></label><div id="batchPreview" class="preview-box">${t('输入链接后预览')}</div><button id="startBatch" class="button primary">${t('加入下载队列')}</button></section><section class="feature-panel"><div class="row between"><h2>${t('下载队列')}</h2><button id="clearQueue" class="text-button">${t('清理已结束任务')}</button></div><p id="queueSummary" class="field-hint"></p><div class="row"><button id="queuePause" class="button">${t('暂停派发')}</button><button id="queueResume" class="button">${t('继续派发')}</button><a class="text-button" href="#settings">${t('调整并发')}</a></div><div id="queueList" class="queue-list"></div></section></div>`;
  }
  function previewBatch() {
    try {
      const urls = expandUrls($('#batchUrls').value);
      $('#batchPreview').textContent = urls.length
        ? t(
            '{0} 个链接\n{1}{2}',
            urls.length,
            urls.slice(0, 5).join('\n'),
            urls.length > 5 ? '\n…' : '',
          )
        : t('输入链接后预览');
      return urls;
    } catch (error) {
      $('#batchPreview').textContent = error.message;
      return null;
    }
  }
  function bindBatch() {
    $('#batchUrls').oninput = previewBatch;
    $('#pasteUrls').onclick = () =>
      run(async () => {
        $('#batchUrls').value = await navigator.clipboard.readText();
        previewBatch();
      });
    $('#urlFile').onchange = () =>
      run(async () => {
        const file = $('#urlFile').files[0];
        if (!file) return;
        if (file.size > 256000) throw new Error(t('链接文件最多 256 KB'));
        const text = await file.text();
        if (file.name.endsWith('.json')) {
          const value = JSON.parse(text);
          if (!Array.isArray(value)) throw new Error(t('JSON 链接文件须为数组'));
          $('#batchUrls').value = value.map((v) => (typeof v === 'string' ? v : v.url)).join('\n');
        } else $('#batchUrls').value = text;
        previewBatch();
      });
    $('#startBatch').onclick = () =>
      run(async () => {
        const urls = previewBatch();
        if (!urls?.length) throw new Error(t('请先输入有效链接'));
        $('#startBatch').disabled = true;
        try {
          const result = await request('ADD_BATCH', {
            text: $('#batchUrls').value,
            template: $('#batchTemplate').value,
            scheduledAt: $('#batchSchedule').value || null,
          });
          toast(t('已加入 {0} 个任务', result.added));
          $('#batchUrls').value = '';
          previewBatch();
          await refresh();
        } finally {
          $('#startBatch').disabled = false;
        }
      });
    for (const [id, action] of [
      ['queuePause', 'pause'],
      ['queueResume', 'resume'],
      ['clearQueue', 'clear'],
    ])
      $('#' + id).onclick = () =>
        run(async () => {
          await request('QUEUE_ACTION', { action });
          await refresh();
        });
  }
  function renderQueue() {
    const { queue = { items: [] }, config } = getState();
    if (!$('#queueList')) return;
    const counts = {};
    for (const task of queue.items) counts[task.state] = (counts[task.state] || 0) + 1;
    $('#queueSummary').textContent = t(
      '{0} · 并发 {1} / 每站 {2} · 等待 {3} · 进行 {4} · 失败 {5}',
      queue.paused ? t('派发已暂停') : t('自动派发中'),
      config.queueConcurrency,
      config.perHostConcurrency,
      counts.waiting || 0,
      counts.running || 0,
      counts.failed || 0,
    );
    const labels = {
      waiting: t('等待'),
      starting: t('启动中'),
      running: t('下载中'),
      complete: t('完成'),
      failed: t('失败'),
      canceled: t('取消'),
    };
    $('#queueList').innerHTML =
      queue.items
        .slice()
        .reverse()
        .slice(0, 100)
        .map(
          (task) =>
            `<article class="queue-row"><div><strong>${h(task.metadata?.filename || urlName(task.url) || task.host)}</strong><p>${h(task.host)} · ${labels[task.state]}${task.paused ? t('（已暂停）') : ''}${task.scheduledAt > Date.now() ? ` · ${h(new Date(task.scheduledAt).toLocaleString(getLocale()))}` : ''}</p>${task.error ? `<p class="form-error">${h(task.error)}</p>` : ''}</div>${task.state === 'failed' ? `<button class="button" data-queue-action="retry" data-queue-id="${task.id}">${t('重试')}</button>` : ['waiting', 'starting', 'running'].includes(task.state) ? `<button class="text-button" data-queue-action="cancel" data-queue-id="${task.id}">${t('取消')}</button>` : ''}</article>`,
        )
        .join('') ||
      `<div class="empty-state"><h3>${t('队列为空')}</h3><p>${t('添加链接，或从资源发现中选一批文件。')}</p></div>`;
  }
  function urlName(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch {
      return '';
    }
  }
  function resourcesMarkup() {
    return `<section class="feature-panel"><div class="row between"><h2>${t('选择要检查的网页')}</h2><button class="text-button" id="refreshTabs">${t('刷新标签页')}</button></div><div id="tabChoices" class="tab-choices"></div><div class="row wrap"><button class="button primary" id="scanResources">${t('扫描已选网页')}</button><button class="button" id="watchResources">${t('捕获后续网络资源')}</button><button class="text-button" id="stopCapture">${t('停止捕获')}</button><button class="text-button" id="clearResources">${t('清空发现结果')}</button></div><p class="field-hint">${t('只扫描和捕获选中的标签页，支持跨站 CDN 资源。开启捕获后，回到网页滚动、刷新或播放媒体；点击“停止捕获”即可结束。Chrome 受限页面无法读取。')}</p><p id="captureStatus" role="status"></p></section><section class="feature-panel"><div class="resource-filters"><label class="field">${t('搜索')}<input id="resourceSearch" type="search" placeholder="${t('文件名、链接、描述')}"></label><label class="field">${t('类型')}<select id="resourceKind"><option value="">${t('全部类型')}</option><option value="image">${t('图片')}</option><option value="audio">${t('音频')}</option><option value="video">${t('视频')}</option><option value="document">${t('文档')}</option><option value="archive">${t('压缩包')}</option><option value="playlist">${t('播放清单')}</option><option value="other">${t('其他')}</option></select></label><label class="field">${t('最小宽度')}<input id="resourceWidth" type="number" min="0" value="0"></label><label class="field">${t('最小大小 KB')}<input id="resourceSize" type="number" min="0" value="0"></label><label class="field">${t('只看网页选区')}<select id="resourceSelected"><option value="">${t('全部')}</option><option value="yes">${t('网页选中的链接')}</option></select></label></div><details><summary>${t('正则筛选')}</summary><label class="field">${t('文件名或链接正则')}<input id="resourceRegex" placeholder="\\.(png|jpg)(\\?|$)"></label></details><div class="row wrap resource-actions"><label><input id="selectResources" type="checkbox">${t(' 选择筛选结果')}</label><span id="resourceCount"></span><input id="resourceTemplate" aria-label="${t('资源保存路径模板')}" placeholder="${t('可选：素材/{page_title}/{filename}')}"><button id="downloadResources" class="button primary">${t('下载已选资源')}</button><button id="copyResources" class="button">${t('复制链接')}</button></div><div id="resourceList" class="resource-grid"></div></section>`;
  }
  async function refreshTabs() {
    tabs = (await chrome.tabs.query({})).filter(
      (tab) => /^https?:/.test(tab.url || '') && !tab.incognito,
    );
    if (!$('#tabChoices')) return;
    const from = Number(new URL(location.href).searchParams.get('tab'));
    $('#tabChoices').innerHTML =
      tabs
        .map(
          (tab) =>
            `<label class="tab-choice"><input type="checkbox" name="resourceTab" value="${tab.id}" ${tab.id === from || tabs.length === 1 ? 'checked' : ''}><span><strong>${h(tab.title || tab.url)}</strong><small>${h(new URL(tab.url).host)}</small></span></label>`,
        )
        .join('') || `<p>${t('没有可扫描的网页，请先打开一个 HTTP(S) 页面。')}</p>`;
  }
  const selectedTabs = () =>
    Array.from(document.querySelectorAll('[name="resourceTab"]:checked'), (input) =>
      Number(input.value),
    );
  async function reloadCapture() {
    const response = await request('GET_CAPTURE');
    capture = response.capture;
    if (mounted === 'resources') await renderResources();
  }
  function bindResources() {
    $('#refreshTabs').onclick = () => run(refreshTabs);
    void run(refreshTabs);
    void run(reloadCapture);
    $('#scanResources').onclick = () =>
      run(async () => {
        const ids = selectedTabs();
        if (!ids.length) throw new Error(t('先选择至少一个网页'));
        const origins = [
          ...new Set(
            tabs.filter((tab) => ids.includes(tab.id)).map((tab) => new URL(tab.url).origin + '/*'),
          ),
        ];
        $('#captureStatus').textContent = t('请在浏览器弹窗中允许所选站点访问。');
        if (!(await chrome.permissions.request({ origins })))
          throw new Error(t('未获站点访问权限'));
        $('#captureStatus').textContent = t('正在扫描所选网页…');
        const result = await request('SCAN_TABS', { tabIds: ids });
        capture = result.capture;
        await renderResources();
        if (result.failures.length)
          toast(t('{0} 个标签页扫描失败：{1}', result.failures.length, result.failures[0].error));
      });
    $('#watchResources').onclick = () =>
      run(async () => {
        const ids = selectedTabs();
        if (!ids.length) throw new Error(t('先选择至少一个网页'));
        $('#captureStatus').textContent = t('请在浏览器弹窗中允许网络捕获所需的站点访问。');
        if (!(await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })))
          throw new Error(t('网络捕获未获授权'));
        const result = await request('SET_CAPTURE', { tabIds: ids, enabled: true });
        capture = result.capture;
        await renderResources();
        toast(t('已开始捕获，回到网页滚动、刷新或播放媒体'));
      });
    $('#stopCapture').onclick = () =>
      run(async () => {
        capture = (await request('SET_CAPTURE', { tabIds: capture.targets, enabled: false }))
          .capture;
        await renderResources();
      });
    $('#clearResources').onclick = () =>
      run(async () => {
        capture = (await request('CLEAR_CAPTURE')).capture;
        resourceSelection.clear();
        await renderResources();
      });
    for (const id of [
      'resourceSearch',
      'resourceKind',
      'resourceWidth',
      'resourceSize',
      'resourceSelected',
      'resourceRegex',
    ])
      $('#' + id).oninput = () => void run(renderResources);
    $('#selectResources').onchange = (event) => {
      for (const r of visibleResources)
        event.target.checked ? resourceSelection.add(r.id) : resourceSelection.delete(r.id);
      void renderResources();
    };
    $('#downloadResources').onclick = () =>
      run(async () => {
        const items = Object.values(capture.resources)
          .flat()
          .filter((r) => resourceSelection.has(r.id));
        if (!items.length) throw new Error(t('先选择资源'));
        if (
          items.some((r) => r.kind === 'playlist') &&
          !confirm(t('播放清单只会保存清单文件，当前不合并媒体分片。继续？'))
        )
          return;
        const result = await request('ADD_BATCH', {
          items,
          template: $('#resourceTemplate').value,
        });
        toast(t('已加入 {0} 个资源', result.added));
        location.hash = 'batch';
      });
    $('#copyResources').onclick = () =>
      run(async () => {
        const items = Object.values(capture.resources)
          .flat()
          .filter((r) => resourceSelection.has(r.id));
        await navigator.clipboard.writeText(items.map((r) => r.url).join('\n'));
        toast(t('已复制 {0} 个链接', items.length));
      });
  }
  async function renderResources() {
    if (!$('#resourceList')) return;
    const gen = ++resourceGeneration;
    const query = $('#resourceSearch').value.toLowerCase(),
      kind = $('#resourceKind').value,
      width = Number($('#resourceWidth').value),
      size = Number($('#resourceSize').value) * 1024,
      selection = $('#resourceSelected').value,
      regex = $('#resourceRegex').value;
    const items = Object.values(capture.resources).flat();
    let shown = items.filter(
      (r) =>
        (!kind || r.kind === kind) &&
        (!width || r.width >= width) &&
        (!size || r.size >= size) &&
        (!selection || r.selected) &&
        [r.filename, r.url, r.linkText, r.linkTitle].some((value) =>
          String(value || '')
            .toLowerCase()
            .includes(query),
        ),
    );
    if (regex) {
      const ids = new Set(await evaluateUI('resourceFilter', { items: shown, regex }));
      shown = shown.filter((r) => ids.has(r.id));
    }
    if (gen !== resourceGeneration || !$('#resourceList')) return;
    visibleResources = shown;
    $('#captureStatus').textContent = t(
      '发现 {0} 个资源 · {1} · 无大小/尺寸信息的资源不参与对应下限筛选。',
      items.length,
      capture.targets.length
        ? t('正在捕获 ') + capture.targets.length + t(' 个标签页')
        : t('未开启持续捕获'),
    );
    $('#resourceCount').textContent = t(
      '筛选 {0} · 已选 {1}',
      shown.length,
      resourceSelection.size,
    );
    $('#resourceList').innerHTML =
      shown
        .slice(0, 300)
        .map(
          (r) =>
            `<label class="resource-card"><input type="checkbox" data-resource-id="${r.id}" ${resourceSelection.has(r.id) ? 'checked' : ''}><div class="resource-thumb">${r.kind === 'image' ? `<img src="${h(r.url)}" loading="lazy" referrerpolicy="no-referrer" alt="${h(r.filename)}">` : `<span>${h(r.kind.toUpperCase())}</span>`}</div><strong title="${h(r.url)}">${h(r.filename)}</strong><span>${h(r.linkText || r.linkTitle || r.pageTitle || '')}</span><small>${h(r.origin)}${r.width ? ` · ${r.width} × ${r.height}` : ''}${r.size ? ` · ${formatBytes(r.size)}` : ''}</small>${r.kind === 'playlist' ? `<small>${t('清单文件；不合并分片')}</small>` : ''}</label>`,
        )
        .join('') ||
      `<div class="empty-state"><h3>${t('暂无资源')}</h3><p>${t('选择网页并扫描，或调整筛选条件。')}</p></div>`;
    if (shown.length > 300)
      $('#resourceList').insertAdjacentHTML(
        'beforeend',
        `<p>${t('界面显示前 300 项；全选与下载操作覆盖全部筛选结果。')}</p>`,
      );
  }
  function archiveSettingsMarkup() {
    const rules = defaultRules();
    return `<section class="feature-panel archive-settings"><div class="row between wrap"><div><h2>${t('保存位置与默认分类')}</h2><p>${t('下载根目录 → 归档子目录 → 分类规则 → 文件名')}</p></div><div class="row wrap"><button class="text-button" data-open-setup>${t('重新查看使用引导')}</button><a class="button" href="#rules">${t('管理分类规则')}</a></div></div>
      <div class="root-settings-grid"><div><h3>${t('电脑上的下载根目录')}</h3><p>${t('跟随 Chrome 的下载位置。点击下方按钮，在打开的设置页中点「更改」选择文件夹。')}</p><div class="row wrap"><button id="chooseDownloadRoot" class="button">${t('选择下载根目录')}</button><button id="showDownloadRoot" class="text-button">${t('打开当前下载文件夹')}</button></div><p class="field-hint">${t('此位置用于所有 Chrome 下载；当前位置可在 Chrome 下载设置中查看。')}</p></div>
      <form id="archiveRootForm"><label class="field">${t('统一归档子目录')}<input name="archiveRoot" maxlength="256" value="${h(getState().config.archiveRoot || '')}" placeholder="${t('留空直接分类，或填 资料/下载')}"><span class="field-hint">${t('例如填「资料/下载」，所有归档规则和批量命名都会加上这个前缀。不要在规则里重复填写。')}</span></label><label class="field">${t('试一个文件')}<select id="archiveExample"><option value="report.pdf">${t('report.pdf · 文档')}</option><option value="photo.heic">${t('photo.heic · 图片')}</option><option value="book.epub">${t('book.epub · 电子书')}</option><option value="brand.woff2">${t('brand.woff2 · 字体')}</option><option value="scene.glb">${t('scene.glb · 模型')}</option><option value="data.parquet">${t('data.parquet · 数据')}</option><option value="app.ts">${t('app.ts · 代码')}</option></select></label><output id="archiveRootPreview" class="preview-box" aria-live="polite"></output><p id="archiveRootError" class="form-error" role="alert"></p><div class="row wrap"><button id="saveArchiveRoot" class="button primary" type="submit">${t('保存归档位置')}</button><span id="archiveRootStatus" class="field-hint" role="status"></span></div></form></div>
      <p class="field-hint">${t('只影响之后开始的下载，已有文件保持原位。普通下载未命中规则、被排除或暂停归档时，仍使用浏览器默认位置；显式批量命名继续生效。')}</p>
      <details class="default-catalogue"><summary>${t('默认 {0} 类 · {1} 种扩展名 · 查看支持范围', rules.length, new Set(rules.flatMap((rule) => rule.extensions.split(', '))).size)}</summary><div class="catalogue-grid">${rules.map((rule) => `<div><strong>${h(rule.name)}</strong><p>${h(rule.extensions)}</p></div>`).join('')}</div><div class="row wrap"><button id="supplementDefaults" class="button">${t('补充默认分类…')}</button><span class="field-hint">${t('先预览，补充到较低优先级；不替换现有规则，可撤销。')}</span></div></details></section>`;
  }
  function settingsMarkup() {
    const c = getState().config;
    return (
      `<section class="feature-panel"><h2>${t('数据与隐私')}</h2><p>${t('下载记录和报告保存在本机。为记录连接 IP，Nivra 会短暂观察 HTTP(S) 请求；网页资源扫描和外部下载器由你主动使用。规则只有手动备份时才进入 Chrome 同步。')}</p><a class="text-button" href="privacy.html" target="_blank" rel="noopener">${t('查看隐私政策')}</a></section>` +
      `<section class="feature-panel"><h2>${t('界面语言')}</h2><label class="field">${t('语言')}<select id="languageSelect"><option value="auto">${t('跟随浏览器')}</option><option value="en">English</option><option value="zh-CN">简体中文</option></select></label><p class="field-hint">${t('中文环境显示中文，其他语言显示英文。文件名和已有归档目录保持不变。')}</p></section>` +
      archiveSettingsMarkup() +
      downloaderSettingsMarkup(getState().downloader) +
      `<div class="feature-columns"><section class="feature-panel"><h2>${t('下载偏好')}</h2><form id="settingsForm"><label class="field">${t('多条规则都符合时')}<select name="matchMode"><option value="first" ${c.matchMode === 'first' ? 'selected' : ''}>${t('用第一条')}</option><option value="last" ${c.matchMode === 'last' ? 'selected' : ''}>${t('用最后一条')}</option></select></label><div class="form-grid"><label class="field">${t('队列总并发')}<input name="queueConcurrency" type="number" min="1" max="20" value="${c.queueConcurrency}"></label><label class="field">${t('每站并发')}<input name="perHostConcurrency" type="number" min="1" max="20" value="${c.perHostConcurrency}"></label></div><label class="check-field"><input name="notifications" type="checkbox" ${c.notifications ? 'checked' : ''}>${t(' 下载完成时通知')}</label><label class="check-field"><input name="replaceDownloadUI" type="checkbox" ${c.replaceDownloadUI ? 'checked' : ''}>${t(' 接管浏览器下载界面（使用 Nivra）')}</label><label class="check-field"><input name="autoOpenPanel" type="checkbox" ${c.autoOpenPanel ? 'checked' : ''}>${t(' 新下载自动展开进度面板')}</label><p class="field-hint">${t('管理页在前台时直接更新列表；其他页面下载时自动展开扩展面板。')}</p><label class="field">${t('自动清理本插件记录')}<input name="autoClearDays" type="number" min="0" max="3650" value="${c.autoClearDays}"><span class="field-hint">${t('单位：天。0 表示关闭；只清理已结束记录，磁盘文件和浏览器历史保留。')}</span></label><button class="button primary" type="submit">${t('保存偏好')}</button></form><hr><button id="openWindow" class="button">${t('作为独立窗口打开')}</button><p class="field-hint">${t('快捷键 Alt+Shift+D 打开工作台；更多快捷键可在浏览器扩展快捷键设置中配置。')}</p></section><section class="feature-panel"><h2>${t('规则云端备份')}</h2><p>${t('使用浏览器账号的扩展同步存储。需在 Chrome 开启同步；跨设备同步时间由浏览器决定。备份只含规则，不含下载文件与记录。')}</p><div class="row wrap"><button id="uploadSync" class="button">${t('上传并替换云端备份')}</button><button id="readSync" class="button">${t('读取云端，预览导入')}</button><button id="clearSync" class="text-button">${t('删除云端备份')}</button></div><p id="syncStatus" role="status"></p><hr><h2>${t('保存下载筛选器')}</h2><label class="field">${t('名称')}<input id="filterName" maxlength="60" placeholder="${t('例如：大于 100 MB 的视频')}"></label><label class="field">${t('条件')}<textarea id="filterCondition" rows="2" placeholder='*ext*.is([ext_video]) &amp;&amp; *size* &gt; mb(100)'></textarea></label><button id="saveFilter" class="button">${t('保存筛选器')}</button><div id="savedFilterList">${(c.savedFilters || []).map((f, i) => `<p class="row between"><span>${h(f.name)}</span><button class="text-button" data-delete-filter="${i}">${t('移除')}</button></p>`).join('')}</div><p class="field-hint">${t('保存后可在下载列表的筛选菜单中使用，也支持导入的 Chrono 筛选规则。')}</p></section></div>`
    );
  }
  function bindSettings() {
    $('#languageSelect').value = getLanguagePreference();
    $('#languageSelect').onchange = (event) => run(() => setLanguagePreference(event.target.value));
    bindDownloaderSettings({ config: getState().downloader, refresh, toast });
    let rootGeneration = 0;
    const previewRoot = async () => {
      const generation = ++rootGeneration;
      $('#archiveRootError').textContent = '';
      $('#archiveRootStatus').textContent =
        $('#archiveRootForm').archiveRoot.value === (getState().config.archiveRoot || '')
          ? t('已保存的设置')
          : t('预览中，尚未保存');
      try {
        const archiveRoot = validateArchiveRoot($('#archiveRootForm').archiveRoot.value);
        $('#saveArchiveRoot').disabled = false;
        const result = await evaluateUI('decide', {
          item: {
            filename: $('#archiveExample').value,
            url: 'https://example.com/download',
            startTime: new Date().toISOString(),
          },
          config: { ...getState().config, archiveRoot },
        });
        if (generation !== rootGeneration) return;
        $('#archiveRootPreview').textContent =
          result.kind === 'matched'
            ? t('下载根目录 / {0}', result.target)
            : t('当前规则未归档此文件，沿用浏览器默认保存位置');
      } catch (error) {
        if (generation !== rootGeneration) return;
        $('#archiveRootError').textContent = error.message;
        $('#archiveRootPreview').textContent = '';
        $('#saveArchiveRoot').disabled = true;
      }
    };
    $('#archiveRootForm').archiveRoot.oninput = () => void previewRoot();
    $('#archiveExample').onchange = () => void previewRoot();
    $('#archiveRootForm').onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        const archiveRoot = validateArchiveRoot(event.target.archiveRoot.value);
        await request('SET_SETTINGS', { settings: { archiveRoot } });
        event.target.archiveRoot.value = archiveRoot;
        await refresh();
        await previewRoot();
        $('#archiveRootStatus').textContent = t('已保存 · 对之后开始的下载生效');
        toast(t('归档位置已保存'));
      });
    };
    $('#chooseDownloadRoot').onclick = () =>
      run(() => chrome.tabs.create({ url: 'chrome://settings/downloads' }));
    $('#showDownloadRoot').onclick = () => run(() => chrome.downloads.showDefaultFolder());
    $('#supplementDefaults').onclick = () =>
      document.dispatchEvent(new CustomEvent('supplement-defaults'));
    void previewRoot();
    $('#settingsForm').onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        const form = event.target,
          settings = {
            matchMode: form.matchMode.value,
            queueConcurrency: Number(form.queueConcurrency.value),
            perHostConcurrency: Number(form.perHostConcurrency.value),
            autoClearDays: Number(form.autoClearDays.value),
            notifications: form.notifications.checked,
            replaceDownloadUI: form.replaceDownloadUI.checked,
            autoOpenPanel: form.autoOpenPanel.checked,
          };
        const permissions = [];
        if (settings.notifications) permissions.push('notifications');
        if (permissions.length && !(await chrome.permissions.request({ permissions })))
          throw new Error(t('所选功能未获浏览器授权'));
        await request('SET_SETTINGS', { settings });
        toast(t('偏好已保存'));
        await refresh();
      });
    };
    $('#openWindow').onclick = () =>
      run(() =>
        chrome.windows.create({
          url: chrome.runtime.getURL('manager.html'),
          type: 'popup',
          width: 1200,
          height: 850,
        }),
      );
    $('#uploadSync').onclick = () =>
      run(async () => {
        if (!confirm(t('用当前规则替换云端备份？其他同步设备可读取此备份。'))) return;
        const { meta } = await request('SYNC_UPLOAD');
        $('#syncStatus').textContent = t(
          '已写入浏览器同步存储：{0} 条规则 · {1}。跨设备到达情况需在另一台设备核对。',
          meta.ruleCount,
          new Date(meta.at).toLocaleString(getLocale()),
        );
      });
    $('#readSync').onclick = () =>
      run(async () => {
        const { pack, meta } = await request('SYNC_READ');
        $('#openImport').click();
        $('#importText').value = JSON.stringify(pack, null, 2);
        $('#previewImport').click();
        $('#syncStatus').textContent = t(
          '读取 {0} 的备份，等待预览导入。',
          new Date(meta.at).toLocaleString(getLocale()),
        );
      });
    $('#clearSync').onclick = () =>
      run(async () => {
        if (!confirm(t('删除规则云端备份？其他同步设备也会移除这份备份，本机规则保持不变。')))
          return;
        await request('SYNC_CLEAR');
        $('#syncStatus').textContent = t('云端备份已删除，本机规则保持不变');
      });
    $('#saveFilter').onclick = () =>
      run(async () => {
        const filter = { name: $('#filterName').value, condition: $('#filterCondition').value };
        await evaluateUI('filter', {
          items: [{ filename: 'test.mp4', totalBytes: 1024 }],
          condition: filter.condition,
          config: getState().config,
        });
        await request('SET_SETTINGS', {
          settings: { savedFilters: [...(getState().config.savedFilters || []), filter] },
        });
        mounted = '';
        await refresh();
        toast(t('筛选器已保存'));
      });
  }
  document.addEventListener('change', (event) => {
    const id = event.target.dataset.resourceId;
    if (id) {
      event.target.checked ? resourceSelection.add(id) : resourceSelection.delete(id);
      $('#resourceCount').textContent = t(
        '筛选 {0} · 已选 {1}',
        visibleResources.length,
        resourceSelection.size,
      );
    }
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.queueAction)
      void run(async () => {
        await request('QUEUE_ACTION', {
          action: button.dataset.queueAction,
          ids: [button.dataset.queueId],
        });
        await refresh();
      });
    if (button.hasAttribute('data-delete-filter'))
      void run(async () => {
        await request('SET_SETTINGS', {
          settings: {
            savedFilters: getState().config.savedFilters.filter(
              (_, i) => i !== Number(button.dataset.deleteFilter),
            ),
          },
        });
        mounted = '';
        await refresh();
      });
  });
  function render(view) {
    if (mounted !== view) {
      mounted = view;
      $('#featureView').innerHTML =
        view === 'batch'
          ? batchMarkup()
          : view === 'resources'
            ? resourcesMarkup()
            : settingsMarkup();
      if (view === 'batch') bindBatch();
      else if (view === 'resources') bindResources();
      else bindSettings();
    }
    if (view === 'batch') renderQueue();
    if (view === 'resources') void run(reloadCapture);
  }
  return { render };
}
