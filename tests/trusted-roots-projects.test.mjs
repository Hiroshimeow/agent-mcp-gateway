import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildTrustedRootsProjectRegistry,
  buildTrustedRootsProjectRegistryFromRaw,
  inferProjectIdFromPath,
  listProjectSummaries,
  loadTrustedRootsProjectRegistry,
  normalizeTrustedRootEntries,
  parseTrustedRootLine,
  resolveTrustedRootPaths,
  splitTrustedRootConfig
} from '../scripts/projects/trusted-roots-projects.mjs';

function abs(...segments) {
  return path.join(os.tmpdir(), 'mcp-project-tests', ...segments);
}

test('parseTrustedRootLine ignores blank lines and full-line comments', () => {
  assert.equal(parseTrustedRootLine(''), null);
  assert.equal(parseTrustedRootLine('   '), null);
  assert.equal(parseTrustedRootLine('# repositories'), null);
  assert.equal(parseTrustedRootLine('  # repositories'), null);
});

test('parseTrustedRootLine parses path-only legacy lines', () => {
  const root = abs('paperclip');
  const entry = parseTrustedRootLine(root);

  assert.equal(entry.root, path.resolve(root));
  assert.equal(entry.projectId, undefined);
  assert.equal(entry.displayName, undefined);
  assert.equal(entry.explicitProjectId, false);
});

test('parseTrustedRootLine parses path with projectId and displayName', () => {
  const root = abs('Paperclip With Spaces');

  assert.deepEqual(
    parseTrustedRootLine(`${root}|paperclip`),
    {
      rawLine: `${root}|paperclip`,
      lineNumber: undefined,
      root: path.resolve(root),
      projectId: 'paperclip',
      displayName: undefined,
      explicitProjectId: true
    }
  );

  const named = parseTrustedRootLine(`${root} | paperclip | Paperclip`);
  assert.equal(named.projectId, 'paperclip');
  assert.equal(named.displayName, 'Paperclip');
});

test('parseTrustedRootLine rejects relative paths and invalid project ids', () => {
  assert.throws(() => parseTrustedRootLine('relative/path | project'), { code: 'TRUSTED_ROOT_MUST_BE_ABSOLUTE' });
  assert.throws(() => parseTrustedRootLine(`${abs('repo')} | Paperclip`), { code: 'INVALID_PROJECT_ID' });
});

test('splitTrustedRootConfig supports newline and semicolon config entries', () => {
  assert.deepEqual(splitTrustedRootConfig(`\n# roots\n${abs('one')} | one; ${abs('two')} | two | Two\n`), [
    `${abs('one')} | one`,
    `${abs('two')} | two | Two`
  ]);
});

test('resolveTrustedRootPaths sends path-only roots for pipe-format config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-root-paths-'));
  const repoRoot = path.join(dir, 'repo');
  const assetRoot = path.join(dir, 'assets');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(assetRoot);

  const result = resolveTrustedRootPaths(
    `${repoRoot} | paperclip | Paperclip\n${assetRoot} | paperclip | Paperclip Assets`,
    undefined
  );

  assert.deepEqual(result.existingRoots, [path.resolve(repoRoot), path.resolve(assetRoot)]);
  assert.equal(result.existingRoots.some(root => root.includes('|')), false);
  assert.deepEqual(result.missingRoots, []);
});

test('resolveTrustedRootPaths keeps legacy path-only roots working', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-trusted-root-'));
  const repoRoot = path.join(dir, 'repo');
  fs.mkdirSync(repoRoot);

  const result = resolveTrustedRootPaths(repoRoot, undefined);

  assert.deepEqual(result.existingRoots, [path.resolve(repoRoot)]);
  assert.deepEqual(result.missingRoots, []);
});

test('normalizeTrustedRootEntries generates ids, supports repeated ids, and dedupes roots', () => {
  const rootA = abs('paperclip');
  const rootB = abs('paperclip-assets');
  const entries = normalizeTrustedRootEntries([
    rootA,
    `${rootB} | paperclip | Paperclip`,
    `${rootB} | paperclip | Paperclip Duplicate`
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].projectId, 'paperclip');
  assert.equal(entries[0].displayName, 'paperclip');
  assert.equal(entries[0].explicitProjectId, false);
  assert.equal(entries[1].projectId, 'paperclip');
  assert.equal(entries[1].displayName, 'Paperclip');
  assert.equal(entries[1].explicitProjectId, true);
});

