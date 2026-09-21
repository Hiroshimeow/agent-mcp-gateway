import fs from 'node:fs';
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const statePath = process.argv[2] || process.env.DYNAMIC_MCP_STATE;
const countPath = process.argv[3] || process.env.DYNAMIC_MCP_COUNT;

function readState() {
  if (!statePath || !fs.existsSync(statePath)) return { tools: ['a'] };
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function bumpCount() {
  if (!countPath) return;
  let count = 0;
  try { count = Number(fs.readFileSync(countPath, 'utf8')) || 0; } catch {}
  fs.writeFileSync(countPath, String(count + 1));
}

const state = readState();
const capabilities = { tools: {} };
if (state.capabilities?.resources !== false) capabilities.resources = {};
if (state.capabilities?.prompts !== false) capabilities.prompts = {};

const server = new Server({ name: 'dynamic-upstream', version: '1.0.0' }, { capabilities });

server.setRequestHandler('tools/list', async () => {
  bumpCount();
  const state = readState();
  if (state.failList || state.failToolsList) throw new Error('dynamic tools/list failure');
  return {
    tools: (state.tools || []).map(name => ({
      name,
      description: `Dynamic tool ${name}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }))
  };
});

server.setRequestHandler('tools/call', async request => ({
  content: [{ type: 'text', text: `dynamic:${request.params.name}` }]
}));

server.setRequestHandler('resources/list', async () => {
  const state = readState();
  if (state.failResourcesList) throw new Error('dynamic resources/list failure');
  return {
    resources: (state.resources || ['main']).map(name => ({
      uri: `dynamic://resource/${name}`,
      name: `Dynamic resource ${name}`,
      mimeType: 'text/plain'
    }))
  };
});

server.setRequestHandler('resources/templates/list', async () => {
  const state = readState();
  if (state.failResourceTemplatesList) throw new Error('dynamic resources/templates/list failure');
  return {
    resourceTemplates: state.templates === false ? [] : [{
      uriTemplate: 'dynamic://resource/{id}',
      name: 'Dynamic resource template',
      mimeType: 'text/plain'
    }]
  };
});

server.setRequestHandler('resources/read', async request => ({
  contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: `dynamic-resource:${request.params.uri}` }]
}));

server.setRequestHandler('prompts/list', async () => {
  const state = readState();
  if (state.failPromptsList) throw new Error('dynamic prompts/list failure');
  return {
    prompts: (state.prompts || ['review']).map(name => ({
      name,
      description: `Dynamic prompt ${name}`,
      arguments: [{ name: 'topic', required: false }]
    }))
  };
});

server.setRequestHandler('prompts/get', async request => ({
  messages: [{ role: 'user', content: { type: 'text', text: `dynamic-prompt:${request.params.name}:${request.params.arguments?.topic || ''}` } }]
}));

await server.connect(new StdioServerTransport());
