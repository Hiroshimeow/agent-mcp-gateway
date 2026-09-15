import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listRepoResources, listRepoResourceTemplates, readRepoResource } from '../scripts/resources/index.mjs';
import { loadSurfaceConfig } from '../scripts/surface-config.mjs';
import { listCustomTools } from '../scripts/custom-tools/index.mjs';
import { listDevicesToolDefinition } from '../scripts/device-inventory.mjs';
import { applyToolRisk } from '../scripts/tool-risk.mjs';
import { catalogToolBytes, selectExternalCatalog } from '../scripts/catalog-budget.mjs';

function syntheticContext(projectCount, skillCount, deviceCount = projectCount) {
  const projects = new Map();
  const projectRoutes = new Map();
  const devices = Array.from({ length: deviceCount }, (_, index) => ({
    deviceId: `device-${String(index).padStart(4, '0')}`,
    online: true,
    revoked: false,
    pathStyle: 'posix',
    capabilities: ['read_text_file']
  }));
  for (let index = 0; index < projectCount; index += 1) {
    const projectId = `project-${String(index).padStart(4, '0')}`;
    const deviceId = devices[index % Math.max(devices.length, 1)]?.deviceId || 'device-0000';
    const project = {
      projectId,
      deviceId,
      displayName: `Project ${index}`,
      repoRoot: path.join(os.tmpdir(), 'mcp-scale-missing', projectId),
      trustedRoots: []
    };
    projects.set(projectId, project);
    projectRoutes.set(`${deviceId}\u0000${projectId}`, project);
  }
  return {
    projectRegistry: {
      projects,
      projectRoutes,
      defaultProjectId: projects.keys().next().value,
      exposeProjectPaths: false
    },
    listSkillResources: () => Array.from({ length: skillCount }, (_, index) => ({
      uri: `skill://skills/synthetic-${index}/SKILL.md`,
      name: `Synthetic skill ${index}`,
      mimeType: 'text/markdown'
    })),
    devices,
    listVisibleDevices: () => devices,
    env: { MCP_RUNTIME_PROFILE: 'safe' },
    listTools: async () => []
  };
}

function mode(name) {
  return loadSurfaceConfig({ surface: { mode: name } }, {});
}

test('resource catalog cardinality stays fixed in agent/native and grows only in legacy', () => {
  const counts = [1, 10, 100, 1000];
  const agentCounts = [];
  const nativeCounts = [];
  const legacyCounts = [];
  for (const count of counts) {
    const context = syntheticContext(count, count, count);
    agentCounts.push(listRepoResources(context, mode('agent')).length);
    nativeCounts.push(listRepoResources(context, mode('native')).length);
    legacyCounts.push(listRepoResources(context, mode('legacy')).length);
  }

  assert.deepEqual(agentCounts, [2, 2, 2, 2]);
  assert.deepEqual(nativeCounts, [2, 2, 2, 2]);
  assert.ok(legacyCounts[0] < legacyCounts[1]);
  assert.ok(legacyCounts[1] < legacyCounts[2]);
  assert.ok(legacyCounts[2] < legacyCounts[3]);
});

test('agent tool count and serialized bytes stay fixed across 1 to 1000 projects skills and devices', () => {
  const counts = [1, 10, 100, 1000];
  const snapshots = counts.map(count => {
    const context = syntheticContext(count, count, count);
    const tools = [...listCustomTools(context), applyToolRisk(listDevicesToolDefinition())];
    return {
      count: tools.length,
      bytes: Buffer.byteLength(JSON.stringify({ tools }), 'utf8'),
      serialized: JSON.stringify(tools)
    };
  });

  assert.deepEqual(snapshots.map(item => item.count), Array(counts.length).fill(snapshots[0].count));
  assert.deepEqual(snapshots.map(item => item.bytes), Array(counts.length).fill(snapshots[0].bytes));
  assert.doesNotMatch(snapshots.at(-1).serialized, /device-0999|project-0999|synthetic-999/);
});

