import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const server = new Server({ name: 'fake-upstream', version: '1.0.0' }, {
  capabilities: { tools: {}, resources: {}, prompts: {} }
});

const tools = [
  { name: 'read_context', description: 'Read fake context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }, _meta: { fake: true } },
  { name: 'write_context', description: 'Write fake context.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'push_context', description: 'Push fake context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true } },
  { name: 'unknown_context', description: 'Unknown fake context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
];

server.setRequestHandler('tools/list', async () => ({ tools }));
server.setRequestHandler('tools/call', async request => ({ content: [{ type: 'text', text: `called:${request.params.name}:${JSON.stringify(request.params.arguments || {})}` }] }));
server.setRequestHandler('resources/list', async () => ({ resources: [{ uri: 'fake://context/main', name: 'Fake context', mimeType: 'text/plain' }] }));
server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [{ uriTemplate: 'fake://context/{id}', name: 'Fake context template', mimeType: 'text/plain' }] }));
server.setRequestHandler('resources/read', async request => ({ contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: `resource:${request.params.uri}` }] }));
server.setRequestHandler('prompts/list', async () => ({ prompts: [{ name: 'review_context', description: 'Review fake context.', arguments: [{ name: 'topic', required: false }] }] }));
server.setRequestHandler('prompts/get', async request => ({ description: 'Review fake context.', messages: [{ role: 'user', content: { type: 'text', text: `prompt:${request.params.name}:${request.params.arguments?.topic || ''}` } }] }));

await server.connect(new StdioServerTransport());
