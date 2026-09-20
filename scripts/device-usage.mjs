import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_ESTIMATION_METHOD = 'utf8_bytes_div_4_estimate';

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('Invalid device_id.');
  return deviceId;
}

function boundedText(value, max = 128, { required = false } = {}) {
  const text = String(value || '').trim();
  if (required && !text) throw new Error('Required usage identifier is missing.');
  return text ? text.slice(0, max) : null;
}

function bytes(value) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0 || number > 64 * 1024 * 1024) throw new Error('Usage byte count must be a bounded non-negative integer.');
  return number;
}

function duration(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  if (number > 24 * 60 * 60 * 1000) throw new Error('Usage duration is outside the bounded range.');
  return number;
}

function timestampMs(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (value) {
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number(fallback());
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

function rowToActivity(row) {
  if (!row) return null;
  return {
    activitySessionId: row.activity_session_id,
    accountId: row.account_id,
    clientId: row.client_id || null,
    displayName: row.display_name || null,
    startedAt: Number(row.started_at),
    lastSeenAt: Number(row.last_seen_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at)
  };
}

function rowToSchema(row) {
  if (!row) return { toolCount: 0, schemaBytes: 0, estimatedTokens: 0, estimationMethod: TOKEN_ESTIMATION_METHOD, updatedAt: null };
  return {
    toolCount: Number(row.tool_count),
    schemaBytes: Number(row.schema_bytes),
    estimatedTokens: Number(row.estimated_tokens),
    estimationMethod: row.estimation_method,
    updatedAt: Number(row.updated_at)
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
    CREATE TABLE IF NOT EXISTS tool_call_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_at INTEGER NOT NULL,
      account_id TEXT,
      activity_session_id TEXT,
      device_id TEXT,
      tool TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','error')),
      error_code TEXT,
      input_bytes INTEGER NOT NULL,
      output_bytes INTEGER NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      spill INTEGER NOT NULL DEFAULT 0,
      caller_category TEXT,
      upstream TEXT
    );
    CREATE INDEX IF NOT EXISTS tool_call_events_account_time_idx ON tool_call_events(account_id, event_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS tool_call_events_activity_idx ON tool_call_events(activity_session_id, event_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS tool_call_events_account_tool_idx ON tool_call_events(account_id, tool);
    CREATE TABLE IF NOT EXISTS skill_load_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_at INTEGER NOT NULL,
      account_id TEXT,
      activity_session_id TEXT,
      skill_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','error')),
      error_code TEXT,
      output_bytes INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      estimation_method TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skill_load_events_account_time_idx ON skill_load_events(account_id, event_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS activity_sessions (
      activity_session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      client_id TEXT,
      display_name TEXT,
      started_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS activity_sessions_account_idx ON activity_sessions(account_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS catalog_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_at INTEGER NOT NULL,
      account_id TEXT,
      activity_session_id TEXT,
      tool_count INTEGER NOT NULL,
      schema_bytes INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      estimation_method TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS catalog_events_account_time_idx ON catalog_events(account_id, event_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS gateway_schema_snapshot (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      tool_count INTEGER NOT NULL,
      schema_bytes INTEGER NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      estimation_method TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_at INTEGER NOT NULL,
      account_id TEXT,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('online','offline','revoked')),
      connection_epoch INTEGER NOT NULL DEFAULT 0,
      agent_version TEXT
    );
    CREATE INDEX IF NOT EXISTS device_status_events_account_time_idx ON device_status_events(account_id, event_at DESC, id DESC);
  `);
  const activityColumns = db.prepare('PRAGMA table_info(activity_sessions)').all();
  if (!activityColumns.some(column => column.name === 'display_name')) {
    db.exec('ALTER TABLE activity_sessions ADD COLUMN display_name TEXT');
  }

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

  const insertToolCall = db.prepare(`
    INSERT INTO tool_call_events (
      event_at, account_id, activity_session_id, device_id, tool, duration_ms, status, error_code,
      input_bytes, output_bytes, truncated, spill, caller_category, upstream
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSkillLoad = db.prepare(`
    INSERT INTO skill_load_events (
      event_at, account_id, activity_session_id, skill_name, status, error_code,
      output_bytes, estimated_tokens, estimation_method
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertActivity = db.prepare(`
    INSERT INTO activity_sessions (activity_session_id, account_id, client_id, started_at, last_seen_at, ended_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `);
  const getActivity = db.prepare('SELECT * FROM activity_sessions WHERE activity_session_id = ?');
  const touchActivity = db.prepare(`
    UPDATE activity_sessions SET last_seen_at = ?
    WHERE activity_session_id = ? AND account_id = ? AND ended_at IS NULL
  `);
  const endActivity = db.prepare(`
    UPDATE activity_sessions SET ended_at = ?, last_seen_at = ?
    WHERE activity_session_id = ? AND account_id = ? AND ended_at IS NULL
  `);
  const renameActivity = db.prepare(`
    UPDATE activity_sessions SET display_name = ?
    WHERE activity_session_id = ? AND account_id = ?
  `);
  const listActivities = db.prepare(`
    SELECT * FROM activity_sessions WHERE account_id = ?
    ORDER BY started_at DESC, activity_session_id DESC LIMIT ?
  `);
  const insertCatalog = db.prepare(`
    INSERT INTO catalog_events (event_at, account_id, activity_session_id, tool_count, schema_bytes, estimated_tokens, estimation_method)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const setSchema = db.prepare(`
    INSERT INTO gateway_schema_snapshot (singleton, tool_count, schema_bytes, estimated_tokens, estimation_method, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      tool_count = excluded.tool_count,
      schema_bytes = excluded.schema_bytes,
      estimated_tokens = excluded.estimated_tokens,
      estimation_method = excluded.estimation_method,
      updated_at = excluded.updated_at
  `);
  const getSchema = db.prepare('SELECT * FROM gateway_schema_snapshot WHERE singleton = 1');
  const insertDeviceStatus = db.prepare(`
    INSERT INTO device_status_events (event_at, account_id, device_id, status, connection_epoch, agent_version)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const totalsForAccount = db.prepare(`
    SELECT COUNT(*) AS tool_calls,
      COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) AS succeeded,
      COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS failed,
      COALESCE(SUM(input_bytes),0) AS input_bytes,
      COALESCE(SUM(output_bytes),0) AS output_bytes
    FROM tool_call_events WHERE account_id = ?
  `);
  const topToolsForAccount = db.prepare(`
    SELECT tool, COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS failures,
      COALESCE(SUM(input_bytes),0) AS input_bytes,
      COALESCE(SUM(output_bytes),0) AS output_bytes
    FROM tool_call_events WHERE account_id = ?
    GROUP BY tool ORDER BY calls DESC, tool ASC LIMIT 10
  `);
  const deviceUsageForAccount = db.prepare(`
    SELECT device_id, COUNT(*) AS tool_calls,
      MAX(event_at) AS last_seen_at,
      COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) AS succeeded,
      COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS failed,
      COALESCE(SUM(input_bytes),0) AS input_bytes,
      COALESCE(SUM(output_bytes),0) AS output_bytes
    FROM tool_call_events
    WHERE account_id = ? AND device_id IS NOT NULL
    GROUP BY device_id ORDER BY device_id ASC
  `);
  const deviceToolUsageForAccount = db.prepare(`
    SELECT tool, COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS failures,
      COALESCE(SUM(input_bytes),0) AS input_bytes,
      COALESCE(SUM(output_bytes),0) AS output_bytes
    FROM tool_call_events
    WHERE account_id = ? AND device_id = ?
    GROUP BY tool ORDER BY calls DESC, tool ASC
  `);
  const recentErrorsForAccount = db.prepare(`
    SELECT event_at, device_id, tool, error_code
    FROM tool_call_events WHERE account_id = ? AND status='error'
    ORDER BY event_at DESC, id DESC LIMIT 20
  `);
  const activityDevicesForAccountSession = db.prepare(`
    SELECT device_id
    FROM tool_call_events
    WHERE account_id = ? AND activity_session_id = ? AND device_id IS NOT NULL
    GROUP BY device_id
    ORDER BY MAX(event_at) DESC, device_id ASC
    LIMIT ?
  `);
  const recentDeviceCallsForAccount = db.prepare(`
    SELECT e.event_at, e.activity_session_id, e.tool, e.duration_ms, e.status, e.error_code,
      e.input_bytes, e.output_bytes, a.client_id
    FROM tool_call_events e
    LEFT JOIN activity_sessions a
      ON a.activity_session_id = e.activity_session_id AND a.account_id = e.account_id
    WHERE e.account_id = ? AND e.device_id = ?
    ORDER BY e.event_at DESC, e.id DESC
    LIMIT ?
  `);
  const skillLoadsForAccount = db.prepare(`
    SELECT skill_name, COUNT(*) AS loads,
      COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS failures,
      COALESCE(SUM(output_bytes),0) AS output_bytes,
      COALESCE(SUM(estimated_tokens),0) AS estimated_tokens,
      MAX(estimation_method) AS estimation_method
    FROM skill_load_events WHERE account_id = ?
    GROUP BY skill_name ORDER BY loads DESC, skill_name ASC LIMIT 20
  `);
  const catalogCountForAccount = db.prepare('SELECT COUNT(*) AS calls FROM catalog_events WHERE account_id = ?');
  const latestCatalogForAccount = db.prepare(`
    SELECT tool_count, schema_bytes, estimated_tokens, estimation_method, event_at
    FROM catalog_events WHERE account_id = ? ORDER BY event_at DESC, id DESC LIMIT 1
  `);
  const deviceStatusForAccount = db.prepare(`
    SELECT event_at, device_id, status, connection_epoch, agent_version
    FROM device_status_events WHERE account_id = ? ORDER BY event_at DESC, id DESC LIMIT 50
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

  function recordToolCall(metric = {}) {
    const eventAt = timestampMs(metric.timestamp, now);
    const accountId = boundedText(metric.accountId, 128);
    const activitySessionId = boundedText(metric.activitySessionId, 128);
    const deviceId = metric.deviceId ? normalizeDeviceId(metric.deviceId) : null;
    const tool = boundedText(metric.tool, 128, { required: true });
    const success = metric.success === true;
    const errorCode = success ? null : boundedText(metric.errorCode || metric.error || 'TOOL_ERROR', 64);
    const inputBytes = bytes(metric.inputBytes);
    const outputBytes = bytes(metric.outputBytes);
    insertToolCall.run(
      eventAt, accountId, activitySessionId, deviceId, tool, duration(metric.durationMs), success ? 'success' : 'error', errorCode,
      inputBytes, outputBytes, metric.truncated ? 1 : 0, metric.spill ? 1 : 0,
      boundedText(metric.callerCategory, 32), boundedText(metric.upstream, 128)
    );
    const skillName = tool === 'get_skill' ? boundedText(metric.skillName, 128) : null;
    if (skillName) {
      insertSkillLoad.run(
        eventAt, accountId, activitySessionId, skillName, success ? 'success' : 'error', errorCode,
        outputBytes, Math.ceil(outputBytes / 4), TOKEN_ESTIMATION_METHOD
      );
    }
  }

  function openActivitySession({ activitySessionId, accountId, clientId = null } = {}) {
    const id = boundedText(activitySessionId, 128, { required: true });
    const owner = boundedText(accountId, 128, { required: true });
    const client = boundedText(clientId, 256);
    const current = getActivity.get(id);
    if (current) {
      if (current.account_id !== owner) throw new Error('Activity session is owned by another account.');
      if (current.ended_at !== null) throw new Error('Activity session has ended.');
      return rowToActivity(current);
    }
    const time = Number(now());
    insertActivity.run(id, owner, client, time, time);
    return rowToActivity(getActivity.get(id));
  }

  function touchActivitySession({ activitySessionId, accountId } = {}) {
    const id = boundedText(activitySessionId, 128, { required: true });
    const owner = boundedText(accountId, 128, { required: true });
    const current = getActivity.get(id);
    if (!current || current.account_id !== owner) throw new Error('Activity session not found for this account.');
    if (current.ended_at !== null) throw new Error('Activity session has ended and is inactive.');
    touchActivity.run(Number(now()), id, owner);
    return rowToActivity(getActivity.get(id));
  }

  function endActivitySession({ activitySessionId, accountId } = {}) {
    const id = boundedText(activitySessionId, 128, { required: true });
    const owner = boundedText(accountId, 128, { required: true });
    const current = getActivity.get(id);
    if (!current || current.account_id !== owner) throw new Error('Activity session not found for this account.');
    if (current.ended_at === null) {
      const time = Number(now());
      endActivity.run(time, time, id, owner);
    }
    return rowToActivity(getActivity.get(id));
  }

  function renameActivitySession({ activitySessionId, accountId, displayName } = {}) {
    const id = boundedText(activitySessionId, 128, { required: true });
    const owner = boundedText(accountId, 128, { required: true });
    const current = getActivity.get(id);
    if (!current || current.account_id !== owner) throw new Error('Activity session not found for this account.');
    const name = boundedText(displayName, 128, { required: true });
    renameActivity.run(name, id, owner);
    return rowToActivity(getActivity.get(id));
  }

  function listActivitySessions(accountId, { limit = 50 } = {}) {
    const owner = boundedText(accountId, 128, { required: true });
    const boundedLimit = Math.max(1, Math.min(200, Number.isInteger(Number(limit)) ? Number(limit) : 50));
    return listActivities.all(owner, boundedLimit).map(rowToActivity);
  }

  function recordCatalogList({ accountId = null, activitySessionId = null, toolCount = 0, schemaBytes = 0, estimatedTokens, estimationMethod = TOKEN_ESTIMATION_METHOD } = {}) {
    const count = Math.max(0, Math.floor(Number(toolCount) || 0));
    const size = bytes(schemaBytes);
    const estimate = estimatedTokens === undefined ? Math.ceil(size / 4) : Math.max(0, Math.floor(Number(estimatedTokens) || 0));
    insertCatalog.run(
      Number(now()), boundedText(accountId, 128), boundedText(activitySessionId, 128), count, size, estimate,
      boundedText(estimationMethod, 64, { required: true })
    );
  }

  function setSchemaSnapshot({ toolCount = 0, schemaBytes = 0, estimatedTokens, estimationMethod = TOKEN_ESTIMATION_METHOD } = {}) {
    const count = Math.max(0, Math.floor(Number(toolCount) || 0));
    const size = bytes(schemaBytes);
    const estimate = estimatedTokens === undefined ? Math.ceil(size / 4) : Math.max(0, Math.floor(Number(estimatedTokens) || 0));
    const method = boundedText(estimationMethod, 64, { required: true });
    setSchema.run(count, size, estimate, method, Number(now()));
    return getSchemaSnapshot();
  }

  function getSchemaSnapshot() {
    return rowToSchema(getSchema.get());
  }

  function recordDeviceStatus(deviceId, { accountId = null, status, connectionEpoch = 0, agentVersion = null } = {}) {
    const state = String(status || '').trim();
    if (!['online', 'offline', 'revoked'].includes(state)) throw new Error('Invalid device status event.');
    const epoch = Math.max(0, Math.floor(Number(connectionEpoch) || 0));
    insertDeviceStatus.run(
      Number(now()), boundedText(accountId, 128), normalizeDeviceId(deviceId), state, epoch, boundedText(agentVersion, 64)
    );
  }

  function getDeviceUsageForAccount(accountId) {
    const owner = boundedText(accountId, 128, { required: true });
    return deviceUsageForAccount.all(owner).map(row => {
      const inputBytes = Number(row.input_bytes);
      const outputBytes = Number(row.output_bytes);
      return {
        deviceId: row.device_id,
        lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
        toolCalls: Number(row.tool_calls),
        succeeded: Number(row.succeeded),
        failed: Number(row.failed),
        inputBytes,
        outputBytes,
        estimatedIoTokens: Math.ceil((inputBytes + outputBytes) / 4),
        estimationMethod: TOKEN_ESTIMATION_METHOD
      };
    });
  }

  function getDeviceToolUsage(accountId, deviceId) {
    const owner = boundedText(accountId, 128, { required: true });
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    return deviceToolUsageForAccount.all(owner, normalizedDeviceId).map(row => ({
      tool: row.tool,
      calls: Number(row.calls),
      failures: Number(row.failures),
      inputBytes: Number(row.input_bytes),
      outputBytes: Number(row.output_bytes)
    }));
  }

  function getActivitySessionDeviceIds(accountId, activitySessionId, { limit = 20 } = {}) {
    const owner = boundedText(accountId, 128, { required: true });
    const sessionId = boundedText(activitySessionId, 128, { required: true });
    const boundedLimit = Math.max(1, Math.min(20, Number.isInteger(Number(limit)) ? Number(limit) : 20));
    return activityDevicesForAccountSession.all(owner, sessionId, boundedLimit).map(row => row.device_id);
  }

  function getDeviceRecentToolCalls(accountId, deviceId, { limit = 20 } = {}) {
    const owner = boundedText(accountId, 128, { required: true });
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const boundedLimit = Math.max(1, Math.min(20, Number.isInteger(Number(limit)) ? Number(limit) : 20));
    return recentDeviceCallsForAccount.all(owner, normalizedDeviceId, boundedLimit).map(row => ({
      eventAt: Number(row.event_at),
      activitySessionId: row.activity_session_id || null,
      clientId: row.client_id || null,
      tool: row.tool,
      success: row.status === 'success',
      durationMs: Number(row.duration_ms),
      inputBytes: Number(row.input_bytes),
      outputBytes: Number(row.output_bytes),
      errorCode: row.error_code || null
    }));
  }

  function getAccountUsage(accountId) {
    const owner = boundedText(accountId, 128, { required: true });
    const totalsRow = totalsForAccount.get(owner);
    const latestCatalog = latestCatalogForAccount.get(owner);
    return {
      totals: {
        toolCalls: Number(totalsRow.tool_calls),
        succeeded: Number(totalsRow.succeeded),
        failed: Number(totalsRow.failed),
        inputBytes: Number(totalsRow.input_bytes),
        outputBytes: Number(totalsRow.output_bytes)
      },
      topTools: topToolsForAccount.all(owner).map(row => ({
        tool: row.tool, calls: Number(row.calls), failures: Number(row.failures),
        inputBytes: Number(row.input_bytes), outputBytes: Number(row.output_bytes)
      })),
      recentErrors: recentErrorsForAccount.all(owner).map(row => ({
        eventAt: Number(row.event_at), deviceId: row.device_id || null, tool: row.tool, errorCode: row.error_code || null
      })),
      skillLoads: skillLoadsForAccount.all(owner).map(row => ({
        skillName: row.skill_name, loads: Number(row.loads), failures: Number(row.failures),
        outputBytes: Number(row.output_bytes), estimatedTokens: Number(row.estimated_tokens), estimationMethod: row.estimation_method
      })),
      catalog: {
        listCalls: Number(catalogCountForAccount.get(owner).calls),
        lastToolCount: latestCatalog ? Number(latestCatalog.tool_count) : null,
        lastSchemaBytes: latestCatalog ? Number(latestCatalog.schema_bytes) : null,
        estimatedTokens: latestCatalog ? Number(latestCatalog.estimated_tokens) : null,
        estimationMethod: latestCatalog?.estimation_method || null,
        lastSeenAt: latestCatalog ? Number(latestCatalog.event_at) : null
      },
      schema: getSchemaSnapshot(),
      activitySessions: listActivitySessions(owner),
      deviceStatusEvents: deviceStatusForAccount.all(owner).map(row => ({
        eventAt: Number(row.event_at), deviceId: row.device_id, status: row.status,
        connectionEpoch: Number(row.connection_epoch), agentVersion: row.agent_version || null
      }))
    };
  }

  function close() {
    db.close();
  }

  return {
    get,
    recordConnection,
    recordToolStarted,
    recordToolSucceeded,
    recordToolFailed,
    touch,
    recordToolCall,
    openActivitySession,
    touchActivitySession,
    endActivitySession,
    renameActivitySession,
    listActivitySessions,
    recordCatalogList,
    setSchemaSnapshot,
    getSchemaSnapshot,
    recordDeviceStatus,
    getDeviceUsageForAccount,
    getDeviceToolUsage,
    getActivitySessionDeviceIds,
    getDeviceRecentToolCalls,
    getAccountUsage,
    close
  };
}
