import test from 'node:test';
import assert from 'node:assert/strict';

import { LOCAL_TOOL_NAMES, isLocalCustomTool, listCustomTools } from '../scripts/custom-tools/index.mjs';

const EXISTING_TOOL_COUNT = 16;
const TARGET_VISIBLE_TOOL_COUNT = 30;

const EXPECTED = [
  'custom_grep',
  'custom_apply_patch',
  'custom_delete_file',
  'custom_copy_file',
  'custom_git_status',
  'custom_git_diff',
  'custom_git_add',
  'custom_git_commit',
  'custom_git_push',
  'custom_zip_create',
  'custom_secret_scan',
  'custom_review_diff',
  'custom_run_tests',
  'custom_release_review'
];

test('registry exposes exactly the 14 planned new custom tools', () => {
  const tools = listCustomTools({ resolvedRepoRoots: ['C:/repo'], resolvedRepoRoot: 'C:/repo' });
  assert.equal(tools.length, 14);
  assert.equal(EXISTING_TOOL_COUNT + tools.length, TARGET_VISIBLE_TOOL_COUNT);
  assert.deepEqual(tools.map(tool => tool.name), EXPECTED);
  assert.deepEqual(LOCAL_TOOL_NAMES.map(name => `custom_${name}`), EXPECTED);
});

test('registry descriptors include required wording and annotations', () => {
  const tools = listCustomTools({ resolvedRepoRoots: ['C:/repo'], resolvedRepoRoot: 'C:/repo' });
  for (const tool of tools) {
    assert.match(tool.description, /^Use this tool to /);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.inputSchema.type, 'object');
  }
  assert.equal(tools.find(tool => tool.name === 'custom_delete_file').annotations.destructiveHint, true);
});

test('isLocalCustomTool accepts prefixed and internal names only for new tools', () => {
  assert.equal(isLocalCustomTool('custom_grep'), true);
  assert.equal(isLocalCustomTool('grep'), true);
  assert.equal(isLocalCustomTool('custom_read_text_file'), false);
});
