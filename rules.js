import { t } from './i18n.js';
import { validateRule, conditionResults, decide, basename } from './engine.js';
import { FILE_TYPES } from './file-types.js';
export const PACK_FORMAT = 'nivra-rules';
export const MAX_PACK_BYTES = 128 * 1024;
export const RULE_FIELDS = [
  'name',
  'enabled',
  'extensions',
  'domain',
  'keyword',
  'regex',
  'folder',
  'mime',
  'urlRegex',
  'finalUrlRegex',
  'referrerRegex',
  'tabUrlRegex',
  'regexFlags',
  'filenameTemplate',
  'pathTemplate',
  'condition',
  'reference',
  'asFilter',
  'conflictAction',
  'action',
  'postAction',
];
const property = (maxLength, description) => ({ type: 'string', maxLength, description });
export const RULE_PACK_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Nivra rule pack',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'version', 'rules'],
  properties: {
    format: { const: PACK_FORMAT },
    version: { const: 1 },
    rules: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { ...property(60, t('规则名称')), minLength: 1 },
          enabled: { type: 'boolean', default: true },
          extensions: property(1000, t('逗号分隔的扩展名，例如 pdf, docx；为空则不限制')),
          domain: property(253, t('域名，不含协议和路径；也匹配其子域名；为空则不限制')),
          keyword: property(512, t('文件名包含，不区分大小写；为空则不限制')),
          regex: property(
            2048,
            t('文件名 JavaScript 正则，支持分组、捕获组、回溯引用和前后查找；运行超时会终止'),
          ),
          mime: property(2048, t('MIME 正则')),
          urlRegex: property(2048, t('完整下载 URL 正则')),
          finalUrlRegex: property(2048, t('跳转后的完整 URL 正则')),
          referrerRegex: property(2048, t('来源 URL 正则')),
          tabUrlRegex: property(2048, t('来源页面 URL 正则，需通过资源扫描或批量入口提供')),
          regexFlags: property(4, t('i/m/s/u 标记，默认 i')),
          folder: property(
            1024,
            t('归档根目录内的相对目录，支持日期/域名/捕获组变量；空值代表归档根目录'),
          ),
          filenameTemplate: property(
            1024,
            t('文件名模板，默认 {filename}；支持 {name}.{ext}、{num:4}、Chrono *page_title* 等'),
          ),
          pathTemplate: property(
            1024,
            t(
              '完整相对路径模板，优先于 folder + filenameTemplate；支持 RegExp ${url:1}/${filename} 和 ${date:YYYY-MM}',
            ),
          ),
          condition: property(
            4096,
            t('Chrono 条件表达式，支持 *ext*、[ext_image]、{rule_ref}、逻辑/比较与白名单函数'),
          ),
          reference: property(60, t('供其他条件引用的内部名称')),
          asFilter: { type: 'boolean' },
          conflictAction: { enum: ['uniquify', 'overwrite', 'prompt'] },
          action: { enum: ['archive', 'keep'] },
          postAction: { enum: ['none', 'reveal'] },
        },
        anyOf: [
          'extensions',
          'domain',
          'keyword',
          'regex',
          'mime',
          'urlRegex',
          'finalUrlRegex',
          'referrerRegex',
          'tabUrlRegex',
          'condition',
        ].map((key) => ({
          required: [key],
          properties: { [key]: { type: 'string', minLength: 1 } },
        })),
      },
    },
  },
};
export const RULE_GUIDE = [
  t('只给之后的新下载分类。文件仍保存在浏览器默认下载目录的子目录中。'),
  t(
    '设置中的 archiveRoot 是所有归档规则和批量路径的共同前缀；规则内不要重复填写此前缀。根目录设置属于本机偏好，不随规则包导出或同步；选择电脑上的下载根目录需在 Chrome 下载设置中操作。',
  ),
  t('从上到下匹配，首个命中规则生效；同一规则中的条件是 AND；扩展名列表内部是 OR。'),
  t(
    '域名匹配浏览器实际提供的下载 URL、最终 URL 或 referrer，含子域名；没有来源信息则不匹配该条件。',
  ),
  t(
    '目录可使用 {year}、{month}、{day}、{host}、${url:1}、${date:YYYY-MM}；filenameTemplate 支持 {name}.{ext} 或 Chrono *page_title*.*ext*。pathTemplate 可定义完整相对路径。',
  ),
  t(
    '完整 JavaScript 正则在可中断的线程中执行。默认同名自动编号；overwrite 会覆盖同名文件，应用前需要明确确认。具体规则通常排在通用分类前；也可选择最后命中生效。',
  ),
].join('\n');
export const RULE_TEMPLATES = [
  {
    id: 'android',
    title: t('Android 构建包'),
    icon: 'app',
    description: t('APK、AAB、APKS 按月收好'),
    sample: { filename: 'app-release.apk', url: 'https://example.com/build.apk' },
    rule: {
      name: t('Android 构建包'),
      extensions: 'apk, aab, apks',
      folder: t('安装包/Android/{year}-{month}'),
    },
  },
  {
    id: 'github',
    title: t('GitHub 下载'),
    icon: 'archive',
    description: t('依据来源域名归入代码目录'),
    sample: { filename: 'project.zip', url: 'https://github.com/example/project/archive.zip' },
    rule: { name: t('GitHub 下载'), domain: 'github.com', folder: t('代码/GitHub/{year}-{month}') },
  },
  {
    id: 'invoice',
    title: t('电子发票'),
    icon: 'file',
    description: t('名称含“发票”的 PDF 按月归档'),
    sample: { filename: t('出行发票.pdf'), url: 'https://example.com/invoice.pdf' },
    rule: {
      name: t('电子发票'),
      extensions: 'pdf',
      keyword: t('发票'),
      folder: t('票据/{year}-{month}'),
    },
  },
  {
    id: 'assets',
    title: t('设计素材'),
    icon: 'image',
    description: t('图片、SVG 和设计文件集中管理'),
    sample: { filename: 'cover.svg', url: 'https://example.com/cover.svg' },
    rule: {
      name: t('设计素材'),
      extensions: 'png, jpg, jpeg, webp, svg, fig, sketch, psd',
      folder: t('素材/{year}-{month}'),
    },
  },
  {
    id: 'reports',
    title: t('工作周报'),
    icon: 'file',
    description: t('名称含“周报”的文档单独存放'),
    sample: { filename: t('项目周报.pdf'), url: 'https://example.com/report.pdf' },
    rule: {
      name: t('工作周报'),
      extensions: 'pdf, docx, xlsx, pptx',
      keyword: t('周报'),
      folder: t('工作/周报/{year}-{month}'),
    },
  },
  ...FILE_TYPES.slice(6).map((type) => ({
    id: type.id,
    title: t(type.name),
    icon: type.icon,
    description: type.extensions.slice(0, 6).join('、').toUpperCase() + t(' 等格式按月归档'),
    sample: { filename: 'sample.' + type.extensions[0], url: 'https://example.com/file' },
    rule: {
      name: t(type.name),
      extensions: type.extensions.join(', '),
      folder: t(type.name) + '/{year}-{month}',
    },
  })),
  {
    id: 'by-site',
    title: t('按下载网站'),
    icon: 'folder',
    description: t('按下载地址的域名，再按月份整理；会匹配所有下载'),
    sample: { filename: 'report.pdf', url: 'https://files.example.com/report.pdf' },
    rule: { name: t('按下载网站'), regex: '.+', folder: t('网站/{host}/{year}-{month}') },
  },
  {
    id: 'screenshots',
    title: t('截图单独存放'),
    icon: 'image',
    description: t('识别截图、屏幕截图、Screenshot 等名称'),
    sample: { filename: 'Screenshot 2026-10-19.png', url: 'https://example.com/image.png' },
    rule: {
      name: t('截图'),
      extensions: 'png, jpg, jpeg, webp, heic',
      regex: t('截图|截屏|screenshot|screen[ _-]?shot'),
      folder: t('图片/截图/{year}-{month}'),
    },
  },
  {
    id: 'datasets',
    title: t('表格与数据集'),
    icon: 'file',
    description: t('CSV、Excel、JSON 与 Parquet 统一收纳'),
    sample: { filename: 'sales.csv', url: 'https://example.com/export.csv' },
    rule: {
      name: t('数据集'),
      extensions: 'csv, tsv, xls, xlsx, json, jsonl, parquet, arrow',
      folder: t('数据集/{year}-{month}'),
    },
  },
  {
    id: 'dated-reports',
    title: t('按文件名日期'),
    icon: 'clock',
    description: t('从 2026-10-19_report.pdf 提取年月分类'),
    sample: { filename: '2026-10-19_report.pdf', url: 'https://example.com/report.pdf' },
    rule: {
      name: t('按文件名日期'),
      regex: '^(20[0-9]{2})[-_](0[1-9]|1[0-2])[-_]',
      folder: t('按文件日期/${filename:1}-${filename:2}'),
    },
  },
  {
    id: 'large-files',
    title: t('大文件单独存放'),
    icon: 'archive',
    description: t('已知大小超过 500 MB 的文件；大小未知时不匹配'),
    sample: {
      filename: 'movie.mp4',
      totalBytes: 600 * 1024 * 1024,
      url: 'https://example.com/movie.mp4',
    },
    rule: { name: t('大文件'), condition: '*size* > mb(500)', folder: t('大文件/{year}-{month}') },
  },
  {
    id: 'mime-images',
    title: t('按内容类型识别图片'),
    icon: 'image',
    description: t('文件名没有图片扩展名时，也可根据服务器 MIME 分类'),
    sample: { filename: 'download', mime: 'image/png', url: 'https://example.com/export' },
    rule: { name: t('图片 MIME'), mime: '^image/', folder: t('图片/{year}-{month}') },
  },
];
export function publicRule(input) {
  const rule = validateRule(input);
  const defaults = {
    regexFlags: 'i',
    filenameTemplate: '{filename}',
    conflictAction: 'uniquify',
    action: 'archive',
    postAction: 'none',
    asFilter: false,
  };
  const basic = ['name', 'enabled', 'extensions', 'domain', 'keyword', 'regex', 'folder'];
  return Object.fromEntries(
    RULE_FIELDS.filter(
      (key) =>
        basic.includes(key) ||
        (rule[key] !== '' && rule[key] !== undefined && rule[key] !== defaults[key]),
    ).map((key) => [key, rule[key]]),
  );
}
export function importLegacyRules(value) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray(value?.rulesets)
      ? value.rulesets
      : !value?.format && Array.isArray(value?.rules)
        ? value.rules
        : value?.pattern
          ? [value]
          : null;
  if (!list) return value;
  const rules = list.map((raw, index) => {
    if (raw && ('pattern' in raw || 'description' in raw))
      return {
        name: String(raw.description || t('RegExp 规则 {0}', index + 1)).slice(0, 60),
        enabled: raw.enabled !== false,
        regex:
          raw.filename ||
          (![raw.mime, raw.url, raw.finalUrl, raw.referrer, raw.tabUrl].some(Boolean) ? '.*' : ''),
        mime: raw.mime || '',
        urlRegex: raw.url || '',
        finalUrlRegex: raw.finalUrl || '',
        referrerRegex: raw.referrer || '',
        tabUrlRegex: raw.tabUrl || '',
        pathTemplate: String(raw.pattern || '').replace(/^\/+/, ''),
        conflictAction: raw['conflict-action'] || 'uniquify',
      };
    if (raw && ('int_name' in raw || 'caption' in raw)) {
      const actions = { '': 'none', '<folder>': 'reveal' };
      if (raw.post_action && !Object.hasOwn(actions, raw.post_action))
        throw new Error(
          t('第 {0} 条 Chrono 规则的完成后动作不受支持，请改为不操作或显示文件夹', index + 1),
        );
      return {
        name: String(raw.caption || raw.int_name || t('Chrono 规则 {0}', index + 1)).slice(0, 60),
        enabled: Boolean(raw.active),
        condition: raw.condition || 'true',
        reference: raw.int_name || '',
        asFilter: Boolean(raw.as_filter),
        folder: String(raw.folder || '').replace(/^\.\//, ''),
        filenameTemplate: raw.naming || '*name*.*ext*',
        postAction: actions[raw.post_action || ''],
      };
    }
    return raw;
  });
  return { format: PACK_FORMAT, version: 1, rules };
}
export function exportRegExpRules(rules) {
  return rules.map((raw) => {
    const rule = validateRule(raw);
    if (rule.condition || rule.action === 'keep' || rule.postAction !== 'none')
      throw new Error(t('「{0}」包含 RegExp 不支持的条件或动作，无法无损导出', rule.name));
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!['i', 'iu', 'ui'].includes(rule.regexFlags))
      throw new Error(t('「{0}」的正则标记无法无损导出到 RegExp', rule.name));
    const guards = [];
    if (rule.regex) guards.push(`(?=[\\s\\S]*(?:${rule.regex}))`);
    if (rule.extensions)
      guards.push(
        `(?=[\\s\\S]*\\.(?:${extensionsOfRule(rule.extensions).map(escape).join('|')})$)`,
      );
    if (rule.keyword) guards.push(`(?=[\\s\\S]*${escape(rule.keyword)})`);
    const filename =
      rule.extensions || rule.keyword ? '^' + guards.join('') + '[\\s\\S]*$' : rule.regex;
    if (rule.domain)
      throw new Error(
        t('「{0}」跨多个来源字段匹配域名，需在 RegExp 中拆为多条规则后迁移', rule.name),
      );
    const template =
      rule.pathTemplate || `${rule.folder ? rule.folder + '/' : ''}${rule.filenameTemplate}`;
    const pattern = template.replace(
      /(?<!\$)\{(year|month|day|hour|minute|second|filename)\}/g,
      (_, key) =>
        key === 'filename'
          ? '${filename}'
          : '${date:' +
            { year: 'YYYY', month: 'MM', day: 'DD', hour: 'HH', minute: 'mm', second: 'ss' }[key] +
            '}',
    );
    if (/(?<!\$)\{/.test(pattern) || pattern.includes('*name*'))
      throw new Error(t('「{0}」包含无法直接导出为 RegExp 的命名模板', rule.name));
    return {
      description: rule.name,
      enabled: rule.enabled,
      filename,
      mime: rule.mime,
      url: rule.urlRegex,
      finalUrl: rule.finalUrlRegex,
      referrer: rule.referrerRegex,
      tabUrl: rule.tabUrlRegex,
      pattern,
      'conflict-action': rule.conflictAction,
    };
  });
}
const extensionsOfRule = (value) => value.split(', ').filter(Boolean);
export function makeRulePack(rules) {
  return parseRulePack({ format: PACK_FORMAT, version: 1, rules: rules.map(publicRule) });
}
export function parseRulePack(value) {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).length > MAX_PACK_BYTES)
      throw new Error(t('配置文件不能超过 128 KiB'));
    const text = value.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(t('JSON 格式不正确，请粘贴完整配置对象'));
    }
  }
  value = importLegacyRules(value);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(t('配置须包含 format、version 和 rules'));
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_PACK_BYTES)
    throw new Error(t('配置文件不能超过 128 KiB'));
  if (value.format !== PACK_FORMAT || value.version !== 1)
    throw new Error(t('仅支持 nivra-rules 格式、version: 1'));
  const unknown = Object.keys(value).filter((key) => !['format', 'version', 'rules'].includes(key));
  if (unknown.length) throw new Error(t('配置包含未知字段：{0}', unknown.join(', ')));
  if (!Array.isArray(value.rules) || value.rules.length > 100)
    throw new Error(t('rules 必须是数组，最多 100 条规则'));
  const rules = value.rules.map((rule, index) => {
    try {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule))
        throw new Error(t('规则必须是对象'));
      const extra = Object.keys(rule).filter((key) => !RULE_FIELDS.includes(key));
      if (extra.length) throw new Error(t('未知字段：{0}', extra.join(', ')));
      return publicRule(rule);
    } catch (error) {
      throw new Error(t('第 {0} 条规则：{1}', index + 1, error.message));
    }
  });
  return { format: PACK_FORMAT, version: 1, rules };
}
export function ruleFingerprint(raw) {
  const { name, ...rule } = publicRule(raw);
  rule.extensions = [...new Set(rule.extensions.split(', ').filter(Boolean))].sort().join(', ');
  rule.keyword = rule.keyword.toLowerCase();
  return JSON.stringify(rule);
}
export function planImport(value, existingRules, position = 'first') {
  if (!['first', 'last'].includes(position)) throw new Error(t('导入位置须为 first 或 last'));
  const pack = parseRulePack(value);
  const seen = new Set(existingRules.map(ruleFingerprint));
  const added = [],
    skipped = [];
  for (const rule of pack.rules) {
    const key = ruleFingerprint(rule);
    if (seen.has(key)) skipped.push(rule.name);
    else {
      seen.add(key);
      added.push(rule);
    }
  }
  if (existingRules.length + added.length > 100)
    throw new Error(t('导入后超过 100 条规则，请减少配置中的规则'));
  const previewRules = added.map((rule, index) => ({ ...rule, id: `import-preview-${index}` }));
  return {
    added,
    skipped,
    position,
    total: existingRules.length + added.length,
    rules:
      position === 'first'
        ? [...previewRules, ...existingRules]
        : [...existingRules, ...previewRules],
  };
}
export function explainRules(sample, config) {
  if (
    !sample.filename ||
    typeof sample.filename !== 'string' ||
    basename(sample.filename).length > 255
  )
    throw new Error(t('请提供 1–255 个字符的示例文件名'));
  const item = { ...sample, startTime: sample.startTime || new Date().toISOString() };
  if (!Number.isFinite(new Date(item.startTime).getTime())) throw new Error(t('示例日期无效'));
  config = {
    ...config,
    rules: config.rules.map((rule, index) => ({ ...rule, id: rule.id || `explain-${index}` })),
  };
  const decision = decide(item, config);
  const steps = config.rules.map((raw, index) => {
    const entry = { name: raw.name, id: raw.id, index, folder: raw.folder };
    const error = decision.errors?.find((error) => error.ruleId === raw.id);
    if (error) return { ...entry, status: 'invalid', error: error.error, checks: [] };
    if (!raw.enabled) return { ...entry, status: 'disabled', checks: [] };
    try {
      const rule = validateRule(raw);
      const checks = conditionResults(rule, item, config);
      const matched = checks.every((check) => check.matched);
      const status = !matched
        ? 'missed'
        : !config.enabled
          ? 'paused'
          : decision.ruleId === rule.id
            ? 'selected'
            : 'shadowed';
      return { ...entry, status, checks };
    } catch (error) {
      return { ...entry, status: 'invalid', error: error.message, checks: [] };
    }
  });
  return { decision, steps };
}
export function sampleFromRecord(record) {
  return {
    filename: basename(record.originalName || record.filename),
    startTime: record.startTime,
    totalBytes: record.totalBytes,
    state: record.state,
    paused: record.paused,
    ...(record.matchContext || { url: record.source }),
    approximate: !record.matchContext || Boolean(record.matchContext.redacted),
  };
}
export function buildAiPrompt(goal) {
  return t(
    '请为 Nivra 生成归档规则配置。\n需求：{0}\n\n配置约束：\n{1}\n\n请返回符合以下 JSON Schema 的完整 JSON 对象，不包含 id、不编造浏览器权限或下载来源。至少指定一个非空匹配条件。若需求依赖不能获得的信息，请说明并提出可用替代条件。不要声称配置已应用到浏览器。\n{2}\n\n可直接导入的例子：\n{3}',
    goal.trim() || t('请先问我希望如何分类下载文件。'),
    RULE_GUIDE,
    JSON.stringify(RULE_PACK_SCHEMA, null, 2),
    JSON.stringify(makeRulePack([RULE_TEMPLATES[0].rule]), null, 2),
  );
}
