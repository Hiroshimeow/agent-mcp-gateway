import { createHash } from 'node:crypto';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function boundedLimit(value) {
  const limit = value === undefined ? DEFAULT_LIMIT : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function inventorySignature(devices) {
  return createHash('sha256')
    .update(JSON.stringify(devices.map(device => ({
      deviceId: device?.deviceId || '',
      online: Boolean(device?.online),
      revoked: Boolean(device?.revoked),
      capabilities: Array.isArray(device?.capabilities) ? device.capabilities : []
    }))))
    .digest('hex')
    .slice(0, 16);
}

function encodeCursor(offset, signature) {
  return Buffer.from(JSON.stringify({ v: 1, offset, signature }), 'utf8').toString('base64url');
}

function decodeCursor(cursor, signature) {
  if (!cursor) return 0;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid cursor: expected an opaque cursor returned by list_devices.');
  }
  if (parsed?.v !== 1 || parsed?.signature !== signature || !Number.isInteger(parsed?.offset) || parsed.offset < 0) {
    throw new Error('Invalid or stale cursor: device inventory changed.');
  }
  return parsed.offset;
}

export function listDevicesToolDefinition() {
  return {
    name: 'list_devices',
    description: 'List registered device identities and bounded capability/status metadata. Adding or removing devices does not change the MCP tool schema.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Opaque cursor returned by the previous page.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT }
      },
      additionalProperties: false
    }
  };
}

function toWireDevice(device = {}) {
  return {
    device_id: device.deviceId || '',
    device_name: device.deviceName || device.deviceId || '',
    hostname: device.hostname || null,
    platform: device.platform || null,
    arch: device.arch || null,
    path_style: device.pathStyle || null,
    online: Boolean(device.online),
    revoked: Boolean(device.revoked),
    agent_version: device.agentVersion || 'unknown',
    capabilities: Array.isArray(device.capabilities) ? [...device.capabilities] : [],
    connection_epoch: Number(device.connectionEpoch || 0),
    connected_at: device.connectedAt || null,
    last_seen_at: device.lastSeenAt || null,
    account: device.account || { connected: false, label: null },
    usage: device.usage ?? null,
    schema: device.schema ?? null
  };
}

export function paginateDeviceInventory(devices, options = {}) {
  const sorted = [...(Array.isArray(devices) ? devices : [])]
    .sort((left, right) => String(left?.deviceId || '').localeCompare(String(right?.deviceId || '')));
  const signature = inventorySignature(sorted);
  const offset = decodeCursor(options.cursor, signature);
  if (offset > sorted.length) throw new Error('Invalid or stale cursor: device offset is outside the current inventory.');
  const limit = boundedLimit(options.limit);
  const page = sorted.slice(offset, offset + limit).map(toWireDevice);
  const nextOffset = offset + page.length;
  const truncated = nextOffset < sorted.length;
  return {
    devices: page,
    truncated,
    nextCursor: truncated ? encodeCursor(nextOffset, signature) : null,
    total: sorted.length
  };
}
