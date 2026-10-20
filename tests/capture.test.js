import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureRegistration, CAPTURE_ORIGINS } from '../capture.js';
function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    emit: (value) => {
      for (const fn of listeners) fn(value);
    },
  };
}
test('capture waits for both optional origins, registers once, and removes the listener on revocation', async () => {
  let grants = [],
    registrations = 0,
    revocations = 0;
  const received = event(),
    added = event(),
    removed = event();
  const api = {
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => grants.includes(origin)),
      onAdded: added,
      onRemoved: removed,
    },
    webRequest: {
      onHeadersReceived: {
        ...received,
        addListener(fn, filter, options) {
          assert.deepEqual(filter.urls, CAPTURE_ORIGINS);
          assert.deepEqual(options, ['responseHeaders']);
          assert.ok(CAPTURE_ORIGINS.every((origin) => grants.includes(origin)));
          registrations++;
          received.addListener(fn);
        },
      },
    },
  };
  const handler = () => {},
    controller = createCaptureRegistration(api, handler, async () => {
      revocations++;
    });
  assert.equal(await controller.ready, false);
  assert.equal(received.listeners.size, 0);
  grants = ['http://*/*'];
  added.emit({ origins: grants });
  assert.equal(await controller.synchronize(), false);
  assert.equal(registrations, 0);
  grants = [...CAPTURE_ORIGINS];
  added.emit({ origins: grants });
  assert.equal(await controller.synchronize(), true);
  assert.equal(registrations, 1);
  assert.equal(received.listeners.size, 1);
  await controller.synchronize();
  assert.equal(registrations, 1);
  grants = [];
  removed.emit({ origins: CAPTURE_ORIGINS });
  assert.equal(received.listeners.size, 0);
  assert.equal(await controller.synchronize(), false);
  assert.ok(revocations >= 1);
  grants = [...CAPTURE_ORIGINS];
  added.emit({ origins: grants });
  assert.equal(await controller.synchronize(), true);
  assert.equal(registrations, 2);
});

test('installation host permissions register before any asynchronous permission lookup', async () => {
  const received = event(),
    added = event(),
    removed = event();
  let resolvePermission;
  const api = {
    runtime: { getManifest: () => ({ host_permissions: CAPTURE_ORIGINS }) },
    permissions: {
      contains: () =>
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
      onAdded: added,
      onRemoved: removed,
    },
    webRequest: { onHeadersReceived: received },
  };
  const handler = () => {},
    controller = createCaptureRegistration(api, handler);
  assert.equal(received.hasListener(handler), true);
  await Promise.resolve();
  resolvePermission(true);
  assert.equal(await controller.ready, true);
  assert.equal(received.listeners.size, 1);
});
