import test from 'node:test';
import assert from 'node:assert/strict';

import { listDevicesToolDefinition, paginateDeviceInventory } from '../scripts/device-inventory.mjs';

function devices(count) {
  return Array.from({ length: count }, (_, index) => ({
    deviceId: `device-${String(index).padStart(4, '0')}`,
    status: index % 2 === 0 ? 'online' : 'offline',
    capabilities: ['read_text_file', 'shell_execute']
  }));
}

test('list_devices schema is cardinality-independent and explicitly bounded', () => {
  const tool = listDevicesToolDefinition();
  assert.equal(tool.name, 'list_devices');
  assert.equal(tool.inputSchema.properties.limit.maximum, 100);
  assert.equal(tool.inputSchema.properties.limit.default, 50);
  assert.equal(tool.inputSchema.properties.cursor.type, 'string');
  assert.doesNotMatch(JSON.stringify(tool), /device-0000/);
});

test('device inventory pagination is stable, bounded, and reports truncation', () => {
  const inventory = devices(1000).reverse();
  const first = paginateDeviceInventory(inventory, { limit: 25 });
  assert.equal(first.devices.length, 25);
  assert.equal(first.devices[0].deviceId, 'device-0000');
  assert.equal(first.truncated, true);
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal(first.total, 1000);

  const second = paginateDeviceInventory(inventory, { limit: 25, cursor: first.nextCursor });
  assert.equal(second.devices[0].deviceId, 'device-0025');
  assert.equal(second.truncated, true);

  assert.throws(
    () => paginateDeviceInventory(devices(999), { limit: 25, cursor: first.nextCursor }),
    /cursor/i
  );
});
