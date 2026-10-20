import { t, getLocale } from './i18n.js';
import { basename } from './engine.js';
import { defaultRules } from './file-types.js';
import {
  RULE_TEMPLATES,
  makeRulePack,
  exportRegExpRules,
  sampleFromRecord,
  buildAiPrompt,
  MAX_PACK_BYTES,
} from './rules.js';
import { evaluateUI } from './evaluator.js';
import { h, icon, request } from './ui.js';
export function initRuleWorkbench({ getState, refresh, editRule, toast }) {
  const $ = (selector) => document.querySelector(selector);
  let importPreview = null;
  let importGeneration = 0;
  const localDate = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function invalidateImport(message = '') {
    importPreview = null;
    importGeneration++;
    $('#applyImport').disabled = true;
    $('#importPreview').textContent = '';
    $('#importError').textContent = message;
  }
  function renderTools() {
    const { config } = getState();
    $('#undoRules').disabled = !config.ruleBackup;
    $('#undoRules').title = config.ruleBackup
      ? t('撤销：{0}', config.ruleBackup.label)
      : t('没有可撤销的修改');
    if (importPreview && (config.revision || 0) > importPreview.revision)
      invalidateImport(t('规则已经变化，请重新校验并预览'));
    if ($('#labDialog').open) runLab();
  }
  function renderTemplates() {
    const query = $('#templateSearch').value.trim().toLowerCase();
    $('#templateList').innerHTML =
      RULE_TEMPLATES.filter((template) => JSON.stringify(template).toLowerCase().includes(query))
        .map(
          (template) =>
            `<button class="template-card" data-use-template="${template.id}">${icon(template.icon)}<strong>${h(template.title)}</strong><span>${h(template.description)}</span><code>${h(template.rule.folder)}</code></button>`,
        )
        .join('') || `<p class="field-hint">${t('没有匹配的模板，试试文件扩展名或场景名称。')}</p>`;
  }
  function openTemplates() {
    $('#templateSearch').value = '';
    renderTemplates();
    $('#templateDialog').showModal();
  }
  $('#templateSearch').oninput = renderTemplates;
  document.addEventListener('supplement-defaults', () => {
    $('#openImport').click();
    $('#importText').value = JSON.stringify(makeRulePack(defaultRules()), null, 2);
    $('#importPosition').value = getState().config.matchMode === 'last' ? 'first' : 'last';
    $('#previewImport').click();
  });
  function fillLab(sample) {
    $('#labFilename').value = sample.filename || 'report.pdf';
    $('#labDate').value = localDate(new Date(sample.startTime || Date.now()));
    $('#labUrl').value = sample.url || '';
    $('#labFinalUrl').value = sample.finalUrl || '';
    $('#labReferrer').value = sample.referrer || '';
    for (const [id, key] of [
      ['labMime', 'mime'],
      ['labTabUrl', 'tabUrl'],
      ['labPageTitle', 'pageTitle'],
      ['labSize', 'totalBytes'],
    ])
      $('#' + id).value = sample[key] ?? (key === 'totalBytes' ? -1 : '');
    $('#labSourceHint').textContent = sample.approximate
      ? t('这条记录的网址信息不完整。可以补全网址再试，结果可能和当时不同。')
      : t('看看现在的规则会把它放在哪里，不会改动文件。');
    runLab();
  }
  function openLab(record) {
    const records = getState()
      .records.filter((r) => r.originalName || r.filename)
      .slice(0, 30);
    $('#labRecord').innerHTML =
      `<option value="">${t('手动输入示例')}</option>${records.map((r) => `<option value="${r.id}">${h(basename(r.originalName || r.filename))} · ${h(new Date(r.startTime).toLocaleString(getLocale()))}</option>`).join('')}`;
    $('#labRecord').value = record ? String(record.id) : '';
    fillLab(
      record
        ? sampleFromRecord(record)
        : { filename: 'report.pdf', url: 'https://example.com/report.pdf' },
    );
    $('#labDialog').showModal();
  }
  let labGeneration = 0;
  async function runLab() {
    const generation = ++labGeneration;
    const result = $('#labResult');
    result.classList.remove('success');
    try {
      if (!$('#labDate').value) throw new Error(t('请选择示例下载日期'));
      const sample = {
        filename: $('#labFilename').value,
        startTime: new Date(`${$('#labDate').value}T12:00:00`).toISOString(),
        url: $('#labUrl').value,
        finalUrl: $('#labFinalUrl').value,
        referrer: $('#labReferrer').value,
        mime: $('#labMime').value,
        tabUrl: $('#labTabUrl').value,
        pageTitle: $('#labPageTitle').value,
        totalBytes: Number($('#labSize').value),
      };
      const { decision, steps } = await evaluateUI('explain', {
        item: sample,
        config: getState().config,
      });
      if (generation !== labGeneration) return;
      result.innerHTML =
        decision.kind === 'matched'
          ? `<strong>${t('采用「{0}」', h(decision.ruleName))}</strong><p>${t('下载目录/{0}', h(decision.target))}</p>`
          : `<strong>${decision.kind === 'paused' ? t('自动归档已暂停') : t('没有符合的规则')}</strong><p>${t('这个文件会放在 Chrome 默认的下载文件夹里。')}</p>`;
      result.classList.toggle('success', decision.kind === 'matched');
      const labels = {
        selected: t('本次采用'),
        shadowed: t('也匹配 · 优先级更低'),
        missed: t('未匹配'),
        disabled: t('规则已停用'),
        invalid: t('规则无效'),
        paused: t('匹配 · 全局已暂停'),
      };
      $('#labTrace').innerHTML =
        steps
          .map(
            (step) =>
              `<article class="trace-row ${step.status}"><div><span class="rule-order">${String(step.index + 1).padStart(2, '0')}</span><strong>${h(step.name)}</strong><span class="trace-label">${labels[step.status]}</span></div>${step.error ? `<p class="form-error">${h(step.error)}</p>` : ''}<div class="condition-chips">${step.checks.map((check) => `<span class="condition-chip ${check.matched ? '' : 'miss'}">${check.matched ? '✓' : '×'} ${h(check.label)}：${h(check.expected)}</span>`).join('')}</div></article>`,
          )
          .join('') || `<p class="field-hint">${t('还没有归档规则。')}</p>`;
    } catch (error) {
      if (generation !== labGeneration) return;
      result.textContent = error.message;
      $('#labTrace').textContent = '';
    }
  }
  function createFromRecord(record) {
    const sample = sampleFromRecord(record);
    const name = basename(sample.filename);
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    let domain = '';
    try {
      const host = new URL(record.source).hostname;
      if (/^[a-z0-9.-]+$/i.test(host)) domain = host;
    } catch {
      /* Source is optional. */
    }
    editRule(
      undefined,
      {
        name: t(
          '{0}{1}文件',
          domain ? t('{0} 的', domain) : '',
          extension ? extension.toUpperCase() : t('同名'),
        ).slice(0, 60),
        extensions: extension,
        domain,
        keyword: extension ? '' : name.slice(0, 160),
        folder: `${domain || t('新分类')}/{year}-{month}`,
      },
      { ...sample, url: record.source },
    );
  }
  $('#openTemplates').addEventListener('click', openTemplates);
  $('#openLab').addEventListener('click', () => openLab());
  $('#openRuleGuide').addEventListener('click', () => $('#ruleGuideDialog').showModal());
  $('#openImport').addEventListener('click', () => {
    invalidateImport();
    $('#importDialog').showModal();
  });
  $('#labRecord').addEventListener('change', () => {
    const record = getState().records.find((r) => String(r.id) === $('#labRecord').value);
    if (record) fillLab(sampleFromRecord(record));
  });
  [
    'labFilename',
    'labDate',
    'labUrl',
    'labFinalUrl',
    'labReferrer',
    'labMime',
    'labTabUrl',
    'labPageTitle',
    'labSize',
  ].forEach((id) => document.getElementById(id).addEventListener('input', runLab));
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-use-template]');
    if (!button) return;
    const template = RULE_TEMPLATES.find((t) => t.id === button.dataset.useTemplate);
    if (!template) return;
    $('#templateDialog').close();
    $('#ruleGuideDialog').close();
    editRule(undefined, template.rule, template.sample);
  });
  $('#chooseImportFile').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (event) => {
    invalidateImport();
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > MAX_PACK_BYTES) throw new Error(t('配置文件不能超过 128 KiB'));
      $('#importText').value = await file.text();
    } catch (error) {
      $('#importError').textContent = error.message;
    }
    event.target.value = '';
  });
  $('#importText').addEventListener('input', () => invalidateImport());
  $('#importPosition').addEventListener('change', () => invalidateImport());
  $('#previewImport').addEventListener('click', async () => {
    invalidateImport();
    const generation = importGeneration;
    try {
      const pack = $('#importText').value;
      const position = $('#importPosition').value;
      const preview = await request('PREVIEW_IMPORT', { pack, position });
      if (generation !== importGeneration) return;
      importPreview = { ...preview, pack, position };
      const { plan } = preview;
      $('#importPreview').innerHTML =
        `<strong>${t('新增 {0} 条 · 跳过 {1} 条相同规则', plan.added.length, plan.skipped.length)}</strong><p class="field-hint">${t('保留现有规则；新规则放在{0}。导入后共 {1} 条。', position === 'first' ? t('最前，优先匹配') : t('最后，作为补充'), plan.total)}</p>${plan.added.map((rule) => `<div class="import-rule"><span>${h(rule.name)}${rule.enabled ? '' : t('（停用）')}</span><span>${h(rule.folder)}</span></div>`).join('')}${plan.skipped.length ? `<p class="field-hint import-hint">${t('已跳过：{0}', plan.skipped.map(h).join('、'))}</p>` : ''}`;
      $('#applyImport').disabled = !plan.added.length;
    } catch (error) {
      if (generation === importGeneration) $('#importError').textContent = error.message;
    }
  });
  $('#applyImport').addEventListener('click', async () => {
    if (!importPreview) return;
    const { pack, position, revision, plan } = importPreview;
    $('#applyImport').disabled = true;
    try {
      const risky = plan.added.some((rule) => rule.enabled && rule.conflictAction === 'overwrite');
      const overwriteConfirmed = risky
        ? confirm(t('导入的规则会覆盖同名文件，确认启用这些覆盖规则？'))
        : false;
      if (risky && !overwriteConfirmed) {
        $('#applyImport').disabled = false;
        return;
      }
      await request('IMPORT_RULES', { pack, position, revision, overwriteConfirmed });
      $('#importDialog').close();
      invalidateImport();
      await refresh();
      toast(t('已导入 {0} 条规则，可撤销上次修改', plan.added.length));
    } catch (error) {
      invalidateImport(error.message);
    }
  });
  $('#copyAiPrompt').addEventListener('click', async () => {
    const prompt = buildAiPrompt($('#aiGoal').value);
    $('#aiPromptOutput').value = prompt;
    $('#aiPromptOutput').hidden = false;
    try {
      await navigator.clipboard.writeText(prompt);
      toast(t('提示词已复制，发给 AI 后把返回的 JSON 粘贴到下方'));
    } catch {
      $('#aiPromptOutput').focus();
      $('#aiPromptOutput').select();
      toast(t('请复制已选中的提示词'));
    }
  });
  $('#exportRules').addEventListener('click', () => {
    try {
      const pack = makeRulePack(getState().config.rules);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'nivra-rules.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(t('规则已导出为 JSON，仅包含规则配置'));
    } catch (error) {
      toast(error.message);
    }
  });
  $('#exportRegExp').addEventListener('click', () => {
    try {
      const rules = exportRegExpRules(getState().config.rules);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'regexp-download-organizer-rules.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (error) {
      toast(error.message);
    }
  });
  $('#undoRules').addEventListener('click', async () => {
    const { config } = getState();
    if (!config.ruleBackup) return;
    if (
      !confirm(
        t(
          '撤销“{0}”，恢复到修改前的 {1} 条规则？已下载文件不会改变。',
          config.ruleBackup.label,
          config.ruleBackup.rules.length,
        ),
      )
    )
      return;
    try {
      const risky = config.ruleBackup.rules.some(
        (rule) => rule.enabled && rule.conflictAction === 'overwrite',
      );
      if (risky && !confirm(t('恢复的规则包含覆盖同名文件动作，继续？'))) return;
      await request('UNDO_RULES', { revision: config.revision || 0, overwriteConfirmed: risky });
      await refresh();
      toast(t('已撤销上一次规则修改'));
    } catch (error) {
      toast(error.message);
    }
  });
  return { renderTools, openLab, createFromRecord };
}
