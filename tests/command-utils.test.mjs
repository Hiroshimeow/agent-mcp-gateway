import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { executeCommand, executeGit } from '../scripts/custom-tools/command-utils.mjs';
import { executeDirectShell } from '../scripts/direct-shell.mjs';

test('executeCommand passes arguments without PowerShell interpolation', async () => {
  const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-command-'));
  const script = path.join(scriptDir, 'print-args.mjs');
  await fs.writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");

  const args = ['value with spaces', 'literal$dollar', 'semi;colon', 'quote"inside'];
  const result = await executeCommand(process.execPath, [script, ...args], { cwd: scriptDir });
  assert.deepEqual(JSON.parse(result.stdout.trim()), args);
  assert.equal(result.exitCode, 0);
});

test('executeGit supports repository paths with spaces', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp git parent '));
  const root = path.join(parent, 'repo with spaces');
  await fs.mkdir(root);
  await executeGit(['init'], { cwd: root });
  await executeGit(['config', 'user.email', 'test@example.com'], { cwd: root });
  await executeGit(['config', 'user.name', 'Tester'], { cwd: root });
  await fs.writeFile(path.join(root, 'file with spaces.txt'), 'hello\n');
  await executeGit(['add', 'file with spaces.txt'], { cwd: root });
  await executeGit(['commit', '-m', 'message with $ dollar and ; semicolon'], { cwd: root });
  const log = await executeGit(['log', '-1', '--pretty=%s'], { cwd: root });
  assert.equal(log.stdout.trim(), 'message with $ dollar and ; semicolon');
});

test('executeDirectShell preserves stdout stderr and exitCode on failure', async () => {
  const failingNodeCommand = process.platform === 'win32'
    ? "Write-Output 'stdout-value'; Write-Error 'stderr-value'; exit 7"
    : "printf 'stdout-value\\n'; printf 'stderr-value\\n' >&2; exit 7";

  await assert.rejects(
    executeDirectShell(failingNodeCommand, { cwd: process.cwd() }),
    error => {
      assert.match(error.stdout, /stdout-value/);
      assert.match(error.stderr, /stderr-value/);
      assert.equal(error.exitCode, 7);
      return true;
    }
  );
});
