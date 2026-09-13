import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('Invalid device_id.');
  return deviceId;
}

export function normalizeEd25519PublicKey(value) {
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Device public key must be Ed25519.');
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function rowToDevice(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    publicKeyPem: row.public_key_pem,
    enrolledAt: row.enrolled_at,
    revokedAt: row.revoked_at
  };
}

export function createDeviceStore({ dbPath, now = () => new Date().toISOString() }) {
  if (!dbPath) throw new Error('dbPath is required for device store.');
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(path.resolve(dbPath));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      public_key_pem TEXT NOT NULL,
      enrolled_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);

  const getStatement = db.prepare(`
    SELECT device_id, public_key_pem, enrolled_at, revoked_at
    FROM devices
    WHERE device_id = ?
  `);
  const listStatement = db.prepare(`
    SELECT device_id, public_key_pem, enrolled_at, revoked_at
    FROM devices
    ORDER BY device_id
  `);
  const insertStatement = db.prepare(`
    INSERT INTO devices (device_id, public_key_pem, enrolled_at, revoked_at)
    VALUES (?, ?, ?, NULL)
  `);
  const rotateStatement = db.prepare(`
    UPDATE devices
    SET public_key_pem = ?
    WHERE device_id = ? AND revoked_at IS NULL
  `);
  const revokeStatement = db.prepare(`
    UPDATE devices
    SET revoked_at = ?
    WHERE device_id = ? AND revoked_at IS NULL
  `);

  function get(deviceId) {
    return rowToDevice(getStatement.get(normalizeDeviceId(deviceId)));
  }

  function list() {
    return listStatement.all().map(rowToDevice);
  }

  function enroll({ deviceId, publicKeyPem }) {
    const normalizedId = normalizeDeviceId(deviceId);
    const normalizedKey = normalizeEd25519PublicKey(publicKeyPem);
    if (getStatement.get(normalizedId)) throw new Error(`Device ${normalizedId} is already enrolled.`);
    insertStatement.run(normalizedId, normalizedKey, now());
    return get(normalizedId);
  }

  function rotate({ deviceId, publicKeyPem }) {
    const normalizedId = normalizeDeviceId(deviceId);
    const normalizedKey = normalizeEd25519PublicKey(publicKeyPem);
    const existing = get(normalizedId);
    if (!existing) throw new Error(`Unknown device ${normalizedId}.`);
    if (existing.revokedAt) throw new Error(`Device ${normalizedId} is revoked.`);
    rotateStatement.run(normalizedKey, normalizedId);
    return get(normalizedId);
  }

  function revoke(deviceId) {
    const normalizedId = normalizeDeviceId(deviceId);
    const result = revokeStatement.run(now(), normalizedId);
    if (Number(result.changes) === 0) {
      const existing = get(normalizedId);
      if (!existing) throw new Error(`Unknown device ${normalizedId}.`);
      return existing;
    }
    return get(normalizedId);
  }

  function close() {
    db.close();
  }

  return { get, list, enroll, rotate, revoke, close };
}
