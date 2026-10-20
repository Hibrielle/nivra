import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReport,
  sampleReport,
  compactSamples,
  networkCandidates,
  reportsOverlap,
  publicReport,
  retentionIds,
  REPORT_LIMITS,
} from '../report-core.js';
const T = 100000;
const item = (extra = {}) => ({
  id: 1,
  startTime: new Date(T).toISOString(),
  state: 'in_progress',
  filename: '/tmp/sample.zip',
  totalBytes: 100000,
  bytesReceived: 0,
  ...extra,
});
test('sampling separates real rates, pause, resume, worker gaps and canceled counter resets', () => {
  const r = createReport(item(), T);
  sampleReport(r, item(), T);
  sampleReport(r, item({ bytesReceived: 1000 }), T + 1000);
  assert.equal(r.samples.at(-1).rate, 1000);
  assert.equal(r.measuredBytes, 1000);
  sampleReport(r, item({ bytesReceived: 2000, paused: true }), T + 2000);
  sampleReport(r, item({ bytesReceived: 2000, paused: true }), T + 3000);
  sampleReport(r, item({ bytesReceived: 2000 }), T + 4000);
  assert.equal(r.pausedMs, 2000);
  sampleReport(r, item({ bytesReceived: 9000 }), T + 10000, true);
  assert.equal(r.samples.at(-1).kind, 'gap');
  assert.equal(r.measuredBytes, 2000);
  sampleReport(r, item({ bytesReceived: 9500 }), T + 11000);
  assert.equal(r.samples.at(-1).rate, 500);
  sampleReport(
    r,
    item({ state: 'interrupted', error: 'USER_CANCELED', bytesReceived: 0 }),
    T + 12000,
  );
  assert.equal(r.state, 'canceled');
  assert.equal(r.samples.at(-1).kind, 'gap');
  assert.equal(r.measuredBytes, 2500);
  const count = r.samples.length;
  sampleReport(r, item({ state: 'interrupted', error: 'USER_CANCELED' }), T + 13000);
  assert.equal(r.samples.length, count);
  assert.ok(r.events.some((e) => e.kind === 'resume'));
  assert.ok(r.partial);
});
test('closely spaced counter notifications are combined before calculating sampled peak', () => {
  const r = createReport(item(), T);
  sampleReport(r, item(), T);
  sampleReport(r, item({ bytesReceived: 100 }), T + 10);
  assert.equal(r.peakMeasured, false);
  sampleReport(r, item({ bytesReceived: 1000 }), T + 1000);
  assert.equal(r.samples.length, 1);
  assert.equal(r.peak, 1000);
  sampleReport(r, item({ bytesReceived: 2000, state: 'complete' }), T + 1010);
  assert.equal(r.samples.length, 1);
  assert.ok(r.peak < 2000);
  sampleReport(r, item({ bytesReceived: 5000 }), T + 6000, true);
  sampleReport(r, item({ bytesReceived: 6000, state: 'complete' }), T + 6010);
  assert.equal(r.samples.at(-1).kind, 'short');
  assert.equal(r.samples.at(-1).rate, null);
  assert.equal(
    createReport(item({ filename: '', url: 'https://example.test/report.pdf?token=secret' }), T)
      .name,
    'report.pdf',
  );
});
test('bounded downsampling retains gaps, measured totals and original sampled peak', () => {
  const r = createReport(item(), T);
  sampleReport(r, item(), T);
  for (let n = 1; n < 2000; n++) sampleReport(r, item({ bytesReceived: n * 100 }), T + n * 1000);
  assert.ok(r.samples.length <= REPORT_LIMITS.samples);
  assert.equal(r.measuredBytes, 199900);
  assert.equal(r.peak, 100);
  assert.ok(r.compacted);
  const samples = compactSamples([
    { from: 0, to: 1000, bytes: 100, rate: 100, kind: 'run', received: 100 },
    { from: 1000, to: 5000, bytes: 0, rate: null, kind: 'gap', received: 100 },
  ]);
  assert.equal(samples[0].kind, 'gap');
  assert.equal(samples[0].rate, null);
});
test('request attribution requires exact fingerprints and time overlap; repeated same-link tasks are ambiguous', () => {
  const a = { id: 1, start: 10000, end: 20000, urlHashes: ['full-url-a'] };
  const b = { id: 2, start: 11000, end: 21000, urlHashes: ['full-url-a'] };
  const c = { id: 3, start: 30000, end: 40000, urlHashes: ['full-url-a'] };
  assert.equal(reportsOverlap(a, b), true);
  assert.equal(reportsOverlap(a, c), false);
  assert.deepEqual(networkCandidates({ start: 12000, hashes: ['full-url-a'] }, [a, b, c]), [a, b]);
  assert.deepEqual(
    networkCandidates({ start: 12000, hashes: ['same-path-different-query'] }, [a, b]),
    [],
  );
  assert.deepEqual(networkCandidates({ start: 5000, hashes: ['full-url-a'] }, [a, b]), []);
  assert.deepEqual(networkCandidates({ start: 16000, hashes: ['full-url-a'] }, [a, b]), []);
  assert.deepEqual(
    networkCandidates({ start: 16000, hashes: ['full-url-a'] }, [
      { ...a, events: [{ kind: 'resume', at: 16000 }] },
    ]).map((r) => r.id),
    [1],
  );
  assert.equal('urlHashes' in publicReport({ ...a, samples: [] }), false);
});
test('retention bounds ended reports by count, age and total budget while preserving active tasks', () => {
  const now = Date.now();
  const active = { id: 999, start: now, updatedAt: now, end: null };
  const ended = Array.from({ length: 210 }, (_, i) => ({
    id: i,
    end: now - i * 1000,
    updatedAt: now - i * 1000,
  }));
  const old = { id: 1000, end: 1, updatedAt: 1 };
  const removed = retentionIds([active, ...ended, old], now);
  assert.equal(removed.includes(999), false);
  assert.equal(removed.includes(1000), true);
  assert.equal(removed.length, 11);
  assert.ok(
    retentionIds(
      [{ id: 1, end: now, updatedAt: now, data: 'x'.repeat(REPORT_LIMITS.bytes) }],
      now,
    ).includes(1),
  );
});
test('resumable failures reopen the report and mark the unobserved interval instead of drawing a false zero', () => {
  const r = createReport(item(), T);
  sampleReport(r, item(), T);
  sampleReport(
    r,
    item({ state: 'interrupted', error: 'NETWORK_FAILED', bytesReceived: 100 }),
    T + 1000,
  );
  assert.ok(r.end);
  sampleReport(r, item({ bytesReceived: 100 }), T + 6000);
  assert.equal(r.end, null);
  assert.equal(r.samples.at(-1).kind, 'gap');
  assert.equal(r.events.at(-1).kind, 'resume');
});
