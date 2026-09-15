import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { createDeviceStore } from '../scripts/device-store.mjs';

function publicKeyPem() {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
}

test('device store persists enrolled identities across reopen and supports revoke', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const key = publicKeyPem();
  const first = createDeviceStore({ dbPath });
  first.enroll({ deviceId: 'device-1', publicKeyPem: key });
  assert.equal(first.get('device-1').revokedAt, null);
  assert.equal(first.list().length, 1);
  first.close();

  const second = createDeviceStore({ dbPath });
  const restored = second.get('device-1');
  assert.equal(restored.deviceId, 'device-1');
  assert.equal(restored.publicKeyPem, key);
  second.revoke('device-1');
  assert.ok(second.get('device-1').revokedAt);
  second.close();
});

test('device store persists bounded machine metadata independently from friendly name', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-metadata-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const store = createDeviceStore({ dbPath });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  store.enroll({
    deviceId: 'g8-a1b2c3d4',
    publicKeyPem: publicKeyPem(),
    deviceName: 'Linux Build Box',
    hostname: 'g8',
    platform: 'linux',
    arch: 'x64',
    pathStyle: 'posix',
    agentVersion: '1.2.3'
  });
  const stored = store.get('g8-a1b2c3d4');
  assert.equal(stored.deviceName, 'Linux Build Box');
  assert.equal(stored.hostname, 'g8');
  assert.equal(stored.platform, 'linux');
  assert.equal(stored.arch, 'x64');
  assert.equal(stored.pathStyle, 'posix');
  assert.equal(stored.agentVersion, '1.2.3');
  store.updateMetadata({ deviceId: 'g8-a1b2c3d4', agentVersion: '1.2.4' });
  assert.equal(store.get('g8-a1b2c3d4').agentVersion, '1.2.4');
});

test('device store refuses silent public-key replacement', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-'));
  const dbPath = path.join(dir, 'devices.sqlite');

  const store = createDeviceStore({ dbPath });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  store.enroll({ deviceId: 'g8-1', publicKeyPem: publicKeyPem() });
  assert.throws(
    () => store.enroll({ deviceId: 'g8-1', publicKeyPem: publicKeyPem() }),
    /already enrolled/i
  );
});

test('device store explicitly rotates the key of an active device atomically', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const times = ['2026-09-13T00:00:00.000Z', '2026-09-13T01:00:00.000Z'];
  const store = createDeviceStore({ dbPath, now: () => times.shift() });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const firstKey = publicKeyPem();
  const secondKey = publicKeyPem();
  const enrolled = store.enroll({ deviceId: 'device', publicKeyPem: firstKey });
  const rotated = store.rotate({ deviceId: 'device', expectedPublicKeyPem: firstKey, publicKeyPem: secondKey });

  assert.equal(rotated.deviceId, 'device');
  assert.equal(rotated.publicKeyPem, secondKey);
  assert.equal(rotated.enrolledAt, enrolled.enrolledAt);
  assert.equal(rotated.revokedAt, null);
  assert.equal(store.get('device').publicKeyPem, secondKey);
});

test('device store refuses key rotation for unknown or revoked devices', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const store = createDeviceStore({ dbPath });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.throws(
    () => store.rotate({ deviceId: 'missing', expectedPublicKeyPem: publicKeyPem(), publicKeyPem: publicKeyPem() }),
    /unknown device/i
  );
  store.enroll({ deviceId: 'revoked', publicKeyPem: publicKeyPem() });
  store.revoke('revoked');
  assert.throws(
    () => store.rotate({ deviceId: 'revoked', expectedPublicKeyPem: publicKeyPem(), publicKeyPem: publicKeyPem() }),
    /revoked/i
  );
});

