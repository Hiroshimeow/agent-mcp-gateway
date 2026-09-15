import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SQLiteAuthState } from '../scripts/auth-session.mjs';
import { createDeviceStore } from '../scripts/device-store.mjs';
import { createDeviceUsageStore } from '../scripts/device-usage.mjs';
import { createDevicePairingStore } from '../scripts/device-pairing-store.mjs';
import { migrateLegacyRuntimeState } from '../scripts/migrate-runtime-state.mjs';

function keyPair() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

test('one-shot runtime migration preserves device/usage and OAuth clients but not legacy tokens or pending pairings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcu-runtime-migrate-'));
  const legacyDeviceDb = path.join(dir, 'devices.sqlite');
  const legacyAuthJson = path.join(dir, 'auth-state.json');
  const targetDb = path.join(dir, 'gateway.sqlite');
  try {
    const legacyDevices = createDeviceStore({ dbPath: legacyDeviceDb, now: () => '2026-09-15T00:00:00.000Z' });
    const enrolled = legacyDevices.enroll({
      deviceId: 'thinkbook',
      deviceName: 'ThinkBook',
      publicKeyPem: keyPair(),
      hostname: 'thinkbook',
      platform: 'win32',
      arch: 'x64',
      pathStyle: 'windows'
    });
    legacyDevices.revoke(enrolled.deviceId);
    legacyDevices.close();

    const legacyUsage = createDeviceUsageStore({ dbPath: legacyDeviceDb, now: () => 123456 });
    legacyUsage.recordConnection('thinkbook');
    legacyUsage.recordToolStarted('thinkbook', 12);
    legacyUsage.recordToolSucceeded('thinkbook', 34);
    legacyUsage.close();

    const legacyPairing = createDevicePairingStore({ dbPath: legacyDeviceDb, now: () => 1000 });
    legacyPairing.start({
      clientId: 'mcp-device',
      deviceId: 'pending-device',
      deviceName: 'Pending',
      publicKeyPem: keyPair(),
      codeChallenge: crypto.createHash('sha256').update('verifier').digest('base64url')
    });
    legacyPairing.close();

    fs.writeFileSync(legacyAuthJson, JSON.stringify({
      clients: { 'chatgpt-client': { client_id: 'chatgpt-client', redirect_uris: ['https://chat.openai.com/callback'] } },
      tokens: { 'legacy-access-secret': { clientId: 'chatgpt-client', scopes: ['mcp:tools'] } },
      refreshTokens: { 'legacy-refresh-secret': { clientId: 'chatgpt-client', scopes: ['mcp:tools'] } }
    }));

    const first = migrateLegacyRuntimeState({ targetDbPath: targetDb, legacyDeviceDbPath: legacyDeviceDb, legacyAuthStatePath: legacyAuthJson });
    assert.equal(first.devicesImported, 1);
    assert.equal(first.usageImported, 1);
    assert.equal(first.pairingsSkipped, 1);
    assert.equal(first.oauthClientsImported, 1);
    assert.equal(first.legacyAccessTokensIgnored, 1);
    assert.equal(first.legacyRefreshTokensIgnored, 1);

    const devices = createDeviceStore({ dbPath: targetDb });
    const migrated = devices.get('thinkbook');
    assert.equal(migrated.deviceName, 'ThinkBook');
    assert.equal(migrated.platform, 'win32');
    assert.ok(migrated.revokedAt);
    assert.equal(migrated.authorizationGeneration, 2);
    devices.close();

    const usage = createDeviceUsageStore({ dbPath: targetDb });
    assert.deepEqual(usage.get('thinkbook'), {
      connections: 1,
      reconnects: 0,
      toolCallsStarted: 1,
      toolCallsSucceeded: 1,
      toolCallsFailed: 0,
      requestBytes: 12,
      responseBytes: 34,
      lastSeenAt: 123456,
      lastErrorCode: null
    });
    usage.close();

    const targetPairing = createDevicePairingStore({ dbPath: targetDb });
    assert.throws(() => targetPairing.getStatusByUserCode('ABCD-EFGH'), /Unknown pairing code/);
    targetPairing.close();

    const auth = new SQLiteAuthState(targetDb);
    assert.equal(auth.getClient('chatgpt-client').client_id, 'chatgpt-client');
    assert.equal(auth.getToken('legacy-access-secret'), undefined);
    assert.equal(auth.getRefreshToken('legacy-refresh-secret'), undefined);
    auth.close();

    const second = migrateLegacyRuntimeState({ targetDbPath: targetDb, legacyDeviceDbPath: legacyDeviceDb, legacyAuthStatePath: legacyAuthJson });
    assert.equal(second.devicesImported, 0);
    assert.equal(second.usageImported, 0);
    assert.equal(second.oauthClientsImported, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
