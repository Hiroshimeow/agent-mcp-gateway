import fs from 'node:fs';
import path from 'node:path';
import { validateExternalToolPrefix, validateUpstreamId } from './names.mjs';
import { expandMcpPreset, expandPlaceholders, normalizeRunnerCommand } from './presets.mjs';
import {
  findUnifiedMcpConfigPath,
  loadUnifiedMcpTomlConfig,
  resolveTrustedRootPaths,
  trustedRootsTomlToRaw
} from '../projects/trusted-roots-projects.mjs';

const DEFAULT_EXTERNAL = {
  enabled: true,
  fail_gateway_on_startup_error: false,
  catalog_cache: 'startup',
  catalog_cache_ttl_ms: 30000,
  startup_timeout_ms: 15000,
  shutdown_timeout_ms: 5000,
  default_transport: 'stdio',
  default_enabled: false
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

function asMsWithSec(raw, msKey, secKey, fallback, label) {
  if (raw && Object.prototype.hasOwnProperty.call(raw, msKey)) return asMs(raw[msKey], fallback, label);
  if (raw && Object.prototype.hasOwnProperty.call(raw, secKey)) {
    const n = Number(raw[secKey]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${secKey}: ${raw[secKey]}`);
    return n * 1000;
  }
  return asMs(undefined, fallback, label);
}

function trustedRootsFromConfig(raw, repoRoot) {
  const trustedRootsRaw = trustedRootsTomlToRaw(raw.trusted_roots, { repoRoot });
  if (!trustedRootsRaw.trim()) return [];
  return resolveTrustedRootPaths(trustedRootsRaw).existingRoots;
}

function resolveMaybeRelative(value, baseDir) {
  if (!value) return undefined;
  const text = String(value).replace(/^['"]|['"]$/g, '');
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(baseDir, text);
}

export function findExternalMcpConfigPath(env = process.env, repoRoot = process.cwd()) {
  return findUnifiedMcpConfigPath(env, repoRoot);
}

export async function loadExternalMcpConfig({ env = process.env, repoRoot = process.cwd() } = {}) {
  const configPath = findExternalMcpConfigPath(env, repoRoot);
  if (!configPath) {
    return normalizeExternalMcpConfig({}, { configPath: null, repoRoot, env, noConfig: true });
  }
  const raw = loadUnifiedMcpTomlConfig(configPath);
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
    startup_timeout_ms: asMsWithSec(externalRaw, 'startup_timeout_ms', 'startup_timeout_sec', DEFAULT_EXTERNAL.startup_timeout_ms, 'startup_timeout_ms'),
    shutdown_timeout_ms: asMsWithSec(externalRaw, 'shutdown_timeout_ms', 'shutdown_timeout_sec', DEFAULT_EXTERNAL.shutdown_timeout_ms, 'shutdown_timeout_ms')
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
  const trustedRoots = trustedRootsFromConfig(raw, repoRoot);
  const placeholderContext = { repoRoot: path.resolve(repoRoot), cwd: baseDir, env, trustedRoots, platform: process.platform };
  const servers = [];
  for (const [rawId, rawServerRaw] of Object.entries(serversRaw)) {
    const id = validateUpstreamId(rawId);
    const serverRaw = expandMcpPreset(id, rawServerRaw, placeholderContext);
    const enabled = Boolean(serverRaw.enabled ?? external.default_enabled);
    let transport = serverRaw.transport;
    if (!transport && serverRaw.url) transport = 'http';
    if (!transport && (serverRaw.command || serverRaw.runner)) transport = 'stdio';
    transport = String(transport || external.default_transport).trim().toLowerCase();
    if (!['stdio', 'http'].includes(transport)) throw new Error(`Invalid transport for ${id}: ${transport}`);
    const toolPrefix = validateExternalToolPrefix(serverRaw.tool_prefix || id, `tool_prefix for ${id}`);
    const server = {
      id,
      enabled,
      transport,
      toolPrefix,
      startupTimeoutMs: asMsWithSec(serverRaw, 'startup_timeout_ms', 'startup_timeout_sec', external.startup_timeout_ms, `startup_timeout_ms for ${id}`),
      shutdownTimeoutMs: asMsWithSec(serverRaw, 'shutdown_timeout_ms', 'shutdown_timeout_sec', external.shutdown_timeout_ms, `shutdown_timeout_ms for ${id}`)
    };
    if (transport === 'stdio') {
      const command = serverRaw.command || normalizeRunnerCommand(serverRaw.runner, process.platform);
      if (!command || typeof command !== 'string') throw new Error(`stdio upstream ${id} requires command`);
      server.command = command;
      server.args = Array.isArray(serverRaw.args) ? serverRaw.args.map(item => expandPlaceholders(String(item), placeholderContext)) : [];
      server.cwd = resolveMaybeRelative(expandPlaceholders(serverRaw.cwd || '.', placeholderContext), baseDir);
    } else {
      if (!serverRaw.url || typeof serverRaw.url !== 'string') throw new Error(`http upstream ${id} requires url`);
      server.url = expandPlaceholders(serverRaw.url, placeholderContext);
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
