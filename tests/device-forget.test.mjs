import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createDevicePairingStore } from '../scripts/device-pairing-store.mjs';
import { createDeviceStore } from '../scripts/device-store.mjs';
import { createDeviceUsageStore } from '../scripts/device-usage.mjs';

function publicKeyPem() {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

test('revoke hard-forgets every product-facing row for a device but leaves unrelated state intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-forget-'));
  const dbPath = path.join(dir, 'gateway.sqlite');
  const deviceStore = createDeviceStore({ dbPath });
  const pairingStore = createDevicePairingStore({ dbPath });
  const usageStore = createDeviceUsageStore({ dbPath });
  const key = publicKeyPem();

  try {
    deviceStore.enroll({ deviceId: 'forget-me', publicKeyPem: key, ownerAccountId: 'alice', deviceName: 'Forget Me' });
    deviceStore.enroll({ deviceId: 'keep-me', publicKeyPem: publicKeyPem(), ownerAccountId: 'alice', deviceName: 'Keep Me' });
    pairingStore.start({
      clientId: 'device-client', deviceId: 'forget-me', deviceName: 'Forget Me', publicKeyPem: key,
      codeChallenge: 'A'.repeat(43)
    });
    usageStore.recordConnection('forget-me');
    usageStore.recordDeviceStatus('forget-me', { accountId: 'alice', status: 'online', connectionEpoch: 1, agentVersion: '1.0.5' });
    usageStore.recordToolCall({
      accountId: 'alice', activitySessionId: null, deviceId: 'forget-me', tool: 'shell_execute',
      durationMs: 12, success: true, inputBytes: 30, outputBytes: 40, callerCategory: 'oauth'
    });
    usageStore.recordToolCall({
      accountId: 'alice', activitySessionId: null, deviceId: 'keep-me', tool: 'read_text_file',
      durationMs: 3, success: true, inputBytes: 5, outputBytes: 7, callerCategory: 'oauth'
    });

    const forgotten = deviceStore.revoke('forget-me');
    assert.equal(forgotten.deviceId, 'forget-me');
    assert.ok(forgotten.forgottenAt);
    assert.equal(deviceStore.get('forget-me'), null);
    assert.ok(deviceStore.get('keep-me'));

    // Simulate an in-flight request completing after the forget transaction.
    // Late product metrics must not recreate ghost rows for the forgotten identity.
    assert.equal(usageStore.recordToolCall({
      accountId: 'alice', activitySessionId: null, deviceId: 'forget-me', tool: 'late_result',
      durationMs: 99, success: false, errorCode: 'LATE_AFTER_FORGET', inputBytes: 1, outputBytes: 2
    }), false);
    assert.equal(usageStore.recordDeviceStatus('forget-me', {
      accountId: 'alice', status: 'offline', connectionEpoch: 1, agentVersion: '1.0.5'
    }), false);
  } finally {
    usageStore.close();
    pairingStore.close();
    deviceStore.close();
  }

  const db = new DatabaseSync(dbPath);
  try {
    for (const table of ['devices', 'device_pairings', 'device_usage', 'tool_call_events', 'device_status_events']) {
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE device_id = ?`).get('forget-me').count;
      assert.equal(Number(count), 0, `${table} should not retain forgotten device product state`);
    }
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM devices WHERE device_id = ?').get('keep-me').count), 1);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM tool_call_events WHERE device_id = ?').get('keep-me').count), 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
