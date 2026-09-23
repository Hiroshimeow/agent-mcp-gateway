import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

import { buildDevicePublicContract, classifyDevicePublicContractChanges } from '../scripts/device-public-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'device-public-contract-v1.json'), 'utf8'));

test('device public MCP contract matches the frozen fixture', () => {
  const current = buildDevicePublicContract();
  const result = classifyDevicePublicContractChanges(fixture, current);
  assert.deepEqual(result, {
    counts: { unchanged: 1, additive: 0, deprecated: 0, breaking: 0 },
    changes: []
  });
  assert.deepEqual(current.tools.slice(0, 2).map(tool => tool.name), ['list_devices', 'project_list']);
});

test('SDK v2 maps an internal device error to the frozen public JSON-RPC envelope', async t => {
  const server = new Server({ name: 'device-contract-error-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'device-contract-error-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server.setRequestHandler('tools/list', async () => ({
    tools: [{ name: 'probe', description: 'probe', inputSchema: { type: 'object' } }]
  }));
  server.setRequestHandler('tools/call', async () => {
    const error = new Error('Device execution runtime is not ready.');
    error.code = 'DEVICE_NOT_READY';
    throw error;
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await assert.rejects(
    client.callTool({ name: 'probe', arguments: {} }),
    error => error?.code === -32603 && error?.message === 'Device execution runtime is not ready.' && error?.data === undefined
  );
});

test('contract classifier distinguishes additive deprecated and breaking changes', () => {
  const base = buildDevicePublicContract();

  const additive = structuredClone(base);
  additive.tools[0].inputSchema.properties.optional_probe = { type: 'string' };
  assert.equal(classifyDevicePublicContractChanges(base, additive).counts.additive, 1);

  const deprecated = structuredClone(base);
  deprecated.tools[0]._meta = { ...(deprecated.tools[0]._meta || {}), deprecated: true };
  assert.equal(classifyDevicePublicContractChanges(base, deprecated).counts.deprecated, 1);

  const breaking = structuredClone(base);
  breaking.tools = breaking.tools.slice(1);
  assert.equal(classifyDevicePublicContractChanges(base, breaking).counts.breaking, 1);
});
