import fs from 'node:fs';
import path from 'node:path';
import * as toml from 'smol-toml';

import {
  assertValidProjectId,
  generateProjectIdForRoot,
  normalizeProjectId
} from './project-id.mjs';

function cleanRootPath(rootPath) {
  return String(rootPath ?? '')
    .trim()
    .replace(/^[']|[']$/g, '')
    .replace(/^["]|["]$/g, '')
    .replace(/^\\\\\?\\/, '');
}

function isWindowsDrivePath(rootPath) {
  return /^[A-Za-z]:[\\/]/.test(String(rootPath || ''));
}

function normalizeRootPath(rootPath) {
  const cleaned = cleanRootPath(rootPath);
  if (process.platform !== 'win32' && isWindowsDrivePath(cleaned)) {
    return cleaned.replace(/\\/g, '/');
  }
  return path.resolve(cleaned);
}

function isInsideRoot(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}


export function trustedRootEntryToLine(entry, context = {}) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  const rawRoot = entry.path ?? entry.root;
  if (!rawRoot) return '';
  const root = expandTrustedRootPlaceholders(String(rawRoot), context);
  const fields = [root];
  if (entry.project_id ?? entry.projectId) fields.push(String(entry.project_id ?? entry.projectId));
  if (entry.display_name ?? entry.displayName) {
    if (fields.length === 1) fields.push('');
    fields.push(String(entry.display_name ?? entry.displayName));
  }
  return fields.join(' | ');
}

export function trustedRootsTomlToRaw(trustedRootsRaw, context = {}) {
  if (!trustedRootsRaw) return '';
  const entries = Array.isArray(trustedRootsRaw.roots) ? trustedRootsRaw.roots : [];
  return entries.map(entry => trustedRootEntryToLine(entry, context)).filter(Boolean).join('\n');
}

export function expandTrustedRootPlaceholders(value, { repoRoot = process.cwd(), home = process.env.HOME || process.env.USERPROFILE || '' } = {}) {
  return String(value).replace(/\$\{([^}]+)\}/g, (match, name) => {
    if (name === 'repoRoot') return repoRoot;
    if (name === 'home') return home;
    return match;
  });
}

export function loadUnifiedMcpTomlConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return {};
  return toml.parse(fs.readFileSync(configPath, 'utf8'));
}

export function defaultUnifiedMcpConfigPath(repoRoot = process.cwd()) {
  return path.resolve(repoRoot, 'config/mcp-servers.toml');
}

