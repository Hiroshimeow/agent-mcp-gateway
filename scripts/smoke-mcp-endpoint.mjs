import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = process.env.MCP_SMOKE_URL || `http://${process.env.MCP_GATEWAY_HOST || '127.0.0.1'}:${process.env.MCP_GATEWAY_PORT || '8101'}/mcp`;
const token = process.env.MCP_BEARER_TOKEN;

if (!token) throw new Error('MCP_BEARER_TOKEN is required for smoke:mcp');

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { authorization: `Bearer ${token}` } }
});
const client = new Client(
  { name: 'agent-mcp-gateway-modern-smoke', version: '1.0.0' },
  { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } }
);

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
  if (!dataLines.length) throw new Error(`Unexpected MCP response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(dataLines.join('\n'));
}

let rawId = 100;
async function extensionRequest(method, params = {}) {
  rawId += 1;
  const body = {
    jsonrpc: '2.0',
    id: rawId,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'agent-mcp-gateway-modern-smoke', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {}
      }
    }
  };
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method
  };
  if (params.uri) headers['mcp-name'] = params.uri;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text.slice(0, 500)}`);
  const message = parseMcpResponse(text);
  if (message?.error) throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
  return message?.result;
}

try {
  await client.connect(transport);
  if (client.getProtocolEra() !== 'modern') throw new Error(`Expected modern MCP era, got ${client.getProtocolEra()}`);
  const capabilities = client.getServerCapabilities?.() || {};
  if (!capabilities.resources) throw new Error('Modern MCP resources capability is missing');
  if (!capabilities.extensions?.['io.modelcontextprotocol/skills']) throw new Error('Skills extension capability is missing');

  const tools = (await client.listTools()).tools || [];
  const requiredTools = ['read_text_file', 'write_file', 'edit_file', 'shell_execute', 'image_preview', 'skill_catalog', 'load_skill'];
  const missingTools = requiredTools.filter(name => !tools.some(tool => tool.name === name));
  if (missingTools.length) throw new Error(`Missing expected tools: ${missingTools.join(', ')}`);
  const removedLegacySkillTool = ['get', 'skill'].join('_');
  if (tools.some(tool => tool.name === removedLegacySkillTool)) throw new Error('Legacy skill loader is still exposed');

  const skillsList = await extensionRequest('skills/list');
  const ponytail = skillsList.skills?.find(skill => skill.uri === 'skill://skills/ponytail/SKILL.md');
  if (!ponytail || ponytail.body !== undefined) throw new Error('skills/list did not expose ponytail as metadata-only entry');

  const skillGet = await extensionRequest('skills/get', { uri: ponytail.uri });
  if (skillGet.skill?.uri !== ponytail.uri || skillGet.skill?.body !== undefined) throw new Error('skills/get did not return the expected stable skill entry');

  const resource = await client.readResource({ uri: ponytail.uri });
  if (!resource.contents?.[0]?.text?.includes('name: ponytail')) throw new Error('resources/read did not return ponytail SKILL.md');

  const catalogResult = await client.callTool({ name: 'skill_catalog', arguments: {} });
  const catalogPayload = catalogResult.structuredContent || JSON.parse(catalogResult.content?.[0]?.text || '{}');
  if (!catalogPayload?.data?.skills?.some(skill => skill.name === 'ponytail')) throw new Error('skill_catalog did not include ponytail');

  const loadResult = await client.callTool({ name: 'load_skill', arguments: { name: 'ponytail' } });
  const loadPayload = loadResult.structuredContent || JSON.parse(loadResult.content?.[0]?.text || '{}');
  if (!loadPayload?.data?.body) throw new Error('load_skill returned no skill body');

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    protocolEra: client.getProtocolEra(),
    protocolVersion: client.getNegotiatedProtocolVersion?.(),
    extension: 'io.modelcontextprotocol/skills',
    skillCount: skillsList.skills?.length || 0,
    toolCount: tools.length,
    checkedTools: requiredTools
  }, null, 2));
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
