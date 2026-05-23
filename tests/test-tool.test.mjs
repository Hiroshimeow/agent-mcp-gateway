import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { executeDirectShell } from '../scripts/direct-shell.mjs';
import { callCustomTool } from '../scripts/custom-tools/index.mjs';

function parse(result) {
  return JSON.parse(result.content.find(entry => entry.type === 'text').text);
}

async function fixture(script = 'node --test tests') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tests-'));
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: script } }));
  await fs.writeFile(path.join(root, 'tests', 'ok.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n");
  return {
    root,
    context: {
      resolvedRepoRoots: [root],
      resolvedRepoRoot: root,
      executeDirectShell
    }
  };
}

test('custom_run_tests runs npm test and returns structured pass', async () => {
  const { root, context } = await fixture();
  const out = parse(await callCustomTool('run_tests', { path: root }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, true);
});

test('custom_run_tests allows MCP runtime smoke commands', async () => {
  const { root, context } = await fixture();
  let observedCommand = '';
  context.executeDirectShell = async command => {
    observedCommand = command;
    return { stdout: 'smoke ok', stderr: '', exitCode: 0 };
  };
  const out = parse(await callCustomTool('run_tests', { path: root, command: 'npm run smoke:mcp:tools' }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, true);
  assert.equal(observedCommand, 'npm run smoke:mcp:tools');
});

test('custom_run_tests rejects arbitrary commands', async () => {
  const { root, context } = await fixture();
  const out = parse(await callCustomTool('run_tests', { path: root, command: 'Remove-Item *' }, context));
  assert.equal(out.ok, false);
});

test('custom_run_tests reports failing tests and truncates output', async () => {
  const { root, context } = await fixture();
  context.executeDirectShell = async () => {
    const error = new Error('Command execution failed: fixture failure');
    error.stdout = 'abcdefghijklmnopqrst';
    error.stderr = 'ERR_ASSERTION';
    error.exitCode = 7;
    throw error;
  };
  const out = parse(await callCustomTool('run_tests', { path: root, maxOutputBytes: 10 }, context));
  assert.equal(out.data.passed, false);
  assert.equal(out.data.exitCode, 7);
  assert.equal(out.data.truncated, true);
});
