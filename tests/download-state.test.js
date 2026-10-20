import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadState, isCanceled } from '../download-state.js';
import { recordStatus } from '../engine.js';
import { matchesTaskView, taskProgress, taskName } from '../task-view.js';
import { taskMenuGroups } from '../download-info.js';

test('manual cancellation is separate from failures and does not suggest resuming, even with stale canResume', () => {
  const canceled = {
    state: 'interrupted',
    error: 'USER_CANCELED',
    canResume: true,
    bytesReceived: 512,
    totalBytes: 1024,
  };
  assert.equal(downloadState(canceled).kind, 'canceled');
  assert.equal(recordStatus(canceled), 'canceled');
  assert.equal(matchesTaskView(canceled, 'failed'), false);
  assert.equal(matchesTaskView(canceled, 'canceled'), true);
  assert.equal(
    taskMenuGroups(canceled)
      .flat()
      .some((a) => a.key === 'resume'),
    false,
  );
  assert.equal(taskProgress(canceled, new Map()).size, '总大小 1 KB');
  assert.equal(taskProgress({ ...canceled, bytesReceived: 0 }, new Map()).size, '总大小 1 KB');
  assert.equal(taskProgress({ ...canceled, totalBytes: -1 }, new Map()).size, '大小未知');
  assert.equal(
    taskProgress({ ...canceled, error: 'NETWORK_DISCONNECTED' }, new Map()).size,
    '512 B / 1 KB',
  );
  assert.equal(isCanceled({ ...canceled, error: 'USER_SHUTDOWN' }), false);
  assert.equal(downloadState({ ...canceled, error: 'NETWORK_DISCONNECTED' }).kind, 'failed');
});

test('failures explain recovery without promising retry can resolve authentication, storage or security errors', () => {
  assert.match(
    downloadState({ state: 'interrupted', error: 'NETWORK_TIMEOUT', canResume: true }).detail,
    /超时.*可继续/,
  );
  for (const error of ['FILE_NO_SPACE', 'FILE_BLOCKED', 'SERVER_UNAUTHORIZED'])
    assert.doesNotMatch(downloadState({ state: 'interrupted', error }).detail, /可重新下载/);
  assert.match(
    downloadState({ state: 'interrupted', error: 'NEW_BROWSER_CODE' }).detail,
    /查看任务详情/,
  );
  assert.equal(
    taskName({ matchContext: { url: 'https://example.test/files/report%20one.pdf' } }),
    'report one.pdf',
  );
  assert.equal(taskName({}), '未命名下载');
});

test('resume discards a pre-pause speed sample and completed/missing states take precedence over stale pause flags', () => {
  const measurements = new Map([
    [1, { at: performance.now(), bytes: 100, speed: 99999, paused: true }],
  ]);
  const record = {
    id: 1,
    state: 'in_progress',
    paused: false,
    bytesReceived: 100,
    totalBytes: 1000,
  };
  assert.equal(taskProgress(record, measurements).speed, 0);
  assert.equal(
    taskProgress({ ...record, state: 'complete', paused: true }, measurements).status,
    '已完成',
  );
  assert.equal(
    taskProgress({ ...record, state: 'complete', exists: false }, measurements).kind,
    'missing',
  );
});
