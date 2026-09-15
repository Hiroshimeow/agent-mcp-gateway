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
