import fs from 'node:fs';
import path from 'node:path';

export function createDeviceAuditRecorder({ auditPath, enabled = true } = {}) {
  let fd = null;
  let warned = false;

  function ensureOpen() {
    if (!enabled || fd !== null) return;
    if (!auditPath) throw new Error('auditPath is required when device audit is enabled');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fd = fs.openSync(auditPath, 'a');
  }

  return {
    record({ requestId, callerId, callerCategory, deviceId, tool, outcome, durationMs, inputBytes, outputBytes = 0, errorCode = null }) {
      if (!enabled) return;
      const entry = {
        timestamp: new Date().toISOString(),
        requestId: String(requestId || ''),
        callerId: String(callerId || ''),
        callerCategory: String(callerCategory || 'anonymous'),
        deviceId: String(deviceId || ''),
        tool: String(tool || ''),
        outcome: String(outcome || 'unknown'),
        durationMs: Math.max(0, Number(durationMs) || 0),
        inputBytes: Math.max(0, Number(inputBytes) || 0),
        outputBytes: Math.max(0, Number(outputBytes) || 0),
        errorCode: errorCode ? String(errorCode) : null
      };
      try {
        ensureOpen();
        fs.writeSync(fd, `${JSON.stringify(entry)}\n`, null, 'utf8');
      } catch (error) {
        if (!warned) {
          warned = true;
          console.error(`[device-audit] append failed: ${error.message}`);
        }
      }
    },
    close() {
      if (fd === null) return;
      fs.closeSync(fd);
      fd = null;
    }
  };
}
