import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildToolMetric, createToolMetricsRecorder } from '../scripts/tool-metrics.mjs';

test('tool metrics keep only bounded metadata and never payload bodies', () => {
  const metric = buildToolMetric({
    toolName: 'shell_execute',
    args: { command: 'SECRET_COMMAND_PAYLOAD', working_directory: '/tmp/work' },
    result: {
      content: [{ type: 'text', text: 'SECRET_OUTPUT_BODY' }],
      structuredContent: {
        stdoutTruncated: true,
        stderrTruncated: false,
        stdoutSpillPath: '/runtime/spill.bin',
        stderrSpillPath: null
      }
    },
    durationMs: 12,
    callerCategory: 'oauth',
    accountId: 'alice',
    activitySessionId: 'activity-a',
    deviceId: 'device-a',
    skillName: null
  });
  const json = JSON.stringify(metric);
  assert.doesNotMatch(json, /SECRET_COMMAND_PAYLOAD|SECRET_OUTPUT_BODY/);
  assert.equal(metric.tool, 'shell_execute');
  assert.equal(metric.success, true);
  assert.equal(metric.truncated, true);
  assert.equal(metric.spill, true);
  assert.equal(metric.callerCategory, 'oauth');
  assert.equal(metric.accountId, 'alice');
  assert.equal(metric.activitySessionId, 'activity-a');
  assert.equal(metric.deviceId, 'device-a');
  assert.equal(metric.errorCode, null);
  assert.ok(metric.inputBytes > 0);
  assert.ok(metric.outputBytes > 0);
});

test('tool metrics capture bounded error code and skill name without payload bodies', () => {
  const metric = buildToolMetric({
    toolName: 'load_skill',
    args: { name: 'mcp-builder', hidden: 'SECRET_INPUT' },
    durationMs: 3,
    callerCategory: 'oauth',
    accountId: 'alice',
    activitySessionId: 'activity-a',
    skillName: 'mcp-builder',
    error: Object.assign(new Error('SECRET_ERROR_BODY'), { code: 'UNKNOWN_SKILL' })
  });
  assert.equal(metric.success, false);
  assert.equal(metric.errorCode, 'UNKNOWN_SKILL');
  assert.equal(metric.skillName, 'mcp-builder');
  assert.doesNotMatch(JSON.stringify(metric), /SECRET_INPUT|SECRET_ERROR_BODY/);
});

test('tool metrics recorder appends one NDJSON object per call', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-metrics-'));
  const metricsPath = path.join(directory, 'calls.ndjson');
  const recorder = createToolMetricsRecorder({ metricsPath });
  try {
    recorder.record({ timestamp: new Date(0).toISOString(), tool: 'load_skill', durationMs: 1, success: true });
    recorder.record({ timestamp: new Date(1).toISOString(), tool: 'read_text_file', durationMs: 2, success: false });
  } finally {
    recorder.close();
  }
  const lines = fs.readFileSync(metricsPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tool, 'load_skill');
  assert.equal(lines[1].success, false);
  fs.rmSync(directory, { recursive: true, force: true });
});