import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listRepoResources, listRepoResourceTemplates, readRepoResource } from '../scripts/resources/index.mjs';
import { loadSurfaceConfig } from '../scripts/surface-config.mjs';

function syntheticContext(projectCount, skillCount) {
  const projects = new Map();
  for (let index = 0; index < projectCount; index += 1) {
    const projectId = `project-${String(index).padStart(4, '0')}`;
    projects.set(projectId, {
      projectId,
      displayName: `Project ${index}`,
      repoRoot: path.join(os.tmpdir(), 'mcp-scale-missing', projectId),
      trustedRoots: []
    });
  }
  return {
    projectRegistry: {
      projects,
      defaultProjectId: projects.keys().next().value,
      exposeProjectPaths: false
    },
    listSkillResources: () => Array.from({ length: skillCount }, (_, index) => ({
      uri: `skill://skills/synthetic-${index}/SKILL.md`,
      name: `Synthetic skill ${index}`,
      mimeType: 'text/markdown'
    })),
    env: { MCP_RUNTIME_PROFILE: 'safe' },
    listTools: async () => []
  };
}

function mode(name) {
  return loadSurfaceConfig({ surface: { mode: name } }, {});
}

test('resource catalog cardinality stays fixed in agent/native and grows only in legacy', () => {
  const counts = [1, 100, 1000];
  const agentCounts = [];
  const nativeCounts = [];
  const legacyCounts = [];
  for (const count of counts) {
    const context = syntheticContext(count, count);
    agentCounts.push(listRepoResources(context, mode('agent')).length);
    nativeCounts.push(listRepoResources(context, mode('native')).length);
    legacyCounts.push(listRepoResources(context, mode('legacy')).length);
  }

  assert.deepEqual(agentCounts, [2, 2, 2]);
  assert.deepEqual(nativeCounts, [2, 2, 2]);
  assert.ok(legacyCounts[0] < legacyCounts[1]);
  assert.ok(legacyCounts[1] < legacyCounts[2]);
});

test('agent exposes no templates, native exposes exactly six fixed templates, legacy preserves three', () => {
  const context = syntheticContext(1000, 1000);
  assert.deepEqual(listRepoResourceTemplates(context, mode('agent')), []);

  const nativeTemplates = listRepoResourceTemplates(context, mode('native'));
  assert.equal(nativeTemplates.length, 6);
  assert.deepEqual(nativeTemplates.map(item => item.uriTemplate), [
    'repo://project/{projectId}/summary',
    'repo://project/{projectId}/tree{?depth}',
    'repo://project/{projectId}/git/status',
    'repo://project/{projectId}/git/diff{?staged}',
    'repo://project/{projectId}/file/{path}',
    'skill://skills/{skillName}/SKILL.md'
  ]);
  assert.equal(listRepoResourceTemplates(context, mode('legacy')).length, 3);
});

test('agent/native list only singleton gateway diagnostics and never project-scoped duplicates', () => {
  const context = syntheticContext(100, 100);
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
  const context = syntheticContext(3, 2);
  const resources = listRepoResources(context, mode('legacy'));
  assert.equal(resources.some(item => item.uri === 'repo://gateway/runtime-profile'), true);
  assert.equal(resources.some(item => item.uri === 'repo://gateway/tool-manifest'), true);
  assert.equal(resources.some(item => /\/runtime-profile$/.test(item.uri) && item.uri.startsWith('repo://project/')), false);
  assert.equal(resources.some(item => /\/tool-manifest$/.test(item.uri) && item.uri.startsWith('repo://project/')), false);
});

test('project deep links and old diagnostic aliases remain readable in every surface mode', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-scale-deep-link-'));
  await fs.writeFile(path.join(root, 'README.md'), '# Deep link\n');
  const project = { projectId: 'fixture', displayName: 'Fixture', repoRoot: root, trustedRoots: [root] };
  const context = {
    projectRegistry: { projects: new Map([['fixture', project]]), defaultProjectId: 'fixture', exposeProjectPaths: false },
    env: { MCP_RUNTIME_PROFILE: 'safe' },
    listTools: async () => []
  };

  for (const surfaceMode of ['legacy', 'agent', 'native']) {
    context.surfaceConfig = mode(surfaceMode);
    const summary = JSON.parse((await readRepoResource('repo://project/fixture/summary', context)).contents[0].text);
    assert.equal(summary.projectId, 'fixture');
    const oldRuntime = JSON.parse((await readRepoResource('repo://project/fixture/runtime-profile', context)).contents[0].text);
    const singletonRuntime = JSON.parse((await readRepoResource('repo://gateway/runtime-profile', context)).contents[0].text);
    assert.deepEqual(oldRuntime, singletonRuntime);
  }
});
