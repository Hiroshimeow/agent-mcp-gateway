import { loadExternalMcpConfig } from './config.mjs';
import { createStdioUpstreamClient } from './stdio-client.mjs';
import { createHttpUpstreamClient } from './http-client.mjs';
import { createCatalogCache } from './catalog-cache.mjs';
import { toExternalToolName, toExternalPromptName, assertNoNameCollision } from './names.mjs';
import { isExternalResourceUri, parseExternalResourceUri, toExternalResourceUri } from './resource-uri.mjs';
import { diagnosticsResource, summarizeDiagnostics } from './diagnostics.mjs';

function safeError(error) {
  return String(error?.message || error || '').slice(0, 1000);
}

function upstreamMeta(server, upstreamName) {
  return { upstreamId: server.id, upstreamToolName: upstreamName, transport: server.transport, source: 'external-mcp' };
}

async function safeList(fn) {
  try { return await fn(); } catch { return {}; }
}

export async function createExternalMcpManager({ env = process.env, repoRoot = process.cwd(), localToolNames = [], localPromptNames = [] } = {}) {
  const config = await loadExternalMcpConfig({ env, repoRoot });
  const clients = new Map();
  const statuses = new Map();
  const cache = createCatalogCache();
  const toolNames = new Set(localToolNames);
  const promptNames = new Set(localPromptNames);

  async function markFailure(server, error) {
    statuses.set(server.id, {
      enabled: true,
      available: false,
      transport: server.transport,
      startedAt: null,
      toolCount: 0,
      resourceCount: 0,
      promptCount: 0,
      lastError: safeError(error)
    });
    if (config.external.fail_gateway_on_startup_error) throw error;
  }

  for (const server of config.servers) {
    try {
      const client = server.transport === 'stdio'
        ? await createStdioUpstreamClient(server)
        : await createHttpUpstreamClient(server);
      clients.set(server.id, client);
      const [toolResult, resourceResult, templateResult, promptResult] = await Promise.all([
        safeList(() => client.listTools()),
        safeList(() => client.listResources()),
        safeList(() => client.listResourceTemplates()),
        safeList(() => client.listPrompts())
      ]);

      for (const tool of toolResult.tools || []) {
        const exposedName = toExternalToolName(server.toolPrefix, tool.name);
        assertNoNameCollision(exposedName, toolNames, 'tool');
        const exposed = {
          ...tool,
          name: exposedName,
          _meta: {
            ...(tool._meta || {}),
            upstream: upstreamMeta(server, tool.name)
          }
        };
        cache.tools.push(exposed);
        cache.toolRoutes.set(exposedName, { serverId: server.id, upstreamToolName: tool.name, tool: exposed });
      }

      for (const resource of resourceResult.resources || []) {
        const exposedUri = toExternalResourceUri(server.id, resource.uri);
        cache.resources.push({
          ...resource,
          uri: exposedUri,
          _meta: { ...(resource._meta || {}), upstream: { upstreamId: server.id, upstreamUri: resource.uri, source: 'external-mcp' } }
        });
        cache.resourceRoutes.set(exposedUri, { serverId: server.id, upstreamUri: resource.uri });
      }

      for (const template of templateResult.resourceTemplates || []) {
        cache.resourceTemplates.push({
          ...template,
          uriTemplate: `external-mcp://${server.id}/{encodedUpstreamUri}`,
          name: template.name ? `${server.id}: ${template.name}` : `${server.id} resource template`,
          _meta: { ...(template._meta || {}), upstream: { upstreamId: server.id, upstreamUriTemplate: template.uriTemplate, source: 'external-mcp' } }
        });
      }

      for (const prompt of promptResult.prompts || []) {
        const exposedName = toExternalPromptName(server.toolPrefix, prompt.name);
        assertNoNameCollision(exposedName, promptNames, 'prompt');
        cache.prompts.push({ ...prompt, name: exposedName, _meta: { ...(prompt._meta || {}), upstream: { upstreamId: server.id, upstreamPromptName: prompt.name, source: 'external-mcp' } } });
        cache.promptRoutes.set(exposedName, { serverId: server.id, upstreamPromptName: prompt.name });
      }

      statuses.set(server.id, {
        enabled: true,
        available: true,
        transport: server.transport,
        startedAt: new Date().toISOString(),
        toolCount: (toolResult.tools || []).length,
        resourceCount: (resourceResult.resources || []).length,
        promptCount: (promptResult.prompts || []).length,
        lastError: null
      });
      console.log(`[external-mcp] ${server.id} available tools=${(toolResult.tools || []).length} resources=${(resourceResult.resources || []).length} prompts=${(promptResult.prompts || []).length}`);
    } catch (error) {
      console.log(`[external-mcp] ${server.id} unavailable: ${safeError(error)}`);
      await markFailure(server, error);
    }
  }

  return {
    config,
    listAllToolsUnfiltered() { return [...cache.tools]; },
    listToolsForProfile() { return [...cache.tools]; },
    hasTool(name) { return cache.toolRoutes.has(name); },
    assertToolAllowedForProfile(name) {
      return cache.toolRoutes.has(name);
    },
    async callTool(name, args = {}) {
      const route = cache.toolRoutes.get(name);
      if (!route) throw new Error(`Unknown external MCP tool: ${name}`);
      const client = clients.get(route.serverId);
      if (!client) throw new Error(`External MCP upstream unavailable: ${route.serverId}`);
      return await client.callTool({ name: route.upstreamToolName, arguments: args });
    },
    listResources() {
      const diagnostics = [
        { uri: 'external-mcp://_diagnostics/status', name: 'External MCP diagnostics', mimeType: 'application/json' },
        ...[...statuses.keys()].map(id => ({ uri: `external-mcp://${id}/status`, name: `External MCP ${id} status`, mimeType: 'application/json' }))
      ];
      return [...diagnostics, ...cache.resources];
    },
    listResourceTemplates() { return [...cache.resourceTemplates]; },
    async readResource(uri) {
      if (!isExternalResourceUri(uri)) throw new Error(`Unsupported external MCP resource URI: ${uri}`);
      const parsed = parseExternalResourceUri(uri);
      if (parsed.diagnostics && parsed.serverId === '_diagnostics') return diagnosticsResource(uri, summarizeDiagnostics(statuses));
      if (parsed.diagnostics) return diagnosticsResource(uri, statuses.get(parsed.serverId) || { enabled: false, available: false, lastError: 'Unknown upstream' });
      const client = clients.get(parsed.serverId);
      if (!client) throw new Error(`External MCP upstream unavailable: ${parsed.serverId}`);
      const result = await client.readResource({ uri: parsed.upstreamUri });
      return {
        ...result,
        contents: (result.contents || []).map(content => ({
          ...content,
          uri,
          _meta: { ...(content._meta || {}), upstream: { upstreamId: parsed.serverId, upstreamUri: parsed.upstreamUri, source: 'external-mcp' } }
        }))
      };
    },
    listPrompts() { return [...cache.prompts]; },
    hasPrompt(name) { return cache.promptRoutes.has(name); },
    async getPrompt(name, args = {}) {
      const route = cache.promptRoutes.get(name);
      if (!route) throw new Error(`Unknown external MCP prompt: ${name}`);
      const client = clients.get(route.serverId);
      if (!client) throw new Error(`External MCP upstream unavailable: ${route.serverId}`);
      return await client.getPrompt({ name: route.upstreamPromptName, arguments: args });
    },
    getDiagnostics() { return summarizeDiagnostics(statuses); },
    async shutdown() {
      await Promise.all([...clients.values()].map(client => client.close().catch(() => {})));
    }
  };
}
