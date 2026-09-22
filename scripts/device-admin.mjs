import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceAuditRecorder } from './device-audit.mjs';
import { createDeviceStore } from './device-store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = path.resolve(process.env.MCP_RUNTIME_DIR || path.join(packageRoot, '.runtime'));
const dbPath = path.resolve(process.env.MCP_GATEWAY_DB_PATH || path.join(runtimeDirectory, 'gateway.sqlite'));
const [command, deviceId, firstKeyPath, secondKeyPath] = process.argv.slice(2);

if (
  !deviceId ||
  !['enroll', 'rotate', 'revoke'].includes(command) ||
  (command === 'enroll' && !firstKeyPath) ||
  (command === 'rotate' && (!firstKeyPath || !secondKeyPath))
) {
  console.error('Usage: npm run device:enroll -- <device_id> <public_key.pem> | npm run device:rotate -- <device_id> <expected_current_public_key.pem> <new_public_key.pem> | npm run device:revoke -- <device_id>');
  process.exit(2);
}

const store = createDeviceStore({ dbPath });
const audit = createDeviceAuditRecorder({ auditPath: path.join(runtimeDirectory, 'device-audit.jsonl'), enabled: false });
try {
  if (command === 'enroll' || command === 'rotate') {
    const firstKeyPem = fs.readFileSync(path.resolve(firstKeyPath), 'utf8');
    const result = command === 'enroll'
      ? store.enroll({ deviceId, publicKeyPem: firstKeyPem })
      : store.rotate({
          deviceId,
          expectedPublicKeyPem: firstKeyPem,
          publicKeyPem: fs.readFileSync(path.resolve(secondKeyPath), 'utf8')
        });
    console.log(JSON.stringify({ ok: true, deviceId: result.deviceId, enrolledAt: result.enrolledAt }));
  } else {
    const result = store.revoke(deviceId);
    audit.recordEvent({ event: 'device_forgotten', callerCategory: 'admin_cli', deviceId: result.deviceId });
    console.log(JSON.stringify({ ok: true, deviceId: result.deviceId, forgottenAt: result.forgottenAt }));
  }
} finally {
  audit.close();
  store.close();
}
