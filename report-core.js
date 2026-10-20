import { downloadState } from './download-state.js';

export const REPORT_LIMITS = {
  samples: 400,
  events: 100,
  hops: 32,
  reports: 200,
  days: 30,
  bytes: 8 * 1024 * 1024,
};
function reportName(item) {
  const name = (item.filename || '').split(/[\\/]/).pop();
  if (name) return name.slice(0, 512);
  try {
    return decodeURIComponent(new URL(item.finalUrl || item.url).pathname.split('/').pop()).slice(
      0,
      512,
    );
  } catch {
    return '';
  }
}
export function reportEvent(report, kind, at, detail = '') {
  report.events.push({ kind, at, ...(detail ? { detail } : {}) });
  if (report.events.length > REPORT_LIMITS.events) {
    report.events.splice(1, 1);
    report.eventsOmitted = (report.eventsOmitted || 0) + 1;
  }
}
export function createReport(item, now = Date.now()) {
  const start = Date.parse(item.startTime) || now;
  const report = {
    id: item.id,
    start,
    updatedAt: now,
    end: null,
    name: reportName(item),
    state: 'active',
    totalBytes: item.totalBytes,
    urlHashes: [],
    samples: [],
    events: [],
    network: { status: 'missing', hops: [] },
    measuredBytes: 0,
    measuredMs: 0,
    pausedMs: 0,
    peak: 0,
    peakMeasured: false,
    partial: now - start > 3000,
    last: null,
  };
  reportEvent(report, report.partial ? 'joined' : 'start', now);
  return report;
}
export function compactSamples(samples) {
  const result = [];
  for (let i = 0; i < samples.length; i += 2) {
    const a = samples[i],
      b = samples[i + 1];
    if (!b) {
      result.push(a);
      continue;
    }
    const kind = a.kind === b.kind ? a.kind : 'gap';
    result.push({
      from: a.from,
      to: b.to,
      bytes: a.bytes + b.bytes,
      rate: kind === 'run' ? ((a.bytes + b.bytes) * 1000) / (b.to - a.from) : null,
      kind,
      received: b.received,
    });
  }
  return result;
}
export function sampleReport(report, item, now = Date.now(), recovered = false) {
  const state = downloadState(item).kind;
  const previous = report.last;
  report.name = reportName(item) || report.name;
  report.totalBytes = item.totalBytes;
  report.updatedAt = now;
  if (
    previous &&
    now > previous.at &&
    (['active', 'paused'].includes(previous.state) || state === 'active' || recovered)
  ) {
    const duration = now - previous.at;
    const delta = Math.max(0, item.bytesReceived || 0) - previous.bytes;
    let kind = 'gap',
      rate = null,
      bytes = 0;
    if (!recovered && duration <= 3500 && previous.state === 'active' && delta >= 0) {
      kind = 'run';
      bytes = delta;
      rate = (delta * 1000) / duration;
      report.measuredBytes += bytes;
      report.measuredMs += duration;
    } else if (!recovered && duration <= 3500 && previous.state === 'paused') {
      kind = 'paused';
      report.pausedMs += duration;
    } else {
      report.partial = true;
      if (report.samples.at(-1)?.kind !== 'gap') reportEvent(report, 'gap', previous.at);
    }
    const sample = {
      from: previous.at,
      to: now,
      rate,
      bytes,
      kind,
      received: Math.max(0, item.bytesReceived || 0),
    };
    const lastSample = report.samples.at(-1);
    // Fold closely spaced state/filename events into an adjacent measurement,
    // rather than presenting a millisecond counter update as the peak speed.
    if (
      kind === 'run' &&
      ['run', 'short'].includes(lastSample?.kind) &&
      lastSample.to === sample.from &&
      (duration < 500 || lastSample.to - lastSample.from < 500)
    ) {
      sample.from = lastSample.from;
      sample.bytes += lastSample.bytes;
      sample.rate = (sample.bytes * 1000) / (sample.to - sample.from);
      report.samples.pop();
    }
    if (sample.kind === 'run' && sample.to - sample.from < 500) {
      sample.kind = 'short';
      sample.rate = null;
    }
    report.samples.push(sample);
    if (sample.kind === 'run' && sample.to - sample.from >= 500) {
      report.peakMeasured = true;
      report.peak = Math.max(report.peak, sample.rate);
    }
    if (report.samples.length > REPORT_LIMITS.samples) {
      report.samples = compactSamples(report.samples);
      report.compacted = true;
    }
  }
  if (state !== report.state)
    reportEvent(report, state === 'active' ? 'resume' : state, now, item.error || '');
  report.state = state;
  report.last = { at: now, bytes: Math.max(0, item.bytesReceived || 0), state };
  report.end = item.state !== 'in_progress' ? Date.parse(item.endTime) || now : null;
  return report;
}
export function networkCandidates(trace, reports, now = Date.now()) {
  return reports.filter(
    (r) =>
      trace.start >= r.start - 2500 &&
      trace.start <= (r.end || now) + 1000 &&
      [
        r.start,
        ...(r.events || []).filter((event) => event.kind === 'resume').map((event) => event.at),
      ].some((at) => Math.abs(trace.start - at) <= 2500) &&
      trace.hashes.some((hash) => r.urlHashes.includes(hash)),
  );
}
export function reportsOverlap(a, b, now = Date.now()) {
  return (
    a.id !== b.id &&
    a.start <= (b.end || now) &&
    b.start <= (a.end || now) &&
    a.urlHashes.some((hash) => b.urlHashes.includes(hash))
  );
}
export function publicReport(report) {
  if (!report) return null;
  const { urlHashes, ...result } = report;
  return result;
}
export function retentionIds(reports, now = Date.now()) {
  const size = (report) => new TextEncoder().encode(JSON.stringify(report)).byteLength;
  const ended = reports.filter((r) => r.end).sort((a, b) => b.updatedAt - a.updatedAt);
  let bytes = reports.filter((r) => !r.end).reduce((n, r) => n + size(r), 0);
  const cutoff = now - REPORT_LIMITS.days * 86400000;
  return ended
    .filter((r, i) => {
      bytes += size(r);
      return i >= REPORT_LIMITS.reports || r.updatedAt < cutoff || bytes > REPORT_LIMITS.bytes;
    })
    .map((r) => r.id);
}
