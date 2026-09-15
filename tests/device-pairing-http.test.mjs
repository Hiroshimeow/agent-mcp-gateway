import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createAccountStore } from '../scripts/account-store.mjs';
import { installAccountRoutes } from '../scripts/account-http.mjs';
import { createDevicePairingStore } from '../scripts/device-pairing-store.mjs';
import { installDevicePairingRoutes } from '../scripts/device-pairing-http.mjs';

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function publicKeyPem() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pair-http-'));
  const dbPath = path.join(dir, 'gateway.sqlite');
  const store = createDevicePairingStore({ dbPath });
  const accountStore = createAccountStore({ dbPath });
  const account = accountStore.createAccount({ email: 'user@example.com', password: 'user-password' });
  const session = accountStore.createSession(account.accountId);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const accountHttp = installAccountRoutes(app, { accountStore, needInvite: true });
  installDevicePairingRoutes(app, {
    pairingStore: store,
    accountFromRequest: accountHttp.accountFromRequest,
    baseUrlFromRequest: () => 'https://mcp-v2.example.test'
  });
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    store,
    accountStore,
    account,
    cookie: `hcu_account_session=${encodeURIComponent(session.sessionId)}`,
    close: async () => {
      await new Promise(resolve => server.close(resolve));
      store.close();
      accountStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function startPairing(f, p = pkce()) {
  const response = await fetch(`${f.base}/device/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'mcp-device',
      scope: 'mcp:tools',
      device_id: 'device-http',
      device_name: 'ThinkBook HTTP',
      public_key_pem: publicKeyPem(),
      code_challenge: p.challenge,
      code_challenge_method: 'S256'
    })
  });
  assert.equal(response.status, 200);
  return { p, data: await response.json() };
}

test('device start returns browser verification URLs and poll stays pending before approval', async () => {
  const f = await fixture();
  try {
    const { p, data } = await startPairing(f);
    assert.match(data.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(data.verification_uri, 'https://mcp-v2.example.test/device/verify');
    assert.equal(data.verification_uri_complete, `https://mcp-v2.example.test/device/verify?user_code=${encodeURIComponent(data.user_code)}`);
    assert.equal(data.interval, 2);

    const poll = await fetch(`${f.base}/device/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: data.device_code, client_id: 'mcp-device', code_verifier: p.verifier })
    });
    assert.equal(poll.status, 400);
    assert.deepEqual(await poll.json(), { error: 'authorization_pending' });
  } finally { await f.close(); }
});

test('device verification requires account login and approval binds account_id', async () => {
  const f = await fixture();
  try {
    const { p, data } = await startPairing(f);
    const anonymous = await fetch(`${f.base}/device/verify?user_code=${encodeURIComponent(data.user_code)}`, { redirect: 'manual' });
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.get('location') || '', /^\/login\?return_to=/);

    const page = await fetch(`${f.base}/device/verify?user_code=${encodeURIComponent(data.user_code)}`, {
      headers: { cookie: f.cookie }
    });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /ThinkBook HTTP/);
    assert.match(html, /user@example\.com/);
    assert.doesNotMatch(html, /type="password"/i);

    const approved = await fetch(`${f.base}/device/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: f.cookie },
      body: new URLSearchParams({ user_code: data.user_code }),
      redirect: 'manual'
    });
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /approved/i);

    const poll = await fetch(`${f.base}/device/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_code: data.device_code, client_id: 'mcp-device', code_verifier: p.verifier })
    });
    assert.equal(poll.status, 200);
    const payload = await poll.json();
    assert.match(payload.enrollment_grant, /^[A-Za-z0-9_-]{32,}$/);
    assert.deepEqual(payload.account, { connected: true, account_id: f.account.accountId, label: 'user@example.com' });
    assert.equal(payload.device_id, 'device-http');

    const status = f.store.getStatusByUserCode(data.user_code);
    assert.equal(status.accountId, f.account.accountId);
    assert.equal(status.accountLabel, 'user@example.com');
  } finally { await f.close(); }
});
