import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as toml from 'smol-toml';

import {
  buildTrustedRootsProjectRegistryFromRaw,
  trustedRootsTomlToRaw
} from './projects/trusted-roots-projects.mjs';

const DEFAULT_WATCH_INTERVAL_MS = 500;

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

export function createWorkspaceRegistry(options = {}) {
  const configPath = path.resolve(options.configPath);
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const env = options.env || process.env;
  const watchIntervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const listeners = new Set();
  let closed = false;
  let state = null;
  let reloadInFlight = null;

  function buildState(content) {
    const rawConfig = toml.parse(content || '');
    const rawRoots = trustedRootsTomlToRaw(rawConfig.trusted_roots, { repoRoot });
    const projectRegistry = buildTrustedRootsProjectRegistryFromRaw(rawRoots, {
      defaultProjectId: env.MCP_DEFAULT_PROJECT_ID,
      requireProjectId: false,
      pathInference: true,
      exposeProjectPaths: String(env.MCP_EXPOSE_PROJECT_PATHS || '').toLowerCase() === 'true',
      checkExists: false
    });
    const roots = projectRegistry.allTrustedRoots.filter(root => fs.existsSync(root));
    return {
      configPath,
      content,
      hash: hashText(content),
      stateSignature: hashText(content),
      rawConfig,
      roots,
      rootsSignature: stableSignature(roots),
      upstreamSignature: stableSignature({
        external_mcp: rawConfig.external_mcp || {},
        mcp_servers: rawConfig.mcp_servers || {}
      }),
      projectRegistry,
      server: {
        name: rawConfig.server?.name || 'agent-mcp-gateway',
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
    if (reloadInFlight) {
      await reloadInFlight;
      return await reloadFromDisk(reason);
    }
    reloadInFlight = (async () => {
      const previousState = state;
      let candidatePublished = false;
      try {
        const content = await fs.promises.readFile(configPath, 'utf8');
        const next = buildState(content);
        if (state?.stateSignature === next.stateSignature) return { changed: false, snapshot: publicSnapshot() };
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

  const initialContent = fs.readFileSync(configPath, 'utf8');
  state = buildState(initialContent);

  const watchListener = () => {
    if (!closed) reloadFromDisk('watch').catch(error => console.error(`[workspace-registry] reload failed: ${error.message}`));
  };
  fs.watchFile(configPath, { interval: watchIntervalMs, persistent: false }, watchListener);

  return {
    snapshot: publicSnapshot,
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
