import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const adminScript = path.join(repoRoot, 'scripts', 'device-admin.mjs');

test('device admin supports operator pre-enroll then revoke', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'device-admin-'));
  const publicKeyPath = path.join(runtime, 'device.pub.pem');
  const { publicKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const env = { ...process.env, MCP_RUNTIME_DIR: runtime };
  const enroll = JSON.parse(execFileSync(process.execPath, [adminScript, 'enroll', 'thinkbook', publicKeyPath], { cwd: repoRoot, env, encoding: 'utf8' }));
  assert.equal(enroll.ok, true);
  assert.equal(enroll.deviceId, 'thinkbook');
  assert.ok(enroll.enrolledAt);
  const revoke = JSON.parse(execFileSync(process.execPath, [adminScript, 'revoke', 'thinkbook'], { cwd: repoRoot, env, encoding: 'utf8' }));
  assert.equal(revoke.ok, true);
  assert.equal(revoke.deviceId, 'thinkbook');
  assert.ok(revoke.revokedAt);
  fs.rmSync(runtime, { recursive: true, force: true });
});
