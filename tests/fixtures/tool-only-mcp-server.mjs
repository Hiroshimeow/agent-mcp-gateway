import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'tool-only-upstream', version: '1.0.0' }, {
  capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'a',
    description: 'Tool-only upstream tool a',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async request => ({
  content: [{ type: 'text', text: `tool-only:${request.params.name}` }]
}));

await server.connect(new StdioServerTransport());
