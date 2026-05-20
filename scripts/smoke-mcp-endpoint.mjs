const endpoint = process.env.MCP_SMOKE_URL || `http://${process.env.MCP_GATEWAY_HOST || '127.0.0.1'}:${process.env.MCP_GATEWAY_PORT || '8101'}/mcp`;
const token = process.env.MCP_BEARER_TOKEN || process.env.MCP_AUTH_PASSWORD;

if (!token) {
  throw new Error('MCP_BEARER_TOKEN or MCP_AUTH_PASSWORD is required for smoke:mcp');
}

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  if (dataLines.length === 0) {
    throw new Error(`Unexpected MCP response: ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(dataLines.join('\n'));
}

async function mcpRequest(payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return parseMcpResponse(text);
}

const initialize = await mcpRequest({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'agent-mcp-gateway-smoke', version: '1.0.0' }
  }
});

if (!initialize?.result?.serverInfo) {
  throw new Error('MCP initialize did not return serverInfo');
}

const toolsList = await mcpRequest({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {}
});

const tools = toolsList?.result?.tools || [];
const requiredTools = ['custom_list_projects', 'custom_git_status', 'custom_grep', 'custom_run_tests'];
const missingTools = requiredTools.filter(name => !tools.some(tool => tool.name === name));
if (missingTools.length > 0) {
  throw new Error(`Missing expected tools: ${missingTools.join(', ')}`);
}

const projectResult = await mcpRequest({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'custom_list_projects',
    arguments: {}
  }
});

if (!projectResult?.result?.content?.length) {
  throw new Error('custom_list_projects returned no content');
}

console.log(
  JSON.stringify(
    {
      ok: true,
      endpoint,
      server: initialize.result.serverInfo,
      toolCount: tools.length,
      checkedTools: requiredTools
    },
    null,
    2
  )
);
