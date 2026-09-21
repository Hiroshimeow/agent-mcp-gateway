import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const server = new Server({ name: 'tool-only-upstream', version: '1.0.0' }, {
  capabilities: { tools: {} }
});

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'a',
    description: 'Tool-only upstream tool a',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }]
}));

server.setRequestHandler('tools/call', async request => ({
  content: [{ type: 'text', text: `tool-only:${request.params.name}` }]
}));

await server.connect(new StdioServerTransport());
