import { t } from './i18n.js';
import {
  createReport,
  sampleReport,
  reportEvent,
  publicReport,
  networkCandidates,
  reportsOverlap,
  retentionIds,
  REPORT_LIMITS,
} from './report-core.js';
import { readReports, saveReports, removeReports } from './report-store.js';
const reports = new Map(),
  traces = new Map(),
  dirty = new Set();
let lane = Promise.resolve(),
  timer,
  lastFlush = 0;
const serial = (operation) => {
  const job = lane.then(operation);
  lane = job.catch((error) => console.warn('Download report:', error.message));
  return job;
};
const hash = async (url) => {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parsed.href))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  } catch {
    return '';
  }
};
const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
async function observe(item, recovery = false) {
  if (item.incognito) return;
  let report = reports.get(item.id);
  if (!report) {
    report = createReport(item);
    reports.set(item.id, report);
  }
  for (const url of [item.url, item.finalUrl]) {
    const fingerprint = await hash(url);
    if (fingerprint && !report.urlHashes.includes(fingerprint)) {
      if (report.urlHashes.length >= 16) report.urlHashes.splice(1, 1);
      report.urlHashes.push(fingerprint);
    }
  }
  report.origin = host(item.url);
  report.destination = host(item.finalUrl || item.url);
  sampleReport(report, item, Date.now(), recovery);
  dirty.add(item.id);
  for (const other of reports.values()) {
    if (reportsOverlap(report, other)) {
      ambiguous(report);
      ambiguous(other);
    }
  }
  matchTraces();
}
function ambiguous(report) {
  if (report.network.status === 'ambiguous') return;
  report.network = { status: 'ambiguous', hops: [] };
  reportEvent(report, 'ambiguous', Date.now());
  dirty.add(report.id);
}
function matchTraces() {
  const pool = [...reports.values()];
  for (const trace of traces.values()) {
    if (!trace.hops.length) continue;
    const candidates = networkCandidates(trace, pool);
    if (candidates.length > 1) {
      for (const r of candidates) ambiguous(r);
      continue;
    }
    const report = candidates[0];
    if (!report || report.network.status === 'ambiguous') continue;
    // Concurrent indistinguishable HTTP requests cannot safely be attributed to one download.
    const conflicts = [...traces.values()].some(
      (other) =>
        other !== trace &&
        Math.abs(other.start - trace.start) <= 2500 &&
        other.hashes.some((h) => trace.hashes.includes(h)),
    );
    if (conflicts) {
      ambiguous(report);
      continue;
    }
    for (const hop of trace.hops) {
      const key = `${trace.id}:${hop.kind}:${hop.at}`;
      if (report.network.hops.some((h) => h.key === key)) continue;
      if (report.network.hops.length >= REPORT_LIMITS.hops) {
        report.network.truncated = true;
        break;
      }
      report.network.hops.push({ ...hop, key });
      dirty.add(report.id);
    }
    report.network.status = report.network.hops.some((h) => h.ip) ? 'observed' : 'missing';
  }
}
async function flush(force = false) {
  if (!dirty.size) return;
  const pending = [...dirty].map((id) => reports.get(id));
  // Ended downloads have no sampling timer to flush their final data later.
  if (!force && pending.every((report) => !report.end) && Date.now() - lastFlush < 5000) return;
  await saveReports(pending);
  dirty.clear();
  lastFlush = Date.now();
}
async function prune() {
  const ids = retentionIds([...reports.values()]);
  if (ids.length) {
    await removeReports(ids);
    for (const id of ids) {
      reports.delete(id);
      dirty.delete(id);
    }
  }
}
function schedule() {
  if (![...reports.values()].some((r) => !r.end)) {
    clearTimeout(timer);
    timer = null;
  } else if (!timer)
    timer = setTimeout(() => {
      timer = null;
      void serial(tick);
    }, 1000);
}
async function tick() {
  try {
    for (const [id, trace] of traces) if (Date.now() - trace.updatedAt > 30000) traces.delete(id);
    const live = new Map(
      (await chrome.downloads.search({ state: 'in_progress' })).map((item) => [item.id, item]),
    );
    for (const report of [...reports.values()].filter((r) => !r.end)) {
      const item = live.get(report.id) || (await chrome.downloads.search({ id: report.id }))[0];
      if (item) {
        sampleReport(report, item);
        dirty.add(report.id);
      } else {
        report.end = Date.now();
        report.state = 'unavailable';
        reportEvent(report, 'unavailable', report.end);
        dirty.add(report.id);
      }
    }
    await flush();
  } finally {
    schedule();
  }
}
async function network(details, kind, receivedAt) {
  const now = receivedAt;
  for (const [id, trace] of traces) if (now - trace.updatedAt > 30000) traces.delete(id);
  let trace = traces.get(details.requestId);
  if (!trace) {
    if (traces.size >= 256) traces.delete(traces.keys().next().value);
    trace = { id: details.requestId, start: now, updatedAt: now, hashes: [], hops: [] };
    traces.set(details.requestId, trace);
  }
  trace.updatedAt = now;
  for (const url of [details.url, details.redirectUrl]) {
    const fingerprint = await hash(url);
    if (fingerprint && trace.hashes.length < 64 && !trace.hashes.includes(fingerprint))
      trace.hashes.push(fingerprint);
  }
  if (['response', 'redirect'].includes(kind) && trace.hops.length < REPORT_LIMITS.hops)
    trace.hops.push({
      at: now,
      kind,
      host: host(details.url),
      ip: details.ip || '',
      status: details.statusCode,
      ...(details.redirectUrl ? { to: host(details.redirectUrl) } : {}),
      cached: Boolean(details.fromCache),
    });
  matchTraces();
  await flush();
}
export function initReports() {
  // Register synchronously; a waking worker must observe the triggering request.
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  for (const [event, kind] of [
    ['onBeforeRequest', 'start'],
    ['onBeforeRedirect', 'redirect'],
    ['onResponseStarted', 'response'],
  ])
    chrome.webRequest[event].addListener((details) => {
      const receivedAt = Date.now();
      void serial(() => network(details, kind, receivedAt));
    }, filter);
  void serial(async () => {
    for (const report of await readReports()) reports.set(report.id, report);
    const active = await chrome.downloads.search({ state: 'in_progress' });
    for (const item of active) await observe(item, reports.has(item.id));
    for (const r of [...reports.values()].filter(
      (r) => !r.end && !active.some((item) => item.id === r.id),
    )) {
      const item = (await chrome.downloads.search({ id: r.id }))[0];
      if (item) await observe(item, true);
      else {
        r.end = Date.now();
        r.state = 'unavailable';
        dirty.add(r.id);
      }
    }
    await flush(true);
    await prune();
    schedule();
  });
  chrome.downloads.onCreated.addListener((item) => {
    void serial(async () => {
      await observe(item);
      await flush(true);
      schedule();
    });
  });
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state && !delta.paused && !delta.filename && !delta.error && !delta.finalUrl) return;
    void serial(async () => {
      if (!reports.has(delta.id)) return;
      const item = (await chrome.downloads.search({ id: delta.id }))[0];
      if (item) {
        await observe(item);
        await flush(true);
        if (item.state !== 'in_progress') await prune();
      }
      schedule();
    });
  });
  chrome.downloads.onErased.addListener((id) => void deleteReports([id]));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'maintenance')
      void serial(async () => {
        await prune();
        await tick();
      });
  });
}
export const deleteReports = (ids) =>
  serial(async () => {
    await removeReports(ids);
    for (const id of ids) {
      reports.delete(id);
      dirty.delete(id);
    }
    schedule();
  });
export function getReport(id) {
  if (!Number.isInteger(id) || id < 0) return Promise.reject(new Error(t('下载编号无效')));
  return serial(async () => ({ report: publicReport(reports.get(id)) }));
}
