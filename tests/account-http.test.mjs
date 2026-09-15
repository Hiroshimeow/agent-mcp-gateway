import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createAccountStore } from '../scripts/account-store.mjs';
import { createLoginRateLimiter, installAccountRoutes } from '../scripts/account-http.mjs';

async function fixture({ needInvite = true, now = () => Date.now() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcu-account-http-'));
  const store = createAccountStore({ dbPath: path.join(dir, 'gateway.sqlite'), now });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const accountHttp = installAccountRoutes(app, {
    accountStore: store,
    needInvite,
    now,
    loginLimiter: createLoginRateLimiter({ now })
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    store,
    accountHttp,
    base,
    close: async () => {
      await new Promise(resolve => server.close(resolve));
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function form(data) {
  return new URLSearchParams(data).toString();
}

async function post(base, route, data, headers = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: form(data)
  });
}

function cookieValue(response, name = 'hcu_account_session') {
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(new RegExp(`${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

test('login UI is dark/progressive and email stage does not reveal account existence', async () => {
  const f = await fixture();
  try {
    f.store.createAccount({ email: 'known@example.com', password: 'known-password' });
    const page = await fetch(`${f.base}/login`);
    const html = await page.text();
    assert.match(html, /background:\s*#0[0-9a-f]{5}/i);
    assert.match(html, />GO</);
    assert.match(html, />OUT</);
    assert.match(html, /name="identity"/);

    const known = await post(f.base, '/login/email', { identity: 'known@example.com' });
    const unknown = await post(f.base, '/login/email', { identity: 'nobody@example.com' });
    const knownHtml = await known.text();
    const unknownHtml = await unknown.text();
    for (const body of [knownHtml, unknownHtml]) {
      assert.match(body, /type="password"/);
      assert.match(body, />GO</);
      assert.doesNotMatch(body, /account exists|not found|unknown account/i);
    }
    assert.equal(known.status, unknown.status);
  } finally { await f.close(); }
});

test('normal user login creates account-bound session while admin has no public product login', async () => {
  const f = await fixture();
  try {
    const user = f.store.createAccount({ email: 'user@example.com', password: 'user-password' });
    f.store.createAdmin({ email: 'admin@example.com', password: 'admin-password' });

    const success = await post(f.base, '/login', { identity: 'user@example.com', password: 'user-password', return_to: '/device/verify?user_code=ABCD' });
    assert.equal(success.status, 302);
    assert.equal(success.headers.get('location'), '/device/verify?user_code=ABCD');
    const sessionId = cookieValue(success);
    assert.ok(sessionId);
    assert.equal(f.store.getSessionAccount(sessionId)?.accountId, user.accountId);

    const admin = await post(f.base, '/login', { identity: 'admin@example.com', password: 'admin-password' });
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /Authentication failed/);
    assert.equal(cookieValue(admin), null);
  } finally { await f.close(); }
});

test('signup respects need_invite without email verification', async () => {
  const gated = await fixture({ needInvite: true });
  try {
    const denied = await post(gated.base, '/signup', { identity: 'new@example.com', password: 'new-password' });
    assert.equal(denied.status, 200);
    assert.match(await denied.text(), /Registration failed/);

    const invite = gated.store.createInvite().code;
    const allowed = await post(gated.base, '/signup', { identity: 'new@example.com', password: 'new-password', invite });
    assert.equal(allowed.status, 302);
    assert.ok(cookieValue(allowed));
    assert.equal(gated.store.getAccountByEmail('new@example.com')?.role, 'user');
  } finally { await gated.close(); }

  const open = await fixture({ needInvite: false });
  try {
    const allowed = await post(open.base, '/signup', { identity: 'open@example.com', password: 'open-password' });
    assert.equal(allowed.status, 302);
    assert.ok(cookieValue(allowed));
  } finally { await open.close(); }
});

test('login cooldown is scoped to source plus account key, not a global victim-account lock', async () => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now });
  try {
    f.store.createAccount({ email: 'user@example.com', password: 'right-password' });
    const sourceA = { 'x-forwarded-for': '198.51.100.10' };
    const sourceB = { 'x-forwarded-for': '198.51.100.11' };

    for (let index = 0; index < 3; index += 1) {
      const failed = await post(f.base, '/login', { identity: 'user@example.com', password: 'wrong-password' }, sourceA);
      assert.equal(failed.status, 200);
      assert.match(await failed.text(), /Authentication failed/);
    }
    const blockedCorrect = await post(f.base, '/login', { identity: 'user@example.com', password: 'right-password' }, sourceA);
    assert.equal(blockedCorrect.status, 200);
    assert.equal(cookieValue(blockedCorrect), null);

    const otherSource = await post(f.base, '/login', { identity: 'user@example.com', password: 'right-password' }, sourceB);
    assert.equal(otherSource.status, 302);
    assert.ok(cookieValue(otherSource));

    now += 60_001;
    const recovered = await post(f.base, '/login', { identity: 'user@example.com', password: 'right-password' }, sourceA);
    assert.equal(recovered.status, 302);
  } finally { await f.close(); }
});

test('accountFromRequest resolves only active normal-account sessions', async () => {
  const f = await fixture();
  try {
    const user = f.store.createAccount({ email: 'session@example.com', password: 'session-password' });
    const session = f.store.createSession(user.accountId);
    const req = { headers: { cookie: `hcu_account_session=${encodeURIComponent(session.sessionId)}` } };
    assert.equal(f.accountHttp.accountFromRequest(req)?.accountId, user.accountId);
    f.store.revokeAccount(user.accountId);
    assert.equal(f.accountHttp.accountFromRequest(req), null);
  } finally { await f.close(); }
});
