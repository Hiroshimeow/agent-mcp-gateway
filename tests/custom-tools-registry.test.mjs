import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LOCAL_TOOL_NAMES, callCustomTool, isLocalCustomTool, listCustomTools } from '../scripts/custom-tools/index.mjs';
import { parseToolResult } from '../scripts/custom-tools/response-utils.mjs';
import { buildTrustedRootsProjectRegistry } from '../scripts/projects/trusted-roots-projects.mjs';

const EXPECTED = ['get_skill', 'image_preview', 'project_list', 'project_inspect'];

test('local registry exposes stable project tools without path metadata', () => {
  const tools = listCustomTools({ resolvedRepoRoots: ['C:/repo'], resolvedRepoRoot: 'C:/repo' });
  assert.deepEqual(tools.map(tool => tool.name), EXPECTED);
  assert.deepEqual(LOCAL_TOOL_NAMES, EXPECTED);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool._meta?.trusted_roots, undefined);
    assert.equal(tool._meta?.root_repo, undefined);
    assert.equal(tool._meta?.repo_root, undefined);
  }
  assert.equal(tools.find(tool => tool.name === 'get_skill').outputSchema.type, 'object');
});

test('isLocalCustomTool accepts only canonical retained names', () => {
  assert.equal(isLocalCustomTool('get_skill'), true);
  assert.equal(isLocalCustomTool('image_preview'), true);
  assert.equal(isLocalCustomTool('project_list'), true);
  assert.equal(isLocalCustomTool('project_inspect'), true);
  assert.equal(isLocalCustomTool('custom_get_skill'), false);
  assert.equal(isLocalCustomTool('custom_image_preview'), false);
  assert.equal(isLocalCustomTool('grep'), false);
  assert.equal(isLocalCustomTool('custom_git_status'), false);
});

test('project tools route through bounded project inspection service', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-project-tools-'));
  await fs.writeFile(path.join(root, 'README.md'), '# Project tool fixture\n');
  const projectRegistry = buildTrustedRootsProjectRegistry([`${root} | fixture | Fixture`], { defaultProjectId: 'fixture' });
  const context = { projectRegistry, env: { MCP_RUNTIME_PROFILE: 'safe' } };

  const listResult = parseToolResult(await callCustomTool('project_list', { limit: 10 }, context));
  assert.equal(listResult.ok, true);
  assert.deepEqual(listResult.data.items.map(item => item.projectId), ['fixture']);

  const inspectResult = parseToolResult(await callCustomTool('project_inspect', { projectId: 'fixture', view: 'summary' }, context));
  assert.equal(inspectResult.ok, true);
  assert.equal(inspectResult.data.projectId, 'fixture');
  assert.equal(inspectResult.data.hasReadme, true);
});

test('project_inspect schema constrains view to the stable enum', () => {
  const tool = listCustomTools().find(item => item.name === 'project_inspect');
  assert.deepEqual(tool.inputSchema.properties.view.enum, ['summary', 'tree', 'git_status', 'git_diff', 'readme', 'package']);
});

test('get_skill returns a structured named skill without repeating the catalog', async () => {
const result = await callCustomTool('get_skill', { name: 'ponytail-review' }, {});
const payload = parseToolResult(result);
assert.deepEqual(result.structuredContent, payload);
assert.equal(payload.ok, true);
assert.equal(payload.data.name, 'ponytail_review');
assert.equal(payload.data.mcpSurfaces.tool, 'get_skill');
  assert.match(payload.data.body, /unnecessary complexity|net: -<N> lines/i);
  assert.equal(payload.data.skillCatalog, undefined);
});

test('get_skill discovery is structured and catalog-only', async () => {
const result = await callCustomTool('get_skill', {}, {});
const payload = parseToolResult(result);
assert.deepEqual(result.structuredContent, payload);
assert.equal(payload.ok, true);
  assert.equal(payload.data.mode, 'discovery');
  assert.equal(payload.data.body, undefined);
  assert.ok(payload.data.skillCatalog.some(skill => skill.name === 'local_coding'));
  assert.ok(payload.data.skillCatalog.some(skill => skill.name === 'systematic_debugging'));
});
