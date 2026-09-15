import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listCustomTools } from '../scripts/custom-tools/index.mjs';
import { selectDeviceForPathHint } from '../scripts/device-inventory.mjs';
import { inspectProject, listProjects } from '../scripts/project-inspection.mjs';
import { getRepoPrompt, listRepoPrompts } from '../scripts/prompts/index.mjs';
import { listRepoResourceTemplates, readRepoResource } from '../scripts/resources/index.mjs';
import {
  buildTrustedRootsProjectRegistry,
  trustedRootEntryToLine
} from '../scripts/projects/trusted-roots-projects.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-device-routing-'));
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'README.md'), '# A\n');
  fs.writeFileSync(path.join(b, 'README.md'), '# B\n');
  const registry = buildTrustedRootsProjectRegistry([
    `${a} | shared | Shared A | linux-a`,
    `${b} | shared | Shared B | linux-b`
  ]);
  return { dir, a, b, registry, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function visibleDevices(...devices) {
  return { listVisibleDevices: () => devices };
}

test('configured project entries preserve explicit device_id and same project_id may exist on different devices', () => {
  const line = trustedRootEntryToLine({
    path: '/srv/project',
    project_id: 'shared',
    display_name: 'Shared',
    device_id: 'linux-a'
  });
  assert.equal(line, '/srv/project | shared | Shared | linux-a');

  const f = fixture();
  try {
    assert.equal(f.registry.projectRoutes.size, 2);
    assert.equal(f.registry.projects.has('shared'), false, 'ambiguous legacy project lookup must not choose one device');
  } finally { f.close(); }
});

test('project tool schemas require explicit device_id', () => {
  const tools = new Map(listCustomTools().map(tool => [tool.name, tool]));
  assert.deepEqual(tools.get('project_list').inputSchema.required, ['device_id']);
  assert.deepEqual(tools.get('project_inspect').inputSchema.required, ['device_id', 'project_id', 'view']);
});

test('project_list is device-scoped and rejects missing or offline devices', () => {
  const f = fixture();
  try {
    const context = {
      projectRegistry: f.registry,
      ...visibleDevices(
        { deviceId: 'linux-a', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' },
        { deviceId: 'linux-b', online: false, revoked: false, platform: 'linux', pathStyle: 'posix' }
      )
    };

    assert.throws(() => listProjects(context, {}), /DEVICE_ID_REQUIRED/);
    const listed = listProjects(context, { device_id: 'linux-a' });
    assert.equal(listed.total, 1);
    assert.deepEqual(listed.items.map(item => [item.device_id, item.project_id]), [['linux-a', 'shared']]);
    assert.throws(() => listProjects(context, { device_id: 'linux-b' }), /DEVICE_OFFLINE/);
  } finally { f.close(); }
});

test('project_inspect requires the exact visible online device/project pair and never reroutes', async () => {
  const f = fixture();
  try {
    const context = {
      projectRegistry: f.registry,
      ...visibleDevices(
        { deviceId: 'linux-a', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' },
        { deviceId: 'linux-b', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' }
      )
    };

    await assert.rejects(
      () => inspectProject(context, { projectId: 'shared', view: 'summary' }),
      /DEVICE_ID_REQUIRED/
    );
    const summary = await inspectProject(context, { deviceId: 'linux-b', projectId: 'shared', view: 'summary' });
    assert.equal(summary.device_id, 'linux-b');
    assert.equal(summary.project_id, 'shared');
    assert.equal(summary.defaultRootName, path.basename(f.b));

    const singleRegistry = buildTrustedRootsProjectRegistry([
      `${f.a} | only-a | Only A | linux-a`
    ]);
    await assert.rejects(
      () => inspectProject({ ...context, projectRegistry: singleRegistry }, { deviceId: 'linux-b', projectId: 'only-a', view: 'summary' }),
      /PROJECT_DEVICE_MISMATCH/
    );
  } finally { f.close(); }
});

test('repo prompts require device_id alongside project_id', () => {
  const prompt = listRepoPrompts().find(item => item.name === 'explore_project');
  assert.equal(prompt.arguments.find(arg => arg.name === 'device_id')?.required, true);
  assert.equal(prompt.arguments.find(arg => arg.name === 'project_id')?.required, true);
  assert.throws(() => getRepoPrompt('explore_project', { project_id: 'shared' }), /DEVICE_ID_REQUIRED/);
  const built = getRepoPrompt('explore_project', { device_id: 'linux-a', project_id: 'shared' });
  assert.match(built.messages[0].content.text, /Device: linux-a/);
});

test('project resources use device-scoped URIs and do not retain project-only routing aliases', async () => {
  const f = fixture();
  try {
    const context = {
      projectRegistry: f.registry,
      surfaceConfig: { mode: 'native' },
      ...visibleDevices(
        { deviceId: 'linux-a', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' },
        { deviceId: 'linux-b', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' }
      )
    };
    const templates = listRepoResourceTemplates(context);
    assert.equal(templates.filter(item => item.uriTemplate.startsWith('repo://')).every(item => item.uriTemplate.includes('{device_id}')), true);

    const resource = await readRepoResource('repo://device/linux-b/project/shared/summary', context);
    const payload = JSON.parse(resource.contents[0].text);
    assert.equal(payload.device_id, 'linux-b');
    assert.equal(payload.project_id, 'shared');
    await assert.rejects(() => readRepoResource('repo://project/shared/summary', context), /Unknown resource URI/);
  } finally { f.close(); }
});

test('path hints select only one compatible owned online device and stay ambiguous with two Linux devices', () => {
  const windows = { deviceId: 'win-a', online: true, revoked: false, platform: 'win32', pathStyle: 'windows' };
  const linuxA = { deviceId: 'linux-a', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' };
  const linuxB = { deviceId: 'linux-b', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' };
  const offlineLinux = { deviceId: 'linux-offline', online: false, revoked: false, platform: 'linux', pathStyle: 'posix' };

  assert.equal(selectDeviceForPathHint([windows, linuxA, offlineLinux], '/home/user/project').deviceId, 'linux-a');
  assert.equal(selectDeviceForPathHint([windows, linuxA], 'C:\\work\\project').deviceId, 'win-a');
  assert.throws(
    () => selectDeviceForPathHint([linuxA, linuxB], '/home/user/project'),
    /DEVICE_SELECTION_AMBIGUOUS/
  );
});
