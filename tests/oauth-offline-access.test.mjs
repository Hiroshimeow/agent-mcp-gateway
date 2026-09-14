import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AUTH_SUPPORTED_SCOPES, FileBackedAuthState, PasswordProtectedAuthProvider } from '../scripts/auth-session.mjs';

test('OAuth advertises offline_access and preserves it across refresh rotation', async () => {
  assert.deepEqual(AUTH_SUPPORTED_SCOPES, ['mcp:tools', 'offline_access']);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-offline-access-'));
  const statePath = path.join(tempDir, 'auth-state.json');
  const stateStore = new FileBackedAuthState(statePath);
  const provider = new PasswordProtectedAuthProvider('secret', stateStore);
  const client = { client_id: 'offline-client' };
  await provider.clientsStore.registerClient(client);
  provider.codes.set('offline-code', {
    client,
    params: {
      codeChallenge: 'challenge',
      scopes: ['mcp:tools', 'offline_access'],
      resource: 'https://example.com/mcp'
    }
  });

  const issued = await provider.exchangeAuthorizationCode(client, 'offline-code');
  assert.match(issued.scope, /offline_access/);
  assert.ok(issued.refresh_token);

  const restarted = new PasswordProtectedAuthProvider('secret', stateStore);
  const refreshed = await restarted.exchangeRefreshToken(client, issued.refresh_token);
  const verified = await restarted.verifyAccessToken(refreshed.access_token);

  assert.match(refreshed.scope, /offline_access/);
  assert.deepEqual(verified.scopes, ['mcp:tools', 'offline_access']);
});