export function findUnifiedMcpConfigPath(env = process.env, repoRoot = process.cwd()) {
  if (String(env.MCP_UPSTREAM_CONFIG || '').trim()) {
    const value = String(env.MCP_UPSTREAM_CONFIG).trim().replace(/^['"]|['"]$/g, '');
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
  }
  const candidate = defaultUnifiedMcpConfigPath(repoRoot);
  return fs.existsSync(candidate) ? candidate : null;
}

export function trustedRootsRawFromSources({ rawConfig = {}, repoRoot = process.cwd() } = {}) {
  return trustedRootsTomlToRaw(rawConfig.trusted_roots, { repoRoot });
}

export function loadTrustedRootsRawFromUnifiedConfig({ env = process.env, repoRoot = process.cwd() } = {}) {
  const configPath = findUnifiedMcpConfigPath(env, repoRoot);
  const rawConfig = loadUnifiedMcpTomlConfig(configPath);
  return trustedRootsRawFromSources({ rawConfig, env, repoRoot });
}

export function splitTrustedRootConfig(rawValue) {
  return String(rawValue || '')
    .split(/[\r\n;]+/)
    .map(entry => entry.trim())
    .filter(entry => entry && !entry.startsWith('#'));
}

export function resolveTrustedRootPaths(rawValue, fallbackRoot) {
  const roots = [];
  if (fallbackRoot) {
    roots.push(normalizeRootPath(fallbackRoot));
  }

  for (const entry of splitTrustedRootConfig(rawValue)) {
    const parsed = parseTrustedRootLine(entry);
    if (parsed?.root) {
      roots.push(parsed.root);
    }
  }

  const resolvedRoots = [...new Set(roots)];
  const existingRoots = [];
  const missingRoots = [];
  for (const root of resolvedRoots) {
    if (fs.existsSync(root)) {
      existingRoots.push(root);
    } else {
      missingRoots.push(root);
    }
  }

  if (existingRoots.length === 0) {
    throw new Error(`No trusted roots exist. Configured roots: ${resolvedRoots.join('; ')}`);
  }

  return { existingRoots, missingRoots, resolvedRoots };
}

export function parseTrustedRootLine(line, options = {}) {
  const lineNumber = options.lineNumber;
  const raw = String(line ?? '');
  const trimmed = raw.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const parts = raw.split('|').map(part => part.trim());
  if (parts.length > 3) {
    const error = new Error(`Invalid trusted root line${lineNumber ? ` ${lineNumber}` : ''}: expected at most 3 pipe-separated fields`);
    error.code = 'INVALID_TRUSTED_ROOT_LINE';
    error.details = { line, lineNumber };
    throw error;
  }

  const root = cleanRootPath(parts[0]);
  if (!root) {
    const error = new Error(`Invalid trusted root line${lineNumber ? ` ${lineNumber}` : ''}: missing path`);
    error.code = 'INVALID_TRUSTED_ROOT_LINE';
    error.details = { line, lineNumber };
    throw error;
  }

  if (!path.isAbsolute(root) && !isWindowsDrivePath(root)) {
    const error = new Error(`Trusted root must be absolute: ${root}`);
    error.code = 'TRUSTED_ROOT_MUST_BE_ABSOLUTE';
    error.details = { root, lineNumber };
    throw error;
  }

  const resolvedRoot = normalizeRootPath(root);
  const explicitProjectId = parts.length >= 2 && parts[1] !== '';
  const projectId = explicitProjectId ? assertValidProjectId(parts[1]) : undefined;
  const displayName = parts.length >= 3 && parts[2] !== '' ? parts[2] : undefined;

  return {
    rawLine: raw,
    lineNumber,
    root: resolvedRoot,
    projectId,
    displayName,
    explicitProjectId
  };
}

export function normalizeTrustedRootEntries(linesOrEntries, options = {}) {
  const entries = [];
  const usedGeneratedIds = new Set();
  const explicitIds = new Set();
  const seenRoots = new Set();

  const parsedEntries = linesOrEntries.map((item, index) => {
    if (typeof item === 'string') return parseTrustedRootLine(item, { lineNumber: index + 1 });
    return item;
  }).filter(Boolean);

  for (const entry of parsedEntries) {
    const root = normalizeRootPath(entry.root);
    const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);

    let projectId;
    const explicitProjectId = Boolean(entry.explicitProjectId || entry.projectId);
    if (entry.projectId) {
      projectId = assertValidProjectId(entry.projectId);
      explicitIds.add(projectId);
    } else {
      projectId = generateProjectIdForRoot(root, new Set([...explicitIds, ...usedGeneratedIds]));
      usedGeneratedIds.add(projectId);
    }

    entries.push({
      ...entry,
      root,
      projectId,
      displayName: entry.displayName || projectId,
      explicitProjectId
    });
  }

  return entries;
}

export function buildTrustedRootsProjectRegistry(entries, options = {}) {
  const normalizedEntries = normalizeTrustedRootEntries(entries, options);
  const projects = new Map();
  const missingRoots = [];

  for (const entry of normalizedEntries) {
    if (options.checkExists && !fs.existsSync(entry.root)) {
      missingRoots.push(entry.root);
      if (options.missingRootMode === 'error') {
        const error = new Error(`Trusted root does not exist: ${entry.root}`);
        error.code = 'TRUSTED_ROOT_NOT_FOUND';
        error.details = { root: entry.root };
        throw error;
      }
    }

    const existing = projects.get(entry.projectId);
    if (!existing) {
      projects.set(entry.projectId, {
        projectId: entry.projectId,
        displayName: entry.displayName,
        repoRoot: entry.root,
        trustedRoots: [entry.root],
        extraTrustedRoots: [],
        explicitProjectId: entry.explicitProjectId
      });
      continue;
    }

    if (!existing.trustedRoots.includes(entry.root)) {
      existing.trustedRoots.push(entry.root);
      existing.extraTrustedRoots.push(entry.root);
    }
    existing.explicitProjectId = existing.explicitProjectId || entry.explicitProjectId;
  }

  const allTrustedRoots = [...new Set(normalizedEntries.map(entry => entry.root))];
  const rootIndex = [];
  for (const project of projects.values()) {
    for (const root of project.trustedRoots) {
      rootIndex.push({ projectId: project.projectId, root });
    }
  }
  rootIndex.sort((a, b) => b.root.length - a.root.length);

  const requestedDefault = normalizeProjectId(options.defaultProjectId || '');
  const defaultProjectId = requestedDefault || normalizedEntries[0]?.projectId;

  return {
    mode: 'trusted-roots-projects',
    defaultProjectId,
    requireProjectId: Boolean(options.requireProjectId),
    pathInference: options.pathInference !== false,
    exposeProjectPaths: Boolean(options.exposeProjectPaths),
    projects,
    rootIndex,
    allTrustedRoots,
    missingRoots
  };
}

export function buildTrustedRootsProjectRegistryFromRaw(rawValue, options = {}) {
  const configuredEntries = splitTrustedRootConfig(rawValue);
  const fallbackEntries = options.fallbackRoot ? [options.fallbackRoot] : [];
  return buildTrustedRootsProjectRegistry(configuredEntries.length > 0 ? configuredEntries : fallbackEntries, options);
}

export function loadTrustedRootsProjectRegistry(configPath, options = {}) {
  const content = fs.readFileSync(configPath, 'utf8');
  return buildTrustedRootsProjectRegistry(content.split(/\r?\n/), options);
}

export function listProjectSummaries(registry, options = {}) {
  const showPaths = Boolean(options.showPaths && registry.exposeProjectPaths);
  const projects = [...registry.projects.values()].map(project => {
    const summary = {
      projectId: project.projectId,
      displayName: project.displayName
    };
    if (showPaths) {
      summary.repoRoot = project.repoRoot;
      summary.trustedRoots = [...project.trustedRoots];
    }
    return summary;
  });

  return {
    defaultProjectId: registry.defaultProjectId,
    requireProjectId: registry.requireProjectId,
    pathInference: registry.pathInference,
    exposeProjectPaths: registry.exposeProjectPaths,
    projects,
    warnings: options.showPaths && !registry.exposeProjectPaths
      ? ['Path exposure is disabled. Set MCP_EXPOSE_PROJECT_PATHS=true to include local paths.']
      : []
  };
}

export function inferProjectIdFromPath(registry, candidatePath) {
  const resolved = normalizeRootPath(candidatePath);
  const match = registry.rootIndex.find(entry => isInsideRoot(resolved, entry.root));
  return match?.projectId;
}
