import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

export async function createHttpUpstreamClient(serverConfig) {
  const headers = {
    'accept': 'application/json, text/event-stream'
  };
  if (serverConfig.bearerToken) headers.authorization = `Bearer ${serverConfig.bearerToken}`;
  const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    requestInit: { headers }
  });
  const client = new Client({ name: `agent-mcp-gateway-upstream-${serverConfig.id}`, version: '1.0.0' }, { capabilities: {} });
  await withTimeout(client.connect(transport), serverConfig.startupTimeoutMs || 15000, `upstream ${serverConfig.id} initialize`);
  const capabilities = client.getServerCapabilities?.() || {};
  return {
    id: serverConfig.id,
    config: serverConfig,
    client,
    transport,
    capabilities,
    async listTools() { return await client.listTools(); },
    async callTool(params) { return await client.callTool(params); },
    async listResources() { return await client.listResources(); },
    async listResourceTemplates() { return await client.listResourceTemplates(); },
    async readResource(params) { return await client.readResource(params); },
    async listPrompts() { return await client.listPrompts(); },
    async getPrompt(params) { return await client.getPrompt(params); },
    async close() {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}
