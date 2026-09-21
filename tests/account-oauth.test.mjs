import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAccountStore } from '../scripts/account-store.mjs';
import { AccountAuthProvider, SQLiteAuthState } from '../scripts/auth-session.mjs';
import { createDeviceUsageStore } from '../scripts/device-usage.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcu-account-oauth-'));
  const accountStore = createAccountStore({ dbPath: path.join(dir, 'gateway.sqlite') });
  const dbPath = path.join(dir, 'gateway.sqlite');
  const stateStore = new SQLiteAuthState(dbPath);
  const usageStore = createDeviceUsageStore({ dbPath });
  const user = accountStore.createAccount({ email: 'user@example.com', password: 'user-password' });
  const session = accountStore.createSession(user.accountId);
  const accountFromRequest = req => {
    const raw = String(req?.headers?.cookie || '');
    const match = raw.match(/(?:^|;\s*)hcu_account_session=([^;]+)/);
    return match ? accountStore.getSessionAccount(decodeURIComponent(match[1])) : null;
  };
  const sessionBindingFromRequest = req => {
    const raw = String(req?.headers?.cookie || '');
    const match = raw.match(/(?:^|;\s*)hcu_account_session=([^;]+)/);
    return match ? `binding:${decodeURIComponent(match[1])}` : null;
  };
  const provider = new AccountAuthProvider({ stateStore, accountStore, accountFromRequest, sessionBindingFromRequest, activityStore: usageStore });
  const client = { client_id: 'chatgpt-client' };
  return { dir, accountStore, stateStore, usageStore, provider, client, user, session };
}

function fakeResponse(req) {
  return {
    req,
    statusCode: 200,
    contentType: null,
    body: null,
    redirectTarget: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.contentType = value;
      return this;
    },
    send(value) {
      this.body = String(value);
      return this;
    },
    redirect(statusOrUrl, maybeUrl) {
      this.redirectTarget = maybeUrl ?? statusOrUrl;
    }
  };
}

