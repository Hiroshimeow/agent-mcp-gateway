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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-zip-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'logs'));
  await fs.mkdir(path.join(root, 'packages'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'src', 'app.txt'), 'app');
  await fs.writeFile(path.join(root, 'logs', 'app.log'), 'log');
  await fs.writeFile(path.join(root, 'packages', 'old.zip'), 'zip');
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref');
  return { root, context: { resolvedRepoRoots: [root], resolvedRepoRoot: root } };
}

test('custom_zip_create creates openable zip and excludes defaults', async () => {
  const { root, context } = await fixture();
  const out = parse(await callCustomTool('zip_create', { destination: 'packages/out.zip' }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.filesAdded, 1);
  const bytes = await fs.readFile(path.join(root, 'packages', 'out.zip'));
  assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
});

test('custom_zip_create refuses overwrite unless overwrite=true', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, 'out.zip'), 'x');
  assert.equal(parse(await callCustomTool('zip_create', { destination: 'out.zip' }, context)).ok, false);
  assert.equal(parse(await callCustomTool('zip_create', { destination: 'out.zip', overwrite: true }, context)).ok, true);
});

test('custom_zip_create dryRun does not create zip and includeGit includes git files', async () => {
  const { root, context } = await fixture();
  let out = parse(await callCustomTool('zip_create', { destination: 'dry.zip', dryRun: true }, context));
  assert.equal(out.ok, true);
  await assert.rejects(() => fs.stat(path.join(root, 'dry.zip')));
  out = parse(await callCustomTool('zip_create', { destination: 'withgit.zip', includeGit: true }, context));
  assert.equal(out.data.filesAdded, 2);
});
