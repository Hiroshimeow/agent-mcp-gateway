import crypto from 'node:crypto';

const ACCOUNT_COOKIE = 'hcu_account_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseCookies(header = '') {
  return String(header)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((result, part) => {
      const index = part.indexOf('=');
      if (index <= 0) return result;
      try { result[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1)); } catch {}
      return result;
    }, {});
}

function safeReturnTo(value) {
  const target = String(value || '').trim();
  if (!target || target.length > 2048 || !target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return '/dashboard';
  return target;
}

function secureRequest(req) {
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return Boolean(req.secure || forwarded === 'https');
}

function sourceKey(req) {
  return String(req.headers?.['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || 'unknown').trim().slice(0, 128);
}

function identityDigest(value) {
  return crypto.createHash('sha256').update(String(value || '').trim().toLowerCase(), 'utf8').digest('hex').slice(0, 24);
}

export function createLoginRateLimiter({ now = () => Date.now() } = {}) {
  const states = new Map();
  const resetAfterMs = 15 * 60_000;

  function key(identity, source) {
    return `${String(source || 'unknown').slice(0, 128)}\n${identityDigest(identity)}`;
  }

  function canAttempt({ identity, source }) {
    const state = states.get(key(identity, source));
    return !state || Number(state.blockedUntil || 0) <= Number(now());
  }

  function recordFailure({ identity, source }) {
    const id = key(identity, source);
    const time = Number(now());
    const previous = states.get(id);
    const state = !previous || time - previous.lastFailure > resetAfterMs
      ? { failures: 0, lastFailure: time, blockedUntil: 0 }
      : previous;
    state.failures += 1;
    state.lastFailure = time;
    if (state.failures >= 5) state.blockedUntil = time + 60 * 60_000;
    else if (state.failures === 4) state.blockedUntil = time + 5 * 60_000;
    else if (state.failures === 3) state.blockedUntil = time + 60_000;
    states.set(id, state);
    return { ...state };
  }

  function recordSuccess({ identity, source }) {
    states.delete(key(identity, source));
  }

  return { canAttempt, recordFailure, recordSuccess };
}

function shell({ title, body }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050505;color:#e8e8e8;font:15px ui-monospace,SFMono-Regular,Consolas,monospace}.box{width:min(92vw,440px)}form{display:flex;gap:10px}input{min-width:0;flex:1;background:#0b0b0b;color:#f4f4f4;border:1px solid #292929;padding:13px 14px;outline:none}input:focus{border-color:#666}button,.link{border:0;padding:13px 16px;background:#222;color:#eee;text-decoration:none;font:inherit;cursor:pointer}.go-green{background:#0b5;color:#001b0e}.go-red{background:#b21;color:#fff}.out{display:inline-block;margin-top:12px;color:#777}.msg{min-height:22px;color:#a7a7a7;margin:0 0 12px}.brand{color:#555;margin-bottom:14px;letter-spacing:.18em}
</style></head><body><main class="box"><div class="brand">HCU</div>${body}</main></body></html>`;
}

function loginIdentityPage(returnTo = '/dashboard') {
  return shell({
    title: 'HCU Login',
    body: `<p class="msg"></p><form method="post" action="/login/email"><input name="identity" type="email" autocomplete="username" autofocus required><input type="hidden" name="return_to" value="${escapeHtml(safeReturnTo(returnTo))}"><button class="go-green" type="submit">GO</button></form><a class="out" href="/signup?return_to=${encodeURIComponent(safeReturnTo(returnTo))}">OUT</a>`
  });
}

function loginPasswordPage(identity, returnTo = '/dashboard', failed = false) {
  return shell({
    title: 'HCU Login',
    body: `<p class="msg">${failed ? 'Authentication failed' : ''}</p><form method="post" action="/login"><input name="password" type="password" autocomplete="current-password" autofocus required><input type="hidden" name="identity" value="${escapeHtml(identity)}"><input type="hidden" name="return_to" value="${escapeHtml(safeReturnTo(returnTo))}"><button class="go-red" type="submit">GO</button></form><a class="out" href="/signup?return_to=${encodeURIComponent(safeReturnTo(returnTo))}">OUT</a>`
  });
}

function signupPage(returnTo = '/dashboard', failed = false, needInvite = true) {
  return shell({
    title: 'HCU Signup',
    body: `<p class="msg">${failed ? 'Registration failed' : ''}</p><form method="post" action="/signup" style="display:grid"><input name="identity" type="email" autocomplete="username" placeholder="email" required><input name="password" type="password" autocomplete="new-password" placeholder="password" required>${needInvite ? '<input name="invite" autocomplete="one-time-code" placeholder="invite" maxlength="8" required>' : ''}<input type="hidden" name="return_to" value="${escapeHtml(safeReturnTo(returnTo))}"><button class="go-green" type="submit">OUT</button></form><a class="out" href="/login?return_to=${encodeURIComponent(safeReturnTo(returnTo))}">GO BACK</a>`
  });
}

export function installAccountRoutes(app, {
  accountStore,
  needInvite = true,
  now = () => Date.now(),
  loginLimiter = createLoginRateLimiter({ now }),
  sessionTtlMs = SESSION_TTL_MS
} = {}) {
  if (!app || !accountStore) throw new Error('app and accountStore are required.');
  const requiresInvite = () => typeof needInvite === 'function' ? Boolean(needInvite()) : Boolean(needInvite);

  function accountFromRequest(req) {
    const sessionId = parseCookies(req?.headers?.cookie || '')[ACCOUNT_COOKIE];
    if (!sessionId) return null;
    const account = accountStore.getSessionAccount(sessionId);
    return account?.role === 'user' ? account : null;
  }

  function setSession(req, res, accountId) {
    const session = accountStore.createSession(accountId, { ttlMs: sessionTtlMs });
    res.cookie(ACCOUNT_COOKIE, session.sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureRequest(req),
      maxAge: sessionTtlMs,
      path: '/'
    });
    return session;
  }

  app.get('/login', (req, res) => {
    res.status(200).type('html').send(loginIdentityPage(req.query?.return_to));
  });

  app.post('/login/email', (req, res) => {
    res.status(200).type('html').send(loginPasswordPage(String(req.body?.identity || '').trim(), req.body?.return_to, false));
  });

  app.post('/login', (req, res) => {
    const identity = String(req.body?.identity || '').trim();
    const returnTo = safeReturnTo(req.body?.return_to);
    const source = sourceKey(req);
    const limiterKey = { identity, source };
    if (!loginLimiter.canAttempt(limiterKey)) {
      res.status(200).type('html').send(loginPasswordPage(identity, returnTo, true));
      return;
    }

    const account = accountStore.verifyPassword(identity, req.body?.password);
    if (!account || account.role !== 'user') {
      loginLimiter.recordFailure(limiterKey);
      res.status(200).type('html').send(loginPasswordPage(identity, returnTo, true));
      return;
    }

    loginLimiter.recordSuccess(limiterKey);
    setSession(req, res, account.accountId);
    res.redirect(302, returnTo);
  });

  app.get('/signup', (req, res) => {
    res.status(200).type('html').send(signupPage(req.query?.return_to, false, requiresInvite()));
  });

  app.post('/signup', (req, res) => {
    const returnTo = safeReturnTo(req.body?.return_to);
    try {
      const account = accountStore.createAccount({
        email: req.body?.identity,
        password: req.body?.password,
        inviteCode: req.body?.invite,
        requireInvite: requiresInvite()
      });
      setSession(req, res, account.accountId);
      res.redirect(302, returnTo);
    } catch {
      res.status(200).type('html').send(signupPage(returnTo, true, requiresInvite()));
    }
  });

  app.post('/logout', (req, res) => {
    const sessionId = parseCookies(req.headers?.cookie || '')[ACCOUNT_COOKIE];
    if (sessionId) accountStore.revokeSession(sessionId);
    res.clearCookie(ACCOUNT_COOKIE, { path: '/' });
    res.redirect(302, '/login');
  });

  return { accountFromRequest, cookieName: ACCOUNT_COOKIE };
}
