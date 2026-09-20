import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDeviceUsageStore } from '../scripts/device-usage.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-device-usage-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  let now = 1_700_000_000_000;
  const store = createDeviceUsageStore({ dbPath, now: () => now });
  return { dir, dbPath, store, tick: () => { now += 1000; } };
}

test('device usage persists metadata-only connection, call, byte, and error counters', () => {
  const f = fixture();
  try {
    f.store.recordConnection('usage-device', { reconnect: false });
    f.tick();
    f.store.recordConnection('usage-device', { reconnect: true });
    f.store.recordToolStarted('usage-device', 123);
    f.store.recordToolSucceeded('usage-device', 456);
    f.store.recordToolStarted('usage-device', 25);
    f.store.recordToolFailed('usage-device', 12, 'DEVICE_TEST_ERROR');

    const usage = f.store.get('usage-device');
    assert.deepEqual(usage, {
      connections: 2,
      reconnects: 1,
      toolCallsStarted: 2,
      toolCallsSucceeded: 1,
      toolCallsFailed: 1,
      requestBytes: 148,
      responseBytes: 468,
      lastSeenAt: 1_700_000_001_000,
      lastErrorCode: 'DEVICE_TEST_ERROR'
    });
    assert.equal(JSON.stringify(usage).includes('payload'), false);
    f.store.close();

    const reopened = createDeviceUsageStore({ dbPath: f.dbPath, now: () => 1_700_000_002_000 });
    assert.deepEqual(reopened.get('usage-device'), usage);
    reopened.close();
  } finally {
    try { f.store.close(); } catch {}
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('dashboard usage uses latest tool call for last seen and supports per-session OAuth labels', () => {
  const f = fixture();
  try {
    f.store.openActivitySession({ activitySessionId: 'session-1', accountId: 'account-1', clientId: 'chatgpt-client' });
    f.store.recordToolCall({
      accountId: 'account-1', activitySessionId: 'session-1', deviceId: 'device-1', tool: 'read_text_file',
      durationMs: 1, success: true, inputBytes: 10, outputBytes: 20, callerCategory: 'oauth'
    });
    const toolSeenAt = 1_700_000_000_000;
    f.tick();
    f.store.recordConnection('device-1', { reconnect: true });
    f.tick();
    f.store.touch('device-1');

    assert.equal(f.store.getDeviceUsageForAccount('account-1')[0].lastSeenAt, toolSeenAt);
    const renamed = f.store.renameActivitySession({ activitySessionId: 'session-1', accountId: 'account-1', displayName: 'ChatGPT office' });
    assert.equal(renamed.displayName, 'ChatGPT office');
    assert.equal(f.store.listActivitySessions('account-1')[0].displayName, 'ChatGPT office');
    assert.throws(
      () => f.store.renameActivitySession({ activitySessionId: 'session-1', accountId: 'account-2', displayName: 'stolen' }),
      /not found/i
    );
  } finally {
    try { f.store.close(); } catch {}
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
