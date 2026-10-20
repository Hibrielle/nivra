import { t, initI18n } from './i18n.js';
import {
  defaultConfig,
  validateFolder,
  validateArchiveRoot,
  validateRule,
  displaySource,
  MAX_RECORDS,
} from './engine.js';
import { planImport } from './rules.js';
import { setDefaultFolderLayout } from './file-types.js';
import { evaluateBackground } from './evaluator.js';
import {
  addBatch,
  getQueue,
  queueAction,
  downloadAction,
  queueContext,
  pumpQueue,
} from './tasks.js';
import { scanTabs, getCapture, setCapture, clearCapture, registerCapture } from './capture.js';
import { uploadRules, readCloudRules, clearCloudRules } from './sync.js';
import { presentDownload } from './download-surface.js';
import { handleDownloader, downloaderSummary } from './downloader-service.js';
import { initReports, getReport, deleteReports } from './report-service.js';
const languageReady = initI18n();
const keyOf = (id) => `record:${id}`;
const queues = new Map();
let configQueue = Promise.resolve();
let syncQueue = Promise.resolve();
function enqueue(id, operation) {
  const task = (queues.get(id) || Promise.resolve())
    .then(operation)
    .catch((error) => console.warn('Nivra:', error.message));
  queues.set(id, task);
  task.finally(() => {
    if (queues.get(id) === task) queues.delete(id);
  });
  return task;
}
async function getConfig() {
  await languageReady;
  return { ...defaultConfig(), ...(await chrome.storage.local.get('config')).config };
}
async function snapshot(item, decision) {
  const key = keyOf(item.id);
  const previous = (await chrome.storage.local.get(key))[key];
  const latest = (await chrome.downloads.search({ id: item.id }))[0];
  if (!latest) return;
  const record = {
    id: latest.id,
    filename: latest.filename,
    originalName: previous?.originalName || item.filename,
    source: displaySource(latest.referrer || latest.finalUrl || latest.url),
    mime: latest.mime || '',
    canResume: latest.canResume,
    matchContext: {
      ...(previous?.matchContext || {}),
      mime: latest.mime || '',
      redacted: true,
      tabUrl: displaySource(item.tabUrl || previous?.matchContext?.tabUrl),
      pageTitle: item.pageTitle || previous?.matchContext?.pageTitle || '',
      linkText: item.linkText || previous?.matchContext?.linkText || '',
      linkTitle: item.linkTitle || previous?.matchContext?.linkTitle || '',
      url: displaySource(latest.url),
      finalUrl: displaySource(latest.finalUrl),
      referrer: displaySource(item.referrer || latest.referrer || previous?.matchContext?.referrer),
    },
    startTime: latest.startTime,
    endTime: latest.endTime || '',
    state: latest.state,
    paused: latest.paused,
    exists: latest.exists,
    bytesReceived: latest.bytesReceived,
    totalBytes: latest.totalBytes,
    error: latest.error || '',
    decision: decision || previous?.decision || { kind: 'pending' },
    completionHandled: previous?.completionHandled || false,
    trashedAt: previous?.trashedAt || '',
    note: previous?.note || '',
  };
  await chrome.storage.local.set({ [key]: record });
  if (latest.state !== 'in_progress') await pruneRecords();
  if (
    latest.state === 'complete' &&
    !record.completionHandled &&
    !['pending', 'historical'].includes(record.decision.kind)
  ) {
    record.completionHandled = true;
    await chrome.storage.local.set({ [key]: record });
    const config = await getConfig();
    if (
      config.notifications &&
      (await chrome.permissions.contains({ permissions: ['notifications'] }))
    )
      await chrome.notifications
        .create(`download:${item.id}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: t('下载完成'),
          message: latest.filename.split(/[\\/]/).pop() || t('文件已下载'),
        })
        .catch(() => {});
    if (record.decision.postAction === 'reveal')
      await chrome.downloads.show(item.id).catch(() => {});
  }
  await updateBadge();
}
async function pruneRecords() {
  const all = await chrome.storage.local.get(null);
  const records = Object.entries(all)
    .filter(([key]) => key.startsWith('record:'))
    .sort((a, b) => b[1].startTime.localeCompare(a[1].startTime));
  const expired = records
    .slice(MAX_RECORDS)
    .filter(([, record]) => record.state !== 'in_progress')
    .map(([key]) => key);
  if (expired.length) {
    await chrome.storage.local.remove(expired);
    await deleteReports(expired.map((key) => Number(key.slice(7))));
  }
}
chrome.runtime.onInstalled.addListener(() => {
  configQueue = configQueue
    .then(async () => {
      await languageReady;
      const { config: saved } = await chrome.storage.local.get('config');
      const config = { ...defaultConfig(), ...saved };
      await chrome.storage.local.set({ config });
      await setupBrowser();
    })
    .catch((error) => console.warn('Browser setup:', error.message));
});

// A download can fail before Chrome has enough headers to determine a name.
// Record its creation separately so those failures remain visible as well.
chrome.downloads.onCreated.addListener((item) => {
  (async () => {
    await configQueue;
    const config = await getConfig();
    if (item.incognito || new Date(item.startTime) < new Date(config.installedAt)) return;
    await enqueue(item.id, () => snapshot(item));
    await presentDownload(item, config);
  })().catch((error) => console.warn('Nivra:', error.message));
});
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let suggested = false;
  const finish = async (value) => {
    if (!suggested) {
      suggested = true;
      // Cancellation can finish while the asynchronous rule evaluator is running.
      // Chrome's internal suggestion callback rejects an already ended download.
      const current = (await chrome.downloads.search({ id: item.id }))[0];
      if (current?.state === 'in_progress') suggest(value);
    }
  };
  (async () => {
    await configQueue;
    const config = await getConfig();
    if (item.incognito || new Date(item.startTime) < new Date(config.installedAt)) {
      await finish();
      return;
    }
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const context = await queueContext(item);
    const enriched = {
      ...item,
      tabUrl: tabs[0]?.url || '',
      pageTitle: tabs[0]?.url === item.referrer ? tabs[0]?.title || '' : '',
      ...context,
      filename: item.filename,
    };
    let decision;
    try {
      if (context.queueTemplate) {
        const target = await evaluateBackground('template', {
          template: context.queueTemplate,
          item: enriched,
          archiveRoot: config.archiveRoot,
        });
        validateFolder(target);
        decision = {
          kind: 'matched',
          ruleName: t('本次批量命名'),
          target,
          folder: target.split('/').slice(0, -1).join('/'),
          conflictAction: 'uniquify',
        };
      } else decision = await evaluateBackground('decide', { item: enriched, config });
    } catch (error) {
      decision = { kind: 'error', error: error.message };
    }
    await finish(
      decision.kind === 'matched'
        ? { filename: decision.target, conflictAction: decision.conflictAction || 'uniquify' }
        : undefined,
    );
    await enqueue(item.id, () => snapshot(enriched, decision));
  })().catch(() => finish());
  return true;
});
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state || delta.paused) void pumpQueue().catch(() => {});
  if (!delta.state && !delta.filename && !delta.paused && !delta.exists && !delta.error) return;
  enqueue(delta.id, async () => {
    const key = keyOf(delta.id);
    const record = (await chrome.storage.local.get(key))[key];
    if (record) await snapshot({ ...record, filename: record.originalName });
  });
});
chrome.downloads.onErased.addListener((id) =>
  enqueue(id, () => chrome.storage.local.remove(keyOf(id))),
);
async function changeConfig(message) {
  const config = await getConfig();
  const before = structuredClone(config.rules);
  if (message.type === 'IMPORT_RULES') {
    if (message.revision !== (config.revision || 0))
      throw new Error(t('规则已经变化，请重新预览后再导入'));
    const plan = planImport(message.pack, config.rules, message.position);
    if (!plan.added.length) return { config, added: 0 };
    const imported = plan.added.map((rule) => ({ ...rule, id: crypto.randomUUID() }));
    config.rules =
      plan.position === 'first' ? [...imported, ...config.rules] : [...config.rules, ...imported];
  }
  if (message.type === 'UNDO_RULES') {
    if (message.revision !== (config.revision || 0))
      throw new Error(t('规则已经变化，请刷新后再撤销'));
    if (!config.ruleBackup) throw new Error(t('没有可撤销的规则修改'));
    config.rules = config.ruleBackup.rules;
    delete config.ruleBackup;
  }
  if (message.type === 'SET_SETTINGS') {
    const settings = message.settings || {};
    if ('archiveRoot' in settings) config.archiveRoot = validateArchiveRoot(settings.archiveRoot);
    if ('defaultFolderLayout' in settings)
      config.rules = setDefaultFolderLayout(config.rules, settings.defaultFolderLayout);
    for (const key of [
      'notifications',
      'replaceDownloadUI',
      'autoOpenPanel',
      'enabled',
      'onboardingDismissed',
    ])
      if (key in settings) {
        if (typeof settings[key] !== 'boolean') throw new Error(t('开关值无效'));
        config[key] = settings[key];
      }
    for (const [key, min, max] of [
      ['queueConcurrency', 1, 20],
      ['perHostConcurrency', 1, 20],
      ['autoClearDays', 0, 3650],
    ])
      if (key in settings) {
        if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max)
          throw new Error(t('{0} 超出允许范围', key));
        config[key] = settings[key];
      }
    if ('matchMode' in settings) {
      if (!['first', 'last'].includes(settings.matchMode)) throw new Error(t('匹配模式无效'));
      config.matchMode = settings.matchMode;
    }
    if ('savedFilters' in settings) {
      if (!Array.isArray(settings.savedFilters) || settings.savedFilters.length > 30)
        throw new Error(t('最多保存 30 个筛选器'));
      for (const filter of settings.savedFilters)
        validateRule({ name: filter.name, condition: filter.condition, action: 'keep' });
      config.savedFilters = settings.savedFilters.map((f) => ({
        name: f.name,
        condition: f.condition,
      }));
    }
    if (
      config.notifications &&
      !(await chrome.permissions.contains({ permissions: ['notifications'] }))
    )
      throw new Error(t('请先允许通知权限'));
    if (
      config.replaceDownloadUI &&
      !(await chrome.permissions.contains({ permissions: ['downloads.ui'] }))
    )
      throw new Error(t('请先允许下载界面控制权限'));
  }
  if (message.type === 'SET_ENABLED') config.enabled = Boolean(message.enabled);
  if (message.type === 'SAVE_RULE') {
    const rule = validateRule(message.rule || {});
    if (!rule.id) rule.id = crypto.randomUUID();
    const index = config.rules.findIndex((item) => item.id === rule.id);
    if (index === -1) {
      if (config.rules.length >= 100) throw new Error(t('最多支持 100 条规则'));
      config.rules.unshift(rule);
    } else config.rules[index] = rule;
  }
  if (message.type === 'TOGGLE_RULE') {
    const rule = config.rules.find((item) => item.id === message.id);
    if (rule) rule.enabled = Boolean(message.enabled);
  }
  if (message.type === 'MOVE_RULE') {
    const from = config.rules.findIndex((item) => item.id === message.id);
    const to = from + (message.direction === 'up' ? -1 : 1);
    if (from >= 0 && to >= 0 && to < config.rules.length)
      [config.rules[from], config.rules[to]] = [config.rules[to], config.rules[from]];
  }
  if (message.type === 'DELETE_RULE')
    config.rules = config.rules.filter((item) => item.id !== message.id);
  const beforeById = new Map(before.map((rule) => [rule.id, rule]));
  const risky = config.rules.some(
    (rule) =>
      rule.enabled &&
      rule.conflictAction === 'overwrite' &&
      JSON.stringify(rule) !== JSON.stringify(beforeById.get(rule.id)),
  );
  if (risky && !message.overwriteConfirmed)
    throw new Error(t('存在会覆盖同名文件的规则，需要明确确认后启用'));
  if (message.type !== 'UNDO_RULES' && JSON.stringify(before) !== JSON.stringify(config.rules)) {
    const labels = {
      SAVE_RULE: t('保存规则'),
      TOGGLE_RULE: t('启停规则'),
      MOVE_RULE: t('调整顺序'),
      DELETE_RULE: t('删除规则'),
      IMPORT_RULES: t('导入规则'),
    };
    config.ruleBackup = {
      rules: before,
      label: labels[message.type] || t('规则修改'),
      at: new Date().toISOString(),
    };
  }
  config.revision = (config.revision || 0) + 1;
  await chrome.storage.local.set({ config });
  if (message.type === 'SET_SETTINGS') {
    await applyBrowserSettings(config);
    void pumpQueue().catch(() => {});
  }
  return { config };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target) return;
  if (sender.tab?.incognito) return;
  const writable = [
    'SET_ENABLED',
    'SAVE_RULE',
    'TOGGLE_RULE',
    'MOVE_RULE',
    'DELETE_RULE',
    'IMPORT_RULES',
    'UNDO_RULES',
    'SET_SETTINGS',
  ];
  let operation;
  if (message.type === 'EVALUATE') {
    operation = evaluateBackground(message.operation, message.payload).then((result) => ({
      result,
    }));
  } else if (message.type === 'GET_STATE') {
    operation = (async () => {
      await languageReady;
      await configQueue;
      const all = await chrome.storage.local.get(null);
      const records = Object.entries(all)
        .filter(([key]) => key.startsWith('record:'))
        .map(([, record]) => record)
        .sort((a, b) => b.startTime.localeCompare(a.startTime));
      // Fetch live progress only for known downloads; never import old history.
      const active = await chrome.downloads.search({ state: 'in_progress' });
      for (const item of active) {
        const record = records.find((r) => r.id === item.id);
        if (record)
          Object.assign(record, {
            bytesReceived: item.bytesReceived,
            totalBytes: item.totalBytes,
            paused: item.paused,
          });
      }
      return {
        config: { ...defaultConfig(), ...all.config },
        records,
        queue: await getQueue(),
        downloader: downloaderSummary(all.externalDownloader),
      };
    })();
  } else if (message.type === 'GET_REPORT') {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    operation = getReport(message.id);
  } else if (
    [
      'GET_DOWNLOADER',
      'SAVE_DOWNLOADER',
      'CLEAR_DOWNLOADER',
      'TEST_DOWNLOADER',
      'SEND_TORRENT',
    ].includes(message.type)
  ) {
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    operation = handleDownloader(message);
  } else if (message.type === 'UPDATE_RECORDS') operation = updateRecords(message);
  else if (message.type === 'DOWNLOAD_ACTION')
    operation = downloadAction(message.action, message.ids, message.confirmed);
  else if (message.type === 'ADD_BATCH') operation = addBatch(message);
  else if (message.type === 'GET_QUEUE') operation = getQueue().then((queue) => ({ queue }));
  else if (message.type === 'QUEUE_ACTION') operation = queueAction(message.action, message.ids);
  else if (message.type === 'SCAN_TABS') operation = scanTabs(message.tabIds);
  else if (message.type === 'GET_CAPTURE')
    operation = getCapture().then((capture) => ({ capture }));
  else if (message.type === 'SET_CAPTURE') operation = setCapture(message.tabIds, message.enabled);
  else if (message.type === 'CLEAR_CAPTURE') operation = clearCapture();
  else if (message.type === 'SYNC_UPLOAD') {
    operation = syncQueue.then(async () => {
      await configQueue;
      return uploadRules(await getConfig());
    });
    syncQueue = operation.catch(() => {});
  } else if (message.type === 'SYNC_READ') operation = syncQueue.then(readCloudRules);
  else if (message.type === 'SYNC_CLEAR') {
    operation = syncQueue.then(clearCloudRules);
    syncQueue = operation.catch(() => {});
  } else if (message.type === 'IMPORT_HISTORY')
    operation = (async () => {
      const items = await chrome.downloads.search({ limit: MAX_RECORDS, orderBy: ['-startTime'] });
      let added = 0;
      for (const item of items) {
        if (item.incognito) continue;
        const key = keyOf(item.id);
        if (!(await chrome.storage.local.get(key))[key]) {
          await enqueue(item.id, () => snapshot(item, { kind: 'historical' }));
          added++;
        }
      }
      return { added };
    })();
  else if (message.type === 'PREVIEW_IMPORT') {
    operation = configQueue.then(async () => {
      const config = await getConfig();
      return {
        plan: planImport(message.pack, config.rules, message.position),
        revision: config.revision || 0,
      };
    });
  } else if (writable.includes(message.type)) {
    operation = configQueue.then(() => changeConfig(message));
    configQueue = operation.catch(() => {});
  } else return;
  operation.then(
    (data) => respond({ ok: true, ...data }),
    (error) => respond({ ok: false, error: error.message }),
  );
  return true;
});
async function updateBadge() {
  const items = await chrome.downloads.search({ state: 'in_progress' });
  const count = items.filter((item) => !item.incognito).length;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#4b5563' });
}
async function applyBrowserSettings(config) {
  if (await chrome.permissions.contains({ permissions: ['downloads.ui'] }))
    await chrome.downloads.setUiOptions({ enabled: !config.replaceDownloadUI });
}
async function setupBrowser() {
  await languageReady;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'download-link',
    title: t('用 Nivra 下载'),
    contexts: ['link', 'image', 'audio', 'video'],
  });
  chrome.contextMenus.create({
    id: 'scan-page',
    title: t('发现本页下载资源'),
    contexts: ['page', 'selection'],
  });
  await chrome.alarms.create('maintenance', { periodInMinutes: 1 });
  await applyBrowserSettings(await getConfig());
}
async function maintenance() {
  await pumpQueue();
  await updateBadge();
  const config = await getConfig();
  if (!config.autoClearDays) return;
  const all = await chrome.storage.local.get(null),
    cutoff = Date.now() - config.autoClearDays * 86400000;
  const expired = Object.entries(all)
    .filter(
      ([key, r]) =>
        key.startsWith('record:') &&
        r.state !== 'in_progress' &&
        new Date(r.startTime).getTime() < cutoff,
    )
    .map(([key]) => key);
  if (expired.length) {
    await chrome.storage.local.remove(expired);
    await deleteReports(expired.map((key) => Number(key.slice(7))));
  }
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'maintenance') void maintenance().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  void setupBrowser().catch(() => {});
  void maintenance().catch(() => {});
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.incognito) return;
  if (info.menuItemId === 'download-link')
    void addBatch({
      items: [
        {
          url: info.linkUrl || info.srcUrl,
          tabUrl: tab?.url || '',
          referrer: info.pageUrl || '',
          pageTitle: tab?.title || '',
          linkText: info.selectionText || '',
        },
      ],
    }).catch((error) => console.warn(error.message));
  if (info.menuItemId === 'scan-page')
    void chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html?tab=${tab.id}#resources`) });
});
chrome.commands.onCommand.addListener(async (command) => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(
      command === 'scan-page' ? `manager.html?tab=${tabs[0]?.id || ''}#resources` : 'manager.html',
    ),
  });
});
chrome.notifications?.onClicked.addListener((id) => {
  if (id.startsWith('download:'))
    void chrome.tabs.create({
      url: chrome.runtime.getURL(`manager.html?download=${id.slice(9)}#all`),
    });
});
async function recoverRecords() {
  const all = await chrome.storage.local.get(null);
  for (const [key, record] of Object.entries(all)) {
    if (key.startsWith('record:') && record.state === 'in_progress')
      await enqueue(record.id, () => snapshot({ ...record, filename: record.originalName }));
  }
  await updateBadge();
}
registerCapture();
initReports();
// Downloads can finish while the extension is disabled or the browser is closing.
void recoverRecords().catch((error) => console.warn('Download recovery:', error.message));
void pumpQueue().catch(() => {});
chrome.permissions.onRemoved.addListener((permissions) => {
  configQueue = configQueue
    .then(async () => {
      const config = await getConfig();
      let changed = false;
      if (permissions.permissions?.includes('notifications')) {
        config.notifications = false;
        changed = true;
      }
      if (permissions.permissions?.includes('downloads.ui')) {
        config.replaceDownloadUI = false;
        changed = true;
      }
      if (changed) {
        config.revision = (config.revision || 0) + 1;
        await chrome.storage.local.set({ config });
      }
    })
    .catch(() => {});
});
async function updateRecords(message) {
  if (
    !Array.isArray(message.ids) ||
    message.ids.length > 1000 ||
    message.ids.some((id) => !Number.isInteger(id))
  )
    throw new Error(t('下载编号无效'));
  if (!['trash', 'restore', 'note'].includes(message.action)) throw new Error(t('未知记录操作'));
  const results = [];
  for (const id of message.ids) {
    await enqueue(id, async () => {
      try {
        const key = keyOf(id),
          record = (await chrome.storage.local.get(key))[key];
        if (!record) throw new Error(t('记录已不存在'));
        if (message.action === 'trash') {
          if (record.state === 'in_progress')
            throw new Error(t('请先取消或完成下载，再移入回收站'));
          record.trashedAt = new Date().toISOString();
        }
        if (message.action === 'restore') record.trashedAt = '';
        if (message.action === 'note') {
          if (typeof message.note !== 'string' || message.note.length > 2000)
            throw new Error(t('备注最多 2000 字'));
          record.note = message.note;
        }
        await chrome.storage.local.set({ [key]: record });
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: error.message });
      }
    });
  }
  return { results };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.uiLanguage)
    configQueue = configQueue
      .then(setupBrowser)
      .catch((error) => console.warn('Language update:', error.message));
});
