import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDevicePublicContract, classifyDevicePublicContractChanges } from '../scripts/device-public-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'device-public-contract-v1.json'), 'utf8'));

test('device public MCP execution contract matches the frozen fixture', () => {
  const result = classifyDevicePublicContractChanges(fixture, buildDevicePublicContract());
  assert.deepEqual(result, {
    counts: { unchanged: 1, additive: 0, deprecated: 0, breaking: 0 },
    changes: []
  });
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
