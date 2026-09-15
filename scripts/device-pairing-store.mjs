import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { normalizeEd25519PublicKey } from './device-store.mjs';

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function requiredText(value, label, max = 512) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new Error(`${label} is required and must be at most ${max} characters.`);
  return text;
}

function normalizeDeviceId(value) {
  const deviceId = requiredText(value, 'device_id', 64);
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('Invalid device_id.');
  return deviceId;
}

function normalizeCodeChallenge(value) {
  const challenge = requiredText(value, 'code_challenge', 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new Error('Invalid PKCE code_challenge.');
  return challenge;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64url');
}

function publicKeyFingerprint(publicKeyPem) {
  return sha256(normalizeEd25519PublicKey(publicKeyPem));
}

function generateUserCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) code += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function statusFromRow(row, nowMs) {
  if (!row) return null;
  const expired = Number(row.expires_at) < nowMs;
  let status = 'pending';
  if (expired) status = 'expired';
  else if (row.grant_consumed_at) status = 'consumed';
  else if (row.approved_at) status = 'approved';
  return {
    userCode: row.user_code,
    deviceId: row.device_id,
    deviceName: row.device_name,
    status,
    expiresAt: Number(row.expires_at),
    approvedAt: row.approved_at ? Number(row.approved_at) : null,
    accountId: row.owner_account_id || null,
    accountLabel: row.account_label || null
  };
}

