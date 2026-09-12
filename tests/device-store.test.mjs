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
