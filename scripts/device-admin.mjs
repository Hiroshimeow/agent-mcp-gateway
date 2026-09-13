import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceStore } from './device-store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = path.resolve(process.env.MCP_RUNTIME_DIR || path.join(packageRoot, '.runtime'));
const dbPath = path.resolve(process.env.MCP_DEVICE_DB_PATH || path.join(runtimeDirectory, 'devices.sqlite'));
const [command, deviceId, publicKeyPath] = process.argv.slice(2);

if (!deviceId || !['enroll', 'rotate', 'revoke'].includes(command) || (['enroll', 'rotate'].includes(command) && !publicKeyPath)) {
  console.error('Usage: npm run device:enroll -- <device_id> <public_key.pem> | npm run device:rotate -- <device_id> <public_key.pem> | npm run device:revoke -- <device_id>');
  process.exit(2);
}

const store = createDeviceStore({ dbPath });
try {
  if (command === 'enroll' || command === 'rotate') {
    const publicKeyPem = fs.readFileSync(path.resolve(publicKeyPath), 'utf8');
    const result = command === 'enroll'
      ? store.enroll({ deviceId, publicKeyPem })
      : store.rotate({ deviceId, publicKeyPem });
    console.log(JSON.stringify({ ok: true, deviceId: result.deviceId, enrolledAt: result.enrolledAt }));
  } else {
    const result = store.revoke(deviceId);
    console.log(JSON.stringify({ ok: true, deviceId: result.deviceId, revokedAt: result.revokedAt }));
  }
} finally {
  store.close();
}
