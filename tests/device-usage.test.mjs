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
