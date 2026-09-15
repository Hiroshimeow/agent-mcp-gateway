import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { callCustomTool, listCustomTools } from '../scripts/custom-tools/index.mjs';
import { inspectProject, listProjects } from '../scripts/project-inspection.mjs';
import { getRepoPrompt, listRepoPrompts } from '../scripts/prompts/index.mjs';
import { listRepoResourceTemplates, readRepoResource } from '../scripts/resources/index.mjs';
import { buildTrustedRootsProjectRegistry } from '../scripts/projects/trusted-roots-projects.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-project-contract-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  const projectRegistry = buildTrustedRootsProjectRegistry([`${root} | fixture | Fixture`], { defaultProjectId: 'fixture' });
  return { root, context: { projectRegistry, env: { MCP_RUNTIME_PROFILE: 'yolo' } } };
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

function errorCode(error) {
  return error?.code;
}

test('project_inspect public schema uses project_id only', () => {
  const tool = listCustomTools().find(item => item.name === 'project_inspect');
  assert.ok(tool);
  assert.ok(tool.inputSchema.properties.project_id);
  assert.equal(tool.inputSchema.properties.projectId, undefined);
  assert.deepEqual(tool.inputSchema.required, ['project_id', 'view']);
});

test('project public outputs use project_id and never silently select default project', async () => {
  const { root, context } = fixture();
  try {
    const listed = listProjects(context);
    assert.equal(listed.items[0].project_id, 'fixture');
    assert.equal(listed.items[0].projectId, undefined);

    await assert.rejects(
      () => inspectProject(context, { view: 'summary' }),
      error => errorCode(error) === 'PROJECT_ID_REQUIRED' && /PROJECT_ID_REQUIRED/.test(error.message)
    );

    await assert.rejects(
      () => callCustomTool('project_inspect', { projectId: 'fixture', view: 'summary' }, context),
      error => errorCode(error) === 'PROJECT_ID_REQUIRED' && /PROJECT_ID_REQUIRED/.test(error.message)
    );

    const response = parseToolResult(await callCustomTool('project_inspect', { project_id: 'fixture', view: 'summary' }, context));
    assert.equal(response.data.project_id, 'fixture');
    assert.equal(response.data.projectId, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repo prompts expose and require project_id without default fallback', () => {
  const prompt = listRepoPrompts().find(item => item.name === 'quality_check');
  assert.ok(prompt.arguments.some(arg => arg.name === 'project_id' && arg.required === true));
  assert.equal(prompt.arguments.some(arg => arg.name === 'projectId'), false);
  assert.throws(
    () => getRepoPrompt('quality_check', {}, { defaultProjectId: 'fixture' }),
    error => errorCode(error) === 'PROJECT_ID_REQUIRED'
  );
  assert.match(getRepoPrompt('quality_check', { project_id: 'fixture' }).messages[0].content.text, /Project: fixture/);
});

test('resource templates use project_id and project listing emits snake_case ids', async () => {
  const templates = listRepoResourceTemplates({}, { mode: 'native' });
  assert.ok(templates.some(item => item.uriTemplate.includes('{project_id}')));
  assert.equal(templates.some(item => item.uriTemplate.includes('{projectId}')), false);

  const { root, context } = fixture();
  try {
    const resource = await readRepoResource('repo://projects', context);
    const payload = JSON.parse(resource.contents[0].text);
    assert.equal(payload.projects[0].project_id, 'fixture');
    assert.equal(payload.projects[0].projectId, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
