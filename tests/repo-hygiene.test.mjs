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

test('direct main entrypoint supports local gateway plus optional tunnel', () => {
  const main = read('main.py');
  const config = read('config/mcp-servers.toml');
  assert.match(main, /authenticated-mcp-wrapper\.mjs/);
  assert.match(main, /--tunnel/);
  assert.match(main, /load_openai_tunnel_config/);
  assert.match(config, /^\[openai_tunnel\]$/m);
});

test('committed mcp config matches the current committed baseline', () => {
  const config = read('config/mcp-servers.toml');
  assert.match(config, /^\[trusted_roots\]$/m);
  assert.match(config, /^\[mcp_servers\.context7\]$/m);
  assert.match(config, /^\[mcp_servers\.filesystem\]$/m);
  assert.match(config, /^\[mcp_servers\.eslint\]$/m);
  assert.match(config, /^\[mcp_servers\.codegraph\]$/m);
  assert.doesNotMatch(config, /^\[mcp_servers\.dcp-retrieval\]$/m);
  assert.match(config, /^\[openai_tunnel\]$/m);
  assert.match(config, /enabled\s*=\s*false/);
});
