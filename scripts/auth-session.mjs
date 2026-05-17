import fs from 'node:fs';

const ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class FileBackedAuthState {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return { clients: {}, tokens: {}, refreshTokens: {}, sessions: {} };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
        tokens: parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {},
        refreshTokens: parsed.refreshTokens && typeof parsed.refreshTokens === 'object' ? parsed.refreshTokens : {},
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {}
      };
    } catch {
      return { clients: {}, tokens: {}, refreshTokens: {}, sessions: {} };
    }
  }

  save() {
    if (!this.filePath) {
      return;
    }

    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getClient(clientId) {
    return this.state.clients[clientId];
  }

  setClient(client) {
    this.state.clients[client.client_id] = client;
    this.save();
  }

  getToken(token) {
    return this.state.tokens[token];
  }

  setToken(token, tokenData) {
    this.state.tokens[token] = tokenData;
    this.save();
  }

  getRefreshToken(refreshToken) {
    return this.state.refreshTokens[refreshToken];
  }

  setRefreshToken(refreshToken, refreshTokenData) {
    this.state.refreshTokens[refreshToken] = refreshTokenData;
    this.save();
  }

  getSession(sessionId) {
    return this.state.sessions[sessionId];
  }

  setSession(sessionId, sessionData) {
    this.state.sessions[sessionId] = sessionData;
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

export class PasswordProtectedAuthProvider {
  constructor(password, stateStore = null) {
    this.password = password;
    this.stateStore = stateStore;
    this.clientsStore = new ClientsStore(stateStore);
    this.codes = new Map();
    this.tokens = new Map();
    this.refreshTokens = new Map();
    this.sessions = new Map();
  }

  hasSession(sessionId) {
    const sessionData = this.sessions.get(sessionId) || this.stateStore?.getSession(sessionId);
    return Boolean(sessionData && sessionData.expiresAt >= Date.now());
  }

  rememberSession(sessionId) {
    const sessionData = {
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS
    };
    this.sessions.set(sessionId, sessionData);
    this.stateStore?.setSession(sessionId, sessionData);
  }

  async authorize(client, params, res) {
    const req = res.req;
    const cookies = parseCookies(req.headers.cookie || '');
    const sessionId = cookies.mcp_auth_session;
    const hasSession = sessionId && this.hasSession(sessionId);

    if (!hasSession) {
      const submittedPassword = req.method === 'POST' ? String(req.body?.password || '') : '';
      if (submittedPassword !== this.password) {
        res.status(200).type('html').send(renderLoginPage(req, submittedPassword.length > 0));
        return;
      }

      const newSessionId = crypto.randomUUID();
      this.rememberSession(newSessionId);
      res.cookie('mcp_auth_session', newSessionId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        maxAge: SESSION_TTL_MS,
        path: '/'
      });
    }

    const code = crypto.randomUUID();
    this.codes.set(code, { client, params });

    const searchParams = new URLSearchParams({ code });
    if (params.state !== undefined) {
      searchParams.set('state', params.state);
    }

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
    if (codeData.client.client_id !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    this.codes.delete(authorizationCode);
    const token = crypto.randomUUID();
    const refreshToken = crypto.randomUUID();
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;
    const tokenData = {
      token,
      clientId: client.client_id,
      scopes: codeData.params.scopes || [],
      expiresAt,
      resource: codeData.params.resource
    };
    const refreshTokenData = {
      refreshToken,
      clientId: client.client_id,
      scopes: codeData.params.scopes || [],
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
      scope: (codeData.params.scopes || []).join(' ')
    };
  }

  async exchangeRefreshToken(client, refreshToken) {
    const refreshTokenData = this.refreshTokens.get(refreshToken) || this.stateStore?.getRefreshToken(refreshToken);
    if (!refreshTokenData || refreshTokenData.expiresAt < Date.now()) {
      throw new Error('Invalid or expired refresh token');
    }
    if (client?.client_id && refreshTokenData.clientId !== client.client_id) {
      throw new Error('Refresh token was not issued to this client');
    }

    const nextAccessToken = crypto.randomUUID();
    const nextRefreshToken = crypto.randomUUID();
    const accessTokenData = {
      token: nextAccessToken,
      clientId: refreshTokenData.clientId,
      scopes: refreshTokenData.scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      resource: refreshTokenData.resource
    };
    const nextRefreshTokenData = {
      refreshToken: nextRefreshToken,
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
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new Error('Invalid or expired token');
    }

    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource
    };
  }
}

export function shouldCreateTransportForRequest(sessionId, requestBody, transports) {
  const isInitialize = requestBody?.method === 'initialize';
  if (isInitialize && (!sessionId || !transports[sessionId])) {
    return true;
  }

  return false;
}

export function shouldUseStatefulSessionTransport(value) {
  return String(value || '').toLowerCase() === 'true';
}

export function isStaticBearerAuthorization(authorizationHeader, configuredToken) {
  const token = String(configuredToken || '').trim();
  if (!token || typeof authorizationHeader !== 'string') {
    return false;
  }

  const header = authorizationHeader.trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  const providedToken = (match ? match[1] : header).trim();
  const tokenBeforeHash = token.includes('#') ? token.slice(0, token.indexOf('#')).trimEnd() : token;

  return providedToken === token || (tokenBeforeHash && providedToken === tokenBeforeHash);
}

function parseCookies(cookieHeader) {
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const index = part.indexOf('=');
      if (index === -1) return acc;
      const key = part.slice(0, index);
      const value = part.slice(index + 1);
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderLoginPage(req, invalidPassword) {
  const source = req.method === 'POST' ? req.body : req.query;
  const hiddenFields = [
    'client_id',
    'redirect_uri',
    'response_type',
    'code_challenge',
    'code_challenge_method',
    'scope',
    'state',
    'resource'
  ]
    .filter(key => source[key] !== undefined)
    .map(key => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(source[key])}">`)
    .join('\n');

  const errorBlock = invalidPassword
    ? '<p style="color:#b00020;margin:0 0 12px;">Sai mật khẩu hoặc mật khẩu trống.</p>'
    : '';

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local Dev MCP Login</title>
</head>
<body style="font-family:Segoe UI,Arial,sans-serif;background:#f7f7f7;margin:0;padding:40px;">
  <div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #ddd;padding:24px;border-radius:12px;">
    <h1 style="margin-top:0;font-size:22px;">Local Dev MCP</h1>
    <p style="line-height:1.5;">Nhập mật khẩu để cấp quyền cho ChatGPT truy cập MCP endpoint này.</p>
    ${errorBlock}
    <form method="post">
      ${hiddenFields}
      <label for="password" style="display:block;margin-bottom:8px;">Mật khẩu</label>
      <input id="password" name="password" type="password" autofocus style="width:100%;padding:10px;border:1px solid #bbb;border-radius:8px;box-sizing:border-box;">
      <button type="submit" style="margin-top:14px;padding:10px 14px;border:none;border-radius:8px;background:#111;color:#fff;cursor:pointer;">Đăng nhập</button>
    </form>
  </div>
</body>
</html>`;
}

const crypto = globalThis.crypto;
