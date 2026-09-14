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
    `${alpha} | alpha | Alpha`,
    `${alphaTools} | alpha-tools | Alpha Tools`,
    `${myAlpha} | my-alpha | My Alpha`,
    `${empty} | empty | Empty`
  ], { defaultProjectId: 'alpha' });
  return { base, alpha, registry };
}

test('listProjects paginates with opaque cursors and exact query match first', async () => {
  const { registry } = await fixture();
  const first = listProjects({ projectRegistry: registry, exposePaths: false }, { query: 'alpha', limit: 2 });
  assert.deepEqual(first.items.map(item => item.projectId), ['alpha', 'alpha-tools']);
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal(first.truncated, true);
  assert.equal(first.items[0].repoRoot, undefined);

  const second = listProjects({ projectRegistry: registry, exposePaths: false }, { query: 'alpha', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.projectId), ['my-alpha']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.truncated, false);

  assert.throws(
    () => listProjects({ projectRegistry: registry }, { cursor: 'not-a-valid-cursor' }),
    /cursor/i
  );
});

test('listProjects hides absolute paths by default and exposes them only when enabled', async () => {
  const { registry, alpha } = await fixture();
  const hidden = listProjects({ projectRegistry: registry, exposePaths: false }, { query: 'alpha', limit: 1 });
  assert.equal(hidden.items[0].repoRoot, undefined);

  const exposed = listProjects({ projectRegistry: registry, exposePaths: true }, { query: 'alpha', limit: 1 });
  assert.equal(exposed.items[0].repoRoot, alpha);
});

test('inspectProject supports summary, bounded tree, git status, and git diff views', async () => {
  const { registry } = await fixture();
  const context = { projectRegistry: registry, env: { MCP_RUNTIME_PROFILE: 'safe' } };

  const summary = await inspectProject(context, { projectId: 'alpha', view: 'summary' });
  assert.equal(summary.projectId, 'alpha');
  assert.equal(summary.hasReadme, true);
  assert.equal(summary.hasPackageJson, true);
  assert.equal(summary.repoRoot, undefined);

  const tree = await inspectProject(context, { projectId: 'alpha', view: 'tree', depth: 2, limit: 2 });
  assert.equal(tree.entries.length, 2);
  assert.equal(tree.truncated, true);
  assert.equal(typeof tree.nextCursor, 'string');
  assert.equal(tree.entries.some(entry => entry.path.includes('node_modules')), false);
  assert.equal(tree.entries.every(entry => entry.depth <= 2), true);

  const treeNext = await inspectProject(context, { projectId: 'alpha', view: 'tree', depth: 2, limit: 10, cursor: tree.nextCursor });
  assert.equal(treeNext.entries.some(entry => entry.path.includes('node_modules')), false);
  assert.equal(treeNext.entries.every(entry => entry.depth <= 2), true);

  const status = await inspectProject(context, { projectId: 'alpha', view: 'git_status' });
  assert.equal(status.ok, true);
  assert.match(status.status, /README\.md/);

  const diff = await inspectProject(context, { projectId: 'alpha', view: 'git_diff' });
  assert.equal(diff.ok, true);
  assert.match(diff.text, /changed/);
});

test('inspectProject rejects unknown views and projects with actionable errors', async () => {
  const { registry } = await fixture();
  const context = { projectRegistry: registry };
  await assert.rejects(() => inspectProject(context, { projectId: 'alpha', view: 'file' }), /view/i);
  await assert.rejects(() => inspectProject(context, { projectId: 'missing', view: 'summary' }), /Unknown projectId/);
});

test('inspectProject reports missing README and package.json explicitly', async () => {
  const { registry } = await fixture();
  const context = { projectRegistry: registry };
  await assert.rejects(() => inspectProject(context, { projectId: 'empty', view: 'readme' }), /README/i);
  await assert.rejects(() => inspectProject(context, { projectId: 'empty', view: 'package' }), /package\.json/i);
});
