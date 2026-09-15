import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDeviceUsageStore } from '../scripts/device-usage.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcu-usage-events-'));
  const dbPath = path.join(dir, 'gateway.sqlite');
  let now = 1_700_000_000_000;
  const store = createDeviceUsageStore({ dbPath, now: () => now });
  return {
    dir,
    dbPath,
    store,
    advance(ms = 1) { now += ms; },
    close() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('SQLite usage store is authoritative for account-scoped tool, skill, catalog, and schema metadata', () => {
  const f = fixture();
  try {
    f.store.openActivitySession({ activitySessionId: 'activity-a', accountId: 'alice', clientId: 'chatgpt-a' });
    f.store.openActivitySession({ activitySessionId: 'activity-b', accountId: 'bob', clientId: 'chatgpt-b' });

    f.store.recordToolCall({
      timestamp: new Date(1_700_000_000_000).toISOString(),
      accountId: 'alice', activitySessionId: 'activity-a', deviceId: 'device-a',
      tool: 'shell_execute', durationMs: 12, success: true, errorCode: null,
      inputBytes: 123, outputBytes: 456, truncated: true, spill: true,
      callerCategory: 'oauth', upstream: null,
      payload: 'SECRET_COMMAND_BODY'
    });
    f.advance();
    f.store.recordToolCall({
      timestamp: new Date(1_700_000_000_001).toISOString(),
      accountId: 'alice', activitySessionId: 'activity-a', deviceId: null,
      tool: 'get_skill', skillName: 'mcp_builder', durationMs: 2, success: false,
      errorCode: 'UNKNOWN_SKILL', inputBytes: 20, outputBytes: 401,
      truncated: false, spill: false, callerCategory: 'oauth'
    });
    f.advance();
    f.store.recordToolCall({
      timestamp: new Date(1_700_000_000_002).toISOString(),
      accountId: 'bob', activitySessionId: 'activity-b', deviceId: 'device-b',
      tool: 'read_text_file', durationMs: 3, success: true,
      inputBytes: 10, outputBytes: 30, callerCategory: 'oauth'
    });

    f.store.recordCatalogList({
      accountId: 'alice', activitySessionId: 'activity-a', toolCount: 16, schemaBytes: 15297,
      estimatedTokens: 3825, estimationMethod: 'utf8_bytes_div_4_estimate'
    });
    f.store.setSchemaSnapshot({
      toolCount: 16, schemaBytes: 15297, estimatedTokens: 3825,
      estimationMethod: 'utf8_bytes_div_4_estimate'
    });

    const alice = f.store.getAccountUsage('alice');
    assert.deepEqual(alice.totals, {
      toolCalls: 2, succeeded: 1, failed: 1, inputBytes: 143, outputBytes: 857
    });
    assert.equal(alice.topTools[0].tool, 'get_skill');
    assert.equal(alice.topTools[0].calls, 1);
    assert.equal(alice.topTools[1].tool, 'shell_execute');
    assert.equal(alice.recentErrors[0].errorCode, 'UNKNOWN_SKILL');
    assert.equal(alice.skillLoads[0].skillName, 'mcp_builder');
    assert.equal(alice.skillLoads[0].loads, 1);
    assert.equal(alice.skillLoads[0].failures, 1);
    assert.equal(alice.skillLoads[0].outputBytes, 401);
    assert.equal(alice.skillLoads[0].estimatedTokens, 101);
    assert.equal(alice.skillLoads[0].estimationMethod, 'utf8_bytes_div_4_estimate');
    assert.equal(alice.catalog.listCalls, 1);
    assert.equal(alice.catalog.lastToolCount, 16);
    assert.equal(alice.catalog.lastSchemaBytes, 15297);
    assert.equal(alice.schema.toolCount, 16);
    assert.equal(alice.schema.schemaBytes, 15297);
    assert.equal(alice.schema.estimatedTokens, 3825);
    assert.equal(alice.schema.estimationMethod, 'utf8_bytes_div_4_estimate');
    assert.equal(JSON.stringify(alice).includes('device-b'), false);

    const bob = f.store.getAccountUsage('bob');
    assert.equal(bob.totals.toolCalls, 1);
    assert.equal(JSON.stringify(bob).includes('shell_execute'), false);

    const dbText = fs.readFileSync(f.dbPath).toString('utf8');
    assert.doesNotMatch(dbText, /SECRET_COMMAND_BODY/);
  } finally { f.close(); }
});

test('activity sessions are account-scoped, refreshable, endable, and fail closed after end', () => {
  const f = fixture();
  try {
    const opened = f.store.openActivitySession({ activitySessionId: 'activity-a', accountId: 'alice', clientId: 'chatgpt-a' });
    assert.equal(opened.activitySessionId, 'activity-a');
    assert.equal(opened.accountId, 'alice');
    assert.equal(opened.endedAt, null);

    f.advance(50);
    const touched = f.store.touchActivitySession({ activitySessionId: 'activity-a', accountId: 'alice' });
    assert.equal(touched.lastSeenAt, 1_700_000_000_050);
    assert.throws(
      () => f.store.touchActivitySession({ activitySessionId: 'activity-a', accountId: 'bob' }),
      /not found|owned|account/i
    );

    const ended = f.store.endActivitySession({ activitySessionId: 'activity-a', accountId: 'alice' });
    assert.ok(ended.endedAt);
    assert.throws(
      () => f.store.touchActivitySession({ activitySessionId: 'activity-a', accountId: 'alice' }),
      /ended|inactive/i
    );
    assert.equal(f.store.listActivitySessions('bob').length, 0);
    assert.equal(f.store.listActivitySessions('alice').length, 1);
  } finally { f.close(); }
});

test('device status changes are stored without payloads and scoped by owner account', () => {
  const f = fixture();
  try {
    f.store.recordDeviceStatus('device-a', { accountId: 'alice', status: 'online', connectionEpoch: 3, agentVersion: '1.2.3' });
    f.advance();
    f.store.recordDeviceStatus('device-a', { accountId: 'alice', status: 'offline', connectionEpoch: 3, agentVersion: '1.2.3' });
    f.store.recordDeviceStatus('device-b', { accountId: 'bob', status: 'online', connectionEpoch: 1, agentVersion: '2.0.0' });

    const alice = f.store.getAccountUsage('alice');
    assert.equal(alice.deviceStatusEvents.length, 2);
    assert.deepEqual(alice.deviceStatusEvents.map(event => event.status), ['offline', 'online']);
    assert.equal(JSON.stringify(alice).includes('device-b'), false);
  } finally { f.close(); }
});
