import { t, getLocale } from './i18n.js';
import { h, request, applyTheme, toggleTheme, formatBytes } from './ui.js';
import { downloadState } from './download-state.js';
applyTheme();
const $ = (selector) => document.querySelector(selector);
$('#reportTheme').onclick = toggleTheme;
const rawId = new URL(location.href).searchParams.get('id');
const id = rawId === null ? NaN : Number(rawId);
let report,
  selected = -1,
  toastTimer;
const duration = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? t('{0} 秒', seconds)
    : seconds < 3600
      ? t('{0} 分 {1} 秒', Math.floor(seconds / 60), seconds % 60)
      : t('{0} 小时 {1} 分', Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60));
};
const relative = (at) => duration(at - report.start);
const speed = (value) => t('{0}/秒', formatBytes(value));
const states = {
  active: t('下载中'),
  paused: t('已暂停'),
  complete: t('已完成'),
  failed: t('下载中断'),
  canceled: t('已取消'),
  unavailable: t('浏览器记录已不存在'),
  missing: t('文件已不存在'),
};
const events = {
  start: t('开始下载'),
  joined: t('从此时开始记录'),
  resume: t('继续下载'),
  paused: t('暂停下载'),
  complete: t('下载完成'),
  failed: t('下载中断'),
  canceled: t('取消下载'),
  gap: t('采样中断，之后重新记录'),
  ambiguous: t('同链接请求重叠，无法确认连接归属'),
  unavailable: t('浏览器记录已不存在'),
  missing: t('文件已不存在'),
};
function renderChart() {
  const left = 60,
    right = 942,
    top = 12,
    bottom = 212;
  const end = Math.max(report.updatedAt, report.end || 0, report.start + 1000);
  const span = end - report.start;
  const max = Math.max(1024, ...report.samples.map((p) => p.rate || 0));
  const x = (at) => left + ((at - report.start) / span) * (right - left);
  const y = (rate) => bottom - (rate / max) * (bottom - top);
  let lines = '',
    bands = '',
    path = '';
  for (const sample of report.samples) {
    if (sample.kind === 'run' && sample.rate !== null) {
      path += `${path ? 'L' : 'M'}${x(sample.from).toFixed(1)},${y(sample.rate).toFixed(1)} L${x(sample.to).toFixed(1)},${y(sample.rate).toFixed(1)} `;
    } else {
      if (path) {
        lines += `<path class="speed-line" d="${path}"/>`;
        path = '';
      }
      bands += `<rect class="${sample.kind === 'paused' ? 'pause' : 'gap'}-band" x="${x(sample.from)}" y="${top}" width="${Math.max(0.5, x(sample.to) - x(sample.from))}" height="${bottom - top}"/>`;
    }
  }
  if (path) lines += `<path class="speed-line" d="${path}"/>`;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) =>
        `<line class="grid" x1="${left}" x2="${right}" y1="${y(max * v)}" y2="${y(max * v)}"/><text x="${left - 9}" y="${y(max * v) + 4}" text-anchor="end">${h(formatBytes(max * v))}/s</text>`,
    )
    .join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) =>
        `<text x="${left + v * (right - left)}" y="239" text-anchor="${v === 0 ? 'start' : v === 1 ? 'end' : 'middle'}">${h(duration(span * v))}</text>`,
    )
    .join('');
  const markers = report.events
    .filter((e) => ['paused', 'resume', 'failed', 'canceled', 'complete'].includes(e.kind))
    .map(
      (e) =>
        `<line class="event-marker" x1="${x(e.at)}" x2="${x(e.at)}" y1="${top}" y2="${bottom}"><title>${h(events[e.kind])} · ${h(relative(e.at))}</title></line>`,
    )
    .join('');
  $('#chartSvg').innerHTML =
    `<defs><pattern id="gapPattern" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 6L6 0" stroke="var(--border-default)" stroke-width="1"/></pattern></defs>${grid}${bands}${markers}${lines}${ticks}<line id="chartCursor" class="cursor" y1="${top}" y2="${bottom}" visibility="hidden"/>${!report.samples.some((sample) => sample.rate !== null) ? `<text x="500" y="110" text-anchor="middle">${t('尚无足够采样，短下载可能没有完整曲线')}</text>` : ''}`;
  $('#chartHint').textContent = t(
    '{0} · 约每秒采样{1}{2}',
    report.end ? t('已保存') : t('正在记录'),
    report.compacted ? t(' · 长任务曲线已聚合') : '',
    report.partial ? t(' · 含未采样区间') : '',
  );
  if (selected >= 0) inspect(Math.min(selected, report.samples.length - 1));
}
function inspect(index) {
  if (!report?.samples[index]) return;
  selected = index;
  const p = report.samples[index];
  const end = Math.max(report.updatedAt, report.end || 0, report.start + 1000);
  const x = 60 + (((p.from + p.to) / 2 - report.start) / (end - report.start)) * 882;
  const cursor = $('#chartCursor');
  cursor.setAttribute('x1', x);
  cursor.setAttribute('x2', x);
  cursor.setAttribute('visibility', 'visible');
  $('#chartTooltip').textContent = t(
    '{0}–{1} · {2} · 采样时已接收 {3}',
    relative(p.from),
    relative(p.to),
    p.kind === 'run'
      ? speed(p.rate)
      : p.kind === 'paused'
        ? t('已暂停')
        : p.kind === 'short'
          ? t('区间不足半秒，样本不足')
          : t('此区间未采样'),
    formatBytes(p.received),
  );
}
$('#speedChart').addEventListener('pointermove', (event) => {
  if (!report?.samples.length) return;
  const box = $('#chartSvg').getBoundingClientRect();
  const fraction = Math.max(
    0,
    Math.min(1, (((event.clientX - box.left) / box.width) * 960 - 60) / 882),
  );
  const at = report.start + fraction * (Math.max(report.updatedAt, report.end || 0) - report.start);
  const index = report.samples.findIndex((p) => p.to >= at);
  inspect(index < 0 ? report.samples.length - 1 : index);
});
$('#speedChart').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !report?.samples.length)
    return;
  event.preventDefault();
  inspect(
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? report.samples.length - 1
        : Math.max(
            0,
            Math.min(report.samples.length - 1, selected + (event.key === 'ArrowRight' ? 1 : -1)),
          ),
  );
});
function render() {
  $('#reportName').textContent = report.name || t('下载 #{0}', id);
  $('#reportSubtitle').textContent =
    `${new Date(report.start).toLocaleString(getLocale())} · ${report.totalBytes > 0 ? formatBytes(report.totalBytes) : t('总大小未知')}`;
  $('#reportState').textContent = states[report.state] || report.state;
  const stats = [
    [t('总耗时'), duration((report.end || report.updatedAt) - report.start)],
    [
      t('观测平均速度'),
      report.measuredMs >= 500
        ? speed((report.measuredBytes * 1000) / report.measuredMs)
        : t('样本不足'),
    ],
    [t('采样峰值'), report.peakMeasured ? speed(report.peak) : t('样本不足')],
    [t('已记录暂停时间'), duration(report.pausedMs)],
  ];
  $('#reportStats').innerHTML = stats
    .map(([label, value]) => `<dl class="report-stat"><dt>${label}</dt><dd>${h(value)}</dd></dl>`)
    .join('');
  renderChart();
  const ambiguous = report.network.status === 'ambiguous';
  $('#networkHint').textContent = ambiguous
    ? t('同链接的下载或请求发生重叠，无法确认连接归属，因此不展示推测的 IP。')
    : t('浏览器观测到的连接端点，按链接与请求时间关联；可能为 CDN 或代理端点，不代表源站。');
  const ips = [...new Set(report.network.hops.map((hop) => hop.ip).filter(Boolean))];
  const facts = [
    [t('原始下载域名'), report.origin || t('未提供')],
    [t('最终下载域名'), report.destination || t('未提供')],
    [t('实际连接 IP'), ambiguous ? t('无法确认') : ips.join('、') || t('未获取')],
    [
      t('IP 类型'),
      ips.length
        ? [...new Set(ips.map((ip) => (ip.includes(':') ? 'IPv6' : 'IPv4')))].join(' / ')
        : '—',
    ],
  ];
  $('#networkSummary').innerHTML = facts
    .map(([key, value]) => `<div><dt>${key}</dt><dd>${h(value)}</dd></div>`)
    .join('');
  $('#networkHops').innerHTML = report.network.hops
    .map(
      (hop) =>
        `<li><time>${h(relative(hop.at))}</time><div><strong>${h(hop.host)}${hop.to ? ` → ${h(hop.to)}` : ''}</strong><p>${h(hop.kind === 'redirect' ? t('重定向') : t('连接'))} · HTTP ${hop.status || '—'} · ${h(hop.ip || t('IP 未提供'))}${hop.cached ? t(' · 磁盘缓存') : ''}</p></div></li>`,
    )
    .join('');
  $('#reportEvents').innerHTML = report.events
    .map(
      (event) =>
        `<li class="${h(event.kind)}"><time>${h(relative(event.at))}</time><div>${h(events[event.kind] || event.kind)}${
          event.kind === 'failed'
            ? `<br>${h(downloadState({ state: 'interrupted', error: event.detail }).detail)}`
            : ''
        }</div></li>`,
    )
    .join('');
  $('#eventHint').textContent =
    `${report.eventsOmitted ? t('较早的 {0} 个事件已省略。', report.eventsOmitted) : ''}${report.network.truncated ? t('连接明细仅保留前 32 条。') : ''}`;
}
async function refresh() {
  try {
    report = (await request('GET_REPORT', { id })).report;
    if (!report) {
      $('#reportName').textContent = t('暂无下载报告');
      $('#reportError').hidden = false;
      $('#reportError').textContent = t(
        '这个任务没有采样记录，或报告已到期清理。新开始的下载会自动记录。',
      );
      $('#reportBody').hidden = true;
      $('#copyReport').disabled = true;
      return;
    }
    $('#reportError').hidden = true;
    $('#reportBody').hidden = false;
    $('#copyReport').disabled = false;
    render();
  } catch (error) {
    $('#reportError').hidden = false;
    $('#reportError').textContent = error.message;
  } finally {
    if (report && !report.end) setTimeout(refresh, 1000);
  }
}
$('#copyReport').onclick = async () => {
  if (!report) return;
  try {
    const ips = [...new Set(report.network.hops.map((hop) => hop.ip).filter(Boolean))];
    const text = [
      t('下载报告 · {0}', report.name || id),
      t('状态：{0}', states[report.state] || report.state),
      t('来源：{0} → {1}', report.origin || t('未提供'), report.destination || t('未提供')),
      t(
        '连接 IP：{0}',
        report.network.status === 'ambiguous' ? t('无法确认') : ips.join(', ') || t('未获取'),
      ),
      t('耗时：{0}', duration((report.end || report.updatedAt) - report.start)),
      t(
        '观测均速：{0}',
        report.measuredMs >= 500
          ? speed((report.measuredBytes * 1000) / report.measuredMs)
          : t('样本不足'),
      ),
      t('采样峰值：{0}', report.peakMeasured ? speed(report.peak) : t('样本不足')),
      t(
        '数据：{0}；采样约 1 秒；{1} 个点',
        report.partial ? t('部分区间未采样') : t('已记录'),
        report.samples.length,
      ),
      ...report.events.map(
        (e) =>
          `${relative(e.at)} ${events[e.kind] || e.kind}${e.kind === 'failed' ? ' ' + e.detail : ''}`,
      ),
    ].join('\n');
    await navigator.clipboard.writeText(text);
    $('#reportToast').textContent = t('已复制摘要（仅含域名，不含链接参数或本地路径）');
  } catch (error) {
    $('#reportToast').textContent = error.message;
  }
  $('#reportToast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#reportToast').hidden = true), 3000);
};
void refresh();
