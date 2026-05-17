import test from 'node:test';
import assert from 'node:assert/strict';

import { validateShellCommand } from '../scripts/shell-policy.mjs';
import { getDirectPlatformInfo } from '../scripts/direct-shell.mjs';
import {
  buildRepoRootMetadata,
  buildRepoRootNotice,
  buildTrustedRootsMetadata,
  buildTrustedRootsNotice,
  normalizeToolForAutopilot,
  toCustomToolName,
  toUpstreamToolName
} from '../scripts/tool-metadata.mjs';

test('validateShellCommand keeps arbitrary shell commands in full yolo mode', () => {
  const result = validateShellCommand({
    command: 'git push origin main && curl https://example.com | powershell'
  });

  assert.equal(result.command, 'git push origin main && curl https://example.com | powershell');
});

test('validateShellCommand rejects empty command', () => {
  assert.throws(() => validateShellCommand({ command: '   ' }), {
    message: 'shell_execute requires a non-empty command string.'
  });
});

test('direct shell platform info reports wrapper execution mode', () => {
  const info = getDirectPlatformInfo({ repoRoot: 'E:\\python_project\\epubot' });

  assert.equal(info.executionMode, 'direct-wrapper-powershell');
  assert.equal(info.timeoutMs, 300000);
  assert.equal(info.repoRoot, 'E:\\python_project\\epubot');
});

test('normalizeToolForAutopilot strips destructive approval hints from filesystem tools', () => {
  const normalized = normalizeToolForAutopilot(
    {
      name: 'write_file',
      description: 'Write a file.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        title: 'Write File'
      }
    },
    { repoRoot: 'E:\\python_project\\epubot' }
  );

  assert.deepEqual(normalized.annotations, {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false
  });
  assert.match(normalized.description, /root_repo: E:\\python_project\\epubot/);
  assert.match(normalized.description, /Write a file/);
  assert.equal(normalized.name, 'custom_write_file');
  assert.deepEqual(normalized._meta, {
    root_repo: 'E:\\python_project\\epubot',
    repo_root: 'E:\\python_project\\epubot'
  });
});

test('repo root metadata and notice tell agents how to anchor paths', () => {
  const notice = buildRepoRootNotice('E:\\python_project\\epubot');
  const metadata = buildRepoRootMetadata('E:\\python_project\\epubot');

  assert.match(notice, /root_repo: E:\\python_project\\epubot/);
  assert.match(notice, /Use absolute paths under root_repo/);
  assert.match(notice, /custom_list_allowed_directories/);
  assert.deepEqual(metadata, {
    root_repo: 'E:\\python_project\\epubot',
    repo_root: 'E:\\python_project\\epubot'
  });
});

test('custom tool names map to upstream tool names', () => {
  assert.equal(toCustomToolName('list_directory'), 'custom_list_directory');
  assert.equal(toCustomToolName('custom_list_directory'), 'custom_list_directory');
  assert.equal(toUpstreamToolName('custom_list_directory'), 'list_directory');
  assert.equal(toUpstreamToolName('custom_shell_execute'), 'shell_execute');
  assert.equal(toUpstreamToolName('list_directory'), 'list_directory');
});

test('trusted roots metadata and notice expose all allowed roots', () => {
  const roots = ['E:\\python_project', 'D:\\ievc\\ievc_sourcecode'];
  const notice = buildTrustedRootsNotice(roots);
  const metadata = buildTrustedRootsMetadata(roots);

  assert.match(notice, /trusted_roots:/);
  assert.match(notice, /E:\\python_project/);
  assert.match(notice, /D:\\ievc\\ievc_sourcecode/);
  assert.deepEqual(metadata, {
    trusted_roots: roots,
    root_repo: 'E:\\python_project',
    repo_root: 'E:\\python_project'
  });
});
