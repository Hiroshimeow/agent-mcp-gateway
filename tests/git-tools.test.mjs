import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeDirectShell } from '../scripts/direct-shell.mjs';

import { callCustomTool } from '../scripts/custom-tools/index.mjs';

function parse(result) {
  return JSON.parse(result.content.find(entry => entry.type === 'text').text);
}

async function shell(command, cwdOrOptions) {
  const cwd = typeof cwdOrOptions === 'string' ? cwdOrOptions : cwdOrOptions?.cwd;
  return await executeDirectShell(command, { cwd });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-git-'));
  await shell('git init; git config user.email test@example.com; git config user.name Tester', root);
  await fs.writeFile(path.join(root, 'README.md'), 'hello\n');
  await shell('git add README.md; git commit -m init', root);
  return { root, context: { resolvedRepoRoots: [root], resolvedRepoRoot: root, executeDirectShell: shell } };
}

test('custom_git_status reports clean and dirty repo', async () => {
  const { root, context } = await fixture();
  let out = parse(await callCustomTool('git_status', { path: root }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.clean, true);
  await fs.writeFile(path.join(root, 'new.txt'), 'new');
  out = parse(await callCustomTool('git_status', { path: root }, context));
  assert.equal(out.data.clean, false);
  assert.equal(out.data.files.some(file => file.path === 'new.txt'), true);
});

test('custom_git_diff supports unstaged, staged, file filter, statOnly, and truncation', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, 'README.md'), 'hello changed\n');
  let out = parse(await callCustomTool('git_diff', { path: root }, context));
  assert.match(out.data.diff, /hello changed/);
  out = parse(await callCustomTool('git_diff', { path: root, files: ['README.md'] }, context));
  assert.match(out.data.diff, /README.md/);
  out = parse(await callCustomTool('git_diff', { path: root, statOnly: true }, context));
  assert.equal(out.data.diff, '');
  assert.match(out.data.stat, /README.md/);
  out = parse(await callCustomTool('git_diff', { path: root, maxBytes: 5 }, context));
  assert.equal(out.data.truncated, true);
  parse(await callCustomTool('git_add', { path: root, files: ['README.md'] }, context));
  out = parse(await callCustomTool('git_diff', { path: root, staged: true }, context));
  assert.match(out.data.diff, /hello changed/);
});

test('custom_git_add and custom_git_commit stage and commit changes', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  assert.equal(parse(await callCustomTool('git_add', { path: root }, context)).ok, false);
  assert.equal(parse(await callCustomTool('git_add', { path: root, all: true, dryRun: true }, context)).ok, true);
  assert.equal(parse(await callCustomTool('git_commit', { path: root, message: 'empty' }, context)).ok, false);
  assert.equal(parse(await callCustomTool('git_add', { path: root, all: true }, context)).ok, true);
  const commit = parse(await callCustomTool('git_commit', { path: root, message: 'add a' }, context));
  assert.equal(commit.ok, true);
  assert.match(commit.data.hash, /^[a-f0-9]{40}$/);
});

test('custom_git_commit allowEmpty works and invalid messages fail', async () => {
  const { root, context } = await fixture();
  assert.equal(parse(await callCustomTool('git_commit', { path: root, message: '' }, context)).ok, false);
  assert.equal(parse(await callCustomTool('git_commit', { path: root, message: 'bad\nbody' }, context)).ok, false);
  assert.equal(parse(await callCustomTool('git_commit', { path: root, message: 'empty ok', allowEmpty: true }, context)).ok, true);
});

test('custom_git_push works with local bare repo and reports missing remote', async () => {
  const { root, context } = await fixture();
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-remote-'));
  await shell('git init --bare', remote);
  await shell(`git remote add origin "${remote}"`, root);
  let out = parse(await callCustomTool('git_push', { path: root, setUpstream: true }, context));
  assert.equal(out.ok, true);
  out = parse(await callCustomTool('git_push', { path: root, remote: 'missing', dryRun: true }, context));
  assert.equal(out.ok, false);
});
