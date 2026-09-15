import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAccountStore } from '../scripts/account-store.mjs';
import { AUTH_SUPPORTED_SCOPES, AccountAuthProvider, SQLiteAuthState } from '../scripts/auth-session.mjs';

test('OAuth advertises offline_access and preserves account identity across refresh rotation', async () => {
  assert.deepEqual(AUTH_SUPPORTED_SCOPES, ['mcp:tools', 'offline_access']);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-offline-access-'));
  const statePath = path.join(tempDir, 'gateway.sqlite');
  const accountStore = createAccountStore({ dbPath: path.join(tempDir, 'gateway.sqlite') });
  try {
    const account = accountStore.createAccount({ email: 'user@example.com', password: 'user-password' });
    const firstState = new SQLiteAuthState(statePath);
    const provider = new AccountAuthProvider({ stateStore: firstState, accountStore, accountFromRequest: () => account });
    const client = { client_id: 'offline-client' };
    await provider.clientsStore.registerClient(client);
    provider.codes.set('offline-code', {
      client,
      accountId: account.accountId,
      params: {
        codeChallenge: 'challenge',
        scopes: ['mcp:tools', 'offline_access'],
        resource: 'https://example.com/mcp'
      }
    });

    const issued = await provider.exchangeAuthorizationCode(client, 'offline-code');
    assert.match(issued.scope, /offline_access/);
    assert.ok(issued.refresh_token);

    const restartedState = new SQLiteAuthState(statePath);
    const restarted = new AccountAuthProvider({ stateStore: restartedState, accountStore, accountFromRequest: () => null });
    const refreshed = await restarted.exchangeRefreshToken(client, issued.refresh_token);
    const verified = await restarted.verifyAccessToken(refreshed.access_token);
    assert.match(refreshed.scope, /offline_access/);
    assert.deepEqual(verified.scopes, ['mcp:tools', 'offline_access']);
    assert.equal(verified.accountId, account.accountId);
    restartedState.close();
    firstState.close();
  } finally {
    accountStore.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