function visibleText(html) {
  return String(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hiddenValue(html, name) {
  return String(html).match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1] || null;
}

async function authorizeThroughGate(f, params, req) {
  const gate = fakeResponse(req);
  await f.provider.authorize(f.client, params, gate);
  const pendingId = hiddenValue(gate.body, 'pending');
  const csrf = hiddenValue(gate.body, 'csrf');
  const continued = fakeResponse(req);
  assert.equal(await f.provider.continueAuthorization({ pendingId, csrf, req, res: continued }), true);
  return { gate, continued };
}

test('OAuth authorization redirects unauthenticated users to product login without shared password', async () => {
  const f = fixture();
  try {
    const req = { headers: {}, originalUrl: '/authorize?client_id=chatgpt-client&state=abc' };
    const res = fakeResponse(req);
    await f.provider.authorize(f.client, { redirectUri: 'https://chat.openai.com/callback', scopes: ['mcp:tools'] }, res);
    assert.match(res.redirectTarget, /^\/login\?return_to=/);
    assert.match(decodeURIComponent(res.redirectTarget), /\/authorize\?client_id=chatgpt-client&state=abc/);
    assert.equal(f.provider.codes.size, 0);
  } finally {
    f.usageStore.close();
    f.stateStore.close();
    f.accountStore.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('OAuth authenticated session shows account confirmation and preserves validated authorization params', async () => {
  const f = fixture();
  try {
    const req = {
      headers: { cookie: `hcu_account_session=${encodeURIComponent(f.session.sessionId)}` },
      originalUrl: '/authorize?client_id=chatgpt-client&state=abc&code_challenge=public-challenge'
    };
    const params = {
      redirectUri: 'https://chat.openai.com/callback',
      codeChallenge: 'validated-challenge',
      scopes: ['mcp:tools', 'offline_access'],
      state: 'validated-state',
      resource: 'https://example.com/mcp',
      issuer: 'https://device.hcu-lab.me/'
    };
    const gate = fakeResponse(req);
    await f.provider.authorize(f.client, params, gate);

    assert.equal(gate.statusCode, 200);
    assert.equal(gate.contentType, 'html');
    assert.equal(visibleText(gate.body), 'Continue as user@example.com Continue Use another account');
    assert.equal(f.provider.codes.size, 0);
    assert.ok(hiddenValue(gate.body, 'pending'));
    assert.ok(hiddenValue(gate.body, 'csrf'));
    assert.doesNotMatch(gate.body, /validated-state|validated-challenge|chat\.openai\.com|client_id/i);

    const continued = fakeResponse(req);
    assert.equal(await f.provider.continueAuthorization({
      pendingId: hiddenValue(gate.body, 'pending'),
      csrf: hiddenValue(gate.body, 'csrf'),
      req,
      res: continued
    }), true);
    const target = new URL(continued.redirectTarget);
    assert.equal(target.origin + target.pathname, 'https://chat.openai.com/callback');
    assert.equal(target.searchParams.get('state'), 'validated-state');
    assert.equal(target.searchParams.get('iss'), 'https://device.hcu-lab.me/');
    const code = target.searchParams.get('code');
    const stored = f.provider.codes.get(code);
    assert.equal(stored.accountId, f.user.accountId);
    assert.equal(stored.params.codeChallenge, 'validated-challenge');
    assert.equal(stored.params.resource, 'https://example.com/mcp');
    assert.deepEqual(stored.params.scopes, ['mcp:tools', 'offline_access']);
  } finally {
    f.usageStore.close();
    f.stateStore.close();
    f.accountStore.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('OAuth pending gate rejects bad CSRF, same-account different session, reuse and OUT consumes only the pending decision', async () => {
  const f = fixture();
  try {
    const req = {
      headers: { cookie: `hcu_account_session=${encodeURIComponent(f.session.sessionId)}` },
      originalUrl: '/authorize?client_id=chatgpt-client&state=switch-me'
    };
    const gate = fakeResponse(req);
    await f.provider.authorize(f.client, {
      redirectUri: 'https://chat.openai.com/callback',
      codeChallenge: 'challenge',
      scopes: ['mcp:tools'],
      state: 'switch-me'
    }, gate);
    const pendingId = hiddenValue(gate.body, 'pending');
    const csrf = hiddenValue(gate.body, 'csrf');

    assert.equal(await f.provider.continueAuthorization({ pendingId, csrf: 'wrong', req, res: fakeResponse(req) }), false);
    const secondSession = f.accountStore.createSession(f.user.accountId);
    const secondReq = {
      ...req,
      headers: { cookie: `hcu_account_session=${encodeURIComponent(secondSession.sessionId)}` }
    };
    assert.equal(await f.provider.continueAuthorization({ pendingId, csrf, req: secondReq, res: fakeResponse(secondReq) }), false);
    assert.equal(f.provider.codes.size, 0);
    assert.equal(f.provider.cancelAuthorization({ pendingId, csrf, req }), req.originalUrl);
    assert.equal(f.provider.cancelAuthorization({ pendingId, csrf, req }), null);
    assert.equal(await f.provider.continueAuthorization({ pendingId, csrf, req, res: fakeResponse(req) }), false);
  } finally {
    f.usageStore.close();
    f.stateStore.close();
    f.accountStore.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('OAuth activity session persists across refresh and ending it blocks access and refresh', async () => {
  const f = fixture();
  try {
    await f.provider.clientsStore.registerClient(f.client);
    const req = {
      headers: { cookie: `hcu_account_session=${encodeURIComponent(f.session.sessionId)}` },
      originalUrl: '/authorize?client_id=chatgpt-client'
    };
    const { continued } = await authorizeThroughGate(f, {
      redirectUri: 'https://chat.openai.com/callback',
      codeChallenge: 'challenge',
      scopes: ['mcp:tools', 'offline_access']
    }, req);
    const code = new URL(continued.redirectTarget).searchParams.get('code');
    const issued = await f.provider.exchangeAuthorizationCode(f.client, code);
    const first = await f.provider.verifyAccessToken(issued.access_token);
    assert.ok(first.activitySessionId);

    const refreshed = await f.provider.exchangeRefreshToken(f.client, issued.refresh_token);
    const second = await f.provider.verifyAccessToken(refreshed.access_token);
    assert.equal(second.activitySessionId, first.activitySessionId);

    f.usageStore.endActivitySession({ activitySessionId: first.activitySessionId, accountId: f.user.accountId });
    await assert.rejects(() => f.provider.verifyAccessToken(refreshed.access_token), /activity session.*ended|inactive/i);
    await assert.rejects(() => f.provider.exchangeRefreshToken(f.client, refreshed.refresh_token), /activity session.*ended|inactive/i);
  } finally {
    f.usageStore.close();
    f.stateStore.close();
    f.accountStore.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('OAuth access and refresh tokens preserve account_id and revoke with the account', async () => {
  const f = fixture();
  try {
    await f.provider.clientsStore.registerClient(f.client);
    const req = {
      headers: { cookie: `hcu_account_session=${encodeURIComponent(f.session.sessionId)}` },
      originalUrl: '/authorize?client_id=chatgpt-client'
    };
    const { continued } = await authorizeThroughGate(f, {
      redirectUri: 'https://chat.openai.com/callback',
      codeChallenge: 'challenge',
      scopes: ['mcp:tools', 'offline_access'],
      resource: 'https://example.com/mcp'
    }, req);
    const target = new URL(continued.redirectTarget);
    const code = target.searchParams.get('code');
    assert.ok(code);

    const issued = await f.provider.exchangeAuthorizationCode(f.client, code);
    const verified = await f.provider.verifyAccessToken(issued.access_token);
    assert.equal(verified.accountId, f.user.accountId);
    assert.equal(verified.clientId, f.client.client_id);
    assert.ok(verified.activitySessionId);
    assert.deepEqual(verified.scopes, ['mcp:tools', 'offline_access']);
    assert.equal(f.usageStore.listActivitySessions(f.user.accountId)[0].activitySessionId, verified.activitySessionId);

    const restartedState = new SQLiteAuthState(path.join(f.dir, 'gateway.sqlite'));
    const restarted = new AccountAuthProvider({
      stateStore: restartedState,
      accountStore: f.accountStore,
      accountFromRequest: () => null,
      activityStore: f.usageStore
    });
    const refreshed = await restarted.exchangeRefreshToken(f.client, issued.refresh_token);
    const verifiedRefresh = await restarted.verifyAccessToken(refreshed.access_token);
    assert.equal(verifiedRefresh.accountId, f.user.accountId);
    assert.equal(verifiedRefresh.activitySessionId, verified.activitySessionId);

    f.accountStore.revokeAccount(f.user.accountId);
    await assert.rejects(() => restarted.verifyAccessToken(refreshed.access_token), /revoked|account/i);
    await assert.rejects(() => restarted.exchangeRefreshToken(f.client, refreshed.refresh_token), /revoked|account/i);
    restartedState.close();
  } finally {
    f.usageStore.close();
    f.stateStore.close();
    f.accountStore.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
