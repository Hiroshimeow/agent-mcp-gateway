import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FileBackedAuthState,
  isStaticBearerAuthorization,
  shouldCreateTransportForRequest,
  shouldUseStatefulSessionTransport
} from '../scripts/auth-session.mjs';

test('shouldCreateTransportForRequest accepts initialize requests with stale session ids', () => {
  const existingTransports = {};
  const initializeRequest = { method: 'initialize', params: { protocolVersion: '2025-03-26' } };
  assert.equal(shouldCreateTransportForRequest('stale-session', initializeRequest, existingTransports), true);
});

test('wrapper defaults to stateless transport mode', () => {
  assert.equal(shouldUseStatefulSessionTransport(undefined), false);
  assert.equal(shouldUseStatefulSessionTransport('false'), false);
  assert.equal(shouldUseStatefulSessionTransport('true'), true);
});

test('isStaticBearerAuthorization accepts only configured bearer token', () => {
  assert.equal(isStaticBearerAuthorization('Bearer hermes-token', 'hermes-token'), true);
  assert.equal(isStaticBearerAuthorization('bearer hermes-token', 'hermes-token'), true);
  assert.equal(isStaticBearerAuthorization('hermes-token', 'hermes-token'), true);
  assert.equal(isStaticBearerAuthorization('Bearer hermes-token', '  hermes-token  '), true);
  assert.equal(isStaticBearerAuthorization('Bearer   hermes-token  ', 'hermes-token'), true);
  assert.equal(isStaticBearerAuthorization('Bearer token-with-specials!@', 'token-with-specials!@#'), true);
  assert.equal(isStaticBearerAuthorization('Bearer wrong-token', 'hermes-token'), false);
  assert.equal(isStaticBearerAuthorization('Basic hermes-token', 'hermes-token'), false);
  assert.equal(isStaticBearerAuthorization(undefined, 'hermes-token'), false);
  assert.equal(isStaticBearerAuthorization('Bearer hermes-token', ''), false);
});

test('static bearer docs describe optional dual auth without replacing OAuth', () => {
  const readme = fs.readFileSync(new URL('../README.vi.md', import.meta.url), 'utf8');
  const envExample = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const security = fs.readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
  assert.match(envExample, /^MCP_BEARER_TOKEN=$/m);
  assert.match(readme, /Static bearer auth/);
  assert.match(security, /GODMODE ACTIVE/);
  assert.match(security, /shell_execute/);
});

test('FileBackedAuthState persists registered client and token metadata across instances', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-state-'));
  const statePath = path.join(tempDir, 'auth-state.json');
  try {
    const first = new FileBackedAuthState(statePath);
    first.setClient({ client_id: 'client-1' });
    first.setToken('access-1', { accountId: 'account-1', clientId: 'client-1', scopes: ['mcp:tools'], expiresAt: Date.now() + 60_000 });
    first.setRefreshToken('refresh-1', { accountId: 'account-1', clientId: 'client-1', scopes: ['mcp:tools'], expiresAt: Date.now() + 60_000 });

    const second = new FileBackedAuthState(statePath);
    assert.equal(second.getClient('client-1').client_id, 'client-1');
    assert.equal(second.getToken('access-1').accountId, 'account-1');
    assert.equal(second.getRefreshToken('refresh-1').accountId, 'account-1');
    second.deleteRefreshToken('refresh-1');
    assert.equal(new FileBackedAuthState(statePath).getRefreshToken('refresh-1'), undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
