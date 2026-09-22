import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceStore } from '../scripts/device-store.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const adminScript = path.join(repoRoot, 'scripts', 'device-admin.mjs');

test('device admin supports operator pre-enroll, key rotation, then revoke', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'device-admin-'));
  const firstPublicKeyPath = path.join(runtime, 'device-first.pub.pem');
  const secondPublicKeyPath = path.join(runtime, 'device-second.pub.pem');
  const first = generateKeyPairSync('ed25519');
  const second = generateKeyPairSync('ed25519');
  fs.writeFileSync(firstPublicKeyPath, first.publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(secondPublicKeyPath, second.publicKey.export({ type: 'spki', format: 'pem' }));
  const env = { ...process.env, MCP_RUNTIME_DIR: runtime };
  const enroll = JSON.parse(execFileSync(process.execPath, [adminScript, 'enroll', 'device', firstPublicKeyPath], { cwd: repoRoot, env, encoding: 'utf8' }));
  assert.equal(enroll.ok, true);
  assert.equal(enroll.deviceId, 'device');
  assert.ok(enroll.enrolledAt);
  const rotate = JSON.parse(execFileSync(process.execPath, [adminScript, 'rotate', 'device', firstPublicKeyPath, secondPublicKeyPath], { cwd: repoRoot, env, encoding: 'utf8' }));
  assert.equal(rotate.ok, true);
  assert.equal(rotate.deviceId, 'device');
  assert.equal(rotate.enrolledAt, enroll.enrolledAt);
  const store = createDeviceStore({ dbPath: path.join(runtime, 'gateway.sqlite') });
  assert.equal(store.get('device').publicKeyPem, second.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  store.close();
  const revoke = JSON.parse(execFileSync(process.execPath, [adminScript, 'revoke', 'device'], { cwd: repoRoot, env, encoding: 'utf8' }));
  assert.equal(revoke.ok, true);
  assert.equal(revoke.deviceId, 'device');
  assert.ok(revoke.forgottenAt);
  fs.rmSync(runtime, { recursive: true, force: true });
});
