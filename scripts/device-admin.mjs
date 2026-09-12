import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceStore } from './device-store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = path.resolve(process.env.MCP_RUNTIME_DIR || path.join(packageRoot, '.runtime'));
const dbPath = path.resolve(process.env.MCP_DEVICE_DB_PATH || path.join(runtimeDirectory, 'devices.sqlite'));
const [command, deviceId] = process.argv.slice(2);

if (command !== 'revoke' || !deviceId) {
  console.error('Usage: npm run device:revoke -- <device_id>');
  process.exit(2);
}

const store = createDeviceStore({ dbPath });
try {
  const result = store.revoke(deviceId);
  console.log(JSON.stringify({ ok: true, deviceId: result.deviceId, revokedAt: result.revokedAt }));
} finally {
  store.close();
}
