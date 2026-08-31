import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeOutputCommand } from '../scripts/benchmark-command.mjs';

test('benchmark output command uses PowerShell call operator on Windows', () => {
  assert.equal(
    buildNodeOutputCommand(1024, { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe' }),
    "& 'C:\\Program Files\\nodejs\\node.exe' -e 'process.stdout.write(Buffer.alloc(1024, 120))'"
  );
});

test('benchmark output command keeps direct executable invocation on POSIX', () => {
  assert.equal(
    buildNodeOutputCommand(1024, { platform: 'linux', execPath: '/usr/bin/node' }),
    "'/usr/bin/node' -e 'process.stdout.write(Buffer.alloc(1024, 120))'"
  );
});
