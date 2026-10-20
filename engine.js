import { t } from './i18n.js';
import moment from './vendor/date.js';
import { defaultRules } from './file-types.js';
import { isCanceled } from './download-state.js';
import {
  compileExpression,
  evaluateExpression,
  itemFields,
  chronoDateFormat,
} from './expressions.js';
export const MAX_RECORDS = 500;
export function defaultConfig(now = new Date().toISOString()) {
  return {
    version: 1,
    revision: 0,
    installedAt: now,
    enabled: true,
    matchMode: 'first',
    notifications: false,
    replaceDownloadUI: true,
    autoOpenPanel: true,
    onboardingDismissed: false,
    archiveRoot: '',
    queueConcurrency: 3,
    perHostConcurrency: 2,
    autoClearDays: 0,
    savedFilters: [],
    rules: defaultRules(),
  };
}
export const basename = (name) =>
  String(name || '')
    .split(/[\\/]/)
    .pop() || 'download';
export const extensionsOf = (value) =>
  String(value || '')
    .split(/[,，\s]+/)
    .map((x) => x.replace(/^\./, '').toLowerCase())
    .filter(Boolean);
export function sanitizedFilename(name) {
  const cleaned = basename(name)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/g, '');
  if (!cleaned || /^\.+$/.test(cleaned)) return 'download';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}
