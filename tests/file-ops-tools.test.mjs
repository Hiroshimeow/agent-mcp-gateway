import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { callCustomTool } from '../scripts/custom-tools/index.mjs';

function parse(result) {
  return JSON.parse(result.content.find(entry => entry.type === 'text').text);
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fileops-'));
  return { root, context: { resolvedRepoRoots: [root], resolvedRepoRoot: root } };
}

test('custom_copy_file copies files and rejects overwrite by default', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  let out = parse(await callCustomTool('copy_file', { source: 'a.txt', destination: 'b.txt' }, context));
  assert.equal(out.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'b.txt'), 'utf8'), 'a');
  out = parse(await callCustomTool('copy_file', { source: 'a.txt', destination: 'b.txt' }, context));
  assert.equal(out.ok, false);
});

test('custom_copy_file dry run does not copy and directory requires recursive', async () => {
  const { root, context } = await fixture();
  await fs.mkdir(path.join(root, 'dir'));
  await fs.writeFile(path.join(root, 'dir', 'a.txt'), 'a');
  let out = parse(await callCustomTool('copy_file', { source: 'dir', destination: 'copy' }, context));
  assert.equal(out.ok, false);
  out = parse(await callCustomTool('copy_file', { source: 'dir', destination: 'copy', recursive: true, dryRun: true }, context));
  assert.equal(out.ok, true);
  await assert.rejects(() => fs.stat(path.join(root, 'copy')));
});

test('custom_delete_file deletes files and respects dryRun', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  let out = parse(await callCustomTool('delete_file', { path: 'a.txt', dryRun: true }, context));
  assert.equal(out.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'a');
  out = parse(await callCustomTool('delete_file', { path: 'a.txt' }, context));
  assert.equal(out.ok, true);
  await assert.rejects(() => fs.stat(path.join(root, 'a.txt')));
});

test('custom_delete_file rejects directory without recursive, .git, root, and outside root', async () => {
  const { root, context } = await fixture();
  await fs.mkdir(path.join(root, 'dir'));
  await fs.mkdir(path.join(root, '.git'));
  assert.equal(parse(await callCustomTool('delete_file', { path: 'dir' }, context)).ok, false);
  assert.equal(parse(await callCustomTool('delete_file', { path: '.git', recursive: true }, context)).ok, false);
  assert.equal(parse(await callCustomTool('delete_file', { path: root, recursive: true }, context)).ok, false);
  assert.equal(parse(await callCustomTool('delete_file', { path: '..', recursive: true }, context)).ok, false);
});
