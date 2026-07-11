import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTrustedRootsProjectRegistry } from '../scripts/projects/trusted-roots-projects.mjs';
import { listRepoResources, readRepoResource } from '../scripts/resources/index.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-res-'));
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(root, 'file.txt'), 'hello');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
  const registry = buildTrustedRootsProjectRegistry([`${root} | fixture | Fixture`], { defaultProjectId: 'fixture' });
  return { root, context: { projectRegistry: registry, env: { MCP_SAFETY_PROFILE: 'safe' }, listTools: async () => [{ name: 'read_text_file' }, { name: 'shell_execute' }] } };
}

function firstJson(result) {
  return JSON.parse(result.contents[0].text);
}

test('lists project resources and reads project list', async () => {
  const { context } = await fixture();
  assert.equal(listRepoResources(context).some(r => r.uri === 'repo://projects'), true);
  const projects = firstJson(await readRepoResource('repo://projects', context));
  assert.equal(projects.projects[0].projectId, 'fixture');
  assert.equal(projects.projects[0].repoRoot, undefined);
});

test('reads summary safety profile readme package tree and tool manifest', async () => {
  const { context } = await fixture();
  assert.equal(firstJson(await readRepoResource('repo://project/fixture/summary', context)).hasPackageJson, true);
  assert.equal(firstJson(await readRepoResource('repo://project/fixture/safety-profile', context)).profile, 'safe');
  assert.match((await readRepoResource('repo://project/fixture/readme', context)).contents[0].text, /Fixture/);
  assert.equal(firstJson(await readRepoResource('repo://project/fixture/package', context)).name, 'fixture');
  assert.equal(Array.isArray(firstJson(await readRepoResource('repo://project/fixture/tree', context)).entries), true);
  assert.equal(firstJson(await readRepoResource('repo://project/fixture/tree?depth=bad', context)).maxDepth, 3);
  const manifest = firstJson(await readRepoResource('repo://project/fixture/tool-manifest', context));
  assert.equal(manifest.tools.find(t => t.name === 'shell_execute').visible, false);
  assert.equal(manifest.tools.find(t => t.name === 'read_text_file').visible, true);
});

test('reads safe project-relative file and rejects traversal', async () => {
  const { context } = await fixture();
  assert.equal((await readRepoResource('repo://project/fixture/file/file.txt', context)).contents[0].text, 'hello');
  await assert.rejects(() => readRepoResource('repo://project/fixture/file/..%2Fsecret.txt', context), /Invalid project-relative/);
});

test('rejects binary and oversized project-relative files', async () => {
  const { context } = await fixture();
  await assert.rejects(() => readRepoResource('repo://project/fixture/file/binary.bin', context), /binary/);
  await assert.rejects(() => readRepoResource('repo://project/fixture/file/large.txt', context), /too large/);
});

test('rejects unknown resource URI', async () => {
  const { context } = await fixture();
  await assert.rejects(() => readRepoResource('repo://project/fixture/nope', context), /Unknown resource URI/);
});
