import { loadExternalMcpConfig } from './config.mjs';
import { createStdioUpstreamClient } from './stdio-client.mjs';
import { createHttpUpstreamClient } from './http-client.mjs';
import { createCatalogSnapshot, createCatalogState } from './catalog-cache.mjs';
import { toExternalToolName, toExternalPromptName, assertNoNameCollision } from './names.mjs';
import { encodeUpstreamResourceUri, isExternalResourceUri, parseExternalResourceUri, toExternalResourceUri } from './resource-uri.mjs';
import { diagnosticsResource, summarizeDiagnostics } from './diagnostics.mjs';

function safeError(error) {
  return String(error?.message || error || '').slice(0, 1000);
}

function upstreamToolMeta(server, upstreamName) {
  return { upstreamId: server.id, upstreamToolName: upstreamName, transport: server.transport, source: 'external-mcp' };
}

function upstreamPromptMeta(server, upstreamName) {
  return { upstreamId: server.id, upstreamPromptName: upstreamName, transport: server.transport, source: 'external-mcp' };
}

function upstreamResourceMeta(server, upstreamUri) {
  return { upstreamId: server.id, upstreamUri, transport: server.transport, source: 'external-mcp' };
}

function timeout(ms, label) {
  return new Promise(resolve => {
    setTimeout(() => resolve({ timedOut: true, label }), Math.max(0, ms));
  });
}

export async function closeClientWithTimeout(client, defaultShutdownTimeoutMs = 5000) {
  const result = await Promise.race([
    client.close().then(() => ({ ok: true })).catch(error => ({ ok: false, error: safeError(error) })),
    timeout(client.config?.shutdownTimeoutMs ?? defaultShutdownTimeoutMs, `upstream ${client.id} close`)
  ]);
  if (result?.timedOut) {
    console.log(`[external-mcp] ${client.id} close timed out`);
    client.kill?.('SIGTERM');
    if (typeof client.isRunning === 'function') {
      const killTimer = setTimeout(() => {
        if (client.isRunning?.()) client.kill?.('SIGKILL');
      }, 1000);
      killTimer.unref?.();
    }
  }
  if (result?.error) console.log(`[external-mcp] ${client.id} close failed: ${result.error}`);
}

async function safeList(server, kind, fn, emptyResult = {}) {
  try {
    return { ok: true, result: await fn(), error: null };
  } catch (error) {
    return { ok: false, result: emptyResult, error: `${kind}: ${safeError(error)}` };
  }
}

function hasCapability(client, capability) {
  return Boolean(client?.capabilities?.[capability]);
}

function skippedList(emptyResult = {}) {
  return { ok: true, result: emptyResult, error: null, skipped: true };
}

function addServerStatus(statuses, server, patch) {
  const previous = statuses.get(server.id) || {};
  statuses.set(server.id, {
    enabled: true,
    available: previous.available ?? true,
    transport: server.transport,
    startedAt: previous.startedAt || null,
    toolCount: previous.toolCount || 0,
    resourceCount: previous.resourceCount || 0,
    resourceTemplateCount: previous.resourceTemplateCount || 0,
    promptCount: previous.promptCount || 0,
    lastError: previous.lastError || null,
    lastRefreshError: previous.lastRefreshError || null,
    lastCatalogRefreshAt: previous.lastCatalogRefreshAt || null,
    ...patch
  });
}

