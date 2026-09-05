import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

// SDK 1.29 callTool() validates structured errors against the success output schema.
async function callToolPreservingStructuredErrors(client, params) {
  if (client.isToolTaskRequired(params.name)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Tool "${params.name}" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.`
    );
  }
  const result = await client.request({ method: 'tools/call', params }, CallToolResultSchema);
  const validator = client.getToolOutputValidator(params.name);
  if (validator && !result.isError) {
    if (!result.structuredContent) {
      throw new McpError(ErrorCode.InvalidRequest, `Tool ${params.name} has an output schema but did not return structured content`);
    }
    const validationResult = validator(result.structuredContent);
    if (!validationResult.valid) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Structured content does not match the tool's output schema: ${validationResult.errorMessage}`
      );
    }
  }
  return result;
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
    async callTool(params) { return await callToolPreservingStructuredErrors(client, params); },
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
