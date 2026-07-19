import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findExternalMcpConfigPath, loadExternalMcpConfig } from '../scripts/upstreams/config.mjs';

async function tempConfig(name, text) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, name);
  await fs.promises.writeFile(configPath, text);
  return { dir, configPath };
}

test('missing config returns no upstreams', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: {} });
  assert.equal(cfg.configPath, null);
  assert.deepEqual(cfg.servers, []);
});

test('optional upstreams are disabled by default and explicit enable is required', async () => {
  const { dir, configPath } = await tempConfig('upstreams.toml', `
[mcp_servers.disabled]
command = "node"

[mcp_servers.enabled]
enabled = true
command = "node"
args = ["server.mjs"]
`);
  assert.equal(findExternalMcpConfigPath({ MCP_UPSTREAM_CONFIG: configPath }, dir), configPath);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  assert.deepEqual(cfg.servers.map(server => server.id), ['enabled']);
  assert.equal(cfg.servers[0].transport, 'stdio');
  assert.equal(cfg.servers[0].toolPrefix, 'enabled');
  assert.equal(cfg.servers[0].cwd, dir);
});

test('external default_enabled can opt all configured servers in', async () => {
  const { dir, configPath } = await tempConfig('default-enabled.toml', `
[external_mcp]
default_enabled = true

[mcp_servers.fake]
command = "node"
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  assert.deepEqual(cfg.servers.map(server => server.id), ['fake']);
});

test('accepts catalog cache modes and validates ttl', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  for (const mode of ['startup', 'none']) {
    const configPath = path.join(dir, `${mode}.toml`);
    await fs.promises.writeFile(configPath, `[external_mcp]\ncatalog_cache = "${mode}"\ncatalog_cache_ttl_ms = 0\n`);
    const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
    assert.equal(cfg.external.catalog_cache, mode);
    assert.equal(cfg.external.catalog_cache_ttl_ms, 30000);
  }

  const ttlPath = path.join(dir, 'ttl.toml');
  await fs.promises.writeFile(ttlPath, '[external_mcp]\ncatalog_cache = "ttl"\ncatalog_cache_ttl_ms = 1\n');
  const ttlCfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: ttlPath } });
  assert.equal(ttlCfg.external.catalog_cache_ttl_ms, 1);

  const badMode = path.join(dir, 'bad-mode.toml');
  await fs.promises.writeFile(badMode, '[external_mcp]\ncatalog_cache = "bad"\n');
  await assert.rejects(() => loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: badMode } }), /Invalid catalog_cache/);

  const badTtl = path.join(dir, 'bad-ttl.toml');
  await fs.promises.writeFile(badTtl, '[external_mcp]\ncatalog_cache = "ttl"\ncatalog_cache_ttl_ms = 0\n');
  await assert.rejects(() => loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: badTtl } }), /must be positive/);
});

test('transport inference, timeouts, and supported presets normalize when enabled', async () => {
  const { dir, configPath } = await tempConfig('normalize.toml', `
[external_mcp]
startup_timeout_sec = 20
shutdown_timeout_sec = 3

[mcp_servers.http]
enabled = true
url = "https://example.com/mcp"

[mcp_servers.stdio]
enabled = true
command = "node"
startup_timeout_sec = 1.5
startup_timeout_ms = 99
shutdown_timeout_sec = 2.5

[mcp_servers.eslint]
enabled = true
preset = "eslint"

[mcp_servers.context7]
enabled = true
preset = "context7"
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  const byId = new Map(cfg.servers.map(server => [server.id, server]));
  assert.equal(cfg.external.startup_timeout_ms, 20000);
  assert.equal(cfg.external.shutdown_timeout_ms, 3000);
  assert.equal(byId.get('http').transport, 'http');
  assert.equal(byId.get('stdio').transport, 'stdio');
  assert.equal(byId.get('stdio').startupTimeoutMs, 99);
  assert.equal(byId.get('stdio').shutdownTimeoutMs, 2500);
  assert.equal(byId.get('eslint').cwd, path.resolve(dir));
  assert.deepEqual(byId.get('eslint').args, ['-y', '@eslint/mcp@latest']);
  assert.equal(byId.get('context7').url, 'https://mcp.context7.com/mcp');
});

test('removed filesystem and ripgrep presets are rejected', async () => {
  for (const preset of ['filesystem', 'ripgrep']) {
    const { dir, configPath } = await tempConfig(`${preset}.toml`, `
[mcp_servers.removed]
enabled = true
preset = "${preset}"
`);
    await assert.rejects(
      () => loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } }),
      /Unknown MCP preset/
    );
  }
});

test('rejects reserved prefixes, invalid ids, and literal bearer tokens for enabled servers', async () => {
  const reserved = await tempConfig('reserved.toml', `
[mcp_servers.ext]
enabled = true
command = "node"
tool_prefix = "custom"
`);
  await assert.rejects(
    () => loadExternalMcpConfig({ repoRoot: reserved.dir, env: { MCP_UPSTREAM_CONFIG: reserved.configPath } }),
    /reserved.*local gateway tools|custom/i
  );

  const literal = await tempConfig('literal.toml', `
[mcp_servers.remote]
enabled = true
url = "http://127.0.0.1:1/mcp"
bearer_token = "secret"
`);
  await assert.rejects(
    () => loadExternalMcpConfig({ repoRoot: literal.dir, env: { MCP_UPSTREAM_CONFIG: literal.configPath } }),
    /bearer_token_env/
  );
});
