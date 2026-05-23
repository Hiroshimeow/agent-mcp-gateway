import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExternalMcpConfigPath, loadExternalMcpConfig } from '../scripts/upstreams/config.mjs';

test('missing config returns no upstreams', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: {} });
  assert.equal(cfg.configPath, null);
  assert.deepEqual(cfg.servers, []);
});

test('loads env config before default paths and applies defaults', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'upstreams.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.fake]
command = "node"
args = ["server.mjs"]
`);
  assert.equal(findExternalMcpConfigPath({ MCP_UPSTREAM_CONFIG: configPath }, dir), configPath);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  assert.equal(cfg.servers.length, 1);
  assert.equal(cfg.servers[0].id, 'fake');
  assert.equal(cfg.servers[0].enabled, true);
  assert.equal(cfg.servers[0].transport, 'stdio');
  assert.equal(cfg.servers[0].toolPrefix, 'fake');
  assert.equal(cfg.servers[0].cwd, dir);
});

test('rejects invalid ids and literal bearer tokens', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'bad.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.remote]
transport = "http"
url = "http://127.0.0.1:1/mcp"
bearer_token = "secret"
`);
  await assert.rejects(() => loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } }), /bearer_token_env/);
});
