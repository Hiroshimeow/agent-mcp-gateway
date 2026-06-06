import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultExcludePatterns,
  matchesAnyGlob,
  resolveInsideTrustedRoots,
  shouldExclude,
  toRelativeFromRoot,
  walkFiles
} from '../scripts/custom-tools/path-utils.mjs';

test('resolveInsideTrustedRoots accepts relative and absolute paths inside trusted roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-path-'));
  const nested = path.join(root, 'src');
  await fs.mkdir(nested);
  const context = { resolvedRepoRoots: [root], resolvedRepoRoot: root };

  assert.equal(resolveInsideTrustedRoots('src', context).path, nested);
  assert.equal(resolveInsideTrustedRoots(nested, context).path, nested);
});

test('resolveInsideTrustedRoots rejects paths outside workspace scope', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-path-'));
  const context = { resolvedRepoRoots: [root], resolvedRepoRoot: root };

  assert.throws(() => resolveInsideTrustedRoots('../outside.txt', context), /outside current workspace scope/);
});

test('glob helpers match include and default exclude patterns', () => {
  assert.equal(matchesAnyGlob('src/app.mjs', ['**/*.mjs']), true);
  assert.equal(matchesAnyGlob('src/app.js', ['**/*.mjs']), false);
  assert.equal(shouldExclude('node_modules/pkg/index.js', defaultExcludePatterns()), true);
  assert.equal(shouldExclude('src/index.js', defaultExcludePatterns()), false);
});

test('walkFiles skips default excluded directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-walk-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'src', 'app.mjs'), 'hello');
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.mjs'), 'hello');

  const files = await walkFiles(root, root, { include: ['**/*.mjs'], exclude: defaultExcludePatterns() });
  assert.deepEqual(files.map(file => toRelativeFromRoot(file, root)), ['src/app.mjs']);
});