export const REGEX_FIELDS = {
  regex: 'filename',
  mime: 'mime',
  urlRegex: 'url',
  finalUrlRegex: 'finalUrl',
  referrerRegex: 'referrer',
  tabUrlRegex: 'tabUrl',
};
export function compileFilenameRegex(pattern, flags = 'i') {
  if (!pattern) return null;
  if (typeof pattern !== 'string' || pattern.length > 2048)
    throw new Error(t('每个正则最多 2048 个字符'));
  if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length)
    throw new Error(t('正则标记仅支持 i、m、s、u'));
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(t('正则格式不正确：{0}', error.message));
  }
}
const VARIABLE_FIELDS = new Set([
  'filename',
  'name',
  'ext',
  'url',
  'finalUrl',
  'referrer',
  'tabUrl',
  'mime',
  'host',
  'hostname',
  'domain',
  'page_title',
  'title',
  'text',
  'desc',
  'subdirs',
  'query',
  'anchor',
  'num',
  'size',
  'size_s',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'date',
  'datetime',
  'time',
  'time_add',
  'addtime',
  'y',
  'm',
  'd',
  'hh',
  'mm',
  'ss',
  'wd',
  'refer',
  'referer',
  'mime_type',
  'remark',
  'remarks',
  'eurl',
]);
const TOKEN = /\$\{([^}]+)\}|\{([^}]+)\}|\*([^*]+)\*/g;
export function validateTemplate(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > 1024 || (!value && !allowEmpty))
    throw new Error(t('路径或命名模板须为 1–1024 个字符'));
  if (!value) return value;
  const substituted = value.replace(TOKEN, (_, legacy, modern, chrono) => {
    const token = legacy || modern || chrono;
    const key = (chrono ? token.split(',')[0].replace(/^flat/, '') : token.split(':')[0]).trim();
    if (!VARIABLE_FIELDS.has(key)) throw new Error(t('未知路径变量：{0}', key));
    const spec = chrono ? token.slice(token.indexOf(',') + 1) : token.slice(token.indexOf(':') + 1);
    if (
      !chrono &&
      token.includes(':') &&
      !['date', 'datetime', 'time', 'num'].includes(key) &&
      !/^\d+$/.test(spec)
    )
      throw new Error(t('捕获组须为数字：{0}', token));
    return 'value';
  });
  if (/[{}]/.test(substituted) || substituted.includes('*'))
    throw new Error(t('路径模板包含未闭合或未知变量'));
  validateFolder(substituted);
  return value;
}
export function validateFolder(folder) {
  if (!folder || folder.length > 1024) throw new Error(t('请填写有效的相对路径'));
  if (/[\\<>:"|?*\u0000-\u001f\u007f]/.test(folder) || folder.startsWith('/'))
    throw new Error(t('仅支持下载目录内的相对路径'));
  const replaced = folder.replace(/\{(year|month|day|hour|minute|second)\}/g, '2026');
  if (/[{}]/.test(replaced)) throw new Error(t('目录包含未知变量'));
  if (
    replaced
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p),
      )
  )
    throw new Error(t('目录不能包含空层级、..、保留名称或以空格/句点结尾'));
  return folder;
}
export function validateArchiveRoot(value = '') {
  if (typeof value !== 'string' || value.length > 256)
    throw new Error(t('归档子目录须为 0–256 个字符'));
  const root = value.trim().normalize('NFC');
  if (!root) return '';
  if (/[{}]/.test(root)) throw new Error(t('归档子目录请使用固定名称，日期变量可放在分类规则中'));
  try {
    return validateFolder(root);
  } catch {
    throw new Error(t('请填写相对目录，例如 资料/下载；选择电脑上的根目录请点「选择下载根目录」'));
  }
}
export function validateRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(t('规则必须是对象'));
  const textFields = [
    'id',
    'name',
    'extensions',
    'domain',
    'keyword',
    'regex',
    'mime',
    'urlRegex',
    'finalUrlRegex',
    'referrerRegex',
    'tabUrlRegex',
    'regexFlags',
    'folder',
    'filenameTemplate',
    'pathTemplate',
    'condition',
    'reference',
    'conflictAction',
    'action',
    'postAction',
  ];
  for (const key of textFields)
    if (input[key] !== undefined && typeof input[key] !== 'string')
      throw new Error(t('{0} 必须是文本', key));
  for (const key of ['enabled', 'asFilter'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw new Error(t('{0} 必须是 true 或 false', key));
  const rule = Object.fromEntries(textFields.map((key) => [key, String(input[key] || '').trim()]));
  rule.enabled = input.enabled !== false;
  rule.asFilter = Boolean(input.asFilter);
  rule.extensions = extensionsOf(rule.extensions).join(', ');
  rule.domain = rule.domain.toLowerCase();
  rule.regexFlags = input.regexFlags === undefined ? 'i' : input.regexFlags;
  rule.filenameTemplate = rule.filenameTemplate || '{filename}';
  rule.conflictAction = rule.conflictAction || 'uniquify';
  rule.action = rule.action || 'archive';
  rule.postAction = rule.postAction || 'none';
  if (!rule.name || rule.name.length > 60) throw new Error(t('规则名称须为 1–60 个字符'));
  if (
    rule.extensions.length > 1000 ||
    extensionsOf(rule.extensions).some((x) => !/^[a-z0-9][a-z0-9.-]*$/.test(x))
  )
    throw new Error(t('扩展名请用逗号分隔，例如 pdf, docx'));
  if (
    rule.domain &&
    (!/^(localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(rule.domain) ||
      rule.domain.includes('..') ||
      rule.domain.length > 253)
  )
    throw new Error(t('请仅填写域名，不含协议和路径'));
  if (rule.keyword.length > 512) throw new Error(t('关键词最多 512 个字符'));
  if (rule.reference && !/^[a-z_][a-z0-9_-]{0,59}$/i.test(rule.reference))
    throw new Error(t('引用名须为字母、数字、下划线或连字符'));
  if (!['uniquify', 'overwrite', 'prompt'].includes(rule.conflictAction))
    throw new Error(t('无效的重名策略'));
  if (!['archive', 'keep'].includes(rule.action)) throw new Error(t('无效的规则动作'));
  if (!['none', 'reveal'].includes(rule.postAction)) throw new Error(t('无效的完成后动作'));
  if (
    !rule.extensions &&
    !rule.domain &&
    !rule.keyword &&
    !rule.condition &&
    !Object.keys(REGEX_FIELDS).some((key) => rule[key])
  )
    throw new Error(t('至少填写一个匹配条件'));
  for (const key of Object.keys(REGEX_FIELDS)) compileFilenameRegex(rule[key], rule.regexFlags);
  compileExpression(rule.condition);
  if (rule.action === 'archive') {
    if (rule.pathTemplate) validateTemplate(rule.pathTemplate.replace(/\/$/, ''));
    else {
      validateTemplate(rule.folder, { allowEmpty: true });
      validateTemplate(rule.filenameTemplate);
    }
  }
  return rule;
}
const MIME_FALLBACK = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  exe: 'application/exe',
  apk: 'application/vnd.android.package-archive',
  txt: 'text/plain',
  torrent: 'application/x-bittorrent',
  avi: 'video/x-msvideo',
};
function normalizeItem(item) {
  let filename = basename(item.filename).normalize('NFC');
  try {
    filename = decodeURIComponent(filename);
  } catch {}
  const normalized = { ...item, filename };
  if (!normalized.mime || normalized.mime === 'application/octet-stream')
    normalized.mime =
      MIME_FALLBACK[filename.split('.').pop().toLowerCase()] || normalized.mime || '';
  for (const key of ['url', 'finalUrl', 'referrer', 'tabUrl']) {
    try {
      normalized[key] = decodeURI(item[key] || '');
    } catch {
      normalized[key] = item[key] || '';
    }
  }
  return normalized;
}
export function inspectRule(rule, item, context = {}) {
  const data = normalizeItem(item),
    name = data.filename,
    checks = [],
    captures = {};
  const extensions = extensionsOf(rule.extensions);
  if (extensions.length)
    checks.push({
      label: t('扩展名'),
      expected: rule.extensions,
      matched: extensions.some((ext) => name.toLowerCase().endsWith(`.${ext}`)),
    });
  if (rule.keyword)
    checks.push({
      label: t('文件名包含'),
      expected: rule.keyword,
      matched: name.toLowerCase().includes(rule.keyword.toLowerCase()),
    });
  if (rule.domain)
    checks.push({
      label: t('来源或下载域名'),
      expected: rule.domain,
      matched: [data.url, data.finalUrl, data.referrer].some((url) => {
        try {
          const host = new URL(url).hostname.toLowerCase();
          return host === rule.domain || host.endsWith(`.${rule.domain}`);
        } catch {
          return false;
        }
      }),
    });
  const labels = {
    regex: t('文件名正则'),
    mime: t('MIME 正则'),
    urlRegex: t('下载 URL 正则'),
    finalUrlRegex: t('最终 URL 正则'),
    referrerRegex: t('来源 URL 正则'),
    tabUrlRegex: t('活动标签页 URL 正则'),
  };
  for (const [key, field] of Object.entries(REGEX_FIELDS)) {
    const value = String(data[field] || '');
    captures[field] = [value];
    if (!rule[key]) continue;
    const match =
      field === 'tabUrl' && !value
        ? null
        : compileFilenameRegex(rule[key], rule.regexFlags ?? 'i').exec(value);
    checks.push({ label: labels[key], expected: rule[key], matched: Boolean(match) });
    if (match) captures[field] = [value, ...match.slice(1)];
  }
  if (rule.condition)
    checks.push({
      label: t('条件表达式'),
      expected: rule.condition,
      matched: evaluateExpression(rule.condition, data, context),
    });
  return { checks, captures, item: data, matched: checks.every((check) => check.matched) };
}
export const conditionResults = (rule, item, context = {}) =>
  inspectRule(rule, item, context).checks;
export const matches = (rule, item, context = {}) => inspectRule(rule, item, context).matched;
export function renderTemplate(template, item, captures = {}) {
  const fields = itemFields(item),
    date = moment(item.startTime || Date.now());
  if (!date.isValid()) throw new Error(t('下载日期无效'));
  const values = {
    ...fields,
    filename: basename(item.filename),
    finalUrl: item.finalUrl || item.url || '',
    referrer: item.referrer || '',
    tabUrl: item.tabUrl || '',
    hostname: fields.host,
    domain: fields.host,
    year: date.format('YYYY'),
    month: date.format('MM'),
    day: date.format('DD'),
    hour: date.format('HH'),
    minute: date.format('mm'),
    second: date.format('ss'),
    y: date.format('YYYY'),
    m: date.format('MM'),
    d: date.format('DD'),
    hh: date.format('HH'),
    mm: date.format('mm'),
    ss: date.format('ss'),
    wd: date.day(),
    size_s: fields.size < 1024 ? `${fields.size} B` : `${(fields.size / 1024).toFixed(1)} KB`,
  };
  return String(template).replace(TOKEN, (_, legacy, modern, chrono) => {
    const text = legacy || modern || chrono,
      flat = Boolean(chrono && text.startsWith('flat'));
    const normalized = flat ? text.slice(4) : text;
    const separator = chrono ? ',' : ':',
      at = normalized.indexOf(separator),
      key = (at < 0 ? normalized : normalized.slice(0, at)).trim(),
      spec = at < 0 ? '' : normalized.slice(at + 1);
    let value;
    if (['date', 'datetime', 'time', 'time_add', 'addtime'].includes(key)) {
      if (chrono)
        value = chronoDateFormat(
          item.startTime,
          spec ||
            (key === 'time' ? 'hh:mm:ss' : key === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd hh:mm:ss'),
        );
      else
        value = date.format(
          spec ||
            (key === 'time' ? 'HH-mm-ss' : key === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD_HH-mm-ss'),
        );
    } else if (key === 'num' && spec) {
      const width = Number(spec);
      if (!Number.isInteger(width) || width < 1 || width > 12)
        throw new Error(t('编号位数须为 1–12'));
      value = String(fields.num).padStart(width, '0');
    } else if (spec) {
      const index = Number(spec);
      value = captures[key]?.[index];
      if (value === undefined) throw new Error(t('捕获组不存在：{0}:{1}', key, spec));
    } else value = values[key];
    if (value === undefined) throw new Error(t('未知命名变量：{0}', key));
    if (value === '' && ['page_title', 'text', 'title', 'tabUrl'].includes(key))
      throw new Error(t('当前下载缺少 {0}，请开启网页上下文或使用其他变量', key));
    value = String(value);
    return flat ? value.replace(/[\\/]/g, '_') : value;
  });
}
function resolvedPath(value) {
  if (!value || /^[\\/]/.test(value) || /^[a-z]:/i.test(value))
    throw new Error(t('生成的路径须位于默认下载目录内'));
  if (value.split(/[\\/]/).some((part) => part === '.' || part === '..'))
    throw new Error(t('生成路径包含越界层级'));
  return value
    .split('/')
    .filter(Boolean)
    .map((part) => sanitizedFilename(part))
    .join('/');
}
export function renderPath(template, item, captures = {}, archiveRoot = '') {
  let target = renderTemplate(template, item, captures);
  if (target.endsWith('/')) target += sanitizedFilename(item.filename);
  target = resolvedPath(target);
  const root = validateArchiveRoot(archiveRoot);
  if (root) target = root + '/' + target;
  validateFolder(target);
  return target;
}
export function decide(item, config) {
  if (!config.enabled) return { kind: 'paused' };
  let selected = null;
  const errors = [];
  for (const raw of config.rules) {
    if (!raw.enabled) continue;
    try {
      const rule = validateRule(raw),
        inspection = inspectRule(rule, item, config);
      if (!inspection.matched) continue;
      if (rule.action === 'keep')
        selected = { kind: 'excluded', ruleId: rule.id, ruleName: rule.name };
      else {
        const rawPath =
          rule.pathTemplate || `${rule.folder ? rule.folder + '/' : ''}${rule.filenameTemplate}`;
        const target = renderPath(
          rawPath,
          inspection.item,
          inspection.captures,
          config.archiveRoot,
        );
        selected = {
          kind: 'matched',
          ruleId: rule.id,
          ruleName: rule.name,
          folder: target.split('/').slice(0, -1).join('/'),
          target,
          conflictAction: rule.conflictAction,
          postAction: rule.postAction,
        };
      }
      if (config.matchMode !== 'last') break;
    } catch (error) {
      errors.push({ ruleId: raw.id, ruleName: raw.name, error: error.message });
    }
  }
  return selected
    ? { ...selected, ...(errors.length ? { errors } : {}) }
    : errors.length
      ? { kind: 'error', errors }
      : { kind: 'unmatched' };
}
export function displaySource(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) ? `${u.origin}${u.pathname}` : u.protocol;
  } catch {
    return '';
  }
}
export function recordStatus(record) {
  if (isCanceled(record)) return 'canceled';
  if (record.state === 'interrupted') return 'failed';
  if (record.state !== 'complete') return 'active';
  if (record.decision?.kind !== 'matched') return 'unmatched';
  const folder = String(record.filename || '')
    .replace(/\\/g, '/')
    .split('/')
    .slice(0, -1)
    .join('/');
  const expected = record.decision.folder;
  const name = basename(record.filename),
    target = record.decision.target ? basename(record.decision.target) : '';
  const dot = target.lastIndexOf('.'),
    stem = dot > 0 ? target.slice(0, dot) : target,
    ext = dot > 0 ? target.slice(dot) : '';
  const numbered =
    name.startsWith(stem + ' (') &&
    name.endsWith(')' + ext) &&
    /^\d+$/.test(name.slice(stem.length + 2, name.length - ext.length - 1));
  const sameName =
    !target ||
    name === target ||
    ((record.decision.conflictAction || 'uniquify') === 'uniquify' && numbered);
  return sameName && (!expected || folder === expected || folder.endsWith(`/${expected}`))
    ? 'archived'
    : 'changed';
}
