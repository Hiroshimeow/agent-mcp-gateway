import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { LOCAL_TOOL_NAMES, callCustomTool, isLocalCustomTool, listCustomTools } from '../scripts/custom-tools/index.mjs';
import { parseToolResult } from '../scripts/custom-tools/response-utils.mjs';
import { buildTrustedRootsProjectRegistry } from '../scripts/projects/trusted-roots-projects.mjs';

const EXISTING_TOOL_COUNT = 16;
const TARGET_VISIBLE_TOOL_COUNT = 35;

const EXPECTED = [
  'custom_list_projects',
  'custom_get_safety_profile',
  'custom_grep',
  'custom_file_inspector',
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
  'custom_screenshot',
  'custom_image_preview',
  'custom_release_review'
];

test('registry exposes custom project discovery plus the planned local custom tools', () => {
  const tools = listCustomTools({ resolvedRepoRoots: ['C:/repo'], resolvedRepoRoot: 'C:/repo' });
  assert.equal(tools.length, 19);
  assert.equal(EXISTING_TOOL_COUNT + tools.length, TARGET_VISIBLE_TOOL_COUNT);
  assert.deepEqual(tools.map(tool => tool.name), EXPECTED);
  assert.deepEqual(LOCAL_TOOL_NAMES.map(name => `custom_${name}`), EXPECTED);
});

test('registry descriptors include required wording and annotations', () => {
  const tools = listCustomTools({ resolvedRepoRoots: ['C:/repo'], resolvedRepoRoot: 'C:/repo' });
  for (const tool of tools) {
    assert.match(tool.description, /^Use this (read-only )?tool to /);
    assert.equal(typeof tool.annotations.openWorldHint, 'boolean');
    assert.equal(tool.inputSchema.type, 'object');
  }
  assert.equal(tools.find(tool => tool.name === 'custom_list_projects').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'custom_delete_file').annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === 'custom_git_push').annotations.openWorldHint, true);
});

test('project-scoped registry descriptors mention project discovery guidance', () => {
  const tools = listCustomTools({ resolvedRepoRoots: ['C:/repo'], resolvedRepoRoot: 'C:/repo' });
  for (const tool of tools.filter(item => !['custom_list_projects', 'custom_get_safety_profile', 'custom_screenshot', 'custom_image_preview'].includes(item.name))) {
    assert.match(tool.description, /Use custom_list_projects to discover projectId values/);
  }
});

test('isLocalCustomTool accepts prefixed and internal names for local tools only', () => {
  assert.equal(isLocalCustomTool('custom_list_projects'), true);
  assert.equal(isLocalCustomTool('list_projects'), true);
  assert.equal(isLocalCustomTool('custom_grep'), true);
  assert.equal(isLocalCustomTool('grep'), true);
  assert.equal(isLocalCustomTool('custom_read_text_file'), false);
});

test('custom_list_projects uses supplied registry without exposing paths by default', async () => {
  const repoRoot = path.join(os.tmpdir(), 'wrapper-project-context');
  const registry = buildTrustedRootsProjectRegistry([`${repoRoot} | wrapper-project | Wrapper Project`], {
    defaultProjectId: 'wrapper-project',
    exposeProjectPaths: true
  });

  const payload = parseToolResult(await callCustomTool('custom_list_projects', {}, { projectRegistry: registry }));

  assert.equal(payload.ok, true);
  assert.equal(payload.data.defaultProjectId, 'wrapper-project');
  assert.equal(payload.data.projects[0].projectId, 'wrapper-project');
  assert.equal(payload.data.projects[0].displayName, 'Wrapper Project');
  assert.equal(payload.data.projects[0].repoRoot, undefined);
  assert.match(payload.data.guidance, /not an isolation boundary/);
});

test('custom_list_projects exposes paths only when explicitly enabled in the registry', async () => {
  const repoRoot = path.join(os.tmpdir(), 'visible-wrapper-project-context');

  const hiddenRegistry = buildTrustedRootsProjectRegistry([`${repoRoot} | hidden-project | Hidden Project`]);
  const hidden = parseToolResult(await callCustomTool('list_projects', { showPaths: true }, { projectRegistry: hiddenRegistry }));
  assert.equal(hidden.data.projects[0].repoRoot, undefined);
  assert.match(hidden.data.warnings[0], /MCP_EXPOSE_PROJECT_PATHS=true/);

  const visibleRegistry = buildTrustedRootsProjectRegistry([`${repoRoot} | visible-project | Visible Project`], {
    exposeProjectPaths: true
  });
  const visible = parseToolResult(await callCustomTool('list_projects', { showPaths: true }, { projectRegistry: visibleRegistry }));
  assert.equal(visible.data.projects[0].repoRoot, path.resolve(repoRoot));
  assert.deepEqual(visible.data.projects[0].trustedRoots, [path.resolve(repoRoot)]);
  assert.deepEqual(visible.data.warnings, []);
});
