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
    callerCategory: 'static-bearer'
  });
  const json = JSON.stringify(metric);
  assert.doesNotMatch(json, /SECRET_COMMAND_PAYLOAD|SECRET_OUTPUT_BODY/);
  assert.equal(metric.tool, 'shell_execute');
  assert.equal(metric.success, true);
  assert.equal(metric.truncated, true);
  assert.equal(metric.spill, true);
  assert.equal(metric.callerCategory, 'static-bearer');
  assert.ok(metric.inputBytes > 0);
  assert.ok(metric.outputBytes > 0);
});

test('tool metrics recorder appends one NDJSON object per call', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-metrics-'));
  const metricsPath = path.join(directory, 'calls.ndjson');
  const recorder = createToolMetricsRecorder({ metricsPath });
  try {
    recorder.record({ timestamp: new Date(0).toISOString(), tool: 'get_skill', durationMs: 1, success: true });
    recorder.record({ timestamp: new Date(1).toISOString(), tool: 'read_text_file', durationMs: 2, success: false });
  } finally {
    recorder.close();
  }
  const lines = fs.readFileSync(metricsPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tool, 'get_skill');
  assert.equal(lines[1].success, false);
  fs.rmSync(directory, { recursive: true, force: true });
});
