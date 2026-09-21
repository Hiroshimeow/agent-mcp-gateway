import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import {
  createOAuthAuthorizationServerRouter,
  redirectUriMatches
} from '../scripts/oauth-authorization-server.mjs';
import { AccountAuthProvider } from '../scripts/auth-session.mjs';

function makeProvider() {
  const clients = new Map();
  const codes = new Map();

  return {
    clientsStore: {
      async getClient(clientId) {
        return clients.get(clientId);
      },
      async registerClient(client) {
        clients.set(client.client_id, client);
        return client;
      }
    },
    async authorize(client, params, res) {
      const code = crypto.randomUUID();
      codes.set(code, {
        clientId: client.client_id,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        scopes: params.scopes,
        resource: params.resource
      });
      const target = new URL(params.redirectUri);
      target.searchParams.set('code', code);
      if (params.state !== undefined) target.searchParams.set('state', params.state);
      res.redirect(target.href);
    },
    async challengeForAuthorizationCode(client, code) {
      const stored = codes.get(code);
      if (!stored || stored.clientId !== client.client_id) {
        throw new OAuthError(OAuthErrorCode.InvalidGrant, 'Invalid authorization code');
      }
      return stored.codeChallenge;
    },
    async exchangeAuthorizationCode(client, code) {
      const stored = codes.get(code);
      if (!stored || stored.clientId !== client.client_id) {
        throw new OAuthError(OAuthErrorCode.InvalidGrant, 'Invalid authorization code');
      }
      codes.delete(code);
      return {
        access_token: 'access-token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'refresh-token',
        scope: stored.scopes.join(' ')
      };
    },
    async exchangeRefreshToken(client, refreshToken) {
      if (refreshToken !== 'refresh-token') {
        throw new OAuthError(OAuthErrorCode.InvalidGrant, 'Invalid refresh token');
      }
      return {
        access_token: 'refreshed-access-token',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'next-refresh-token',
        scope: 'mcp:tools'
      };
    }
  };
}

async function withOAuthServer(provider, fn) {
  const app = express();
  app.use(createOAuthAuthorizationServerRouter({
    provider,
    issuerUrl: new URL('http://localhost'),
    resourceServerUrl: new URL('http://localhost/mcp'),
    scopesSupported: ['mcp:tools', 'offline_access'],
    resourceName: 'Local Dev MCP',
    authorizationOptions: { rateLimit: false },
    tokenOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false },
    revocationOptions: { rateLimit: false }
  }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    await fn(base);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function registerPublicClient(base) {
  const response = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'OAuth migration test',
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.ok(body.client_id);
  assert.equal(body.client_secret, undefined);
  return body;
}

test('OAuth authorization server publishes MCP discovery metadata and registers clients', async () => {
  const provider = makeProvider();

  await withOAuthServer(provider, async base => {
    const metadataResponse = await fetch(`${base}/.well-known/oauth-authorization-server`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.issuer, 'http://localhost/');
    assert.equal(metadata.authorization_endpoint, 'http://localhost/authorize');
    assert.equal(metadata.token_endpoint, 'http://localhost/token');
    assert.equal(metadata.registration_endpoint, 'http://localhost/register');
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);

    const resourceResponse = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(resourceResponse.status, 200);
    const resource = await resourceResponse.json();
    assert.equal(resource.resource, 'http://localhost/mcp');
    assert.deepEqual(resource.authorization_servers, ['http://localhost/']);

    const registered = await registerPublicClient(base);
    assert.equal(registered.token_endpoint_auth_method, 'none');
  });
});

test('OAuth authorization code flow enforces PKCE S256 and appends RFC 9207 issuer', async () => {
  const provider = makeProvider();

  await withOAuthServer(provider, async base => {
    const client = await registerPublicClient(base);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');

    const authorizeUrl = new URL(`${base}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', 'mcp:tools offline_access');
    authorizeUrl.searchParams.set('state', 'state-123');
    authorizeUrl.searchParams.set('resource', 'http://localhost/mcp');

    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(authorize.status, 302);
    const callback = new URL(authorize.headers.get('location'));
    assert.equal(callback.origin, 'https://client.example');
    assert.equal(callback.pathname, '/callback');
    assert.equal(callback.searchParams.get('state'), 'state-123');
    assert.equal(callback.searchParams.get('iss'), 'http://localhost/');
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const wrongVerifier = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: 'x'.repeat(43),
      redirect_uri: 'https://client.example/callback'
    });
    const wrong = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: wrongVerifier
    });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error, 'invalid_grant');

    const correctVerifier = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: 'https://client.example/callback'
    });
    const token = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: correctVerifier
    });
    assert.equal(token.status, 200);
    const tokens = await token.json();
    assert.equal(tokens.access_token, 'access-token');
    assert.equal(tokens.refresh_token, 'refresh-token');

    const refresh = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: tokens.refresh_token
      })
    });
    assert.equal(refresh.status, 200);
    assert.equal((await refresh.json()).access_token, 'refreshed-access-token');
  });
});

test('OAuth redirect matching keeps RFC 8252 loopback port flexibility only for loopback hosts', () => {
  assert.equal(
    redirectUriMatches('http://127.0.0.1:54321/callback', 'http://127.0.0.1:12345/callback'),
    true
  );
  assert.equal(
    redirectUriMatches('https://client.example:54321/callback', 'https://client.example:12345/callback'),
    false
  );
  assert.equal(
    redirectUriMatches('http://localhost:54321/other', 'http://localhost:12345/callback'),
    false
  );
  assert.equal(
    redirectUriMatches('http://[::1]:54321/callback', 'http://[::1]:12345/callback'),
    true
  );
});

test('AccountAuthProvider emits v2 invalid_token errors for the maintained bearer middleware', async () => {
  const provider = new AccountAuthProvider({
    accountStore: { getAccount: () => null },
    accountFromRequest: () => null
  });

  await assert.rejects(
    () => provider.verifyAccessToken('missing-token'),
    error => error instanceof OAuthError && error.code === OAuthErrorCode.InvalidToken
  );
});
