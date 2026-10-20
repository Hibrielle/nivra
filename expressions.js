import { t } from './i18n.js';
import jsep from './vendor/parser.js';
import moment from './vendor/date.js';
import { FILE_TYPES, TYPE_BY_ID } from './file-types.js';
jsep.addBinaryOp('=', 6);
jsep.addBinaryOp('<>', 6);
export const EXT_GROUPS = {
  ...Object.fromEntries(FILE_TYPES.map((type) => ['ext_' + type.id, type.extensions.join('|')])),
  ext_doc: [...TYPE_BY_ID.document.extensions, ...TYPE_BY_ID.ebook.extensions].join('|'),
  ext_pdf: 'pdf',
  ext_binary: TYPE_BY_ID.installer.extensions.join('|'),
};
export function itemFields(item) {
  const filename = String(item.filename || 'download')
    .split(/[\\/]/)
    .pop();
  const dot = filename.lastIndexOf('.');
  let parsed;
  try {
    parsed = new URL(item.url || item.finalUrl);
  } catch {
    parsed = new URL('https://unknown.invalid');
  }
  const start = new Date(item.startTime || Date.now());
  const state =
    item.queueState === 'waiting'
      ? 'inqueue'
      : item.paused
        ? 'paused'
        : item.state === 'complete'
          ? 'finished'
          : item.state === 'interrupted'
            ? 'interrupted'
            : 'download';
  return {
    filename,
    name: dot > 0 ? filename.slice(0, dot) : filename,
    ext: dot > 0 ? filename.slice(dot + 1) : '',
    url: item.url || '',
    eurl: item.finalUrl || item.url || '',
    host: parsed.hostname === 'unknown.invalid' ? '' : parsed.hostname,
    query: parsed.search.slice(1),
    anchor: parsed.hash.slice(1),
    subdirs: parsed.pathname.split('/').slice(1, -1).join('/'),
    mime: item.mime || '',
    mime_type: item.mime || '',
    referer: item.referrer || '',
    refer: item.referrer || '',
    tab_url: item.tabUrl || '',
    page_title: item.pageTitle || '',
    title: item.linkTitle || '',
    text: item.linkText || '',
    desc: item.linkText || item.linkTitle || '',
    remark: item.linkText || '',
    remarks: item.linkText || '',
    num: item.batchIndex || 1,
    size: item.totalBytes ?? item.fileSize ?? -1,
    time_add: start.getTime(),
    time_finish: new Date(item.endTime || item.startTime || Date.now()).getTime(),
    time_elapsed: Math.max(0, Date.now() - start.getTime()),
    progress: item.totalBytes > 0 ? ((item.bytesReceived || 0) / item.totalBytes) * 100 : 0,
    finished_bytes: item.bytesReceived || 0,
    state,
  };
}
function tokenizeMacros(expression) {
  let out = '',
    quote = '';
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += expression[++i] || '';
      } else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    const rest = expression.slice(i);
    const patterns = [
      [/^\*([a-z_][a-z0-9_]*)\*/i, 'field'],
      [/^\{([a-z_][a-z0-9_-]*)\}/i, 'rule'],
      [/^\[([a-z0-9_]+)\]/i, 'constant'],
    ];
    let found = false;
    for (const [pattern, fn] of patterns) {
      const m = rest.match(pattern);
      if (m) {
        out += `${fn}(${JSON.stringify(m[1].toLowerCase())})`;
        i += m[0].length - 1;
        found = true;
        break;
      }
    }
    if (!found) out += c;
  }
  return out;
}
const cache = new Map();
export function compileExpression(expression) {
  if (!expression) return null;
  if (typeof expression !== 'string' || expression.length > 4096)
    throw new Error(t('条件表达式最多 4096 个字符'));
  if (cache.has(expression)) return cache.get(expression);
  let ast;
  try {
    ast = jsep(tokenizeMacros(expression));
  } catch (error) {
    throw new Error(t('条件表达式格式不正确：{0}', error.message));
  }
  let nodes = 0;
  const check = (node) => {
    if (++nodes > 512) throw new Error(t('条件表达式过长'));
    if (
      ![
        'Literal',
        'Identifier',
        'UnaryExpression',
        'BinaryExpression',
        'LogicalExpression',
        'CallExpression',
        'MemberExpression',
      ].includes(node.type)
    )
      throw new Error(t('条件不支持 {0}', node.type));
    if (
      node.type === 'Identifier' &&
      ![
        'true',
        'false',
        'field',
        'rule',
        'constant',
        'kb',
        'mb',
        'gb',
        'sec',
        'min',
        'hr',
        'hour',
        'yearof',
        'monthof',
        'dateof',
        'dayof',
        'hourof',
        'minuteof',
        'secondof',
        'is',
        'has',
        'beginwith',
        'endwith',
        'match',
        'aft',
        'aft_',
        'b4',
        'b4_',
        'btwn',
        'btwn_',
        '_btwn',
        '_btwn_',
        'length',
      ].includes(node.name)
    )
      throw new Error(t('未知函数或字段：{0}', node.name));
    if (node.type === 'MemberExpression' && (node.computed || node.property.type !== 'Identifier'))
      throw new Error(t('条件不支持动态属性访问'));
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((v) => v && typeof v === 'object' && check(v));
      else if (value && typeof value === 'object') check(value);
    }
  };
  check(ast);
  if (cache.size > 200) cache.clear();
  cache.set(expression, ast);
  return ast;
}
function constantValue(name, now, groups) {
  if (Object.hasOwn(groups, name)) return groups[name];
  const simple = {
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
    sun: 0,
    download: 'download',
    inqueue: 'inqueue',
    paused: 'paused',
    finished: 'finished',
    interrupted: 'interrupted',
  };
  if (Object.hasOwn(simple, name)) return simple[name];
  if (name === 'now') return now.valueOf();
  const end = name.endsWith('_'),
    key = end ? name.slice(0, -1) : name;
  let date;
  if (key === 'today') date = now.clone().startOf('day');
  else if (key === 'yesterday') date = now.clone().subtract(1, 'day').startOf('day');
  else {
    const m = key.match(/^(this|last)_(week|month|year)$/);
    const ago = key.match(/^(\d+)_(days|weeks|months|years)_ago$/);
    if (m)
      date = now
        .clone()
        .subtract(m[1] === 'last' ? 1 : 0, m[2])
        .startOf(m[2]);
    else if (ago) date = now.clone().subtract(Number(ago[1]), ago[2]).startOf(ago[2]);
    else throw new Error(t('未知常量：[{0}]', name));
  }
  if (end) {
    const unit = key.includes('week')
      ? 'week'
      : key.includes('month')
        ? 'month'
        : key.includes('year')
          ? 'year'
          : 'day';
    date.endOf(unit);
  }
  return date.valueOf();
}
export function evaluateExpression(expression, item, context = {}, references = new Set()) {
  if (!expression) return true;
  const ast = compileExpression(expression),
    fields = itemFields(item),
    now = moment(context.now || Date.now());
  const methods = {
    has: (a, b) => new RegExp(String(b), 'i').test(String(a)),
    is: (a, b) =>
      typeof a === 'number' &&
      typeof b === 'string' &&
      /^(today|yesterday|this_|last_|\d+_)/.test(b)
        ? a >= constantValue(b, now, EXT_GROUPS) && a <= constantValue(b + '_', now, EXT_GROUPS)
        : new RegExp(`^(?:${b})$`, 'i').test(String(a)),
    beginwith: (a, b) => new RegExp(`^(?:${b})`, 'i').test(String(a)),
    endwith: (a, b) => new RegExp(`(?:${b})$`, 'i').test(String(a)),
    match: (a, b) => new RegExp(String(b), 'i').test(String(a)),
    aft: (a, b) => a > dateNumber(b),
    aft_: (a, b) => a >= dateNumber(b),
    b4: (a, b) => a < dateNumber(b),
    b4_: (a, b) => a <= dateNumber(b),
    btwn: (a, b, c) => a > dateNumber(b) && a < dateNumber(c),
    btwn_: (a, b, c) => a > dateNumber(b) && a <= dateNumber(c),
    _btwn: (a, b, c) => a >= dateNumber(b) && a < dateNumber(c),
    _btwn_: (a, b, c) => a >= dateNumber(b) && a <= dateNumber(c),
  };
  const functions = {
    field: (name) => {
      if (!Object.hasOwn(fields, name)) throw new Error(t('未知下载字段：{0}', name));
      return fields[name];
    },
    constant: (name) => constantValue(name, now, { ...EXT_GROUPS, ...context.extensionGroups }),
    rule: (name) => {
      if (references.has(name)) throw new Error(t('规则引用循环：{0}', name));
      const target = context.rules?.find((rule) => rule.reference === name);
      if (!target) throw new Error(t('找不到引用规则：{0}', name));
      const next = new Set(references);
      next.add(name);
      return evaluateExpression(target.condition, item, context, next);
    },
    kb: (n) => n * 1024,
    mb: (n) => n * 1024 ** 2,
    gb: (n) => n * 1024 ** 3,
    sec: (n) => n * 1000,
    min: (n) => n * 60000,
    hr: (n) => n * 3600000,
    hour: (n) => n * 3600000,
    yearof: (n) => new Date(n).getFullYear(),
    monthof: (n) => new Date(n).getMonth(),
    dateof: (n) => new Date(n).getDate(),
    dayof: (n) => new Date(n).getDay(),
    hourof: (n) => new Date(n).getHours(),
    minuteof: (n) => new Date(n).getMinutes(),
    secondof: (n) => new Date(n).getSeconds(),
  };
  function visit(node) {
    if (node.type === 'Literal') return node.value;
    if (node.type === 'Identifier') {
      if (node.name === 'true') return true;
      if (node.name === 'false') return false;
      throw new Error(t('函数必须带参数调用'));
    }
    if (node.type === 'UnaryExpression') {
      const value = visit(node.argument);
      if (node.operator === '!') return !value;
      if (node.operator === '-') return -value;
      if (node.operator === '+') return +value;
      throw new Error(t('不支持的单目运算'));
    }
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      const a = visit(node.left);
      if (node.operator === '&&') return a && visit(node.right);
      if (node.operator === '||') return a || visit(node.right);
      const b = visit(node.right);
      switch (node.operator) {
        case '=':
        case '==':
        case '===':
          return a === b;
        case '<>':
        case '!=':
        case '!==':
          return a !== b;
        case '>':
          return a > b;
        case '<':
          return a < b;
        case '>=':
          return a >= b;
        case '<=':
          return a <= b;
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '%':
          return a % b;
        default:
          throw new Error(t('不支持的运算符'));
      }
    }
    if (node.type === 'CallExpression') {
      const args = node.arguments.map(visit);
      if (node.callee.type === 'Identifier' && Object.hasOwn(functions, node.callee.name))
        return functions[node.callee.name](...args);
      if (node.callee.type === 'MemberExpression') {
        const method = node.callee.property.name;
        if (Object.hasOwn(methods, method))
          return methods[method](visit(node.callee.object), ...args);
      }
      throw new Error(t('不支持的函数调用'));
    }
    if (node.type === 'MemberExpression' && node.property.name === 'length')
      return String(visit(node.object)).length;
    throw new Error(t('不支持的条件表达式'));
  }
  return Boolean(visit(ast));
}
function dateNumber(value) {
  return typeof value === 'string' ? Date.parse(value) : Number(value);
}
export function chronoDateFormat(value, format = 'yyyy-MM-dd') {
  const d = new Date(value),
    pad = (v, n = 2) => String(v).padStart(n, '0');
  return format.replace(
    /yyyy|yy|MM|M|dd|d|hh|h|HH|H|mm|m|ss|s|SSS|S/g,
    (token) =>
      ({
        yyyy: d.getFullYear(),
        yy: String(d.getFullYear()).slice(-2),
        MM: pad(d.getMonth() + 1),
        M: d.getMonth() + 1,
        dd: pad(d.getDate()),
        d: d.getDate(),
        hh: pad(d.getHours()),
        h: d.getHours(),
        HH: pad(d.getHours()),
        H: d.getHours(),
        mm: pad(d.getMinutes()),
        m: d.getMinutes(),
        ss: pad(d.getSeconds()),
        s: d.getSeconds(),
        SSS: pad(d.getMilliseconds(), 3),
        S: d.getMilliseconds(),
      })[token],
  );
}
