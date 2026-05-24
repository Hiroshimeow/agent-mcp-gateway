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

test('accepts catalog cache modes and validates ttl', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  for (const mode of ['startup', 'none']) {
    const configPath = path.join(dir, `${mode}.toml`);
    await fs.promises.writeFile(configPath, `
[external_mcp]
catalog_cache = "${mode}"
catalog_cache_ttl_ms = 0
`);
    const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
    assert.equal(cfg.external.catalog_cache, mode);
    assert.equal(cfg.external.catalog_cache_ttl_ms, 30000);
  }

  const ttlPath = path.join(dir, 'ttl.toml');
  await fs.promises.writeFile(ttlPath, `
[external_mcp]
catalog_cache = "ttl"
catalog_cache_ttl_ms = 1
`);
  const ttlCfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: ttlPath } });
  assert.equal(ttlCfg.external.catalog_cache, 'ttl');
  assert.equal(ttlCfg.external.catalog_cache_ttl_ms, 1);

  const invalidModePath = path.join(dir, 'bad-mode.toml');
  await fs.promises.writeFile(invalidModePath, `
[external_mcp]
catalog_cache = "bad"
`);
  await assert.rejects(() => loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: invalidModePath } }), /Invalid catalog_cache/);

  const invalidTtlPath = path.join(dir, 'bad-ttl.toml');
  await fs.promises.writeFile(invalidTtlPath, `
[external_mcp]
catalog_cache = "ttl"
catalog_cache_ttl_ms = 0
`);
  await assert.rejects(() => loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: invalidTtlPath } }), /catalog_cache_ttl_ms must be positive/);
});

test('rejects reserved external tool prefixes', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'reserved-prefix.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.ext]
command = "node"
tool_prefix = "custom"
`);
  await assert.rejects(() => loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } }), /reserved.*local gateway tools|custom/i);
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
