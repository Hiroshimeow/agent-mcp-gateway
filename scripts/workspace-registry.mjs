import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as toml from 'smol-toml';

import {
  buildTrustedRootsProjectRegistryFromRaw,
  trustedRootsTomlToRaw
} from './projects/trusted-roots-projects.mjs';

const DEFAULT_WATCH_INTERVAL_MS = 500;
const DEFAULT_LOCK_RETRIES = 100;
const DEFAULT_LOCK_DELAY_MS = 20;
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableSignature(value) {
  return hashText(JSON.stringify(stableValue(value)));
}

function stripWrappingQuotes(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function stripWindowsLongPathPrefix(value) {
  const text = String(value);
  if (/^\\\\\?\\UNC\\/i.test(text)) return `\\\\${text.slice(8)}`;
  return text.replace(/^\\\\\?\\/, '');
}

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function looksLikeWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function isAbsoluteWorkspacePath(value, { platform = process.platform } = {}) {
  let text = stripWindowsLongPathPrefix(stripWrappingQuotes(value));
  if (text.startsWith('file://')) {
    try { text = fileURLToPath(text); } catch { return false; }
  }
  return platform === 'win32' ? path.win32.isAbsolute(text) : path.posix.isAbsolute(text);
}

function nearestExistingPath(absolutePath, api, fsImpl) {
  let current = absolutePath;
  const suffix = [];
  while (!fsImpl.existsSync(current)) {
    const parent = api.dirname(current);
    if (parent === current) return absolutePath;
    suffix.unshift(api.basename(current));
    current = parent;
  }
  let resolved = current;
  try {
    resolved = (fsImpl.realpathSync.native || fsImpl.realpathSync)(current);
  } catch {
    resolved = current;
  }
  return suffix.reduce((base, segment) => api.join(base, segment), resolved);
}

export function normalizeWorkspacePath(value, options = {}) {
  const platform = options.platform || process.platform;
  const api = pathApiFor(platform);
  let text = stripWindowsLongPathPrefix(stripWrappingQuotes(value));
  if (!text) throw new Error('Path is required');
  if (text.startsWith('file://')) text = fileURLToPath(text);
  if (platform === 'win32') text = text.replaceAll('/', '\\');
  if (!api.isAbsolute(text)) {
    const cwd = options.cwd || process.cwd();
    text = api.resolve(cwd, text);
  } else {
    text = api.normalize(text);
  }

  const canTouchHostFs = platform === process.platform && !(platform !== 'win32' && looksLikeWindowsAbsolute(text));
  if (options.realpath !== false && canTouchHostFs) {
    text = nearestExistingPath(text, api, options.fsImpl || fs);
  }
  text = api.normalize(text);
  const root = api.parse(text).root;
  while (text.length > root.length && /[\\/]$/.test(text)) text = text.slice(0, -1);
  return text;
}

export function workspacePathKey(value, options = {}) {
  const platform = options.platform || process.platform;
  const normalized = normalizeWorkspacePath(value, { ...options, platform });
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathInsideWorkspace(root, candidate, options = {}) {
  const platform = options.platform || process.platform;
  const api = pathApiFor(platform);
  const normalizedRoot = normalizeWorkspacePath(root, { ...options, platform });
  const normalizedCandidate = normalizeWorkspacePath(candidate, { ...options, platform });
  const rootForCompare = platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
  const candidateForCompare = platform === 'win32' ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const relative = api.relative(rootForCompare, candidateForCompare);
  return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative));
}

export function deriveWorkspaceRoot(targetPath, kind = 'directory', options = {}) {
  const platform = options.platform || process.platform;
  const api = pathApiFor(platform);
  const normalized = normalizeWorkspacePath(targetPath, { ...options, platform });
  return kind === 'directory' ? normalized : api.dirname(normalized);
}

export function toPortableTomlPath(value, options = {}) {
  const platform = options.platform || process.platform;
  const normalized = normalizeWorkspacePath(value, { ...options, platform, realpath: false });
  return platform === 'win32' ? normalized.replaceAll('\\', '/') : normalized;
}