export async function buildExternalCatalog({ servers, clients, localToolNames = [], localPromptNames = [], generation = 0, statuses = new Map() }) {
  const snapshot = createCatalogSnapshot({ generation, builtAt: new Date().toISOString() });
  const toolNames = new Set(localToolNames);
  const promptNames = new Set(localPromptNames);
  const resourceUris = new Set();
  const serverDiagnostics = new Map();

  for (const server of servers) {
    const client = clients.get(server.id);
    if (!client) {
      const previous = statuses.get(server.id);
      const error = previous?.lastError || 'External MCP upstream unavailable';
      serverDiagnostics.set(server.id, { error });
      addServerStatus(statuses, server, { available: false, lastRefreshError: error, lastError: error });
      continue;
    }

    const supportsResources = hasCapability(client, 'resources');
    const supportsPrompts = hasCapability(client, 'prompts');
    const [toolList, resourceList, templateList, promptList] = await Promise.all([
      safeList(server, 'tools/list', () => client.listTools(), { tools: [] }),
      supportsResources ? safeList(server, 'resources/list', () => client.listResources(), { resources: [] }) : skippedList({ resources: [] }),
      supportsResources ? safeList(server, 'resources/templates/list', () => client.listResourceTemplates(), { resourceTemplates: [] }) : skippedList({ resourceTemplates: [] }),
      supportsPrompts ? safeList(server, 'prompts/list', () => client.listPrompts(), { prompts: [] }) : skippedList({ prompts: [] })
    ]);

    const errors = [toolList, resourceList, templateList, promptList].filter(item => !item.ok).map(item => item.error);
    if (errors.length > 0) {
      const error = errors.join('; ');
      serverDiagnostics.set(server.id, { error });
      addServerStatus(statuses, server, {
        available: true,
        lastRefreshError: error,
        lastError: error,
        lastCatalogRefreshAt: snapshot.builtAt
      });
      throw new Error(`External MCP catalog refresh failed for ${server.id}: ${error}`);
    } else {
      serverDiagnostics.set(server.id, { error: null });
    }

    for (const tool of toolList.result.tools || []) {
      const exposedName = toExternalToolName(server.toolPrefix, tool.name);
      assertNoNameCollision(exposedName, toolNames, 'tool');
      const exposed = {
        ...tool,
        name: exposedName,
        _meta: {
          ...(tool._meta || {}),
          upstream: upstreamToolMeta(server, tool.name)
        }
      };
      snapshot.tools.push(exposed);
      snapshot.toolRoutes.set(exposedName, { serverId: server.id, upstreamToolName: tool.name, tool: exposed });
    }

    for (const resource of resourceList.result.resources || []) {
      const exposedUri = toExternalResourceUri(server.id, resource.uri);
      if (resourceUris.has(exposedUri)) throw new Error(`External MCP resource URI collision: ${exposedUri}`);
      resourceUris.add(exposedUri);
      snapshot.resources.push({
        ...resource,
        uri: exposedUri,
        _meta: { ...(resource._meta || {}), upstream: upstreamResourceMeta(server, resource.uri) }
      });
      snapshot.resourceRoutes.set(exposedUri, { serverId: server.id, upstreamUri: resource.uri });
    }

    const upstreamTemplates = templateList.result.resourceTemplates || [];
    if (upstreamTemplates.length > 0) {
      snapshot.resourceTemplates.push({
        uriTemplate: `external-mcp://${server.id}/{encodedUpstreamUri}`,
        name: `${server.id} external resource`,
        description: `Read an encoded upstream resource URI from ${server.id}. Upstream templates are listed in _meta.upstream.resourceTemplates.`,
        mimeType: 'application/octet-stream',
        _meta: {
          upstream: {
            upstreamId: server.id,
            source: 'external-mcp',
            routeFormat: `external-mcp://${server.id}/<base64url-upstream-uri>`,
            resourceTemplates: upstreamTemplates.map(template => ({
              name: template.name || null,
              uriTemplate: template.uriTemplate,
              mimeType: template.mimeType || null,
              description: template.description || null,
              encodedTemplate: encodeUpstreamResourceUri(template.uriTemplate)
            }))
          }
        }
      });
    }

    for (const prompt of promptList.result.prompts || []) {
      const exposedName = toExternalPromptName(server.toolPrefix, prompt.name);
      assertNoNameCollision(exposedName, promptNames, 'prompt');
      snapshot.prompts.push({
        ...prompt,
        name: exposedName,
        _meta: { ...(prompt._meta || {}), upstream: upstreamPromptMeta(server, prompt.name) }
      });
      snapshot.promptRoutes.set(exposedName, { serverId: server.id, upstreamPromptName: prompt.name });
    }

    addServerStatus(statuses, server, {
      available: true,
      toolCount: (toolList.result.tools || []).length,
      resourceCount: (resourceList.result.resources || []).length,
      resourceTemplateCount: upstreamTemplates.length,
      promptCount: (promptList.result.prompts || []).length,
      lastError: errors.length ? errors.join('; ') : null,
      lastRefreshError: errors.length ? errors.join('; ') : null,
      lastCatalogRefreshAt: snapshot.builtAt
    });
  }

  snapshot.diagnostics = Object.fromEntries(serverDiagnostics.entries());
  return snapshot;
}

