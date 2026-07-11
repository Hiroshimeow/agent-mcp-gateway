import test from 'node:test';
import assert from 'node:assert/strict';

import { executeDirectShell, getDirectShell } from '../scripts/direct-shell.mjs';

function commandFor(platform, windows, posix) {
  return platform === 'win32' ? windows : posix;
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

test('executeDirectShell reports timeout and truncation metadata', async () => {
  const timeoutCommand = commandFor(process.platform, 'Start-Sleep -Seconds 2', 'sleep 2');
  const timed = await executeDirectShell(timeoutCommand, { cwd: process.cwd(), timeout: 50 });
  assert.equal(timed.timedOut, true);
  assert.notEqual(timed.exitCode, 0);

  const outputCommand = commandFor(
    process.platform,
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Write-Output ('x' * 200)",
    "printf '%0200d' 0"
  );
  const truncated = await executeDirectShell(outputCommand, { cwd: process.cwd(), maxOutputBytes: 32 });
  assert.equal(truncated.stdoutTruncated, true);
  assert.ok(truncated.stdoutBytes > truncated.returnedStdoutBytes);
});

test('getDirectShell keeps platform-native non-login invocation', () => {
  assert.deepEqual(getDirectShell('linux', {}), {
    executable: '/bin/sh',
    args: ['-c'],
    executionMode: 'direct-wrapper-posix-shell'
  });
  assert.match(getDirectShell('win32', {}).executable, /powershell\.exe$/i);
});