export function toFilesystemRootUri(value, options = {}) {
  const platform = options.platform || process.platform;
  const normalized = normalizeWorkspacePath(value, { ...options, platform, realpath: false });
  if (platform !== 'win32') return `file://${normalized}`;
  if (normalized.startsWith('\\\\')) return `file://${normalized}`;
  return `file://${normalized.replaceAll('\\', '/')}`;
}

function tomlString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function findMatchingArrayEnd(text, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let comment = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (comment) {
      if (char === '\n') comment = false;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\' && quote === '"') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '#') { comment = true; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('Unable to locate the end of [trusted_roots].roots array');
}

export function insertTrustedRootText(text, portableRoot) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const sectionMatch = /^\s*\[trusted_roots\]\s*(?:#.*)?$/m.exec(text);
  const entry = `  ${tomlString(portableRoot)}`;

  if (!sectionMatch) {
    const separator = text.length === 0 || text.endsWith('\n') ? '' : newline;
    return `${text}${separator}${newline}[trusted_roots]${newline}roots = [${newline}${entry}${newline}]${newline}`;
  }

  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const nextSectionMatch = /^\s*\[[^\]]+\]\s*(?:#.*)?$/m.exec(text.slice(sectionStart));
  const sectionEnd = nextSectionMatch ? sectionStart + nextSectionMatch.index : text.length;
  const sectionText = text.slice(sectionStart, sectionEnd);
  const rootsMatch = /^\s*roots\s*=\s*\[/m.exec(sectionText);
  if (!rootsMatch) {
    const insertion = `${newline}roots = [${newline}${entry}${newline}]${newline}`;
    return `${text.slice(0, sectionEnd)}${insertion}${text.slice(sectionEnd)}`;
  }

  const openIndex = sectionStart + rootsMatch.index + rootsMatch[0].lastIndexOf('[');
  const closeIndex = findMatchingArrayEnd(text, openIndex);
  let body = text.slice(openIndex + 1, closeIndex);
  const hasValue = body.replace(/#[^\r\n]*/g, '').trim().length > 0;
  if (hasValue) {
    const lines = body.split(/(\r?\n)/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^\r?\n$/.test(lines[index]) || !lines[index].trim() || lines[index].trimStart().startsWith('#')) continue;
      const commentIndex = lines[index].indexOf('#');
      const valuePart = commentIndex >= 0 ? lines[index].slice(0, commentIndex) : lines[index];
      if (!valuePart.trimEnd().endsWith(',')) {
        const suffix = commentIndex >= 0 ? lines[index].slice(commentIndex) : '';
        lines[index] = `${valuePart.trimEnd()},${valuePart.slice(valuePart.trimEnd().length)}${suffix}`;
        body = lines.join('');
      }
      break;
    }
  }
  const prefix = body.length === 0 ? newline : (body.endsWith('\n') ? '' : newline);
  const insertion = `${prefix}${entry}${newline}`;
  return `${text.slice(0, openIndex + 1)}${body}${insertion}${text.slice(closeIndex)}`;
}

function rootsFromRawConfig(rawConfig, { repoRoot, env = process.env, platform, fsImpl = fs } = {}) {
  const raw = trustedRootsTomlToRaw(rawConfig.trusted_roots, { repoRoot });
  const roots = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const rootText = line.split('|')[0]?.trim();
    if (!rootText) continue;
    const expanded = rootText
      .replaceAll('${repoRoot}', repoRoot)
      .replaceAll('${home}', env.HOME || env.USERPROFILE || '');
    try {
      const normalized = normalizeWorkspacePath(expanded, { platform, fsImpl });
      const key = workspacePathKey(normalized, { platform, fsImpl, realpath: false });
      if (!roots.some(item => item.key === key)) roots.push({ path: normalized, key });
    } catch {
      // Validation is handled by the TOML parser and runtime consumers.
    }
  }
  return roots;
}

function lockOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return true;
  }
}

