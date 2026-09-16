import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { publicGatePage } from './account-http.mjs';
import { escapeHtml } from './enduser-ui.mjs';

const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_AUTH_TTL_MS = 5 * 60 * 1000;

export const AUTH_SUPPORTED_SCOPES = Object.freeze(['mcp:tools', 'offline_access']);

function authTokenHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export class SQLiteAuthState {
  constructor(dbPath) {
    if (!dbPath) throw new Error('dbPath is required for SQLiteAuthState.');
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new DatabaseSync(resolved);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_access_tokens (
        token_hash TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL
      );
    `);
    this.getClientStatement = this.db.prepare('SELECT metadata_json FROM oauth_clients WHERE client_id = ?');
    this.setClientStatement = this.db.prepare('INSERT INTO oauth_clients (client_id, metadata_json) VALUES (?, ?) ON CONFLICT(client_id) DO UPDATE SET metadata_json = excluded.metadata_json');
    this.getTokenStatement = this.db.prepare('SELECT metadata_json FROM oauth_access_tokens WHERE token_hash = ?');
    this.setTokenStatement = this.db.prepare('INSERT INTO oauth_access_tokens (token_hash, metadata_json) VALUES (?, ?) ON CONFLICT(token_hash) DO UPDATE SET metadata_json = excluded.metadata_json');
    this.getRefreshStatement = this.db.prepare('SELECT metadata_json FROM oauth_refresh_tokens WHERE token_hash = ?');
    this.setRefreshStatement = this.db.prepare('INSERT INTO oauth_refresh_tokens (token_hash, metadata_json) VALUES (?, ?) ON CONFLICT(token_hash) DO UPDATE SET metadata_json = excluded.metadata_json');
    this.deleteRefreshStatement = this.db.prepare('DELETE FROM oauth_refresh_tokens WHERE token_hash = ?');
  }

  getClient(clientId) {
    const row = this.getClientStatement.get(String(clientId || ''));
    return row ? JSON.parse(row.metadata_json) : undefined;
  }
  setClient(client) {
    this.setClientStatement.run(client.client_id, JSON.stringify(client));
  }
  getToken(token) {
    const row = this.getTokenStatement.get(authTokenHash(token));
    return row ? JSON.parse(row.metadata_json) : undefined;
  }
  setToken(token, tokenData) {
    this.setTokenStatement.run(authTokenHash(token), JSON.stringify(tokenData));
  }
  getRefreshToken(refreshToken) {
    const row = this.getRefreshStatement.get(authTokenHash(refreshToken));
    return row ? JSON.parse(row.metadata_json) : undefined;
  }
  setRefreshToken(refreshToken, refreshTokenData) {
    this.setRefreshStatement.run(authTokenHash(refreshToken), JSON.stringify(refreshTokenData));
  }
  deleteRefreshToken(refreshToken) {
    this.deleteRefreshStatement.run(authTokenHash(refreshToken));
  }
  close() {
    this.db.close();
  }
}

class ClientsStore {
  constructor(stateStore) {
    this.stateStore = stateStore;
  }

  async getClient(clientId) {
    return this.stateStore?.getClient(clientId);
  }

  async registerClient(clientMetadata) {
    this.stateStore?.setClient(clientMetadata);
    return clientMetadata;
  }
}

function activeAccount(accountStore, accountId) {
  const account = accountStore?.getAccount(accountId);
  if (!account || account.revokedAt !== null || account.role !== 'user') {
    throw new Error('OAuth account is missing or revoked.');
  }
  return account;
}

function localReturnPath(req) {
  const value = String(req?.originalUrl || req?.url || '/').trim();
  if (!value || value.length > 4096 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value;
}

function redirectToAccountLogin(res) {
  res.redirect(`/login?return_to=${encodeURIComponent(localReturnPath(res.req))}`);
}

export class AccountAuthProvider {
  constructor({ stateStore = null, accountStore, accountFromRequest, sessionBindingFromRequest, activityStore = null, now = () => Date.now(), pendingAuthTtlMs = PENDING_AUTH_TTL_MS } = {}) {
    if (!accountStore) throw new Error('accountStore is required for AccountAuthProvider.');
    if (typeof accountFromRequest !== 'function') throw new Error('accountFromRequest is required for AccountAuthProvider.');
    if (sessionBindingFromRequest != null && typeof sessionBindingFromRequest !== 'function') throw new Error('sessionBindingFromRequest must be a function when provided.');
    this.stateStore = stateStore;
    this.accountStore = accountStore;
    this.accountFromRequest = accountFromRequest;
    this.sessionBindingFromRequest = sessionBindingFromRequest;
    this.activityStore = activityStore;
    this.now = now;
    this.pendingAuthTtlMs = pendingAuthTtlMs;
    this.clientsStore = new ClientsStore(stateStore);
    this.codes = new Map();
    this.tokens = new Map();
    this.refreshTokens = new Map();
    this.pendingAuthorizations = new Map();
  }

  ensureActivitySession(tokenData, { token = null, refreshToken = null } = {}) {
    let activitySessionId = String(tokenData.activitySessionId || '').trim();
    if (!activitySessionId) {
      activitySessionId = crypto.randomUUID();
      tokenData.activitySessionId = activitySessionId;
      this.activityStore?.openActivitySession({
        activitySessionId,
        accountId: tokenData.accountId,
        clientId: tokenData.clientId
      });
      if (token) this.stateStore?.setToken(token, tokenData);
      if (refreshToken) this.stateStore?.setRefreshToken(refreshToken, tokenData);
      return activitySessionId;
    }
    this.activityStore?.touchActivitySession({ activitySessionId, accountId: tokenData.accountId });
    return activitySessionId;
  }

  issueAuthorizationCode(client, params, accountId, res) {
    activeAccount(this.accountStore, accountId);
    const code = crypto.randomUUID();
    this.codes.set(code, { client, params, accountId });

    const searchParams = new URLSearchParams({ code });
    if (params.state !== undefined) searchParams.set('state', params.state);
    const targetUrl = new URL(String(params.redirectUri).trim());
    targetUrl.search = searchParams.toString();
    res.redirect(targetUrl.toString());
  }

  prunePendingAuthorizations() {
    const now = Number(this.now());
    for (const [pendingId, pending] of this.pendingAuthorizations) {
      if (pending.expiresAt <= now) this.pendingAuthorizations.delete(pendingId);
    }
  }

  takePendingAuthorization({ pendingId, csrf, req }) {
    this.prunePendingAuthorizations();
    const pending = this.pendingAuthorizations.get(String(pendingId || ''));
    if (!pending || pending.csrf !== String(csrf || '')) return null;
    const account = this.accountFromRequest(req);
    const sessionBinding = this.sessionBindingFromRequest?.(req);
    if (!account || account.role !== 'user' || account.revokedAt !== null || account.accountId !== pending.accountId || !sessionBinding || sessionBinding !== pending.sessionBinding) return null;
    this.pendingAuthorizations.delete(String(pendingId));
    return pending;
  }

  async authorize(client, params, res) {
    const account = this.accountFromRequest(res.req);
    if (!account || account.role !== 'user' || account.revokedAt !== null) {
      redirectToAccountLogin(res);
      return;
    }

    activeAccount(this.accountStore, account.accountId);
    this.prunePendingAuthorizations();
    const pendingId = crypto.randomUUID();
    const csrf = crypto.randomUUID();
    const sessionBinding = this.sessionBindingFromRequest?.(res.req);
    if (!sessionBinding) throw new Error('OAuth account session binding is unavailable.');
    this.pendingAuthorizations.set(pendingId, {
      client,
      params,
      accountId: account.accountId,
      sessionBinding,
      csrf,
      returnTo: localReturnPath(res.req),
      expiresAt: Number(this.now()) + this.pendingAuthTtlMs
    });
    const hidden = `<input type="hidden" name="pending" value="${escapeHtml(pendingId)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
    const identity = escapeHtml(account.email || account.identity || account.accountId);
    res.status(200).type('html').send(publicGatePage(`<div>Continue as ${identity}</div><div class="row"><form class="go-form" method="post" action="/oauth/continue">${hidden}<button class="go" type="submit">Continue</button></form><form class="out-form" method="post" action="/oauth/out">${hidden}<button class="out" type="submit">Use another account</button></form></div>`));
  }

  async continueAuthorization({ pendingId, csrf, req, res }) {
    const pending = this.takePendingAuthorization({ pendingId, csrf, req });
    if (!pending) return false;
    this.issueAuthorizationCode(pending.client, pending.params, pending.accountId, res);
    return true;
  }

  cancelAuthorization({ pendingId, csrf, req }) {
    return this.takePendingAuthorization({ pendingId, csrf, req })?.returnTo || null;
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new Error('Invalid authorization code');
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new Error('Invalid authorization code');
    if (codeData.client.client_id !== client.client_id) throw new Error('Authorization code was not issued to this client');
    activeAccount(this.accountStore, codeData.accountId);

    this.codes.delete(authorizationCode);
    const token = crypto.randomUUID();
    const refreshToken = crypto.randomUUID();
    const activitySessionId = crypto.randomUUID();
    const scopes = codeData.params.scopes || [];
    this.activityStore?.openActivitySession({
      activitySessionId,
      accountId: codeData.accountId,
      clientId: client.client_id
    });
    const tokenData = {
      token,
      accountId: codeData.accountId,
      clientId: client.client_id,
      activitySessionId,
      scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      resource: codeData.params.resource
    };
    const refreshTokenData = {
      refreshToken,
      accountId: codeData.accountId,
      clientId: client.client_id,
      activitySessionId,
      scopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      resource: codeData.params.resource
    };
    this.tokens.set(token, tokenData);
    this.refreshTokens.set(refreshToken, refreshTokenData);
    this.stateStore?.setToken(token, tokenData);
    this.stateStore?.setRefreshToken(refreshToken, refreshTokenData);

    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(' ')
    };
  }

  async exchangeRefreshToken(client, refreshToken) {
    const refreshTokenData = this.refreshTokens.get(refreshToken) || this.stateStore?.getRefreshToken(refreshToken);
    if (!refreshTokenData || refreshTokenData.expiresAt < Date.now()) throw new Error('Invalid or expired refresh token');
    if (client?.client_id && refreshTokenData.clientId !== client.client_id) throw new Error('Refresh token was not issued to this client');
    activeAccount(this.accountStore, refreshTokenData.accountId);
    const activitySessionId = this.ensureActivitySession(refreshTokenData, { refreshToken });

    this.refreshTokens.delete(refreshToken);
    this.stateStore?.deleteRefreshToken?.(refreshToken);

    const nextAccessToken = crypto.randomUUID();
    const nextRefreshToken = crypto.randomUUID();
    const accessTokenData = {
      token: nextAccessToken,
      accountId: refreshTokenData.accountId,
      clientId: refreshTokenData.clientId,
      activitySessionId,
      scopes: refreshTokenData.scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      resource: refreshTokenData.resource
    };
    const nextRefreshTokenData = {
      refreshToken: nextRefreshToken,
      accountId: refreshTokenData.accountId,
      clientId: refreshTokenData.clientId,
      activitySessionId,
      scopes: refreshTokenData.scopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      resource: refreshTokenData.resource
    };
    this.tokens.set(nextAccessToken, accessTokenData);
    this.refreshTokens.set(nextRefreshToken, nextRefreshTokenData);
    this.stateStore?.setToken(nextAccessToken, accessTokenData);
    this.stateStore?.setRefreshToken(nextRefreshToken, nextRefreshTokenData);

    return {
      access_token: nextAccessToken,
      token_type: 'bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: nextRefreshToken,
      scope: refreshTokenData.scopes.join(' ')
    };
  }

  async verifyAccessToken(token) {
    const tokenData = this.tokens.get(token) || this.stateStore?.getToken(token);
    if (!tokenData || tokenData.expiresAt < Date.now()) throw new Error('Invalid or expired token');
    activeAccount(this.accountStore, tokenData.accountId);
    const activitySessionId = this.ensureActivitySession(tokenData, { token });
    return {
      token,
      accountId: tokenData.accountId,
      clientId: tokenData.clientId,
      activitySessionId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource
    };
  }
}

