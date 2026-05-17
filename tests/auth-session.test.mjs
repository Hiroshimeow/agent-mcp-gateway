import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FileBackedAuthState,
  PasswordProtectedAuthProvider,
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
  assert.match(readme, /Hermes\/OpenClaw/);
  assert.match(readme, /Authorization: Bearer <token>/);
  assert.match(readme, /OAuth vẫn giữ nguyên cho ChatGPT/);
  assert.match(readme, /Nếu `MCP_BEARER_TOKEN` trống, launcher chỉ chấp nhận OAuth như trước/);
  assert.match(security, /Static Bearer token auth is a shared secret/);
  assert.match(security, /Keep `MCP_BEARER_TOKEN` only in `.env`/);
});

test('PasswordProtectedAuthProvider persists clients and tokens across instances', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-test-'));
  const statePath = path.join(tempDir, 'auth-state.json');
  const stateStore = new FileBackedAuthState(statePath);

  const providerA = new PasswordProtectedAuthProvider('secret', stateStore);
  const client = { client_id: 'client-1' };
  await providerA.clientsStore.registerClient(client);
  providerA.codes.set('code-1', {
    client,
    params: { codeChallenge: 'challenge', scopes: ['mcp:tools'], resource: 'https://example.com/mcp' }
  });

  const tokenResponse = await providerA.exchangeAuthorizationCode(client, 'code-1');

  const providerB = new PasswordProtectedAuthProvider('secret', stateStore);
  const restoredClient = await providerB.clientsStore.getClient('client-1');
  const restoredToken = await providerB.verifyAccessToken(tokenResponse.access_token);

  assert.deepEqual(restoredClient, client);
  assert.equal(restoredToken.clientId, 'client-1');
  assert.deepEqual(restoredToken.scopes, ['mcp:tools']);
});

test('PasswordProtectedAuthProvider supports refresh tokens across instances', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-test-'));
  const statePath = path.join(tempDir, 'auth-state.json');
  const stateStore = new FileBackedAuthState(statePath);

  const providerA = new PasswordProtectedAuthProvider('secret', stateStore);
  const client = { client_id: 'client-2' };
  await providerA.clientsStore.registerClient(client);
  providerA.codes.set('code-2', {
    client,
    params: { codeChallenge: 'challenge', scopes: ['mcp:tools'], resource: 'https://example.com/mcp' }
  });

  const tokenResponse = await providerA.exchangeAuthorizationCode(client, 'code-2');
  const providerB = new PasswordProtectedAuthProvider('secret', stateStore);
  const refreshed = await providerB.exchangeRefreshToken(client, tokenResponse.refresh_token);
  const restoredToken = await providerB.verifyAccessToken(refreshed.access_token);

  assert.equal(refreshed.token_type, 'bearer');
  assert.ok(refreshed.refresh_token);
  assert.equal(restoredToken.clientId, 'client-2');
});

test('PasswordProtectedAuthProvider restores remembered machine session across instances', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-test-'));
  const statePath = path.join(tempDir, 'auth-state.json');
  const stateStore = new FileBackedAuthState(statePath);

  const providerA = new PasswordProtectedAuthProvider('secret', stateStore);
  providerA.rememberSession('machine-session-1');

  const providerB = new PasswordProtectedAuthProvider('secret', stateStore);
  assert.equal(providerB.hasSession('machine-session-1'), true);
});