test('invalid expected or replacement keys leave the enrolled record unchanged', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-invalid-key-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const store = createDeviceStore({ dbPath });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const currentKey = publicKeyPem();
  store.enroll({ deviceId: 'invalid-key-device', publicKeyPem: currentKey });

  assert.throws(
    () => store.rotate({ deviceId: 'invalid-key-device', expectedPublicKeyPem: 'not-a-public-key', publicKeyPem: publicKeyPem() }),
    /invalid|key|decoder/i
  );
  assert.equal(store.get('invalid-key-device').publicKeyPem, currentKey);

  assert.throws(
    () => store.rotate({ deviceId: 'invalid-key-device', expectedPublicKeyPem: currentKey, publicKeyPem: 'not-a-public-key' }),
    /invalid|key|decoder/i
  );
  assert.equal(store.get('invalid-key-device').publicKeyPem, currentKey);

  const ecKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
    type: 'spki',
    format: 'pem'
  });
  assert.throws(
    () => store.rotate({ deviceId: 'invalid-key-device', expectedPublicKeyPem: ecKey, publicKeyPem: publicKeyPem() }),
    /Ed25519/i
  );
  assert.equal(store.get('invalid-key-device').publicKeyPem, currentKey);

  assert.throws(
    () => store.rotate({ deviceId: 'invalid-key-device', expectedPublicKeyPem: currentKey, publicKeyPem: ecKey }),
    /Ed25519/i
  );
  assert.equal(store.get('invalid-key-device').publicKeyPem, currentKey);
});

test('authorization generations are monotonic and serialized authorization rejects stale state', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-generation-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const store = createDeviceStore({ dbPath });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const a = publicKeyPem();
  const b = publicKeyPem();
  const enrolled = store.enroll({ deviceId: 'generation-device', publicKeyPem: a });
  assert.equal(enrolled.authorizationGeneration, 1);
  const rotated = store.rotate({ deviceId: 'generation-device', expectedPublicKeyPem: a, publicKeyPem: b });
  assert.equal(rotated.authorizationGeneration, 2);
  const rolledBack = store.rotate({ deviceId: 'generation-device', expectedPublicKeyPem: b, publicKeyPem: a });
  assert.equal(rolledBack.authorizationGeneration, 3);
  assert.equal(store.withCurrentAuthorization({ deviceId: 'generation-device', publicKeyPem: a, authorizationGeneration: 3 }, () => 'ok'), 'ok');
  assert.throws(() => store.withCurrentAuthorization({ deviceId: 'generation-device', publicKeyPem: a, authorizationGeneration: 1 }, () => {}), /authorization changed|revoked|stale/i);
  store.revoke('generation-device');
  assert.equal(store.get('generation-device').authorizationGeneration, 4);
  assert.throws(() => store.withCurrentAuthorization({ deviceId: 'generation-device', publicKeyPem: a, authorizationGeneration: 4 }, () => {}), /authorization changed|revoked|stale/i);
});

test('legacy device registry migrates authorization generation idempotently', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-migration-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE devices (
      device_id TEXT PRIMARY KEY,
      public_key_pem TEXT NOT NULL,
      enrolled_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);
  const key = publicKeyPem();
  legacy.prepare('INSERT INTO devices (device_id, public_key_pem, enrolled_at, revoked_at) VALUES (?, ?, ?, NULL)')
    .run('legacy-device', key, '2026-09-13T00:00:00.000Z');
  legacy.close();

  const first = createDeviceStore({ dbPath });
  assert.equal(first.get('legacy-device').authorizationGeneration, 1);
  first.close();
  const second = createDeviceStore({ dbPath });
  assert.equal(second.get('legacy-device').authorizationGeneration, 1);
  second.close();
});

test('device store rejects stale expected key during rotation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const store = createDeviceStore({ dbPath });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const firstKey = publicKeyPem();
  const secondKey = publicKeyPem();
  const thirdKey = publicKeyPem();
  store.enroll({ deviceId: 'cas-device', publicKeyPem: firstKey });
  store.rotate({ deviceId: 'cas-device', expectedPublicKeyPem: firstKey, publicKeyPem: secondKey });
  assert.throws(
    () => store.rotate({ deviceId: 'cas-device', expectedPublicKeyPem: firstKey, publicKeyPem: thirdKey }),
    /current key changed/i
  );
  assert.equal(store.get('cas-device').publicKeyPem, secondKey);
});
