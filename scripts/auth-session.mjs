import fs from 'node:fs';
import crypto from 'node:crypto';

const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AUTH_SUPPORTED_SCOPES = Object.freeze(['mcp:tools', 'offline_access']);

export class FileBackedAuthState {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return { clients: {}, tokens: {}, refreshTokens: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
        tokens: parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {},
        refreshTokens: parsed.refreshTokens && typeof parsed.refreshTokens === 'object' ? parsed.refreshTokens : {}
      };
    } catch {
      return { clients: {}, tokens: {}, refreshTokens: {} };
    }
  }

  save() {
    if (!this.filePath) return;
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getClient(clientId) { return this.state.clients[clientId]; }
  setClient(client) {
    this.state.clients[client.client_id] = client;
    this.save();
  }

  getToken(token) { return this.state.tokens[token]; }
  setToken(token, tokenData) {
    this.state.tokens[token] = tokenData;
    this.save();
  }

  getRefreshToken(refreshToken) { return this.state.refreshTokens[refreshToken]; }
  setRefreshToken(refreshToken, refreshTokenData) {
    this.state.refreshTokens[refreshToken] = refreshTokenData;
    this.save();
  }
  deleteRefreshToken(refreshToken) {
    delete this.state.refreshTokens[refreshToken];
    this.save();
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

function redirectToAccountLogin(res) {
  const req = res.req;
  const returnTo = String(req?.originalUrl || req?.url || '/').trim();
  res.redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
}

export class AccountAuthProvider {
  constructor({ stateStore = null, accountStore, accountFromRequest } = {}) {
    if (!accountStore) throw new Error('accountStore is required for AccountAuthProvider.');
    if (typeof accountFromRequest !== 'function') throw new Error('accountFromRequest is required for AccountAuthProvider.');
    this.stateStore = stateStore;
    this.accountStore = accountStore;
    this.accountFromRequest = accountFromRequest;
    this.clientsStore = new ClientsStore(stateStore);
    this.codes = new Map();
    this.tokens = new Map();
    this.refreshTokens = new Map();
  }

  async authorize(client, params, res) {
    const account = this.accountFromRequest(res.req);
    if (!account || account.role !== 'user' || account.revokedAt !== null) {
      redirectToAccountLogin(res);
      return;
    }

    activeAccount(this.accountStore, account.accountId);
    const code = crypto.randomUUID();
    this.codes.set(code, { client, params, accountId: account.accountId });

    const searchParams = new URLSearchParams({ code });
    if (params.state !== undefined) searchParams.set('state', params.state);
    const targetUrl = new URL(String(params.redirectUri).trim());
    targetUrl.search = searchParams.toString();
    res.redirect(targetUrl.toString());
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
    const scopes = codeData.params.scopes || [];
    const tokenData = {
      token,
      accountId: codeData.accountId,
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      resource: codeData.params.resource
    };
    const refreshTokenData = {
      refreshToken,
      accountId: codeData.accountId,
      clientId: client.client_id,
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

    this.refreshTokens.delete(refreshToken);
    this.stateStore?.deleteRefreshToken?.(refreshToken);

    const nextAccessToken = crypto.randomUUID();
    const nextRefreshToken = crypto.randomUUID();
    const accessTokenData = {
      token: nextAccessToken,
      accountId: refreshTokenData.accountId,
      clientId: refreshTokenData.clientId,
      scopes: refreshTokenData.scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      resource: refreshTokenData.resource
    };
    const nextRefreshTokenData = {
      refreshToken: nextRefreshToken,
      accountId: refreshTokenData.accountId,
      clientId: refreshTokenData.clientId,
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
    return {
      token,
      accountId: tokenData.accountId,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource
    };
  }
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
