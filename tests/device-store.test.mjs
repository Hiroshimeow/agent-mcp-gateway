import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

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
  first.enroll({ deviceId: 'thinkbook-1', publicKeyPem: key });
  assert.equal(first.get('thinkbook-1').revokedAt, null);
  assert.equal(first.list().length, 1);
  first.close();

  const second = createDeviceStore({ dbPath });
  const restored = second.get('thinkbook-1');
  assert.equal(restored.deviceId, 'thinkbook-1');
  assert.equal(restored.publicKeyPem, key);
  second.revoke('thinkbook-1');
  assert.ok(second.get('thinkbook-1').revokedAt);
  second.close();
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
  const enrolled = store.enroll({ deviceId: 'thinkbook', publicKeyPem: firstKey });
  const rotated = store.rotate({ deviceId: 'thinkbook', expectedPublicKeyPem: firstKey, publicKeyPem: secondKey });

  assert.equal(rotated.deviceId, 'thinkbook');
  assert.equal(rotated.publicKeyPem, secondKey);
  assert.equal(rotated.enrolledAt, enrolled.enrolledAt);
  assert.equal(rotated.revokedAt, null);
  assert.equal(store.get('thinkbook').publicKeyPem, secondKey);
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
  assert.throws(() => store.withCurrentAuthorization({ deviceId: 'generation-device', publicKeyPem: a, authorizationGeneration: 4 }, () => {}), /authorization changed|revoked|stale/i);
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
