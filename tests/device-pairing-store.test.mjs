import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDevicePairingStore } from '../scripts/device-pairing-store.mjs';

function keypair() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-device-pairing-'));
  let now = 1_700_000_000_000;
  const store = createDevicePairingStore({
    dbPath: path.join(dir, 'devices.sqlite'),
    now: () => now,
    ttlMs: 10 * 60_000,
    pollIntervalSec: 2
  });
  return {
    store,
    advance(ms) { now += ms; },
    close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test('pairing start issues bounded human and device codes without secrets in status', () => {
  const f = fixture();
  try {
    const p = pkce();
    const publicKeyPem = keypair();
    const started = f.store.start({
      clientId: 'mcp-device',
      deviceId: 'device-test',
      deviceName: 'ThinkBook Test',
      publicKeyPem,
      codeChallenge: p.challenge
    });

    assert.match(started.deviceCode, /^[A-Za-z0-9_-]{32,}$/);
    assert.match(started.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(started.expiresIn, 600);
    assert.equal(started.interval, 2);

    const status = f.store.getStatusByUserCode(started.userCode);
    assert.equal(status.deviceId, 'device-test');
    assert.equal(status.deviceName, 'ThinkBook Test');
    assert.equal(status.status, 'pending');
    assert.equal('deviceCode' in status, false);
    assert.equal('codeChallenge' in status, false);
    assert.equal('publicKeyPem' in status, false);
  } finally { f.close(); }
});

test('approval plus PKCE poll issues a key-bound single-use enrollment grant', () => {
  const f = fixture();
  try {
    const p = pkce();
    const publicKeyPem = keypair();
    const started = f.store.start({
      clientId: 'mcp-device',
      deviceId: 'device-test',
      deviceName: 'ThinkBook Test',
      publicKeyPem,
      codeChallenge: p.challenge
    });

    assert.deepEqual(f.store.poll({
      deviceCode: started.deviceCode,
      clientId: 'mcp-device',
      codeVerifier: p.verifier
    }), { status: 'authorization_pending' });

    const approved = f.store.approve({ userCode: started.userCode, accountId: 'account-example', accountLabel: 'Example Gateway' });
    assert.equal(approved.accountId, 'account-example');
    assert.equal(approved.accountLabel, 'Example Gateway');

    assert.throws(() => f.store.poll({
      deviceCode: started.deviceCode,
      clientId: 'mcp-device',
      codeVerifier: 'wrong-verifier'
    }), /PKCE|verifier/i);

    const polled = f.store.poll({
      deviceCode: started.deviceCode,
      clientId: 'mcp-device',
      codeVerifier: p.verifier
    });
    assert.equal(polled.status, 'approved');
    assert.match(polled.enrollmentGrant, /^[A-Za-z0-9_-]{32,}$/);
    assert.deepEqual(polled.account, { connected: true, account_id: 'account-example', label: 'Example Gateway' });
    assert.equal(polled.deviceId, 'device-test');

    assert.throws(() => f.store.consumeGrant({
      enrollmentGrant: polled.enrollmentGrant,
      deviceId: 'other-device',
      publicKeyPem
    }), /bound|device/i);

    const consumed = f.store.consumeGrant({
      enrollmentGrant: polled.enrollmentGrant,
      deviceId: 'device-test',
      publicKeyPem
    });
    assert.deepEqual(consumed.account, { connected: true, account_id: 'account-example', label: 'Example Gateway' });
    assert.equal(consumed.deviceId, 'device-test');

    assert.throws(() => f.store.consumeGrant({
      enrollmentGrant: polled.enrollmentGrant,
      deviceId: 'device-test',
      publicKeyPem
    }), /consumed|invalid|used/i);
  } finally { f.close(); }
});

test('pairing expires closed before approval, polling, or grant consumption', () => {
  const f = fixture();
  try {
    const p = pkce();
    const publicKeyPem = keypair();
    const started = f.store.start({
      clientId: 'mcp-device',
      deviceId: 'device-test',
      deviceName: 'ThinkBook Test',
      publicKeyPem,
      codeChallenge: p.challenge
    });
    f.advance(10 * 60_000 + 1);

    assert.throws(() => f.store.approve({ userCode: started.userCode, accountId: 'account-example', accountLabel: 'Example Gateway' }), /expired/i);
    assert.throws(() => f.store.poll({ deviceCode: started.deviceCode, clientId: 'mcp-device', codeVerifier: p.verifier }), /expired/i);
  } finally { f.close(); }
});
