import test from 'node:test';
import assert from 'node:assert/strict';

import { LOCAL_TOOL_NAMES, callCustomTool, isLocalCustomTool, listCustomTools } from '../scripts/custom-tools/index.mjs';
import { parseToolResult } from '../scripts/custom-tools/response-utils.mjs';

const EXPECTED = ['get_skill', 'image_preview'];

test('local registry exposes only the two non-filesystem core helpers without aliases', () => {
  const tools = listCustomTools({ resolvedRepoRoots: ['C:/repo'], resolvedRepoRoot: 'C:/repo' });
  assert.deepEqual(tools.map(tool => tool.name), EXPECTED);
  assert.deepEqual(LOCAL_TOOL_NAMES, EXPECTED);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  assert.equal(tools.find(tool => tool.name === 'get_skill').outputSchema.type, 'object');
});

test('isLocalCustomTool accepts only canonical retained names', () => {
  assert.equal(isLocalCustomTool('get_skill'), true);
  assert.equal(isLocalCustomTool('image_preview'), true);
  assert.equal(isLocalCustomTool('custom_get_skill'), false);
  assert.equal(isLocalCustomTool('custom_image_preview'), false);
  assert.equal(isLocalCustomTool('grep'), false);
  assert.equal(isLocalCustomTool('custom_git_status'), false);
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
