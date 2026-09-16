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

function visibleText(html) {
  return String(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('root routes anonymous users to login and active users to dashboard', async () => {
  const f = await fixture();
  try {
    const anonymous = await fetch(`${f.base}/`, { redirect: 'manual' });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get('location'), '/login');

    const user = f.store.createAccount({ email: 'root@example.com', password: 'root-password' });
    const session = f.store.createSession(user.accountId);
    const authenticated = await fetch(`${f.base}/`, {
      redirect: 'manual',
      headers: { cookie: `hcu_account_session=${encodeURIComponent(session.sessionId)}` }
    });
    assert.equal(authenticated.status, 302);
    assert.equal(authenticated.headers.get('location'), '/dashboard');
  } finally { await f.close(); }
});

test('outside login gate exposes only GO and OUT while preserving progressive anti-enumeration', async () => {
  const f = await fixture();
  try {
    f.store.createAccount({ email: 'known@example.com', password: 'known-password' });
    const page = await fetch(`${f.base}/login?return_to=${encodeURIComponent('/device/verify?user_code=ABCD')}`);
    const html = await page.text();
    assert.match(html, /name="return_to" value="\/device\/verify\?user_code=ABCD"/);
    assert.match(html, /background:\s*#0[0-9a-f]{5}/i);
    assert.equal(visibleText(html), 'GO OUT');
    assert.match(html, /name="identity"/);
    assert.match(html, /href="\/signup\?return_to=%2Fdevice%2Fverify%3Fuser_code%3DABCD"/);
    assert.match(html, /placeholder="email"/i);
    assert.match(html, /\.go\{background:#176b45;color:#f2f2f2\}/i);
    assert.match(html, /\.out\{background:#8f342c;color:#f2f2f2\}/i);

    const known = await post(f.base, '/login/email', { identity: 'known@example.com', return_to: '/device/verify?user_code=ABCD' });
    const unknown = await post(f.base, '/login/email', { identity: 'nobody@example.com', return_to: '/device/verify?user_code=ABCD' });
    const knownHtml = await known.text();
    const unknownHtml = await unknown.text();
    for (const body of [knownHtml, unknownHtml]) {
      assert.match(body, /type="password"/);
      assert.equal(visibleText(body), 'GO OUT');
      assert.doesNotMatch(body, /account exists|not found|unknown account/i);
      assert.match(body, /placeholder="password"/i);
    }
    assert.equal(known.status, unknown.status);

    const failed = await post(f.base, '/login', { identity: 'known@example.com', password: 'wrong-password', return_to: '/device/verify?user_code=ABCD' });
    const failedHtml = await failed.text();
    assert.equal(visibleText(failedHtml), 'GO OUT');
    assert.match(failedHtml, /aria-invalid="true"/);
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
    const adminHtml = await admin.text();
    assert.equal(visibleText(adminHtml), 'GO OUT');
    assert.match(adminHtml, /aria-invalid="true"/);
    assert.equal(cookieValue(admin), null);
  } finally { await f.close(); }
});

test('account routes expose OAuth gate helpers without changing pre-redesign logout behavior', async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.accountHttp.clearSession, 'function');
    assert.equal(typeof f.accountHttp.loginLocation, 'function');
    assert.equal(
      f.accountHttp.loginLocation('/authorize?client_id=chatgpt-client&state=abc'),
      `/login?return_to=${encodeURIComponent('/authorize?client_id=chatgpt-client&state=abc')}`
    );
    assert.equal(f.accountHttp.loginLocation('//evil.example/steal'), '/login');

    const user = f.store.createAccount({ email: 'out@example.com', password: 'out-password' });
    const session = f.store.createSession(user.accountId);
    const response = await post(f.base, '/logout', { return_to: '/authorize?client_id=chatgpt-client&state=abc' }, {
      cookie: `hcu_account_session=${encodeURIComponent(session.sessionId)}`
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
    assert.equal(f.store.getSessionAccount(session.sessionId), null);
  } finally { await f.close(); }
});

test('signup respects need_invite without email verification', async () => {
  const gated = await fixture({ needInvite: true });
  try {
    const signupPage = await fetch(`${gated.base}/signup`);
    const signupHtml = await signupPage.text();
    assert.match(signupHtml, /name="return_to" value="\/dashboard"/);
    assert.equal(visibleText(signupHtml), 'OUT GO');
    assert.match(signupHtml, /name="invite"/);
    assert.match(signupHtml, /<button[^>]*>OUT<\/button>/);
    assert.match(signupHtml, /href="\/login\?return_to=%2Fdashboard"[^>]*>GO<\/a>/);
    assert.match(signupHtml, /placeholder="email"/i);
    assert.match(signupHtml, /placeholder="password"/i);
    assert.match(signupHtml, /placeholder="invite code"/i);

    const denied = await post(gated.base, '/signup', { identity: 'new@example.com', password: 'new-password' });
    assert.equal(denied.status, 200);
    const deniedHtml = await denied.text();
    assert.equal(visibleText(deniedHtml), 'OUT GO');
    assert.match(deniedHtml, /aria-invalid="true"/);

    const invite = gated.store.createInvite().code;
    const allowed = await post(gated.base, '/signup', { identity: 'new@example.com', password: 'new-password', invite });
    assert.equal(allowed.status, 302);
    assert.equal(allowed.headers.get('location'), '/dashboard');
    assert.ok(cookieValue(allowed));
    assert.equal(gated.store.getAccountByEmail('new@example.com')?.role, 'user');
  } finally { await gated.close(); }

  const open = await fixture({ needInvite: false });
  try {
    const openPage = await fetch(`${open.base}/signup`);
    assert.equal(visibleText(await openPage.text()), 'OUT GO');
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
      const failedHtml = await failed.text();
      assert.equal(visibleText(failedHtml), 'GO OUT');
      assert.match(failedHtml, /aria-invalid="true"/);
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
