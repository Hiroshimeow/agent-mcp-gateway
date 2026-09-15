import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const wrapper = fs.readFileSync(new URL('../scripts/authenticated-mcp-wrapper.mjs', import.meta.url), 'utf8');
const deviceAdmin = fs.readFileSync(new URL('../scripts/device-admin.mjs', import.meta.url), 'utf8');
const launcher = fs.readFileSync(new URL('../scripts/start-mcp-live.ps1', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('runtime uses gateway.sqlite as the single authoritative state database', () => {
  assert.match(wrapper, /gatewayDbPath/);
  assert.doesNotMatch(wrapper, /devices\.sqlite|deviceDbPath/);
  assert.doesNotMatch(wrapper, /AUTH_STATE_PATH|auth-state\.json/);
  assert.match(deviceAdmin, /gateway\.sqlite/);
  assert.doesNotMatch(deviceAdmin, /MCP_DEVICE_DB_PATH|devices\.sqlite/);
  assert.doesNotMatch(launcher, /AUTH_STATE_PATH|auth-state\.json/);
  assert.equal(pkg.scripts['admin:migrate-runtime'], 'node scripts/migrate-runtime-state.mjs');
});

test('wrapper preserves account and activity session through MCP caller context and project/device routing', () => {
  assert.match(wrapper, /function createProxyServer\(\{ accountId, activitySessionId, callerKey, callerCategory, callerSubject \}\)/);
  assert.match(wrapper, /routeObservedToolCall\(request, \{ accountId, activitySessionId, callerKey, callerCategory, callerSubject \}\)/);
  assert.match(wrapper, /activitySessionId: req\.auth\?\.activitySessionId \|\| null/);
  assert.match(wrapper, /customToolContext\(context\)/);
  assert.match(wrapper, /deviceBroker\.listDevices\(\{ accountId: callerContext\.accountId \|\| null \}\)/);
});

test('SQLite usage is authoritative while file telemetry is explicit opt-in debug export', () => {
  assert.match(wrapper, /deviceUsageStore\.recordToolCall\(/);
  assert.match(wrapper, /deviceUsageStore\.recordCatalogList\(/);
  assert.match(wrapper, /deviceUsageStore\.setSchemaSnapshot\(/);
  assert.match(wrapper, /MCP_METRICS_ENABLED, false/);
  assert.match(wrapper, /MCP_DEVICE_AUDIT_ENABLED, false/);
});