export function createDevicePairingStore({
  dbPath,
  now = () => Date.now(),
  ttlMs = 10 * 60_000,
  pollIntervalSec = 2
} = {}) {
  if (!dbPath) throw new Error('dbPath is required for device pairing store.');
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) throw new Error('Pairing ttlMs must be between 60000 and 3600000.');
  if (!Number.isInteger(pollIntervalSec) || pollIntervalSec < 1 || pollIntervalSec > 30) throw new Error('Pairing pollIntervalSec must be between 1 and 30.');

  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS device_pairings (
      device_code TEXT PRIMARY KEY,
      user_code TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      public_key_fingerprint TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      approved_at INTEGER,
      owner_account_id TEXT,
      account_label TEXT,
      grant_hash TEXT UNIQUE,
      grant_issued_at INTEGER,
      grant_consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS device_pairings_user_code_idx ON device_pairings(user_code);
    CREATE INDEX IF NOT EXISTS device_pairings_grant_hash_idx ON device_pairings(grant_hash);
  `);

  const columns = db.prepare('PRAGMA table_info(device_pairings)').all();
  if (!columns.some(column => column.name === 'owner_account_id')) {
    db.exec('ALTER TABLE device_pairings ADD COLUMN owner_account_id TEXT');
  }

  const getByUserCodeStatement = db.prepare('SELECT * FROM device_pairings WHERE user_code = ?');
  const getByDeviceCodeStatement = db.prepare('SELECT * FROM device_pairings WHERE device_code = ?');
  const getByGrantHashStatement = db.prepare('SELECT * FROM device_pairings WHERE grant_hash = ?');
  const insertStatement = db.prepare(`
    INSERT INTO device_pairings (
      device_code, user_code, client_id, device_id, device_name,
      public_key_fingerprint, code_challenge, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const approveStatement = db.prepare(`
    UPDATE device_pairings
    SET approved_at = ?, owner_account_id = ?, account_label = ?
    WHERE user_code = ? AND approved_at IS NULL
  `);
  const grantStatement = db.prepare(`
    UPDATE device_pairings
    SET grant_hash = ?, grant_issued_at = ?
    WHERE device_code = ? AND grant_hash IS NULL
  `);
  const consumeStatement = db.prepare(`
    UPDATE device_pairings
    SET grant_consumed_at = ?
    WHERE grant_hash = ? AND grant_consumed_at IS NULL
  `);

  function start({ clientId, deviceId, deviceName, publicKeyPem, codeChallenge }) {
    const normalizedClientId = requiredText(clientId, 'client_id', 128);
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const normalizedDeviceName = requiredText(deviceName, 'device_name', 128);
    const fingerprint = publicKeyFingerprint(publicKeyPem);
    const normalizedChallenge = normalizeCodeChallenge(codeChallenge);
    const createdAt = Number(now());
    const expiresAt = createdAt + ttlMs;
    const deviceCode = crypto.randomBytes(32).toString('base64url');

    let userCode;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateUserCode();
      try {
        insertStatement.run(
          deviceCode,
          candidate,
          normalizedClientId,
          normalizedDeviceId,
          normalizedDeviceName,
          fingerprint,
          normalizedChallenge,
          createdAt,
          expiresAt
        );
        userCode = candidate;
        break;
      } catch (error) {
        if (!String(error?.message || '').toLowerCase().includes('unique')) throw error;
      }
    }
    if (!userCode) throw new Error('Unable to allocate a unique device pairing code.');

    return {
      deviceCode,
      userCode,
      expiresIn: Math.floor(ttlMs / 1000),
      interval: pollIntervalSec
    };
  }

  function getStatusByUserCode(userCode) {
    const normalized = requiredText(userCode, 'user_code', 16).toUpperCase();
    const row = getByUserCodeStatement.get(normalized);
    if (!row) throw new Error('Unknown pairing code.');
    return statusFromRow(row, Number(now()));
  }

  function approve({ userCode, accountId, accountLabel }) {
    const normalized = requiredText(userCode, 'user_code', 16).toUpperCase();
    const owner = requiredText(accountId, 'account_id', 64);
    const label = requiredText(accountLabel, 'account_label', 128);
    const row = getByUserCodeStatement.get(normalized);
    if (!row) throw new Error('Unknown pairing code.');
    const nowMs = Number(now());
    if (Number(row.expires_at) < nowMs) throw new Error('Pairing code expired.');
    if (row.grant_consumed_at) throw new Error('Pairing code was already consumed.');
    if (!row.approved_at) approveStatement.run(nowMs, owner, label, normalized);
    const updated = getByUserCodeStatement.get(normalized);
    return statusFromRow(updated, nowMs);
  }

  function poll({ deviceCode, clientId, codeVerifier }) {
    const normalizedDeviceCode = requiredText(deviceCode, 'device_code', 128);
    const normalizedClientId = requiredText(clientId, 'client_id', 128);
    const verifier = requiredText(codeVerifier, 'code_verifier', 256);
    const row = getByDeviceCodeStatement.get(normalizedDeviceCode);
    if (!row) throw new Error('Unknown device code.');
    const nowMs = Number(now());
    if (Number(row.expires_at) < nowMs) throw new Error('Device pairing code expired.');
    if (row.client_id !== normalizedClientId) throw new Error('Device code was not issued to this client.');
    if (sha256(verifier) !== row.code_challenge) throw new Error('PKCE verifier does not match device pairing request.');
    if (!row.approved_at) return { status: 'authorization_pending' };
    if (row.grant_consumed_at) throw new Error('Pairing enrollment grant was already consumed.');
    if (row.grant_hash) throw new Error('Pairing enrollment grant was already issued.');

    const enrollmentGrant = crypto.randomBytes(32).toString('base64url');
    const grantHash = sha256(enrollmentGrant);
    const changed = grantStatement.run(grantHash, nowMs, normalizedDeviceCode);
    if (Number(changed.changes) !== 1) throw new Error('Pairing enrollment grant was already issued.');
    return {
      status: 'approved',
      enrollmentGrant,
      deviceId: row.device_id,
      account: { connected: true, account_id: row.owner_account_id, label: row.account_label }
    };
  }

  function consumeGrant({ enrollmentGrant, deviceId, publicKeyPem }) {
    const grant = requiredText(enrollmentGrant, 'enrollment_grant', 256);
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const fingerprint = publicKeyFingerprint(publicKeyPem);
    const grantHash = sha256(grant);
    const row = getByGrantHashStatement.get(grantHash);
    if (!row) throw new Error('Invalid enrollment grant.');
    const nowMs = Number(now());
    if (Number(row.expires_at) < nowMs) throw new Error('Enrollment grant expired.');
    if (row.grant_consumed_at) throw new Error('Enrollment grant was already consumed.');
    if (row.device_id !== normalizedDeviceId) throw new Error('Enrollment grant is bound to a different device.');
    if (row.public_key_fingerprint !== fingerprint) throw new Error('Enrollment grant is bound to a different device key.');
    const changed = consumeStatement.run(nowMs, grantHash);
    if (Number(changed.changes) !== 1) throw new Error('Enrollment grant was already consumed.');
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      account: { connected: true, account_id: row.owner_account_id, label: row.account_label }
    };
  }

  function close() {
    db.close();
  }

  return { start, getStatusByUserCode, approve, poll, consumeGrant, close };
}
