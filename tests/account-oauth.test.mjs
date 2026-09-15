import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAccountStore } from '../scripts/account-store.mjs';
import { AccountAuthProvider, SQLiteAuthState } from '../scripts/auth-session.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcu-account-oauth-'));
  const accountStore = createAccountStore({ dbPath: path.join(dir, 'gateway.sqlite') });
  const stateStore = new SQLiteAuthState(path.join(dir, 'gateway.sqlite'));
  const user = accountStore.createAccount({ email: 'user@example.com', password: 'user-password' });
  const session = accountStore.createSession(user.accountId);
  const accountFromRequest = req => {
    const raw = String(req?.headers?.cookie || '');
    const match = raw.match(/(?:^|;\s*)hcu_account_session=([^;]+)/);
    return match ? accountStore.getSessionAccount(decodeURIComponent(match[1])) : null;
  };
  const provider = new AccountAuthProvider({ stateStore, accountStore, accountFromRequest });
  const client = { client_id: 'chatgpt-client' };
  return { dir, accountStore, stateStore, provider, client, user, session };
}

function fakeResponse(req) {
  return {
    req,
    redirectTarget: null,
    redirect(statusOrUrl, maybeUrl) {
      this.redirectTarget = maybeUrl ?? statusOrUrl;
    }
  };
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
    const res = fakeResponse(req);
    await f.provider.authorize(f.client, {
      redirectUri: 'https://chat.openai.com/callback',
      codeChallenge: 'challenge',
      scopes: ['mcp:tools', 'offline_access'],
      resource: 'https://example.com/mcp'
    }, res);
    const target = new URL(res.redirectTarget);
    const code = target.searchParams.get('code');
    assert.ok(code);

    const issued = await f.provider.exchangeAuthorizationCode(f.client, code);
    const verified = await f.provider.verifyAccessToken(issued.access_token);
    assert.equal(verified.accountId, f.user.accountId);
    assert.equal(verified.clientId, f.client.client_id);
    assert.deepEqual(verified.scopes, ['mcp:tools', 'offline_access']);

    const restartedState = new SQLiteAuthState(path.join(f.dir, 'gateway.sqlite'));
    const restarted = new AccountAuthProvider({
      stateStore: restartedState,
      accountStore: f.accountStore,
      accountFromRequest: () => null
    });
    const refreshed = await restarted.exchangeRefreshToken(f.client, issued.refresh_token);
    const verifiedRefresh = await restarted.verifyAccessToken(refreshed.access_token);
    assert.equal(verifiedRefresh.accountId, f.user.accountId);

    f.accountStore.revokeAccount(f.user.accountId);
    await assert.rejects(() => restarted.verifyAccessToken(refreshed.access_token), /revoked|account/i);
    await assert.rejects(() => restarted.exchangeRefreshToken(f.client, refreshed.refresh_token), /revoked|account/i);
    restartedState.close();
  } finally {
    f.stateStore.close();
    f.accountStore.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