test('buildTrustedRootsProjectRegistry groups multiple roots per project and keeps first root as repoRoot', () => {
  const repoRoot = abs('paperclip');
  const assetRoot = abs('paperclip-assets');
  const deerRoot = abs('deer-flow');

  const registry = buildTrustedRootsProjectRegistry([
    `${repoRoot} | paperclip | Paperclip`,
    `${assetRoot} | paperclip`,
    `${deerRoot} | deer-flow`
  ], { defaultProjectId: 'paperclip' });

  assert.equal(registry.mode, 'trusted-roots-projects');
  assert.equal(registry.defaultProjectId, 'paperclip');
  assert.deepEqual(registry.allTrustedRoots, [path.resolve(repoRoot), path.resolve(assetRoot), path.resolve(deerRoot)]);

  const paperclip = registry.projects.get('paperclip');
  assert.equal(paperclip.repoRoot, path.resolve(repoRoot));
  assert.deepEqual(paperclip.trustedRoots, [path.resolve(repoRoot), path.resolve(assetRoot)]);
  assert.deepEqual(paperclip.extraTrustedRoots, [path.resolve(assetRoot)]);
  assert.equal(paperclip.displayName, 'Paperclip');
});

test('buildTrustedRootsProjectRegistry sorts root index by longest prefix for inference', () => {
  const broadRoot = abs('git-project');
  const nestedRoot = abs('git-project', 'paperclip');
  const registry = buildTrustedRootsProjectRegistry([
    `${broadRoot} | git-project-workspace`,
    `${nestedRoot} | paperclip`
  ]);

  assert.equal(inferProjectIdFromPath(registry, path.join(nestedRoot, 'README.md')), 'paperclip');
  assert.equal(inferProjectIdFromPath(registry, path.join(broadRoot, 'other', 'README.md')), 'git-project-workspace');
});

test('buildTrustedRootsProjectRegistryFromRaw uses fallback root only when no config exists', () => {
  const fallbackRoot = abs('fallback-repo');
  const configuredRoot = abs('configured-repo');

  const fallbackRegistry = buildTrustedRootsProjectRegistryFromRaw('', { fallbackRoot, defaultProjectId: 'fallback-repo' });
  assert.equal(fallbackRegistry.projects.get('fallback-repo').repoRoot, path.resolve(fallbackRoot));

  const configuredRegistry = buildTrustedRootsProjectRegistryFromRaw(`${configuredRoot} | configured-repo`, {
    fallbackRoot,
    defaultProjectId: 'configured-repo',
    requireProjectId: true,
    pathInference: false,
    exposeProjectPaths: true
  });
  assert.equal(configuredRegistry.projects.has('fallback-repo'), false);
  assert.equal(configuredRegistry.projects.get('configured-repo').repoRoot, path.resolve(configuredRoot));
  assert.equal(configuredRegistry.requireProjectId, true);
  assert.equal(configuredRegistry.pathInference, false);
  assert.equal(configuredRegistry.exposeProjectPaths, true);
});

test('buildTrustedRootsProjectRegistry reports or rejects missing roots based on mode', () => {
  const missing = abs('missing-root');
  const registry = buildTrustedRootsProjectRegistry([`${missing} | missing-root`], { checkExists: true });
  assert.deepEqual(registry.missingRoots, [path.resolve(missing)]);

  assert.throws(
    () => buildTrustedRootsProjectRegistry([`${missing} | missing-root`], { checkExists: true, missingRootMode: 'error' }),
    { code: 'TRUSTED_ROOT_NOT_FOUND' }
  );
});

test('loadTrustedRootsProjectRegistry reads trusted roots files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-roots-projects-'));
  const configPath = path.join(dir, 'trusted-roots.txt');
  const repoRoot = path.join(dir, 'repo with spaces');
  fs.writeFileSync(configPath, `# projects\n${repoRoot} | repo | Repo\n`, 'utf8');

  const registry = loadTrustedRootsProjectRegistry(configPath);
  assert.equal(registry.projects.get('repo').displayName, 'Repo');
});

test('listProjectSummaries does not expose full local paths by default', () => {
  const repoRoot = abs('paperclip');
  const registry = buildTrustedRootsProjectRegistry([`${repoRoot} | paperclip | Paperclip`]);

  const hidden = listProjectSummaries(registry, { showPaths: true });
  assert.equal(hidden.projects[0].repoRoot, undefined);
  assert.match(hidden.warnings[0], /Path exposure is disabled/);

  registry.exposeProjectPaths = true;
  const visible = listProjectSummaries(registry, { showPaths: true });
  assert.equal(visible.projects[0].repoRoot, path.resolve(repoRoot));
  assert.deepEqual(visible.warnings, []);
});
