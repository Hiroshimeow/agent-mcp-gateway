import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHttpUpstreamClient } from '../scripts/upstreams/http-client.mjs';

const successSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: { type: 'string' } }
};

function createFixtureServer() {
  const server = new Server(
    { name: 'http-upstream-regression-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'structured_error', inputSchema: { type: 'object' }, outputSchema: successSchema },
      { name: 'structured_success', inputSchema: { type: 'object' }, outputSchema: successSchema },
      { name: 'invalid_success', inputSchema: { type: 'object' }, outputSchema: successSchema }
    ]
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name === 'structured_error') {
      return {
        isError: true,
        content: [{ type: 'text', text: 'EXPECTED_ERROR' }],
        structuredContent: {
          error: { code: 'EXPECTED_ERROR', message: 'expected fixture error', retryable: false, details: {} }
        }
      };
    }
    if (request.params.name === 'invalid_success') {
      return {
        content: [{ type: 'text', text: 'invalid success' }],
        structuredContent: { wrong: true }
      };
    }
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { value: 'ok' }
    };
  });
  return server;
}

async function startFixture() {
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const server = createFixtureServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const listener = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    candidate.once('error', reject);
  });
  const address = listener.address();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise(resolve => listener.close(resolve))
  };
}

test('HTTP upstream preserves structured tool errors while keeping success output validation', async () => {
  const fixture = await startFixture();
  let client;
  try {
    client = await createHttpUpstreamClient({
      id: 'fixture',
      url: fixture.url,
      startupTimeoutMs: 5000
    });
    await client.listTools();

    const errorResult = await client.callTool({ name: 'structured_error', arguments: {} });
    assert.equal(errorResult.isError, true);
    assert.equal(errorResult.structuredContent.error.code, 'EXPECTED_ERROR');
    assert.equal(errorResult.structuredContent.error.retryable, false);

    const successResult = await client.callTool({ name: 'structured_success', arguments: {} });
    assert.deepEqual(successResult.structuredContent, { value: 'ok' });

    await assert.rejects(
      client.callTool({ name: 'invalid_success', arguments: {} }),
      /Structured content does not match the tool's output schema/
    );
  } finally {
    await client?.close();
    await fixture.close();
  }
});
