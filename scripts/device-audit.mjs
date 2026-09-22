import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function createDeviceAuditRecorder({ auditPath, enabled = true } = {}) {
  let fd = null;
  let warned = false;

  function ensureOpen(force = false) {
    if ((!enabled && !force) || fd !== null) return;
    if (!auditPath) throw new Error('auditPath is required when device audit is enabled');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fd = fs.openSync(auditPath, 'a');
  }

  function append(entry, force = false) {
    if (!enabled && !force) return;
    try {
      ensureOpen(force);
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`, null, 'utf8');
    } catch (error) {
      if (!warned) {
        warned = true;
        console.error(`[device-audit] append failed: ${error.message}`);
      }
    }
  }

  return {
    record({ requestId, callerId, callerCategory, deviceId, tool, outcome, durationMs, inputBytes, outputBytes = 0, errorCode = null }) {
      append({
        timestamp: new Date().toISOString(),
        type: 'tool_call',
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
      });
    },
    recordEvent({ event, callerId, callerCategory, deviceId, details = null }) {
      append({
        timestamp: new Date().toISOString(),
        type: 'device_event',
        event: String(event || 'unknown'),
        callerId: callerId ? createHash('sha256').update(String(callerId), 'utf8').digest('hex').slice(0, 16) : '',
        callerCategory: String(callerCategory || 'system'),
        deviceId: String(deviceId || ''),
        details: details && typeof details === 'object' ? details : null
      }, true);
    },
    close() {
      if (fd === null) return;
      fs.closeSync(fd);
      fd = null;
    }
  };
}
