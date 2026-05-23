import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fake-upstream', version: '1.0.0' }, {
  capabilities: { tools: {}, resources: {}, prompts: {} }
});

const tools = [
  { name: 'read_context', description: 'Read fake context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }, _meta: { fake: true } },
  { name: 'write_context', description: 'Write fake context.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false } },
  { name: 'push_context', description: 'Push fake context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true } },
  { name: 'unknown_context', description: 'Unknown fake context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: `called:${request.params.name}:${JSON.stringify(request.params.arguments || {})}` }] }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'fake://context/main', name: 'Fake context', mimeType: 'text/plain' }] }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ uriTemplate: 'fake://context/{id}', name: 'Fake context template', mimeType: 'text/plain' }] }));
server.setRequestHandler(ReadResourceRequestSchema, async request => ({ contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: `resource:${request.params.uri}` }] }));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'review_context', description: 'Review fake context.', arguments: [{ name: 'topic', required: false }] }] }));
server.setRequestHandler(GetPromptRequestSchema, async request => ({ description: 'Review fake context.', messages: [{ role: 'user', content: { type: 'text', text: `prompt:${request.params.name}:${request.params.arguments?.topic || ''}` } }] }));

await server.connect(new StdioServerTransport());
