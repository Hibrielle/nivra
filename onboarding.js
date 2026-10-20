import { t } from './i18n.js';
import { h, icon, request } from './ui.js';
import { validateArchiveRoot } from './engine.js';
import { evaluateUI } from './evaluator.js';
import { defaultRuleLayout, setDefaultFolderLayout } from './file-types.js';
export function initOnboarding({ getState, refresh, toast }) {
  const $ = (selector) => document.querySelector(selector);
  const banner = document.createElement('section');
  banner.id = 'setupBanner';
  banner.className = 'setup-banner';
  banner.hidden = true;
  banner.innerHTML = `<div><strong>${t('先选好下载位置')}</strong><p>${t('文件放哪里、要不要分类，先按你的习惯选好。大约 2 分钟。')}</p></div><button class="button primary" data-open-setup>${t('开始设置')}</button><button class="icon-button" id="dismissSetup" aria-label="${t('暂不设置')}" title="${t('暂不设置')}">${icon('close')}</button>`;
  $('.main-content').prepend(banner);
  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <dialog id="setupDialog" class="modal setup-dialog" aria-labelledby="setupTitle">
      <div class="modal-heading"><div><p class="eyebrow" id="setupProgress"></p><h2 id="setupTitle">${t('开始使用 Nivra')}</h2></div><button class="icon-button" id="closeSetup" aria-label="${t('关闭使用引导')}">${icon('close')}</button></div>
      <section data-setup-step="0"><h3>${t('下载的文件放哪里？')}</h3><p>${t('Nivra 会把文件放在 Chrome 的下载文件夹里。')}</p><div class="setup-location"><strong>${t('Chrome 的下载文件夹')}</strong><p>${t('想换个位置，可以去 Chrome 设置里选。改完会影响所有 Chrome 下载。')}</p><button id="setupChooseRoot" class="button">${t('去 Chrome 选择文件夹')}</button></div><label class="field">${t('在里面再建一个文件夹（可选）')}<input id="setupRoot" maxlength="256" placeholder="${t('留空直接分类，或填 资料/下载')}"><span class="field-hint">${t('比如填「资料/下载」。留空也行，Nivra 会直接在下载文件夹里分类。')}</span></label><p id="setupRootHint" class="setup-path"></p></section>
      <section data-setup-step="1" hidden>
        <h3>${t('下载后怎么整理？')}</h3>
        <label class="setup-option"><input id="setupByType" type="checkbox"><span><strong>${t('按文件类型分类')}</strong><small>${t('文档、图片、压缩包分别放进各自的文件夹。')}</small></span></label>
        <fieldset id="setupDateGroup" class="setup-date-group"><legend>${t('按时间分类')}</legend><div class="setup-date-choices">
          <label class="setup-time-option"><input type="radio" name="setupDate" value="none"><span>${t('不按时间')}</span></label>
          <label class="setup-time-option"><input type="radio" name="setupDate" value="month"><span>${t('按月份')}</span></label>
          <label class="setup-time-option"><input type="radio" name="setupDate" value="day"><span>${t('按日期')}</span></label>
          <label id="setupDateKeep" class="setup-time-option" hidden><input type="radio" name="setupDate" value="keep"><span>${t('保持各自设置')}</span></label>
        </div></fieldset>
        <label id="setupOrderField" class="field">${t('目录顺序')}<select id="setupOrder"><option value="type-first">${t('类型在前：文档 / 时间')}</option><option value="date-first">${t('时间在前：时间 / 文档')}</option><option id="setupOrderKeep" value="keep" hidden>${t('保持各自设置')}</option></select></label>
        <p id="setupLayoutHint" class="field-hint"></p>
        <div class="setup-example" role="figure" aria-labelledby="setupExampleTitle"><p id="setupExampleTitle">${t('文件会这样保存')}</p><div id="setupExampleTree" class="setup-example-tree" aria-live="polite"></div></div>
        <p id="setupRulesHint" class="field-hint"></p>
      </section>
      <section data-setup-step="2" hidden><h3>${t('下载一个文件试试')}</h3><p>${t('用这个小文件试试：')}<strong>nivra-test.txt</strong>。</p><div id="setupPreview" class="preview-box" role="status"></div><p class="field-hint">${t('下载好了，点任务旁边的文件夹图标就能找到它。')}</p><p class="field-hint">${t('如果 Chrome 弹出保存窗口，你也可以在那里换位置。')}</p></section>
      <p id="setupError" class="form-error" role="alert"></p>
      <div class="modal-footer"><button id="setupBack" class="button">${t('上一步')}</button><span class="spacer"></span><button id="setupSave" class="button" hidden>${t('保存设置')}</button><button id="setupNext" class="button primary">${t('下一步')}</button><button id="setupTest" class="button primary" hidden>${t('保存并下载')}</button></div>
    </dialog>`,
  );
  const dialog = $('#setupDialog');
  let step = 0,
    generation = 0,
    saving = false,
    layoutChanged = false,
    hasDefaults = true,
    mixedLayout = false;
  function layout() {
    const date = document.querySelector('[name="setupDate"]:checked').value;
    const order = $('#setupOrder').value;
    return {
      byType: $('#setupByType').indeterminate ? null : $('#setupByType').checked,
      date: date === 'keep' ? null : date,
      order: order === 'keep' ? null : order,
    };
  }
  function enabled() {
    if (!hasDefaults) return getState().config.enabled;
    const choice = layout();
    return choice.byType !== false || choice.date !== 'none';
  }
  function updateLayoutOptions() {
    const choice = layout();
    $('#setupOrderField').hidden =
      !hasDefaults || choice.byType === false || choice.date === 'none';
    $('#setupLayoutHint').textContent = !hasDefaults
      ? t('没有可调整的默认分类。自定义目录可以在“归档规则”中修改。')
      : !enabled()
        ? t('类型和时间都关闭时，文件直接放进 Chrome 下载文件夹。')
        : mixedLayout && !layoutChanged
          ? t('各类文件目前设置不同，未修改的选项会保持原样。')
          : t('只调整默认分类，自定义目录仍按各自规则保存。');
    if (step === 1) void updateExample();
  }
  const rootHint = () => {
    const choice = layout();
    const groups = [
      choice.byType !== false ? t('分类文件夹') : '',
      choice.date === 'none' ? '' : choice.date === 'day' ? t('年-月-日') : t('年-月'),
    ];
    if (choice.order === 'date-first') groups.reverse();
    $('#setupRootHint').textContent = [
      t('Chrome 下载文件夹'),
      ...(enabled() ? [$('#setupRoot').value.trim(), ...groups] : []),
      t('文件名'),
    ]
      .filter(Boolean)
      .join(' / ');
  };
  function previewResult() {
    return evaluateUI('decide', {
      config: {
        ...getState().config,
        archiveRoot: validateArchiveRoot($('#setupRoot').value),
        enabled: enabled(),
        rules:
          enabled() && layoutChanged
            ? setDefaultFolderLayout(getState().config.rules, layout())
            : getState().config.rules,
      },
      item: {
        filename: 'nivra-test.txt',
        url: chrome.runtime.getURL('examples/nivra-test.txt'),
        mime: 'text/plain',
        startTime: new Date().toISOString(),
      },
    });
  }
  async function updateExample() {
    const token = ++generation;
    const tree = $('#setupExampleTree');
    try {
      const result = await previewResult();
      if (token !== generation || !dialog.open || step !== 1) return;
      if (result.kind === 'error') throw new Error(t('规则暂时无法计算，请到“归档规则”中检查。'));
      const parts = [t('Chrome 下载文件夹'), ...(result.target || 'nivra-test.txt').split('/')];
      const target = parts.join('/');
      if (tree.dataset.path === target) return;
      for (const animation of tree.getAnimations()) animation.cancel();
      const height = tree.getBoundingClientRect().height;
      tree.innerHTML = parts
        .map(
          (part, index) =>
            `<div class="setup-example-entry" style="--depth:${index}">${icon(index === parts.length - 1 ? 'file' : 'folder')}<span>${h(part)}</span></div>`,
        )
        .join('');
      tree.dataset.path = target;
      if (height && !matchMedia('(prefers-reduced-motion: reduce)').matches)
        tree.animate(
          [
            { height: `${height}px`, opacity: 0.4 },
            { height: `${tree.getBoundingClientRect().height}px`, opacity: 1 },
          ],
          { duration: 160, easing: 'ease-out' },
        );
    } catch (error) {
      if (token === generation && dialog.open) {
        tree.textContent = error.message;
        delete tree.dataset.path;
      }
    }
  }
  async function preview() {
    const token = ++generation;
    $('#setupTest').disabled = $('#setupSave').disabled = true;
    $('#setupPreview').textContent = t('正在查看保存位置…');
    try {
      const result = await previewResult();
      if (token !== generation || !dialog.open) return;
      if (result.kind === 'error')
        throw new Error(result.error || t('规则执行失败，请先检查归档规则'));
      $('#setupPreview').innerHTML =
        `<strong>${t('按刚才的设置，会放在这里')}</strong><p class="setup-path">${h(t('Chrome 下载文件夹 / ') + (result.target || 'nivra-test.txt'))}</p><span>${h(result.ruleName ? t('用的规则：') + result.ruleName : t('放在 Chrome 默认的下载文件夹里'))}</span>`;
      $('#setupTest').disabled = $('#setupSave').disabled = false;
    } catch (error) {
      if (token === generation && dialog.open) $('#setupError').textContent = error.message;
    }
  }
  function showStep() {
    for (const section of document.querySelectorAll('[data-setup-step]'))
      section.hidden = Number(section.dataset.setupStep) !== step;
    $('#setupProgress').textContent =
      `${step + 1} / 3 · ${[t('下载位置'), t('整理方式'), t('下载一个文件')][step]}`;
    $('#setupBack').hidden = step === 0;
    $('#setupNext').hidden = step === 2;
    $('#setupTest').hidden = $('#setupSave').hidden = step !== 2;
    $('#setupError').textContent = '';
    if (step === 1) void updateExample();
    if (step === 2) void preview();
    dialog.scrollTop = 0;
  }
  function open() {
    const { config } = getState();
    step = 0;
    layoutChanged = false;
    $('#setupRoot').value = config.archiveRoot || '';
    const layouts = config.rules.map(defaultRuleLayout).filter(Boolean);
    hasDefaults = layouts.length > 0;
    const shared = (key, fallback) =>
      !layouts.length
        ? fallback
        : layouts.every((item) => item[key] === layouts[0][key])
          ? layouts[0][key]
          : null;
    const byType = config.enabled ? shared('byType', false) : false;
    const date = config.enabled ? shared('date', 'none') : 'none';
    const order = shared('order', 'type-first');
    mixedLayout = byType === null || date === null || order === null;
    $('#setupByType').checked = byType !== false;
    $('#setupByType').indeterminate = byType === null;
    $('#setupByType').disabled = $('#setupDateGroup').disabled = !hasDefaults;
    $('#setupDateKeep').hidden = date !== null;
    document.querySelector(`[name="setupDate"][value="${date ?? 'keep'}"]`).checked = true;
    $('#setupOrderKeep').hidden = order !== null;
    $('#setupOrder').value = order ?? 'keep';
    updateLayoutOptions();
    $('#setupRulesHint').textContent = t(
      '你现在有 {0} 条规则在用。之后可以在“归档规则”里继续调整。',
      config.rules.filter((rule) => rule.enabled).length,
    );
    rootHint();
    dialog.showModal();
    showStep();
    $('#setupChooseRoot').focus();
  }
  async function finish(download) {
    if (saving) return;
    saving = true;
    for (const button of dialog.querySelectorAll('button')) button.disabled = true;
    let saved = false;
    try {
      await request('SET_SETTINGS', {
        settings: {
          archiveRoot: validateArchiveRoot($('#setupRoot').value),
          enabled: enabled(),
          onboardingDismissed: true,
          ...(enabled() && layoutChanged ? { defaultFolderLayout: layout() } : {}),
        },
      });
      saved = true;
      if (download)
        await chrome.downloads.download({
          url: chrome.runtime.getURL('examples/nivra-test.txt'),
          saveAs: false,
          conflictAction: 'uniquify',
        });
      dialog.close();
      await refresh();
      toast(download ? t('开始下载了，完成后点文件夹图标就能找到') : t('设置好了，可以开始下载了'));
    } catch (error) {
      $('#setupError').textContent =
        (saved ? t('设置已经保存，但没能开始下载：') : '') + error.message;
    } finally {
      saving = false;
      for (const button of dialog.querySelectorAll('button')) button.disabled = false;
    }
  }
  $('#setupRoot').addEventListener('input', rootHint);
  for (const control of document.querySelectorAll('#setupByType, [name="setupDate"], #setupOrder'))
    control.addEventListener('change', () => {
      layoutChanged = true;
      updateLayoutOptions();
      rootHint();
    });
  $('#setupChooseRoot').onclick = () => chrome.tabs.create({ url: 'chrome://settings/downloads' });
  $('#setupNext').onclick = () => {
    try {
      validateArchiveRoot($('#setupRoot').value);
      step++;
      showStep();
    } catch (error) {
      $('#setupError').textContent = error.message;
    }
  };
  $('#setupBack').onclick = () => {
    generation++;
    step--;
    showStep();
  };
  $('#closeSetup').onclick = () => dialog.close();
  dialog.addEventListener('cancel', (event) => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    generation++;
  });
  $('#setupSave').onclick = () => void finish(false);
  $('#setupTest').onclick = () => void finish(true);
  $('#dismissSetup').onclick = async () => {
    try {
      await request('SET_SETTINGS', { settings: { onboardingDismissed: true } });
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  };
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-open-setup]')) open();
  });
  let requested = new URL(location.href).searchParams.has('setup');
  return {
    render(view) {
      banner.hidden = Boolean(getState().config.onboardingDismissed) || view !== 'all';
      if (requested) {
        requested = false;
        const url = new URL(location.href);
        url.searchParams.delete('setup');
        history.replaceState(null, '', url);
        open();
      }
    },
  };
}