test('hybrid external eager schemas stay within the configured serialized-byte budget at scale', () => {
  const budgetBytes = 24 * 1024;
  const tools = Array.from({ length: 1000 }, (_, index) => ({
    name: `bulk_read_${String(index).padStart(4, '0')}`,
    description: `Read synthetic external item ${index}.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { upstream: { upstreamId: 'bulk', source: 'external-mcp' } }
  }));
  const selection = selectExternalCatalog(tools, {
    exposure_mode: 'hybrid',
    eager_schema_budget_bytes: budgetBytes,
    eager_allowlist: []
  }, [{ id: 'bulk' }]);

  assert.ok(selection.eagerTools.length > 0);
  assert.ok(selection.deferredTools.length > 0);
  assert.ok(selection.eagerTools.reduce((sum, tool) => sum + catalogToolBytes(tool), 0) <= budgetBytes);
  assert.ok(selection.diagnostics.eager.bytes <= budgetBytes);
});

test('agent exposes no templates, native exposes exactly six fixed templates, legacy preserves three', () => {
  const context = syntheticContext(1000, 1000, 1000);
  assert.deepEqual(listRepoResourceTemplates(context, mode('agent')), []);

  const nativeTemplates = listRepoResourceTemplates(context, mode('native'));
  assert.equal(nativeTemplates.length, 6);
  assert.deepEqual(nativeTemplates.map(item => item.uriTemplate), [
    'repo://device/{device_id}/project/{project_id}/summary',
    'repo://device/{device_id}/project/{project_id}/tree{?depth}',
    'repo://device/{device_id}/project/{project_id}/git/status',
    'repo://device/{device_id}/project/{project_id}/git/diff{?staged}',
    'repo://device/{device_id}/project/{project_id}/file/{path}',
    'skill://skills/{skillName}/SKILL.md'
  ]);
  assert.equal(listRepoResourceTemplates(context, mode('legacy')).length, 3);
});

test('agent/native list only singleton gateway diagnostics and never project-scoped duplicates', () => {
  const context = syntheticContext(100, 100, 100);
  for (const surfaceMode of ['agent', 'native']) {
    const resources = listRepoResources(context, mode(surfaceMode));
    assert.deepEqual(resources.map(item => item.uri), [
      'repo://gateway/runtime-profile',
      'repo://gateway/tool-manifest'
    ]);
    assert.equal(resources.some(item => item.uri.includes('/project/')), false);
    assert.equal(resources.some(item => item.uri.startsWith('skill://')), false);
  }
});

test('legacy lists singleton diagnostics but does not duplicate gateway diagnostics under projects', () => {
  const context = syntheticContext(3, 2, 3);
  const resources = listRepoResources(context, mode('legacy'));
  assert.equal(resources.some(item => item.uri === 'repo://gateway/runtime-profile'), true);
  assert.equal(resources.some(item => item.uri === 'repo://gateway/tool-manifest'), true);
  assert.equal(resources.some(item => /\/runtime-profile$/.test(item.uri) && item.uri.includes('/project/')), false);
  assert.equal(resources.some(item => /\/tool-manifest$/.test(item.uri) && item.uri.includes('/project/')), false);
});

test('project deep links and old diagnostic aliases remain readable in every surface mode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-scale-deep-link-'));
  await fs.writeFile(path.join(root, 'README.md'), '# Deep link\n');
  const project = { projectId: 'fixture', deviceId: 'device-a', displayName: 'Fixture', repoRoot: root, trustedRoots: [root] };
  const context = {
    projectRegistry: {
      projects: new Map([['fixture', project]]),
      projectRoutes: new Map([['device-a\u0000fixture', project]]),
      defaultProjectId: 'fixture',
      exposeProjectPaths: false
    },
    listVisibleDevices: () => [{ deviceId: 'device-a', online: true, revoked: false, pathStyle: 'posix' }],
    env: { MCP_RUNTIME_PROFILE: 'safe' },
    listTools: async () => []
  };

  for (const surfaceMode of ['legacy', 'agent', 'native']) {
    context.surfaceConfig = mode(surfaceMode);
    const summary = JSON.parse((await readRepoResource('repo://device/device-a/project/fixture/summary', context)).contents[0].text);
    assert.equal(summary.device_id, 'device-a');
    assert.equal(summary.project_id, 'fixture');
    const oldRuntime = JSON.parse((await readRepoResource('repo://project/fixture/runtime-profile', context)).contents[0].text);
    const singletonRuntime = JSON.parse((await readRepoResource('repo://gateway/runtime-profile', context)).contents[0].text);
    assert.deepEqual(oldRuntime, singletonRuntime);
  }
});
