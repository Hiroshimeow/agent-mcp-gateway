import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_LENGTH = 8;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

function accountError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export function normalizeAccountEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw accountError('INVALID_EMAIL', 'A valid email is required.');
  }
  return email;
}

function normalizePassword(value) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 1024) {
    throw accountError('INVALID_PASSWORD', 'Password must be between 8 and 1024 characters.');
  }
  return password;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(normalizePassword(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function verifyPasswordHash(password, encoded) {
  try {
    const [kind, nText, rText, pText, saltText, digestText] = String(encoded || '').split('$');
    if (kind !== 'scrypt') return false;
    const N = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(digestText, 'base64url');
    const actual = crypto.scryptSync(String(password || ''), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const DUMMY_PASSWORD_HASH = hashPassword('hcu-dummy-password-not-an-account');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function inviteHash(code) {
  return sha256Hex(String(code || '').trim().toUpperCase());
}

function sessionHash(sessionId) {
  return sha256Hex(String(sessionId || '').trim());
}

function generateInviteCode() {
  const bytes = crypto.randomBytes(INVITE_LENGTH);
  let value = '';
  for (let index = 0; index < INVITE_LENGTH; index += 1) {
    value += INVITE_ALPHABET[bytes[index] % INVITE_ALPHABET.length];
  }
  return value;
}

function rowToAccount(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    email: row.email_normalized,
    role: row.role,
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
  };
}

function rowToInvite(row) {
  if (!row) return null;
  return {
    inviteHash: row.invite_hash,
    createdAt: Number(row.created_at),
    usedAt: row.used_at === null ? null : Number(row.used_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
  };
}

export function createAccountStore({ dbPath, now = () => Date.now() } = {}) {
  if (!dbPath) throw new Error('dbPath is required for account store.');
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      email_normalized TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS invites (
      invite_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      session_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS accounts_email_idx ON accounts(email_normalized);
    CREATE INDEX IF NOT EXISTS account_sessions_account_idx ON account_sessions(account_id);
  `);

  const getByIdStatement = db.prepare(`
    SELECT account_id, email_normalized, password_hash, role, created_at, revoked_at
    FROM accounts WHERE account_id = ?
  `);
  const getByEmailStatement = db.prepare(`
    SELECT account_id, email_normalized, password_hash, role, created_at, revoked_at
    FROM accounts WHERE email_normalized = ?
  `);
  const listAccountsStatement = db.prepare(`
    SELECT account_id, email_normalized, password_hash, role, created_at, revoked_at
    FROM accounts ORDER BY created_at, account_id
  `);
  const insertAccountStatement = db.prepare(`
    INSERT INTO accounts (account_id, email_normalized, password_hash, role, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `);
  const revokeAccountStatement = db.prepare(`
    UPDATE accounts SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL
  `);
  const deleteAccountStatement = db.prepare('DELETE FROM accounts WHERE account_id = ?');
  const insertSessionStatement = db.prepare(`
    INSERT INTO account_sessions (session_hash, account_id, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, NULL)
  `);
  const getSessionAccountStatement = db.prepare(`
    SELECT a.account_id, a.email_normalized, a.password_hash, a.role, a.created_at, a.revoked_at
    FROM account_sessions s
    JOIN accounts a ON a.account_id = s.account_id
    WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at >= ? AND a.revoked_at IS NULL
  `);
  const revokeSessionStatement = db.prepare('UPDATE account_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL');
  const revokeAccountSessionsStatement = db.prepare('UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL');
  const deleteAccountSessionsStatement = db.prepare('DELETE FROM account_sessions WHERE account_id = ?');

  const getInviteStatement = db.prepare('SELECT invite_hash, created_at, used_at, revoked_at FROM invites WHERE invite_hash = ?');
  const listInvitesStatement = db.prepare('SELECT invite_hash, created_at, used_at, revoked_at FROM invites ORDER BY created_at, invite_hash');
  const insertInviteStatement = db.prepare('INSERT INTO invites (invite_hash, created_at, used_at, revoked_at) VALUES (?, ?, NULL, NULL)');
  const consumeInviteStatement = db.prepare('UPDATE invites SET used_at = ? WHERE invite_hash = ? AND used_at IS NULL AND revoked_at IS NULL');
  const revokeInviteStatement = db.prepare('UPDATE invites SET revoked_at = ? WHERE invite_hash = ? AND used_at IS NULL AND revoked_at IS NULL');

  function getAccount(accountId) {
    return rowToAccount(getByIdStatement.get(String(accountId || '').trim()));
  }

  function getAccountByEmail(email) {
    return rowToAccount(getByEmailStatement.get(normalizeAccountEmail(email)));
  }

  function listAccounts() {
    return listAccountsStatement.all().map(rowToAccount);
  }

  function createAccountInternal({ email, password, role, inviteCode, requireInvite }) {
    const normalizedEmail = normalizeAccountEmail(email);
    const passwordHash = hashPassword(password);
    const createdAt = Number(now());
    const accountId = crypto.randomUUID();
    const invite = String(inviteCode || '').trim().toUpperCase();
    const hash = invite ? inviteHash(invite) : null;
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      if (requireInvite) {
        if (!invite) throw accountError('INVITE_REQUIRED', 'A valid invite code is required.');
        const row = getInviteStatement.get(hash);
        if (!row || row.used_at !== null || row.revoked_at !== null) {
          throw accountError('INVITE_INVALID', 'Invite code is invalid, used, or revoked.');
        }
      }
      try {
        insertAccountStatement.run(accountId, normalizedEmail, passwordHash, role, createdAt);
      } catch (error) {
        if (String(error?.message || '').toLowerCase().includes('unique')) {
          throw accountError('ACCOUNT_EXISTS', 'Account already exists.');
        }
        throw error;
      }
      if (requireInvite) {
        const changed = consumeInviteStatement.run(createdAt, hash);
        if (Number(changed.changes) !== 1) throw accountError('INVITE_INVALID', 'Invite code is invalid, used, or revoked.');
      }
      db.exec('COMMIT');
      began = false;
      return getAccount(accountId);
    } catch (error) {
      if (began) { try { db.exec('ROLLBACK'); } catch {} }
      throw error;
    }
  }

  function createAccount({ email, password, inviteCode, requireInvite = false }) {
    return createAccountInternal({ email, password, role: 'user', inviteCode, requireInvite: Boolean(requireInvite) });
  }

  function createAdmin({ email, password }) {
    return createAccountInternal({ email, password, role: 'admin', requireInvite: false });
  }

  function verifyPassword(email, password) {
    let normalizedEmail;
    try { normalizedEmail = normalizeAccountEmail(email); } catch { normalizedEmail = null; }
    const row = normalizedEmail ? getByEmailStatement.get(normalizedEmail) : null;
    const matches = verifyPasswordHash(password, row?.password_hash || DUMMY_PASSWORD_HASH);
    if (!row || row.revoked_at !== null || !matches) return null;
    return rowToAccount(row);
  }

  function createSession(accountId, { ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const id = String(accountId || '').trim();
    const account = getAccount(id);
    if (!account || account.revokedAt !== null) throw accountError('ACCOUNT_NOT_FOUND', 'Unknown or revoked account.');
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 24 * 60 * 60 * 1000) {
      throw accountError('INVALID_SESSION_TTL', 'Session ttlMs must be between 60000 and 2592000000.');
    }
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const createdAt = Number(now());
    const expiresAt = createdAt + ttlMs;
    insertSessionStatement.run(sessionHash(sessionId), id, createdAt, expiresAt);
    return { sessionId, accountId: id, createdAt, expiresAt };
  }

  function getSessionAccount(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    return rowToAccount(getSessionAccountStatement.get(sessionHash(id), Number(now())));
  }

  function revokeSession(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return false;
    return Number(revokeSessionStatement.run(Number(now()), sessionHash(id)).changes) === 1;
  }

  function revokeAccount(accountId) {
    const id = String(accountId || '').trim();
    const existing = getAccount(id);
    if (!existing) throw accountError('ACCOUNT_NOT_FOUND', 'Unknown account.');
    if (existing.revokedAt !== null) return existing;
    const revokedAt = Number(now());
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      revokeAccountStatement.run(revokedAt, id);
      revokeAccountSessionsStatement.run(revokedAt, id);
      db.exec('COMMIT');
      began = false;
      return getAccount(id);
    } catch (error) {
      if (began) { try { db.exec('ROLLBACK'); } catch {} }
      throw error;
    }
  }

  function deleteAccount(accountId) {
    const id = String(accountId || '').trim();
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      deleteAccountSessionsStatement.run(id);
      const deleted = Number(deleteAccountStatement.run(id).changes) === 1;
      db.exec('COMMIT');
      began = false;
      return deleted;
    } catch (error) {
      if (began) { try { db.exec('ROLLBACK'); } catch {} }
      throw error;
    }
  }

  function createInvite() {
    const createdAt = Number(now());
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const code = generateInviteCode();
      try {
        insertInviteStatement.run(inviteHash(code), createdAt);
        return { code, createdAt };
      } catch (error) {
        if (!String(error?.message || '').toLowerCase().includes('unique')) throw error;
      }
    }
    throw new Error('Unable to allocate a unique invite code.');
  }

  function listInvites() {
    return listInvitesStatement.all().map(rowToInvite);
  }

  function revokeInvite(code) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) throw accountError('INVITE_INVALID', 'Invite code is required.');
    const hash = inviteHash(normalized);
    const existing = getInviteStatement.get(hash);
    if (!existing) throw accountError('INVITE_INVALID', 'Invite code is invalid.');
    if (existing.used_at !== null) throw accountError('INVITE_INVALID', 'Invite code is already used.');
    if (existing.revoked_at === null) revokeInviteStatement.run(Number(now()), hash);
    return rowToInvite(getInviteStatement.get(hash));
  }

  function close() {
    db.close();
  }

  return {
    getAccount,
    getAccountByEmail,
    listAccounts,
    createAccount,
    createAdmin,
    verifyPassword,
    createSession,
    getSessionAccount,
    revokeSession,
    revokeAccount,
    deleteAccount,
    createInvite,
    listInvites,
    revokeInvite,
    close
  };
}
