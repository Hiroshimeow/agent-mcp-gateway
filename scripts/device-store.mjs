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
    deviceName: row.device_name || row.device_id,
    ownerAccountId: row.owner_account_id || null,
    accountLabel: row.account_label || null,
    hostname: row.hostname || null,
    platform: row.platform || null,
    arch: row.arch || null,
    pathStyle: row.path_style || null,
    publicKeyPem: row.public_key_pem,
    enrolledAt: row.enrolled_at,
    revokedAt: row.revoked_at,
    authorizationGeneration: Number(row.authorization_generation)
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
      revoked_at TEXT,
      authorization_generation INTEGER NOT NULL DEFAULT 1,
      device_name TEXT,
      owner_account_id TEXT,
      account_label TEXT,
      hostname TEXT,
      platform TEXT,
      arch TEXT,
      path_style TEXT
    );
  `);
  const columns = db.prepare(`PRAGMA table_info(devices)`).all();
  if (!columns.some(column => column.name === 'authorization_generation')) {
    db.exec('ALTER TABLE devices ADD COLUMN authorization_generation INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.some(column => column.name === 'device_name')) {
    db.exec('ALTER TABLE devices ADD COLUMN device_name TEXT');
  }
  if (!columns.some(column => column.name === 'owner_account_id')) {
    db.exec('ALTER TABLE devices ADD COLUMN owner_account_id TEXT');
  }
  if (!columns.some(column => column.name === 'account_label')) {
    db.exec('ALTER TABLE devices ADD COLUMN account_label TEXT');
  }
  for (const column of ['hostname', 'platform', 'arch', 'path_style']) {
    if (!columns.some(entry => entry.name === column)) db.exec(`ALTER TABLE devices ADD COLUMN ${column} TEXT`);
  }
  db.exec('PRAGMA busy_timeout = 5000');

  const getStatement = db.prepare(`
    SELECT device_id, device_name, owner_account_id, account_label, hostname, platform, arch, path_style, public_key_pem, enrolled_at, revoked_at, authorization_generation
    FROM devices
    WHERE device_id = ?
  `);
  const listStatement = db.prepare(`
    SELECT device_id, device_name, owner_account_id, account_label, hostname, platform, arch, path_style, public_key_pem, enrolled_at, revoked_at, authorization_generation
    FROM devices
    ORDER BY device_id
  `);
  const insertStatement = db.prepare(`
    INSERT INTO devices (device_id, device_name, owner_account_id, account_label, hostname, platform, arch, path_style, public_key_pem, enrolled_at, revoked_at, authorization_generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
  `);
  const rotateStatement = db.prepare(`
    UPDATE devices
    SET public_key_pem = ?, authorization_generation = authorization_generation + 1
    WHERE device_id = ? AND public_key_pem = ? AND revoked_at IS NULL
  `);
  const revokeStatement = db.prepare(`
    UPDATE devices
    SET revoked_at = ?, authorization_generation = authorization_generation + 1
    WHERE device_id = ? AND revoked_at IS NULL
  `);
  const metadataStatement = db.prepare(`
    UPDATE devices
    SET device_name = ?, account_label = ?, hostname = ?, platform = ?, arch = ?, path_style = ?
    WHERE device_id = ? AND revoked_at IS NULL
  `);
  const ownerStatement = db.prepare(`
    UPDATE devices
    SET owner_account_id = ?, account_label = ?, authorization_generation = authorization_generation + 1
    WHERE device_id = ? AND revoked_at IS NULL
  `);

  function get(deviceId) {
    return rowToDevice(getStatement.get(normalizeDeviceId(deviceId)));
  }

  function list() {
    return listStatement.all().map(rowToDevice);
  }

  function enroll({ deviceId, publicKeyPem, deviceName = null, ownerAccountId = null, accountLabel = null, hostname = null, platform = null, arch = null, pathStyle = null }) {
    const normalizedId = normalizeDeviceId(deviceId);
    const normalizedKey = normalizeEd25519PublicKey(publicKeyPem);
    const normalizedName = String(deviceName || '').trim().slice(0, 128) || normalizedId;
    const normalizedOwner = String(ownerAccountId || '').trim().slice(0, 64) || null;
    const normalizedAccount = String(accountLabel || '').trim().slice(0, 128) || null;
    const normalizedHostname = String(hostname || '').trim().slice(0, 128) || null;
    const normalizedPlatform = String(platform || '').trim().slice(0, 32) || null;
    const normalizedArch = String(arch || '').trim().slice(0, 32) || null;
    const normalizedPathStyle = ['windows', 'posix'].includes(String(pathStyle || '').trim()) ? String(pathStyle).trim() : null;
    if (getStatement.get(normalizedId)) throw new Error(`Device ${normalizedId} is already enrolled.`);
    const enrolledAt = now();
    insertStatement.run(normalizedId, normalizedName, normalizedOwner, normalizedAccount, normalizedHostname, normalizedPlatform, normalizedArch, normalizedPathStyle, normalizedKey, enrolledAt);
    return {
      deviceId: normalizedId,
      deviceName: normalizedName,
      ownerAccountId: normalizedOwner,
      accountLabel: normalizedAccount,
      hostname: normalizedHostname,
      platform: normalizedPlatform,
      arch: normalizedArch,
      pathStyle: normalizedPathStyle,
      publicKeyPem: normalizedKey,
      enrolledAt,
      revokedAt: null,
      authorizationGeneration: 1
    };
  }

  function rotate({ deviceId, expectedPublicKeyPem, publicKeyPem }) {
    const normalizedId = normalizeDeviceId(deviceId);
    const expectedKey = normalizeEd25519PublicKey(expectedPublicKeyPem);
    const normalizedKey = normalizeEd25519PublicKey(publicKeyPem);
    const result = rotateStatement.run(normalizedKey, normalizedId, expectedKey);
    if (Number(result.changes) === 0) {
      const existing = get(normalizedId);
      if (!existing) throw new Error(`Unknown device ${normalizedId}.`);
      if (existing.revokedAt) throw new Error(`Device ${normalizedId} is revoked.`);
      throw new Error(`Device ${normalizedId} current key changed; rotation was not applied.`);
    }
    return get(normalizedId);
  }

  function updateMetadata({ deviceId, deviceName, accountLabel, hostname, platform, arch, pathStyle }) {
    const normalizedId = normalizeDeviceId(deviceId);
    const current = get(normalizedId);
    if (!current) throw new Error(`Unknown device ${normalizedId}.`);
    if (current.revokedAt) throw new Error(`Device ${normalizedId} is revoked.`);
    const nextName = deviceName === undefined ? current.deviceName : (String(deviceName || '').trim().slice(0, 128) || normalizedId);
    const nextAccount = accountLabel === undefined ? current.accountLabel : (String(accountLabel || '').trim().slice(0, 128) || null);
    const nextHostname = hostname === undefined ? current.hostname : (String(hostname || '').trim().slice(0, 128) || null);
    const nextPlatform = platform === undefined ? current.platform : (String(platform || '').trim().slice(0, 32) || null);
    const nextArch = arch === undefined ? current.arch : (String(arch || '').trim().slice(0, 32) || null);
    const pathValue = String(pathStyle || '').trim();
    const nextPathStyle = pathStyle === undefined ? current.pathStyle : (['windows', 'posix'].includes(pathValue) ? pathValue : null);
    const result = metadataStatement.run(nextName, nextAccount, nextHostname, nextPlatform, nextArch, nextPathStyle, normalizedId);
    if (Number(result.changes) !== 1) throw new Error(`Device ${normalizedId} metadata update failed.`);
    return get(normalizedId);
  }

  function assignOwner({ deviceId, ownerAccountId, accountLabel = null }) {
    const normalizedId = normalizeDeviceId(deviceId);
    const current = get(normalizedId);
    if (!current) throw new Error(`Unknown device ${normalizedId}.`);
    if (current.revokedAt) throw new Error(`Device ${normalizedId} is revoked.`);
    const owner = String(ownerAccountId || '').trim().slice(0, 64) || null;
    const label = String(accountLabel || '').trim().slice(0, 128) || null;
    if (current.ownerAccountId === owner && current.accountLabel === label) return current;
    const result = ownerStatement.run(owner, label, normalizedId);
    if (Number(result.changes) !== 1) throw new Error(`Device ${normalizedId} owner update failed.`);
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

  function withCurrentAuthorization({ deviceId, publicKeyPem, authorizationGeneration }, callback) {
    const normalizedId = normalizeDeviceId(deviceId);
    const normalizedKey = normalizeEd25519PublicKey(publicKeyPem);
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      const row = getStatement.get(normalizedId);
      if (!row || row.revoked_at || row.public_key_pem !== normalizedKey || Number(row.authorization_generation) !== Number(authorizationGeneration)) {
        throw new Error(`Device ${normalizedId} authorization changed, was revoked, or is stale.`);
      }
      const result = callback(rowToDevice(row));
      db.exec('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) { try { db.exec('ROLLBACK'); } catch {} }
      throw error;
    }
  }

  function close() { db.close(); }

  return { get, list, enroll, rotate, updateMetadata, assignOwner, revoke, withCurrentAuthorization, close };
}
