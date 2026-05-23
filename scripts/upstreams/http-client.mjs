import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function createHttpUpstreamClient(serverConfig) {
  const headers = {};
  if (serverConfig.bearerToken) headers.authorization = `Bearer ${serverConfig.bearerToken}`;
  const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    requestInit: Object.keys(headers).length ? { headers } : undefined
  });
  const client = new Client({ name: `agent-mcp-gateway-upstream-${serverConfig.id}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    id: serverConfig.id,
    config: serverConfig,
    client,
    transport,
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
