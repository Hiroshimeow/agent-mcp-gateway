import test from 'node:test';
import assert from 'node:assert/strict';

import { validateShellCommand } from '../scripts/shell-policy.mjs';
import { buildShellExecuteAnnotations, buildShellExecuteDescription } from '../scripts/shell-tool-descriptor.mjs';

test('validateShellCommand keeps arbitrary shell commands in yolo mode', () => {
  const result = validateShellCommand(
    { command: 'git status --short', working_directory: 'C:/repo' },
    { resolvedRepoRoots: ['C:/repo'], defaultCwd: 'C:/repo' }
  );
  assert.equal(result.command, 'git status --short');
  assert.match(result.cwd, /repo$/i);
});

test('validateShellCommand accepts an explicit bounded timeout', () => {
  const result = validateShellCommand({ command: 'echo ok', timeout_ms: 1250 });
  assert.equal(result.timeoutMs, 1250);
});

test('validateShellCommand rejects invalid timeout values', () => {
  for (const timeout_ms of [0, -1, 300001, 1.5, '1000']) {
    assert.throws(
      () => validateShellCommand({ command: 'echo ok', timeout_ms }),
      /timeout_ms must be an integer between 1 and 300000/i
    );
  }
});

test('validateShellCommand rejects empty command', () => {
  assert.throws(() => validateShellCommand({ command: '   ' }), /non-empty command string/);
});

test('validateShellCommand rejects a working directory outside current roots', () => {
  assert.throws(
    () => validateShellCommand(
      { command: 'pwd', working_directory: 'D:/outside' },
      { resolvedRepoRoots: ['C:/repo'], defaultCwd: 'C:/repo' }
    ),
    /outside configured trusted roots|not under|must stay inside trusted roots/i
  );
});

test('shell descriptor stays static while directing content operations to filesystem tools', () => {
  const description = buildShellExecuteDescription();
  assert.match(description, /get_skill\(name\)/i);
  assert.match(description, /terminal access/);
  assert.match(description, /content search/);
  assert.match(description, /git, tests, builds/);
  assert.match(description, /read_text_file, write_file, or edit_file/);
  assert.match(description, /working_directory/);
  assert.match(description, /bounded head\/tail preview/i);
  assert.match(description, /spill path/i);
  assert.doesNotMatch(description, /Trusted roots:/i);
  assert.doesNotMatch(description, /C:\/repo/i);
  assert.deepEqual(buildShellExecuteAnnotations(), {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false
  });
});
