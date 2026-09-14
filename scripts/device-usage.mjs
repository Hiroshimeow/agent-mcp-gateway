import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('Invalid device_id.');
  return deviceId;
}

function bytes(value) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0 || number > 64 * 1024 * 1024) throw new Error('Usage byte count must be a bounded non-negative integer.');
  return number;
}

function rowToUsage(row) {
  if (!row) {
    return {
      connections: 0,
      reconnects: 0,
      toolCallsStarted: 0,
      toolCallsSucceeded: 0,
      toolCallsFailed: 0,
      requestBytes: 0,
      responseBytes: 0,
      lastSeenAt: null,
      lastErrorCode: null
    };
  }
  return {
    connections: Number(row.connections),
    reconnects: Number(row.reconnects),
    toolCallsStarted: Number(row.tool_calls_started),
    toolCallsSucceeded: Number(row.tool_calls_succeeded),
    toolCallsFailed: Number(row.tool_calls_failed),
    requestBytes: Number(row.request_bytes),
    responseBytes: Number(row.response_bytes),
    lastSeenAt: Number(row.last_seen_at),
    lastErrorCode: row.last_error_code || null
  };
}

export function createDeviceUsageStore({ dbPath, now = () => Date.now() } = {}) {
  if (!dbPath) throw new Error('dbPath is required for device usage store.');
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS device_usage (
      device_id TEXT PRIMARY KEY,
      connections INTEGER NOT NULL DEFAULT 0,
      reconnects INTEGER NOT NULL DEFAULT 0,
      tool_calls_started INTEGER NOT NULL DEFAULT 0,
      tool_calls_succeeded INTEGER NOT NULL DEFAULT 0,
      tool_calls_failed INTEGER NOT NULL DEFAULT 0,
      request_bytes INTEGER NOT NULL DEFAULT 0,
      response_bytes INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL,
      last_error_code TEXT
    );
  `);

  const getStatement = db.prepare('SELECT * FROM device_usage WHERE device_id = ?');
  const connectionStatement = db.prepare(`
    INSERT INTO device_usage (device_id, connections, reconnects, last_seen_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      connections = connections + 1,
      reconnects = reconnects + excluded.reconnects,
      last_seen_at = excluded.last_seen_at
  `);
  const startedStatement = db.prepare(`
    INSERT INTO device_usage (device_id, tool_calls_started, request_bytes, last_seen_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      tool_calls_started = tool_calls_started + 1,
      request_bytes = request_bytes + excluded.request_bytes,
      last_seen_at = excluded.last_seen_at
  `);
  const succeededStatement = db.prepare(`
    INSERT INTO device_usage (device_id, tool_calls_succeeded, response_bytes, last_seen_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      tool_calls_succeeded = tool_calls_succeeded + 1,
      response_bytes = response_bytes + excluded.response_bytes,
      last_seen_at = excluded.last_seen_at,
      last_error_code = NULL
  `);
  const failedStatement = db.prepare(`
    INSERT INTO device_usage (device_id, tool_calls_failed, response_bytes, last_seen_at, last_error_code)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      tool_calls_failed = tool_calls_failed + 1,
      response_bytes = response_bytes + excluded.response_bytes,
      last_seen_at = excluded.last_seen_at,
      last_error_code = excluded.last_error_code
  `);
  const touchStatement = db.prepare(`
    INSERT INTO device_usage (device_id, last_seen_at)
    VALUES (?, ?)
    ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `);

  function get(deviceId) {
    return rowToUsage(getStatement.get(normalizeDeviceId(deviceId)));
  }

  function recordConnection(deviceId, { reconnect = false } = {}) {
    connectionStatement.run(normalizeDeviceId(deviceId), reconnect ? 1 : 0, Number(now()));
    return get(deviceId);
  }

  function recordToolStarted(deviceId, requestBytes = 0) {
    startedStatement.run(normalizeDeviceId(deviceId), bytes(requestBytes), Number(now()));
    return get(deviceId);
  }

  function recordToolSucceeded(deviceId, responseBytes = 0) {
    succeededStatement.run(normalizeDeviceId(deviceId), bytes(responseBytes), Number(now()));
    return get(deviceId);
  }

  function recordToolFailed(deviceId, responseBytes = 0, errorCode = 'REMOTE_DEVICE_ERROR') {
    const code = String(errorCode || 'REMOTE_DEVICE_ERROR').slice(0, 64);
    failedStatement.run(normalizeDeviceId(deviceId), bytes(responseBytes), Number(now()), code);
    return get(deviceId);
  }

  function touch(deviceId) {
    touchStatement.run(normalizeDeviceId(deviceId), Number(now()));
    return get(deviceId);
  }

  function close() {
    db.close();
  }

  return { get, recordConnection, recordToolStarted, recordToolSucceeded, recordToolFailed, touch, close };
}