export function installAuthorizationGateRoutes(app, { provider, clearSession, loginLocation } = {}) {
  if (!app || !provider || typeof clearSession !== 'function' || typeof loginLocation !== 'function') {
    throw new Error('app, provider, clearSession, and loginLocation are required.');
  }

  app.post('/oauth/continue', async (req, res) => {
    const ok = await provider.continueAuthorization({
      pendingId: req.body?.pending,
      csrf: req.body?.csrf,
      req,
      res
    });
    if (!ok && !res.headersSent) res.status(400).end();
  });

  app.post('/oauth/out', (req, res) => {
    const returnTo = provider.cancelAuthorization({
      pendingId: req.body?.pending,
      csrf: req.body?.csrf,
      req
    });
    if (!returnTo) {
      res.status(400).end();
      return;
    }
    clearSession(req, res);
    res.redirect(302, loginLocation(returnTo));
  });
}

export function shouldCreateTransportForRequest(sessionId, requestBody, transports) {
  const isInitialize = requestBody?.method === 'initialize';
  return Boolean(isInitialize && (!sessionId || !transports[sessionId]));
}

export function shouldUseStatefulSessionTransport(value) {
  return String(value || '').toLowerCase() === 'true';
}

export function isStaticBearerAuthorization(authorizationHeader, configuredToken) {
  const token = String(configuredToken || '').trim();
  if (!token || typeof authorizationHeader !== 'string') return false;
  const header = authorizationHeader.trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  const providedToken = (match ? match[1] : header).trim();
  const tokenBeforeHash = token.includes('#') ? token.slice(0, token.indexOf('#')).trimEnd() : token;
  return providedToken === token || (tokenBeforeHash && providedToken === tokenBeforeHash);
}
