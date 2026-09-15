import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { ok } from '../scripts/custom-tools/response-utils.mjs';
import { normalizeRemoteFilesystemResult } from '../scripts/remote-tool-result.mjs';

const filesystemOutputSchema = {
  type: 'object',
  properties: { content: { type: 'string' } },
  required: ['content'],
  additionalProperties: false
};

const shellOutputSchema = {
  type: 'object',
  properties: {
    workingDirectoryResolved: { type: 'string' },
    exitCode: { type: 'number' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    timedOut: { type: 'boolean' },
    stdoutTruncated: { type: 'boolean' },
    stderrTruncated: { type: 'boolean' },
    stdoutBytes: { type: 'number' },
    stderrBytes: { type: 'number' },
    stdoutSpillPath: {},
    stderrSpillPath: {}
  }
};

const customOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    tool: { type: 'string' },
    summary: { type: 'string' },
    data: { type: 'object' }
  },
  required: ['ok', 'tool', 'summary', 'data'],
  additionalProperties: false
};

async function fixture() {
  const server = new Server({ name: 'strict-output-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'strict-output-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const tools = [
    { name: 'filesystem', description: 'filesystem', inputSchema: { type: 'object' }, outputSchema: filesystemOutputSchema },
    { name: 'shell', description: 'shell', inputSchema: { type: 'object' }, outputSchema: shellOutputSchema },
    { name: 'custom', description: 'custom', inputSchema: { type: 'object' }, outputSchema: customOutputSchema },
    { name: 'malformed', description: 'malformed control', inputSchema: { type: 'object' }, outputSchema: filesystemOutputSchema }
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name === 'filesystem') {
      return normalizeRemoteFilesystemResult({ content: [{ type: 'text', text: 'hello' }] });
    }
    if (request.params.name === 'shell') {
      const structuredContent = {
        workingDirectoryResolved: 'C:/work',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutSpillPath: null,
        stderrSpillPath: null
      };
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    }
    if (request.params.name === 'custom') return ok('custom', 'ok', { value: 1 });
    return { content: [{ type: 'text', text: 'missing structured content' }] };
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  return { client, server };
}

test('strict MCP SDK client accepts every gateway structured-output shape', async t => {
  const { client, server } = await fixture();
  t.after(async () => {
    await client.close();
    await server.close();
  });

  assert.equal((await client.callTool({ name: 'filesystem', arguments: {} })).structuredContent.content, 'hello');
  assert.equal((await client.callTool({ name: 'shell', arguments: {} })).structuredContent.exitCode, 0);
  assert.equal((await client.callTool({ name: 'custom', arguments: {} })).structuredContent.ok, true);
});

test('strict MCP SDK client rejects missing structured content when outputSchema exists', async t => {
  const { client, server } = await fixture();
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await assert.rejects(
    client.callTool({ name: 'malformed', arguments: {} }),
    /has an output schema but did not return structured content/
  );
});
