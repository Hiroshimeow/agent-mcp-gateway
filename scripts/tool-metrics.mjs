import fs from 'node:fs';
import path from 'node:path';

function byteSize(value) {
  const json = JSON.stringify(value ?? {});
  return Buffer.byteLength(json || '', 'utf8');
}

export function buildToolMetric({
  toolName,
  args,
  result,
  durationMs,
  callerCategory = null,
  accountId = null,
  activitySessionId = null,
  deviceId = null,
  skillName = null,
  upstream = null,
  error = null
} = {}) {
  const structured = result?.structuredContent || {};
  const success = !error && result?.isError !== true;
  return {
    timestamp: new Date().toISOString(),
    tool: String(toolName || 'unknown'),
    durationMs: Math.max(0, Number(durationMs) || 0),
    success,
    error: error ? 'exception' : (result?.isError === true ? 'tool-error' : null),
    inputBytes: byteSize(args),
    outputBytes: byteSize(result),
    truncated: Boolean(structured.stdoutTruncated || structured.stderrTruncated),
    spill: Boolean(structured.stdoutSpillPath || structured.stderrSpillPath),
    callerCategory: callerCategory ? String(callerCategory).slice(0, 32) : null,
    accountId: accountId ? String(accountId).slice(0, 128) : null,
    activitySessionId: activitySessionId ? String(activitySessionId).slice(0, 128) : null,
    deviceId: deviceId ? String(deviceId).slice(0, 64) : null,
    skillName: skillName ? String(skillName).slice(0, 128) : null,
    errorCode: error ? String(error.code || 'EXCEPTION').slice(0, 64) : (result?.isError === true ? String(structured.code || 'TOOL_ERROR').slice(0, 64) : null),
    upstream: upstream ? String(upstream).slice(0, 128) : null
  };
}

export function createToolMetricsRecorder({ metricsPath, enabled = true } = {}) {
  let fd = null;
  let warned = false;

  function ensureOpen() {
    if (!enabled || fd !== null) return;
    if (!metricsPath) throw new Error('metricsPath is required when metrics are enabled');
    fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
    fd = fs.openSync(metricsPath, 'a');
  }

  return {
    record(metric) {
      if (!enabled) return;
      try {
        ensureOpen();
        fs.writeSync(fd, `${JSON.stringify(metric)}\n`, null, 'utf8');
      } catch (error) {
        if (!warned) {
          warned = true;
          console.error(`[metrics] append failed: ${error.message}`);
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
