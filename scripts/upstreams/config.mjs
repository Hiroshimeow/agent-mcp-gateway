import fs from 'node:fs';
import path from 'node:path';
import * as toml from 'smol-toml';
import { validateExternalToolPrefix, validateUpstreamId } from './names.mjs';

const DEFAULT_EXTERNAL = {
  enabled: true,
  fail_gateway_on_startup_error: false,
  catalog_cache: 'startup',
  catalog_cache_ttl_ms: 30000,
  startup_timeout_ms: 15000,
  shutdown_timeout_ms: 5000,
  default_transport: 'stdio',
  default_enabled: true
};

function envFlag(value, defaultValue = true) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return defaultValue;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return defaultValue;
}

function asMs(value, fallback, label) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${label}: ${value}`);
  return n;
}

function resolveMaybeRelative(value, baseDir) {
  if (!value) return undefined;
  const text = String(value).replace(/^['"]|['"]$/g, '');
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(baseDir, text);
}

export function findExternalMcpConfigPath(env = process.env, repoRoot = process.cwd()) {
  const candidates = [];
  if (String(env.MCP_UPSTREAM_CONFIG || '').trim()) {
    candidates.push(resolveMaybeRelative(env.MCP_UPSTREAM_CONFIG, repoRoot));
  }
  candidates.push(path.resolve(repoRoot, 'config/mcp-servers.toml'));
  candidates.push(path.resolve(repoRoot, '.mcp-gateway/mcp-servers.toml'));
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

export async function loadExternalMcpConfig({ env = process.env, repoRoot = process.cwd() } = {}) {
  const configPath = findExternalMcpConfigPath(env, repoRoot);
  if (!configPath) {
    return normalizeExternalMcpConfig({}, { configPath: null, repoRoot, env, noConfig: true });
  }
  const rawText = await fs.promises.readFile(configPath, 'utf8');
  const raw = toml.parse(rawText);
  return normalizeExternalMcpConfig(raw, { configPath, repoRoot, env });
}

export function normalizeExternalMcpConfig(raw = {}, { configPath = null, repoRoot = process.cwd(), env = process.env, noConfig = false } = {}) {
  const externalRaw = raw.external_mcp || {};
  const catalogCache = String(externalRaw.catalog_cache ?? DEFAULT_EXTERNAL.catalog_cache).trim().toLowerCase();
  const external = {
    ...DEFAULT_EXTERNAL,
    ...externalRaw,
    enabled: envFlag(env.MCP_EXTERNAL_MCP_ENABLED, externalRaw.enabled ?? DEFAULT_EXTERNAL.enabled),
    catalog_cache: catalogCache,
    catalog_cache_ttl_ms: DEFAULT_EXTERNAL.catalog_cache_ttl_ms,
    startup_timeout_ms: asMs(externalRaw.startup_timeout_ms, DEFAULT_EXTERNAL.startup_timeout_ms, 'startup_timeout_ms'),
    shutdown_timeout_ms: asMs(externalRaw.shutdown_timeout_ms, DEFAULT_EXTERNAL.shutdown_timeout_ms, 'shutdown_timeout_ms')
  };
  external.fail_gateway_on_startup_error = Boolean(externalRaw.fail_gateway_on_startup_error ?? DEFAULT_EXTERNAL.fail_gateway_on_startup_error);
  if (!['startup', 'ttl', 'none'].includes(external.catalog_cache)) throw new Error(`Invalid catalog_cache: ${external.catalog_cache}`);
  if (external.catalog_cache === 'ttl') {
    external.catalog_cache_ttl_ms = asMs(externalRaw.catalog_cache_ttl_ms, DEFAULT_EXTERNAL.catalog_cache_ttl_ms, 'catalog_cache_ttl_ms');
    if (external.catalog_cache_ttl_ms <= 0) {
      throw new Error('catalog_cache_ttl_ms must be positive when catalog_cache = "ttl"');
    }
  }
  if (!['stdio', 'http'].includes(external.default_transport)) throw new Error(`Invalid default_transport: ${external.default_transport}`);

  const baseDir = configPath ? path.dirname(configPath) : repoRoot;
  const serversRaw = raw.mcp_servers || {};
  const servers = [];
  for (const [rawId, serverRaw] of Object.entries(serversRaw)) {
    const id = validateUpstreamId(rawId);
    const enabled = Boolean(serverRaw.enabled ?? external.default_enabled);
    const transport = String(serverRaw.transport || external.default_transport).trim().toLowerCase();
    if (!['stdio', 'http'].includes(transport)) throw new Error(`Invalid transport for ${id}: ${transport}`);
    const toolPrefix = validateExternalToolPrefix(serverRaw.tool_prefix || id, `tool_prefix for ${id}`);
    const server = {
      id,
      enabled,
      transport,
      toolPrefix,
      startupTimeoutMs: asMs(serverRaw.startup_timeout_ms, external.startup_timeout_ms, `startup_timeout_ms for ${id}`),
      shutdownTimeoutMs: asMs(serverRaw.shutdown_timeout_ms, external.shutdown_timeout_ms, `shutdown_timeout_ms for ${id}`)
    };
    if (transport === 'stdio') {
      if (!serverRaw.command || typeof serverRaw.command !== 'string') throw new Error(`stdio upstream ${id} requires command`);
      server.command = serverRaw.command;
      server.args = Array.isArray(serverRaw.args) ? serverRaw.args.map(String) : [];
      server.cwd = resolveMaybeRelative(serverRaw.cwd || '.', baseDir);
    } else {
      if (!serverRaw.url || typeof serverRaw.url !== 'string') throw new Error(`http upstream ${id} requires url`);
      server.url = serverRaw.url;
      if (serverRaw.bearer_token) throw new Error(`http upstream ${id} must use bearer_token_env, not literal bearer_token`);
      if (serverRaw.bearer_token_env) {
        server.bearerTokenEnv = String(serverRaw.bearer_token_env);
        server.bearerToken = env[server.bearerTokenEnv] || '';
      }
    }
    if (enabled) servers.push(server);
  }
  return { configPath, noConfig, external, servers: external.enabled ? servers : [] };
}
