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
  const projectRegistry = buildTrustedRootsProjectRegistry([`${root} | fixture | Fixture | device-a`], { defaultProjectId: 'fixture' });
  return {
    root,
    context: {
      projectRegistry,
      env: { MCP_RUNTIME_PROFILE: 'yolo' },
      listVisibleDevices: () => [{ deviceId: 'device-a', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' }],
      callDeviceTool: async (tool, args) => {
        assert.equal(tool, 'project_inspect');
        return { defaultRootName: path.basename(args.path), hasReadme: true, hasPackageJson: false };
      }
    }
  };
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

function errorCode(error) {
  return error?.code;
}

test('project_inspect public schema uses device_id plus project_id only', () => {
  const tool = listCustomTools().find(item => item.name === 'project_inspect');
  assert.ok(tool);
  assert.ok(tool.inputSchema.properties.device_id);
  assert.ok(tool.inputSchema.properties.project_id);
  assert.equal(tool.inputSchema.properties.deviceId, undefined);
  assert.equal(tool.inputSchema.properties.projectId, undefined);
  assert.deepEqual(tool.inputSchema.required, ['device_id', 'project_id', 'view']);
});

test('project public outputs use project_id and never silently select default project', async () => {
  const { root, context } = fixture();
  try {
    const listed = listProjects(context, { device_id: 'device-a' });
    assert.equal(listed.items[0].project_id, 'fixture');
    assert.equal(listed.items[0].projectId, undefined);

    await assert.rejects(
      () => inspectProject(context, { view: 'summary' }),
      error => errorCode(error) === 'DEVICE_ID_REQUIRED' && /DEVICE_ID_REQUIRED/.test(error.message)
    );

    await assert.rejects(
      () => callCustomTool('project_inspect', { device_id: 'device-a', projectId: 'fixture', view: 'summary' }, context),
      error => errorCode(error) === 'PROJECT_ID_REQUIRED' && /PROJECT_ID_REQUIRED/.test(error.message)
    );

    const response = parseToolResult(await callCustomTool('project_inspect', { device_id: 'device-a', project_id: 'fixture', view: 'summary' }, context));
    assert.equal(response.data.device_id, 'device-a');
    assert.equal(response.data.project_id, 'fixture');
    assert.equal(response.data.projectId, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repo prompts expose and require device_id plus project_id without default fallback', () => {
  const prompt = listRepoPrompts().find(item => item.name === 'quality_check');
  assert.ok(prompt.arguments.some(arg => arg.name === 'device_id' && arg.required === true));
  assert.ok(prompt.arguments.some(arg => arg.name === 'project_id' && arg.required === true));
  assert.equal(prompt.arguments.some(arg => arg.name === 'projectId'), false);
  assert.throws(
    () => getRepoPrompt('quality_check', {}, { defaultProjectId: 'fixture' }),
    error => errorCode(error) === 'DEVICE_ID_REQUIRED'
  );
  assert.match(getRepoPrompt('quality_check', { device_id: 'device-a', project_id: 'fixture' }).messages[0].content.text, /Device: device-a[\s\S]*Project: fixture/);
});

test('resource templates use device_id plus project_id and project listing emits snake_case ids', async () => {
  const templates = listRepoResourceTemplates({}, { mode: 'native' });
  assert.ok(templates.some(item => item.uriTemplate.includes('{device_id}') && item.uriTemplate.includes('{project_id}')));
  assert.equal(templates.some(item => item.uriTemplate.includes('{deviceId}') || item.uriTemplate.includes('{projectId}')), false);

  const { root, context } = fixture();
  try {
    const resource = await readRepoResource('repo://device/device-a/projects', context);
    const payload = JSON.parse(resource.contents[0].text);
    assert.equal(payload.device_id, 'device-a');
    assert.equal(payload.projects[0].project_id, 'fixture');
    assert.equal(payload.projects[0].projectId, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