async function reclaimStaleLock(lockPath, options = {}) {
  let stat;
  try {
    stat = await fs.promises.stat(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }

  let metadata = null;
  try {
    metadata = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
  } catch {
    // Legacy/unreadable locks require the conservative age threshold below.
  }

  const ownerAlive = lockOwnerAlive(Number(metadata?.pid));
  const staleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const oldEnough = Date.now() - stat.mtimeMs >= staleMs;
  const reclaim = ownerAlive === false || oldEnough;
  if (!reclaim) return false;
  await fs.promises.rm(lockPath, { force: true });
  return true;
}

async function acquireLock(lockPath, options = {}) {
  const retries = options.lockRetries ?? DEFAULT_LOCK_RETRIES;
  const delayMs = options.lockDelayMs ?? DEFAULT_LOCK_DELAY_MS;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      await handle.sync();
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt === retries) throw error;
      if (await reclaimStaleLock(lockPath, options)) continue;
      await sleep(delayMs);
    }
  }
  throw new Error(`Unable to acquire config lock: ${lockPath}`);
}

async function atomicReplace(targetPath, content, options = {}) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    toml.parse(await fs.promises.readFile(temporaryPath, 'utf8'));
    const retries = options.renameRetries ?? 20;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.promises.rename(temporaryPath, targetPath);
        break;
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= retries) throw error;
        await sleep(25 * (attempt + 1));
      }
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function persistTrustedRoot(configPath, rootPath, options = {}) {
  const platform = options.platform || process.platform;
  const repoRoot = options.repoRoot || process.cwd();
  const env = options.env || process.env;
  const portableRoot = toPortableTomlPath(rootPath, { platform, realpath: false });
  const lockPath = `${configPath}.lock`;
  const lock = await acquireLock(lockPath, options);
  try {
    const original = await fs.promises.readFile(configPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const rawConfig = toml.parse(original || '');
    const roots = rootsFromRawConfig(rawConfig, { repoRoot, env, platform });
    if (roots.some(item => isPathInsideWorkspace(item.path, rootPath, { platform }))) {
      return { added: false, root: rootPath, content: original };
    }
    const updated = insertTrustedRootText(original, portableRoot);
    toml.parse(updated);
    await atomicReplace(configPath, updated, options);
    return { added: true, root: rootPath, content: updated };
  } finally {
    await lock.close().catch(() => {});
    await fs.promises.rm(lockPath, { force: true }).catch(() => {});
  }
}

export function createWorkspaceRegistry(options = {}) {
  const configPath = path.resolve(options.configPath);
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const listeners = new Set();
  let closed = false;
  let state = null;
  let reloadInFlight = null;
  let grantQueue = Promise.resolve();

  function buildState(content) {
    const rawConfig = toml.parse(content || '');
    const roots = rootsFromRawConfig(rawConfig, { repoRoot, env, platform }).map(item => item.path);
    const rawRoots = trustedRootsTomlToRaw(rawConfig.trusted_roots, { repoRoot });
    const projectRegistry = buildTrustedRootsProjectRegistryFromRaw(rawRoots, {
      defaultProjectId: env.MCP_DEFAULT_PROJECT_ID,
      requireProjectId: false,
      pathInference: true,
      exposeProjectPaths: String(env.MCP_EXPOSE_PROJECT_PATHS || '').toLowerCase() === 'true',
      checkExists: false
    });
    return {
      configPath,
      content,
      hash: hashText(content),
      rawConfig,
      roots,
      rootsSignature: stableSignature(roots.map(root => workspacePathKey(root, { platform, realpath: false })).sort()),
      upstreamSignature: stableSignature({
        external_mcp: rawConfig.external_mcp || {},
        mcp_servers: rawConfig.mcp_servers || {}
      }),
      projectRegistry,
      server: {
        name: rawConfig.server?.name || 'personal-mcp-launcher',
        title: rawConfig.server?.title || 'Local Coding Gateway',
        description: rawConfig.server?.description || 'Local coding workspace for filesystem, shell, image inspection, and optional skills.',
        instructions: rawConfig.server?.instructions || 'Use filesystem tools for content, shell_execute for terminal workflows, image_preview for local images, and get_skill for reusable coding guidance.'
      },
      loadedAt: new Date().toISOString(),
      lastError: null
    };
  }

  function publicSnapshot() {
    return {
      ...state,
      roots: [...state.roots],
      rawConfig: state.rawConfig,
      projectRegistry: state.projectRegistry,
      server: { ...state.server }
    };
  }

  async function notify(previous, reason) {
    const next = publicSnapshot();
    for (const listener of listeners) {
      await listener(next, previous, reason);
    }
  }

  async function reloadFromDisk(reason = 'manual') {
    if (reloadInFlight) return await reloadInFlight;
    reloadInFlight = (async () => {
      const previousState = state;
      let candidatePublished = false;
      try {
        const content = await fs.promises.readFile(configPath, 'utf8');
        const next = buildState(content);
        if (state?.hash === next.hash) return { changed: false, snapshot: publicSnapshot() };
        const previous = state ? publicSnapshot() : null;
        state = next;
        candidatePublished = true;
        await notify(previous, reason);
        return { changed: true, snapshot: publicSnapshot() };
      } catch (error) {
        if (!previousState) throw error;
        const lastError = String(error?.message || error);
        state = { ...(candidatePublished ? previousState : state), lastError };
        console.error(`[workspace-registry] keeping last synchronized config: ${lastError}`);
        return { changed: false, error, snapshot: publicSnapshot() };
      } finally {
        reloadInFlight = null;
      }
    })();
    return await reloadInFlight;
  }

  async function waitForActiveReload() {
    const activeReload = reloadInFlight;
    return activeReload ? await activeReload : null;
  }

  async function reloadAfterSelfWrite() {
    const activeResult = await waitForActiveReload();
    if (activeResult?.error) throw activeResult.error;
    const result = await reloadFromDisk('self-write');
    if (result.error) throw result.error;
    return result;
  }

  function enqueueGrant(task) {
    const result = grantQueue.then(task, task);
    grantQueue = result.catch(() => {});
    return result;
  }

  const initialContent = fs.readFileSync(configPath, 'utf8');
  state = buildState(initialContent);

  const watchListener = () => {
    if (!closed) reloadFromDisk('watch').catch(error => console.error(`[workspace-registry] reload failed: ${error.message}`));
  };
  fs.watchFile(configPath, { interval: watchIntervalMs, persistent: false }, watchListener);

  return {
    snapshot: publicSnapshot,
    contains(candidatePath) {
      if (!candidatePath) return false;
      let normalized;
      try { normalized = normalizeWorkspacePath(candidatePath, { platform }); } catch { return false; }
      return state.roots.some(root => isPathInsideWorkspace(root, normalized, { platform }));
    },
    async ensureTrustedPath(targetPath, kind = 'directory') {
      if (!isAbsoluteWorkspacePath(targetPath, { platform })) {
        return { added: false, absolute: false, root: null, snapshot: publicSnapshot() };
      }
      const root = deriveWorkspaceRoot(targetPath, kind, { platform });
      await waitForActiveReload();
      if (state.roots.some(existing => isPathInsideWorkspace(existing, root, { platform }))) {
        return { added: false, absolute: true, root, snapshot: publicSnapshot() };
      }
      return await enqueueGrant(async () => {
        await waitForActiveReload();
        if (state.roots.some(existing => isPathInsideWorkspace(existing, root, { platform }))) {
          return { added: false, absolute: true, root, snapshot: publicSnapshot() };
        }
        const result = await persistTrustedRoot(configPath, root, { ...options, repoRoot, env, platform });
        await reloadAfterSelfWrite();
        if (!state.roots.some(existing => isPathInsideWorkspace(existing, root, { platform }))) {
          throw new Error(`Trusted root synchronization failed: ${root}`);
        }
        return { ...result, absolute: true, root, snapshot: publicSnapshot() };
      });
    },
    reloadFromDisk,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      fs.unwatchFile(configPath, watchListener);
      listeners.clear();
    }
  };
}

export function classifyWorkspaceChange(next, previous) {
  return {
    rootsChanged: !previous || next.rootsSignature !== previous.rootsSignature,
    upstreamChanged: !previous || next.upstreamSignature !== previous.upstreamSignature
  };
}
