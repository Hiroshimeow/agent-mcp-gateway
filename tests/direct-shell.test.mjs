import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SHELL_RESPONSE_BUDGET_BYTES, executeDirectShell, getDirectShell } from '../scripts/direct-shell.mjs';

function commandFor(platform, windows, posix) {
  return platform === 'win32' ? windows : posix;
}

function nodeScriptCommand(script) {
  if (process.platform === 'win32') {
    const executable = `'${process.execPath.replaceAll("'", "''")}'`;
    return `& ${executable} -e '${script.replaceAll("'", "''")}'`;
  }
  return `"${process.execPath.replaceAll('"', '\\"')}" -e "${script.replaceAll('"', '\\"')}"`;
}

function serializedShellResultBytes(result) {
  const value = {
    command: 'benchmark',
    workingDirectoryRequested: process.cwd(),
    workingDirectoryResolved: process.cwd(),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stderrClassification: result.exitCode !== 0 || result.timedOut ? 'error' : (result.stderr ? 'warning' : 'none'),
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    returnedStdoutBytes: result.returnedStdoutBytes,
    returnedStderrBytes: result.returnedStderrBytes,
    stdoutHeadBytes: result.stdoutHeadBytes,
    stdoutTailBytes: result.stdoutTailBytes,
    stderrHeadBytes: result.stderrHeadBytes,
    stderrTailBytes: result.stderrTailBytes,
    stdoutSpillPath: result.stdoutSpillPath,
    stderrSpillPath: result.stderrSpillPath,
    encoding: result.encoding
  };
  const toolResult = {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: toolResult }));
}

test('executeDirectShell returns structured nonzero results without throwing', async () => {
  const command = commandFor(
    process.platform,
    "Write-Output 'stdout-value'; [Console]::Error.WriteLine('stderr-value'); exit 7",
    "printf 'stdout-value\\n'; printf 'stderr-value\\n' >&2; exit 7"
  );
  const result = await executeDirectShell(command, { cwd: process.cwd() });
  assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /stdout-value/);
  assert.match(result.stderr, /stderr-value/);
  assert.equal(result.timedOut, false);
  assert.equal(result.encoding, 'utf-8');
  assert.ok(result.durationMs >= 0);
});

test('executeDirectShell preserves UTF-8 Vietnamese and Japanese output', async () => {
  const command = commandFor(
    process.platform,
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Write-Output 'Tiếng Việt 日本語'",
    "printf 'Tiếng Việt 日本語\\n'"
  );
  const result = await executeDirectShell(command, { cwd: process.cwd() });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Tiếng Việt 日本語/);
});

test('executeDirectShell reports timeout and spills exact oversized output with head-tail preview', async () => {
  const timeoutCommand = commandFor(process.platform, 'Start-Sleep -Seconds 2', 'sleep 2');
  const timed = await executeDirectShell(timeoutCommand, { cwd: process.cwd(), timeout: 50 });
  assert.equal(timed.timedOut, true);
  assert.notEqual(timed.exitCode, 0);

  const spillDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shell-spill-'));
  const outputCommand = commandFor(
    process.platform,
    "$s = ('A' * 100) + ('B' * 100); [Console]::Out.Write($s)",
    "printf '%0100d' 0 | tr '0' 'A'; printf '%0100d' 0 | tr '0' 'B'"
  );
  try {
    const truncated = await executeDirectShell(outputCommand, {
      cwd: process.cwd(),
      maxOutputBytes: 32,
      spillDirectory
    });
    assert.equal(truncated.stdoutTruncated, true);
    assert.equal(truncated.stdoutBytes, 200);
    assert.equal(truncated.returnedStdoutBytes, 32);
    assert.equal(truncated.stdoutHeadBytes, 16);
    assert.equal(truncated.stdoutTailBytes, 16);
    assert.match(truncated.stdout, /^A{16}/);
    assert.match(truncated.stdout, /B{16}$/);
    assert.ok(truncated.stdoutSpillPath.startsWith(spillDirectory));
    assert.equal(fs.readFileSync(truncated.stdoutSpillPath, 'utf8'), `${'A'.repeat(100)}${'B'.repeat(100)}`);
  } finally {
    fs.rmSync(spillDirectory, { recursive: true, force: true });
  }
});

test('default shell previews keep stdout plus stderr inside the 128 KiB serialized MCP budget', async () => {
  const spillDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shell-wire-both-'));
  const bytes = 256 * 1024;
  const command = nodeScriptCommand(`process.stdout.write(Buffer.alloc(${bytes}, 120)); process.stderr.write(Buffer.alloc(${bytes}, 121))`);
  try {
    const result = await executeDirectShell(command, { cwd: process.cwd(), spillDirectory });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutBytes, bytes);
    assert.equal(result.stderrBytes, bytes);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.ok(serializedShellResultBytes(result) <= DEFAULT_SHELL_RESPONSE_BUDGET_BYTES);
    assert.equal(fs.readFileSync(result.stdoutSpillPath).equals(Buffer.alloc(bytes, 120)), true);
    assert.equal(fs.readFileSync(result.stderrSpillPath).equals(Buffer.alloc(bytes, 121)), true);
  } finally {
    fs.rmSync(spillDirectory, { recursive: true, force: true });
  }
});

test('control-byte output spills and stays inside the 128 KiB serialized MCP budget', async () => {
  const spillDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shell-wire-control-'));
  const bytes = 64 * 1024;
  const command = nodeScriptCommand(`process.stdout.write(Buffer.alloc(${bytes}))`);
  try {
    const result = await executeDirectShell(command, { cwd: process.cwd(), spillDirectory });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutBytes, bytes);
    assert.equal(result.stdoutTruncated, true);
    assert.ok(serializedShellResultBytes(result) <= DEFAULT_SHELL_RESPONSE_BUDGET_BYTES);
    assert.equal(fs.readFileSync(result.stdoutSpillPath).equals(Buffer.alloc(bytes)), true);
  } finally {
    fs.rmSync(spillDirectory, { recursive: true, force: true });
  }
});

test('spill cleanup stays bounded and leaves unrelated runtime files alone', async () => {
  const spillDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shell-cleanup-'));
  const keepPath = path.join(spillDirectory, 'keep.txt');
  fs.writeFileSync(keepPath, 'keep', 'utf8');
  const outputCommand = commandFor(
    process.platform,
    "$s = ('x' * 64); [Console]::Out.Write($s)",
    "printf '%064d' 0 | tr '0' 'x'"
  );
  try {
    for (let index = 0; index < 35; index += 1) {
      const result = await executeDirectShell(outputCommand, { cwd: process.cwd(), maxOutputBytes: 16, spillDirectory });
      assert.equal(result.stdoutTruncated, true);
    }
    const spills = fs.readdirSync(spillDirectory).filter(name => name.startsWith('mcp-shell-'));
    assert.ok(spills.length <= 32);
    assert.equal(fs.readFileSync(keepPath, 'utf8'), 'keep');
  } finally {
    fs.rmSync(spillDirectory, { recursive: true, force: true });
  }
});

test('getDirectShell keeps platform-native non-login invocation', () => {
  assert.deepEqual(getDirectShell('linux', {}), {
    executable: '/bin/sh',
    args: ['-c'],
    executionMode: 'direct-wrapper-posix-shell'
  });
  assert.match(getDirectShell('win32', {}).executable, /powershell\.exe$/i);
});
