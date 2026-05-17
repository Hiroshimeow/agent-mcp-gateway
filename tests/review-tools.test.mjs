import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { callCustomTool } from '../scripts/custom-tools/index.mjs';

function parse(result) {
  return JSON.parse(result.content.find(entry => entry.type === 'text').text);
}

async function shell(command, cwdOrOptions) {
  const cwd = typeof cwdOrOptions === 'string' ? cwdOrOptions : cwdOrOptions?.cwd;
  return await new Promise((resolve, reject) => {
    execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`)); else resolve({ stdout, stderr });
    });
  });
}

async function gitFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-review-'));
  await shell('git init; git config user.email test@example.com; git config user.name Tester', root);
  await fs.writeFile(path.join(root, 'README.md'), 'hello\n');
  await shell('git add README.md; git commit -m init', root);
  return { root, context: { resolvedRepoRoots: [root], resolvedRepoRoot: root, executeDirectShell: shell } };
}

test('custom_review_diff flags token-like added lines and logs', async () => {
  const { root, context } = await gitFixture();
  await fs.writeFile(path.join(root, 'secret.txt'), 'ghp_1234567890abcdefghijklmnop\n');
  await fs.mkdir(path.join(root, 'logs'));
  await fs.writeFile(path.join(root, 'logs', 'app.log'), 'log\n');
  await shell('git add secret.txt logs/app.log', root);
  const out = parse(await callCustomTool('review_diff', { path: root, staged: true }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, false);
  assert.equal(out.data.findings.some(f => f.title === 'Token-like value added'), true);
  assert.equal(out.data.findings.some(f => f.title === 'Sensitive/generated file changed'), true);
});

test('custom_review_diff passes harmless README typo', async () => {
  const { root, context } = await gitFixture();
  await fs.writeFile(path.join(root, 'README.md'), 'hello world\n');
  const out = parse(await callCustomTool('review_diff', { path: root }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, true);
});