function serverSignature(server) {
  return JSON.stringify({
    transport: server.transport,
    toolPrefix: server.toolPrefix,
    command: server.command,
    args: server.args || [],
    cwd: server.cwd,
    url: server.url,
    bearerTokenEnv: server.bearerTokenEnv,
    startupTimeoutMs: server.startupTimeoutMs,
    shutdownTimeoutMs: server.shutdownTimeoutMs
  });
}

function catalogKeys(snapshot) {
  return {
    tools: (snapshot.tools || []).map(item => item.name).sort().join('\n'),
    resources: (snapshot.resources || []).map(item => item.uri).sort().join('\n') + '\n' +
      (snapshot.resourceTemplates || []).map(item => item.uriTemplate).sort().join('\n'),
    prompts: (snapshot.prompts || []).map(item => item.name).sort().join('\n')
  };
}

export async function createExternalMcpManager({
  env = process.env,
  repoRoot = process.cwd(),
  localToolNames = [],
  localPromptNames = [],
  onCatalogChanged = async () => {},
  clientFactory = null
} = {}) {
  let config = await loadExternalMcpConfig({ env, repoRoot });
  let servers = config.servers;
  let clients = new Map();
  let statuses = new Map();
  const createClient = clientFactory || (async server => server.transport === 'stdio'
    ? await createStdioUpstreamClient(server)
    : await createHttpUpstreamClient(server));

  async function markFailureIn(statusMap, configValue, server, error) {
    addServerStatus(statusMap, server, {
      available: false,
      startedAt: null,
      toolCount: 0,
      resourceCount: 0,
      resourceTemplateCount: 0,
      promptCount: 0,
      lastError: safeError(error),
      lastRefreshError: safeError(error)
    });
    if (configValue.external.fail_gateway_on_startup_error) throw error;
  }

  async function startServerInto(server, clientMap, statusMap, configValue, { allowUnavailable = true } = {}) {
    try {
      const client = await createClient(server);
      clientMap.set(server.id, client);
      addServerStatus(statusMap, server, {
        enabled: true,
        available: true,
        startedAt: new Date().toISOString(),
        lastError: null,
        lastRefreshError: null
      });
      return client;
    } catch (error) {
      console.log(`[external-mcp] ${server.id} unavailable: ${safeError(error)}`);
      await markFailureIn(statusMap, configValue, server, error);
      if (!allowUnavailable) throw error;
      return null;
    }
  }

  for (const server of servers) await startServerInto(server, clients, statuses, config);

  const catalogState = createCatalogState();
  const knownExternalToolNames = new Set();
  const knownExternalPromptNames = new Set();

  async function commitRefresh({ notify = true } = {}) {
    const nextGeneration = catalogState.generation + 1;
    const candidateStatuses = new Map(statuses);
    const candidate = await buildExternalCatalog({
      servers,
      clients,
      localToolNames,
      localPromptNames,
      generation: nextGeneration,
      statuses: candidateStatuses
    });
    for (const [id, status] of candidateStatuses.entries()) statuses.set(id, status);
    const previous = catalogState.snapshot;
    catalogState.snapshot = candidate;
    catalogState.generation = nextGeneration;
    catalogState.lastRefreshAt = candidate.builtAt;
    catalogState.lastRefreshError = null;
    for (const tool of candidate.tools) knownExternalToolNames.add(tool.name);
    for (const prompt of candidate.prompts) knownExternalPromptNames.add(prompt.name);
    for (const server of servers) {
      const status = statuses.get(server.id);
      console.log(`[external-mcp] ${server.id} catalog tools=${status?.toolCount || 0} resources=${status?.resourceCount || 0} prompts=${status?.promptCount || 0}`);
    }
    if (notify) {
      const before = catalogKeys(previous);
      const after = catalogKeys(candidate);
      const changes = {
        toolsChanged: before.tools !== after.tools,
        resourcesChanged: before.resources !== after.resources,
        promptsChanged: before.prompts !== after.prompts
      };
      if (changes.toolsChanged || changes.resourcesChanged || changes.promptsChanged) {
        await onCatalogChanged(changes);
      }
    }
    return candidate;
  }

  async function refreshCatalog(options = {}) {
    if (catalogState.refreshInFlight) return await catalogState.refreshInFlight;
    catalogState.refreshInFlight = (async () => {
      try {
        return await commitRefresh(options);
      } catch (error) {
        catalogState.lastRefreshError = safeError(error);
        return catalogState.snapshot;
      } finally {
        catalogState.refreshInFlight = null;
      }
    })();
    return await catalogState.refreshInFlight;
  }

  await refreshCatalog({ notify: false });
  if (catalogState.lastRefreshError && config.external.fail_gateway_on_startup_error) throw new Error(catalogState.lastRefreshError);

  async function snapshotForCatalogList() {
    const mode = config.external.catalog_cache;
    if (mode === 'startup') return catalogState.snapshot;
    if (mode === 'none') return await refreshCatalog({ notify: false });
    const last = catalogState.lastRefreshAt ? Date.parse(catalogState.lastRefreshAt) : 0;
    if (Date.now() - last <= config.external.catalog_cache_ttl_ms) return catalogState.snapshot;
    return await refreshCatalog({ notify: false });
  }

  function currentSnapshot() {
    return catalogState.snapshot;
  }

  async function reconcile(nextConfig) {
    const resolvedConfig = nextConfig || await loadExternalMcpConfig({ env, repoRoot });
    if (catalogState.refreshInFlight) await catalogState.refreshInFlight;

    const previousServers = servers;
    const previousClients = clients;
    const previousStatuses = statuses;
    const previousSnapshot = catalogState.snapshot;
    const previousGeneration = catalogState.generation;
    const previousById = new Map(previousServers.map(server => [server.id, server]));
    const nextServers = resolvedConfig.servers;
    const nextById = new Map(nextServers.map(server => [server.id, server]));
    const candidateClients = new Map();
    const candidateStatuses = new Map(previousStatuses);
    const stagedClients = [];
    let candidate;

    try {
      for (const next of nextServers) {
        const previous = previousById.get(next.id);
        const unchanged = previous && serverSignature(previous) === serverSignature(next);
        const committedClient = previousClients.get(next.id);
        if (unchanged && committedClient) {
          candidateClients.set(next.id, committedClient);
          continue;
        }
        const staged = await startServerInto(next, candidateClients, candidateStatuses, resolvedConfig, { allowUnavailable: false });
        if (staged) stagedClients.push(staged);
      }

      for (const previous of previousServers) {
        if (nextById.has(previous.id)) continue;
        const prior = candidateStatuses.get(previous.id) || {};
        candidateStatuses.set(previous.id, {
          ...prior,
          enabled: false,
          available: false,
          toolCount: 0,
          resourceCount: 0,
          resourceTemplateCount: 0,
          promptCount: 0,
          lastError: null,
          lastRefreshError: null
        });
      }

      candidate = await buildExternalCatalog({
        servers: nextServers,
        clients: candidateClients,
        localToolNames,
        localPromptNames,
        generation: previousGeneration + 1,
        statuses: candidateStatuses
      });
    } catch (error) {
      await Promise.all(stagedClients.map(client => closeClientWithTimeout(client, resolvedConfig.external.shutdown_timeout_ms)));
      catalogState.lastRefreshError = safeError(error);
      throw new Error(`External MCP reconcile failed; committed topology preserved: ${safeError(error)}`);
    }

    config = resolvedConfig;
    servers = nextServers;
    clients = candidateClients;
    statuses = candidateStatuses;
    catalogState.snapshot = candidate;
    catalogState.generation = candidate.generation;
    catalogState.lastRefreshAt = candidate.builtAt;
    catalogState.lastRefreshError = null;
    for (const tool of candidate.tools) knownExternalToolNames.add(tool.name);
    for (const prompt of candidate.prompts) knownExternalPromptNames.add(prompt.name);

    const retiredClients = [];
    for (const [id, client] of previousClients.entries()) {
      if (candidateClients.get(id) !== client) retiredClients.push(client);
    }
    await Promise.all(retiredClients.map(client => closeClientWithTimeout(client, resolvedConfig.external.shutdown_timeout_ms)));

    const before = catalogKeys(previousSnapshot);
    const after = catalogKeys(candidate);
    const changes = {
      toolsChanged: before.tools !== after.tools,
      resourcesChanged: before.resources !== after.resources,
      promptsChanged: before.prompts !== after.prompts
    };
    if (changes.toolsChanged || changes.resourcesChanged || changes.promptsChanged) {
      await Promise.resolve(onCatalogChanged(changes)).catch(error => {
        console.log(`[external-mcp] catalog notification failed: ${safeError(error)}`);
      });
    }
    return candidate;
  }

  function diagnosticsList() {
    return [
      { uri: 'external-mcp://_diagnostics/status', name: 'External MCP diagnostics', mimeType: 'application/json' },
      ...[...statuses.keys()].map(id => ({ uri: `external-mcp://${id}/status`, name: `External MCP ${id} status`, mimeType: 'application/json' }))
    ];
  }

  return {
    get config() { return config; },
    async listAllToolsUnfiltered() { return [...(await snapshotForCatalogList()).tools]; },
    async listToolsForProfile() { return [...(await snapshotForCatalogList()).tools]; },
    hasTool(name) { return currentSnapshot().toolRoutes.has(name); },
    isExternalToolName(name) { return currentSnapshot().toolRoutes.has(name) || knownExternalToolNames.has(name); },
    isExternalPromptName(name) { return currentSnapshot().promptRoutes.has(name) || knownExternalPromptNames.has(name); },
    assertToolAllowedForProfile(name) {
      return currentSnapshot().toolRoutes.has(name);
    },
    async callTool(name, args = {}) {
      const route = currentSnapshot().toolRoutes.get(name);
      if (!route) throw new Error(`Unknown external MCP tool: ${name}`);
      const client = clients.get(route.serverId);
      if (!client) throw new Error(`External MCP upstream unavailable: ${route.serverId}`);
      return await client.callTool({ name: route.upstreamToolName, arguments: args });
    },
    async listResources() {
      return [...diagnosticsList(), ...(await snapshotForCatalogList()).resources];
    },
    async listResourceTemplates() { return [...(await snapshotForCatalogList()).resourceTemplates]; },
    async readResource(uri) {
      if (!isExternalResourceUri(uri)) throw new Error(`Unsupported external MCP resource URI: ${uri}`);
      const parsed = parseExternalResourceUri(uri);
      if (parsed.diagnostics && parsed.serverId === '_diagnostics') return diagnosticsResource(uri, summarizeDiagnostics(statuses, catalogState, config));
      if (parsed.diagnostics) return diagnosticsResource(uri, statuses.get(parsed.serverId) || { enabled: false, available: false, lastError: 'Unknown upstream' });
      const route = currentSnapshot().resourceRoutes.get(uri) || { serverId: parsed.serverId, upstreamUri: parsed.upstreamUri };
      const client = clients.get(route.serverId);
      if (!client) throw new Error(`External MCP upstream unavailable: ${route.serverId}`);
      const result = await client.readResource({ uri: route.upstreamUri });
      return {
        ...result,
        contents: (result.contents || []).map(content => ({
          ...content,
          uri,
          _meta: { ...(content._meta || {}), upstream: { upstreamId: route.serverId, upstreamUri: route.upstreamUri, source: 'external-mcp' } }
        }))
      };
    },
    async listPrompts() { return [...(await snapshotForCatalogList()).prompts]; },
    hasPrompt(name) { return currentSnapshot().promptRoutes.has(name); },
    async getPrompt(name, args = {}) {
      const route = currentSnapshot().promptRoutes.get(name);
      if (!route) throw new Error(`Unknown external MCP prompt: ${name}`);
      const client = clients.get(route.serverId);
      if (!client) throw new Error(`External MCP upstream unavailable: ${route.serverId}`);
      return await client.getPrompt({ name: route.upstreamPromptName, arguments: args });
    },
    getDiagnostics() { return summarizeDiagnostics(statuses, catalogState, config); },
    reconcile,
    async shutdown() {
      await Promise.all([...clients.values()].map(client => closeClientWithTimeout(client, config.external.shutdown_timeout_ms)));
    },
    _refreshForTests: refreshCatalog,
    _reconcileForTests: reconcile,
    _catalogStateForTests: catalogState
  };
}
