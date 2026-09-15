import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildTrustedRootsProjectRegistry } from '../scripts/projects/trusted-roots-projects.mjs';
import { inspectProject, listProjects } from '../scripts/project-inspection.mjs';

async function makeProject(base, name, { readme = true, pkg = true } = {}) {
  const root = path.join(base, name);
  await fs.mkdir(root, { recursive: true });
  if (readme) await fs.writeFile(path.join(root, 'README.md'), `# ${name}\n`);
  if (pkg) await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name }));
  return root;
}

async function fakeDeviceInspector(tool, args) {
  assert.equal(tool, 'project_inspect');
  const root = args.path;
  if (args.view === 'summary') {
    const exists = async file => fs.access(path.join(root, file)).then(() => true, () => false);
    return {
      defaultRootName: path.basename(root),
      hasReadme: await exists('README.md') || await exists('README.vi.md'),
      hasPackageJson: await exists('package.json')
    };
  }
  if (args.view === 'tree') {
    if (!args.cursor) {
      return {
        rootName: path.basename(root), maxDepth: args.depth ?? 3, maxEntries: args.limit ?? 200,
        entries: [
          { path: 'README.md', name: 'README.md', type: 'file', depth: 1 },
          { path: 'package.json', name: 'package.json', type: 'file', depth: 1 }
        ],
        truncated: true,
        nextCursor: 'device-tree-next'
      };
    }
    return {
      rootName: path.basename(root), maxDepth: args.depth ?? 3, maxEntries: args.limit ?? 200,
      entries: [{ path: 'src', name: 'src', type: 'directory', depth: 1 }],
      truncated: false,
      nextCursor: null
    };
  }
  if (args.view === 'git_status') {
    return { ok: true, status: execFileSync('git', ['status', '--short', '--branch'], { cwd: root, encoding: 'utf8' }), stderr: '', exitCode: 0 };
  }
  if (args.view === 'git_diff') {
    return { ok: true, staged: args.staged === true, text: execFileSync('git', args.staged === true ? ['diff', '--staged'] : ['diff'], { cwd: root, encoding: 'utf8' }), stderr: '', exitCode: 0 };
  }
  if (args.view === 'readme') {
    for (const fileName of ['README.md', 'README.vi.md']) {
      try { return { fileName, text: await fs.readFile(path.join(root, fileName), 'utf8') }; } catch {}
    }
    throw new Error(`README not found for project_id: ${args.project_id}`);
  }
  if (args.view === 'package') {
    try { return { data: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) }; }
    catch { throw new Error(`package.json not found for project_id: ${args.project_id}`); }
  }
  throw new Error(`Unexpected device inspection view: ${args.view}`);
}

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-project-inspection-'));
  const alpha = await makeProject(base, 'alpha');
  const alphaTools = await makeProject(base, 'alpha-tools');
  const myAlpha = await makeProject(base, 'my-alpha');
  const empty = await makeProject(base, 'empty', { readme: false, pkg: false });

  await fs.mkdir(path.join(alpha, 'src', 'nested'), { recursive: true });
  await fs.writeFile(path.join(alpha, 'src', 'a.txt'), 'a');
  await fs.writeFile(path.join(alpha, 'src', 'b.txt'), 'b');
  await fs.writeFile(path.join(alpha, 'src', 'nested', 'deep.txt'), 'deep');
  await fs.mkdir(path.join(alpha, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(alpha, 'node_modules', 'hidden.txt'), 'hidden');

  execFileSync('git', ['init'], { cwd: alpha, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: alpha, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: alpha, stdio: 'ignore' });
  await fs.appendFile(path.join(alpha, 'README.md'), 'changed\n');

  const registry = buildTrustedRootsProjectRegistry([
    `${alpha} | alpha | Alpha | device-a`,
    `${alphaTools} | alpha-tools | Alpha Tools | device-a`,
    `${myAlpha} | my-alpha | My Alpha | device-a`,
    `${empty} | empty | Empty | device-a`
  ], { defaultProjectId: 'alpha' });
  const context = {
    projectRegistry: registry,
    listVisibleDevices: () => [{ deviceId: 'device-a', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' }],
    callDeviceTool: fakeDeviceInspector
  };
  return { base, alpha, registry, context };
}

test('listProjects paginates with opaque cursors and exact query match first', async () => {
  const { context } = await fixture();
  const first = listProjects({ ...context, exposePaths: false }, { device_id: 'device-a', query: 'alpha', limit: 2 });
  assert.deepEqual(first.items.map(item => item.project_id), ['alpha', 'alpha-tools']);
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal(first.truncated, true);
  assert.equal(first.items[0].repoRoot, undefined);

  const second = listProjects({ ...context, exposePaths: false }, { device_id: 'device-a', query: 'alpha', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.project_id), ['my-alpha']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.truncated, false);

  assert.throws(
    () => listProjects(context, { device_id: 'device-a', cursor: 'not-a-valid-cursor' }),
    /cursor/i
  );
});

test('listProjects hides absolute paths by default and exposes them only when enabled', async () => {
  const { context, alpha } = await fixture();
  const hidden = listProjects({ ...context, exposePaths: false }, { device_id: 'device-a', query: 'alpha', limit: 1 });
  assert.equal(hidden.items[0].repoRoot, undefined);

  const exposed = listProjects({ ...context, exposePaths: true }, { device_id: 'device-a', query: 'alpha', limit: 1 });
  assert.equal(exposed.items[0].repoRoot, alpha);
});

test('inspectProject routes inspection through the selected device instead of gateway-host paths', async () => {
  const remoteRoot = path.join(os.tmpdir(), `definitely-not-local-${Date.now()}`, 'remote-project');
  const registry = buildTrustedRootsProjectRegistry([
    `${remoteRoot} | remote | Remote | device-a`
  ]);
  const calls = [];
  const context = {
    projectRegistry: registry,
    env: { MCP_RUNTIME_PROFILE: 'safe' },
    listVisibleDevices: () => [{ deviceId: 'device-a', online: true, revoked: false, platform: 'linux', pathStyle: 'posix' }],
    async callDeviceTool(tool, args) {
      calls.push({ tool, args });
      return { hasReadme: true, hasPackageJson: true, defaultRootName: 'remote-project' };
    }
  };

  const summary = await inspectProject(context, { deviceId: 'device-a', projectId: 'remote', view: 'summary' });
  assert.equal(summary.project_id, 'remote');
  assert.equal(summary.hasReadme, true);
  assert.equal(summary.hasPackageJson, true);
  assert.deepEqual(calls, [{
    tool: 'project_inspect',
    args: { device_id: 'device-a', path: remoteRoot, project_id: 'remote', view: 'summary' }
  }]);
});

test('inspectProject supports summary, bounded tree, git status, and git diff views', async () => {
  const { context: baseContext } = await fixture();
  const context = { ...baseContext, env: { MCP_RUNTIME_PROFILE: 'safe' } };

  const summary = await inspectProject(context, { deviceId: 'device-a', projectId: 'alpha', view: 'summary' });
  assert.equal(summary.project_id, 'alpha');
  assert.equal(summary.hasReadme, true);
  assert.equal(summary.hasPackageJson, true);
  assert.equal(summary.repoRoot, undefined);

  const tree = await inspectProject(context, { deviceId: 'device-a', projectId: 'alpha', view: 'tree', depth: 2, limit: 2 });
  assert.equal(tree.entries.length, 2);
  assert.equal(tree.truncated, true);
  assert.equal(typeof tree.nextCursor, 'string');
  assert.equal(tree.entries.some(entry => entry.path.includes('node_modules')), false);
  assert.equal(tree.entries.every(entry => entry.depth <= 2), true);

  const treeNext = await inspectProject(context, { deviceId: 'device-a', projectId: 'alpha', view: 'tree', depth: 2, limit: 10, cursor: tree.nextCursor });
  assert.equal(treeNext.entries.some(entry => entry.path.includes('node_modules')), false);
  assert.equal(treeNext.entries.every(entry => entry.depth <= 2), true);

  const status = await inspectProject(context, { deviceId: 'device-a', projectId: 'alpha', view: 'git_status' });
  assert.equal(status.ok, true);
  assert.match(status.status, /README\.md/);

  const diff = await inspectProject(context, { deviceId: 'device-a', projectId: 'alpha', view: 'git_diff' });
  assert.equal(diff.ok, true);
  assert.match(diff.text, /changed/);
});

test('inspectProject rejects unknown views and projects with actionable errors', async () => {
  const { context } = await fixture();
  await assert.rejects(() => inspectProject(context, { deviceId: 'device-a', projectId: 'alpha', view: 'file' }), /view/i);
  await assert.rejects(() => inspectProject(context, { deviceId: 'device-a', projectId: 'missing', view: 'summary' }), /PROJECT_DEVICE_MISMATCH/);
});

test('inspectProject reports missing README and package.json explicitly', async () => {
  const { context } = await fixture();
  await assert.rejects(() => inspectProject(context, { deviceId: 'device-a', projectId: 'empty', view: 'readme' }), /README/i);
  await assert.rejects(() => inspectProject(context, { deviceId: 'device-a', projectId: 'empty', view: 'package' }), /package\.json/i);
});
