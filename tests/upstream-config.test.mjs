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

test('url without transport infers http', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'url-only.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  assert.equal(cfg.servers[0].transport, 'http');
  assert.equal(cfg.servers[0].url, 'https://mcp.context7.com/mcp');
});

test('command without transport infers stdio', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'command-only.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.fake]
command = "node"
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  assert.equal(cfg.servers[0].transport, 'stdio');
});

test('timeout second aliases normalize and ms wins', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'timeouts.toml');
  await fs.promises.writeFile(configPath, `
[external_mcp]
startup_timeout_sec = 20
shutdown_timeout_sec = 3

[mcp_servers.fake]
command = "node"
startup_timeout_sec = 1.5
startup_timeout_ms = 99
shutdown_timeout_sec = 2.5
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  assert.equal(cfg.external.startup_timeout_ms, 20000);
  assert.equal(cfg.external.shutdown_timeout_ms, 3000);
  assert.equal(cfg.servers[0].startupTimeoutMs, 99);
  assert.equal(cfg.servers[0].shutdownTimeoutMs, 2500);
});

test('filesystem preset roots trusted expands all trusted roots into args', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const extra = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-root-'));
  const configPath = path.join(dir, 'filesystem.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.filesystem]
preset = "filesystem"
roots = "trusted"
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath, MCP_TRUSTED_ROOTS: extra } });
  assert.equal(cfg.servers[0].transport, 'stdio');
  assert.equal(cfg.servers[0].command, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  assert.deepEqual(cfg.servers[0].args.slice(0, 2), ['-y', '@modelcontextprotocol/server-filesystem']);
  assert.ok(cfg.servers[0].args.includes(path.resolve(dir)));
  assert.ok(cfg.servers[0].args.includes(path.resolve(extra)));
});

test('ripgrep preset roots trusted expands allow-dir for all trusted roots', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const extra = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-root-'));
  const configPath = path.join(dir, 'ripgrep.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.rg]
preset = "ripgrep"
roots = "trusted"
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath, MCP_TRUSTED_ROOTS: extra } });
  const args = cfg.servers[0].args;
  assert.deepEqual(args.slice(0, 2), ['-y', '@atef_andrus/mcp-ripgrep']);
  assert.ok(args.includes('--allow-dir'));
  assert.ok(args.includes(path.resolve(dir)));
  assert.ok(args.includes(path.resolve(extra)));
  assert.ok(args.includes('--max-result-chars'));
  assert.ok(args.includes('80000'));
});

test('ripgrep preset explicit args inherit trusted roots only when explicitly requested', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'ripgrep-inherit.toml');
  await fs.promises.writeFile(configPath, `
[trusted_roots]
roots = ["${dir.replaceAll('\\', '\\\\')}"]

[mcp_servers.rg]
preset = "ripgrep"
roots = "trusted"
args = ["-y", "@atef_andrus/mcp-ripgrep"]
inherit_trusted_roots = true
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  assert.deepEqual(cfg.servers[0].args, ['-y', '@atef_andrus/mcp-ripgrep', '--allow-dir', path.resolve(dir)]);
});

test('eslint preset defaults cwd to repoRoot without trusted root injection', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'eslint.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.eslint]
preset = "eslint"
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  assert.equal(cfg.servers[0].cwd, path.resolve(dir));
  assert.deepEqual(cfg.servers[0].args, ['-y', '@eslint/mcp@latest']);
});

test('context7 preset creates http config without roots', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'context7.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.context7]
preset = "context7"
roots = "trusted"
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } });
  assert.equal(cfg.servers[0].transport, 'http');
  assert.equal(cfg.servers[0].url, 'https://mcp.context7.com/mcp');
  assert.equal(cfg.servers[0].args, undefined);
});

test('explicit preset args are not silently mutated by trusted roots', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const extra = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-root-'));
  const configPath = path.join(dir, 'explicit-args.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.filesystem]
preset = "filesystem"
roots = "trusted"
args = ["-y", "@modelcontextprotocol/server-filesystem", "${dir.replaceAll('\\', '\\\\')}"]
`);
  const cfg = await loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath, MCP_TRUSTED_ROOTS: extra } });
  assert.deepEqual(cfg.servers[0].args, ['-y', '@modelcontextprotocol/server-filesystem', dir]);
});

test('reserved prefix custom is rejected after preset expansion', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-config-'));
  const configPath = path.join(dir, 'reserved-preset.toml');
  await fs.promises.writeFile(configPath, `
[mcp_servers.filesystem]
preset = "filesystem"
tool_prefix = "custom"
`);
  await assert.rejects(() => loadExternalMcpConfig({ repoRoot: dir, env: { MCP_UPSTREAM_CONFIG: configPath } }), /reserved.*local gateway tools|custom/i);
});
