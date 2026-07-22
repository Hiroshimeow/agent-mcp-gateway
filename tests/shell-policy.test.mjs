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

test('shell descriptor directs content operations to filesystem tools and preserves profile annotations', () => {
  const description = buildShellExecuteDescription('Trusted roots: C:/repo');
  assert.match(description, /call get_skill without arguments/i);
  assert.match(description, /terminal access/);
  assert.match(description, /content search/);
  assert.match(description, /git, tests, builds/);
  assert.match(description, /read_text_file, write_file, or edit_file/);
  assert.match(description, /working_directory/);
  assert.deepEqual(buildShellExecuteAnnotations(), {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false
  });
});
