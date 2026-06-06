import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('unified config is committed and local package artifacts are ignored', () => {
  const gitignore = read('.gitignore');
  assert.doesNotMatch(gitignore, /^config\/trusted-roots\.txt$/m);
  assert.doesNotMatch(gitignore, /^\.mcp-gateway\/$/m);
  assert.match(gitignore, /^packages\/$/m);
});

test('.env.example keeps runtime env separate from unified config', () => {
  const envExample = read('.env.example');
  assert.doesNotMatch(envExample, /^MCP_TRUSTED_ROOTS_FILE=/m);
  assert.match(envExample, /^MCP_UPSTREAM_CONFIG=$/m);
  assert.match(envExample, /^MCP_EXTERNAL_MCP_ENABLED=true$/m);
});

test('batch live launcher does not prompt for public advertise URL', () => {
  const batch = read('start-mcp-live.bat');
  assert.doesNotMatch(batch, /Advertise URL/i);
  assert.doesNotMatch(batch, /MCP_ADVERTISE_URL_INPUT/);
  assert.doesNotMatch(batch, /-AdvertiseUrl\s+\$env:MCP_ADVERTISE_URL_INPUT/);
});

test('committed mcp config matches the current committed baseline', () => {
  const config = read('config/mcp-servers.toml');
  assert.match(config, /^\[trusted_roots\]$/m);
  assert.match(config, /^\[mcp_servers\.context7\]$/m);
  assert.match(config, /^\[mcp_servers\.filesystem\]$/m);
  assert.match(config, /^\[mcp_servers\.eslint\]$/m);
  assert.match(config, /^\[mcp_servers\.codegraph\]$/m);
  assert.match(config, /^\[mcp_servers\.dcp-retrieval\]$/m);
  assert.match(config, /bearer_token_env\s*=\s*"DCP_RETRIEVAL_TOKEN"/);
});
