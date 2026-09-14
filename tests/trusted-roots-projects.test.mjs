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
  const root = abs('example-app');
  const entry = parseTrustedRootLine(root);

  assert.equal(entry.root, path.resolve(root));
  assert.equal(entry.projectId, undefined);
  assert.equal(entry.displayName, undefined);
  assert.equal(entry.explicitProjectId, false);
});

test('parseTrustedRootLine parses path with projectId and displayName', () => {
  const root = abs('Example App With Spaces');

  assert.deepEqual(
    parseTrustedRootLine(`${root}|example-app`),
    {
      rawLine: `${root}|example-app`,
      lineNumber: undefined,
      root: path.resolve(root),
      projectId: 'example-app',
      displayName: undefined,
      explicitProjectId: true
    }
  );

  const named = parseTrustedRootLine(`${root} | example-app | Example App`);
  assert.equal(named.projectId, 'example-app');
  assert.equal(named.displayName, 'Example App');
});

test('parseTrustedRootLine rejects relative paths and invalid project ids', () => {
  assert.throws(() => parseTrustedRootLine('relative/path | project'), { code: 'TRUSTED_ROOT_MUST_BE_ABSOLUTE' });
  assert.throws(() => parseTrustedRootLine(`${abs('repo')} | Example App`), { code: 'INVALID_PROJECT_ID' });
});

test('parseTrustedRootLine accepts Windows drive paths with slash or backslash separators', () => {
  const backslash = parseTrustedRootLine('C:\\temp | win-temp');
  assert.equal(backslash.root, process.platform === 'win32' ? path.resolve('C:\\temp') : 'C:/temp');
  assert.equal(backslash.projectId, 'win-temp');

  const slash = parseTrustedRootLine('C:/temp | win-temp');
  assert.equal(slash.root, process.platform === 'win32' ? path.resolve('C:/temp') : 'C:/temp');
  assert.equal(slash.projectId, 'win-temp');
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
    `${repoRoot} | example-app | Example App\n${assetRoot} | example-app | Example App Assets`,
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
  const rootA = abs('example-app');
  const rootB = abs('example-app-assets');
  const entries = normalizeTrustedRootEntries([
    rootA,
    `${rootB} | example-app | Example App`,
    `${rootB} | example-app | Example App Duplicate`
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].projectId, 'example-app');
  assert.equal(entries[0].displayName, 'example-app');
  assert.equal(entries[0].explicitProjectId, false);
  assert.equal(entries[1].projectId, 'example-app');
  assert.equal(entries[1].displayName, 'Example App');
  assert.equal(entries[1].explicitProjectId, true);
});

test('buildTrustedRootsProjectRegistry groups multiple roots per project and keeps first root as repoRoot', () => {
  const repoRoot = abs('example-app');
  const assetRoot = abs('example-app-assets');
  const deerRoot = abs('deer-flow');

  const registry = buildTrustedRootsProjectRegistry([
    `${repoRoot} | example-app | Example App`,
    `${assetRoot} | example-app`,
    `${deerRoot} | deer-flow`
  ], { defaultProjectId: 'example-app' });

  assert.equal(registry.mode, 'trusted-roots-projects');
  assert.equal(registry.defaultProjectId, 'example-app');
  assert.deepEqual(registry.allTrustedRoots, [path.resolve(repoRoot), path.resolve(assetRoot), path.resolve(deerRoot)]);

  const exampleApp = registry.projects.get('example-app');
  assert.equal(exampleApp.repoRoot, path.resolve(repoRoot));
  assert.deepEqual(exampleApp.trustedRoots, [path.resolve(repoRoot), path.resolve(assetRoot)]);
  assert.deepEqual(exampleApp.extraTrustedRoots, [path.resolve(assetRoot)]);
  assert.equal(exampleApp.displayName, 'Example App');
});

test('buildTrustedRootsProjectRegistry sorts root index by longest prefix for inference', () => {
  const broadRoot = abs('workspace');
  const nestedRoot = abs('workspace', 'example-repo');
  const registry = buildTrustedRootsProjectRegistry([
    `${broadRoot} | workspace-root`,
    `${nestedRoot} | example-repo`
  ]);

  assert.equal(inferProjectIdFromPath(registry, path.join(nestedRoot, 'README.md')), 'example-repo');
  assert.equal(inferProjectIdFromPath(registry, path.join(broadRoot, 'other', 'README.md')), 'workspace-root');
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
  const repoRoot = abs('example-app');
  const registry = buildTrustedRootsProjectRegistry([`${repoRoot} | example-app | Example App`]);

  const hidden = listProjectSummaries(registry, { showPaths: true });
  assert.equal(hidden.projects[0].repoRoot, undefined);
  assert.match(hidden.warnings[0], /Path exposure is disabled/);

  registry.exposeProjectPaths = true;
  const visible = listProjectSummaries(registry, { showPaths: true });
  assert.equal(visible.projects[0].repoRoot, path.resolve(repoRoot));
  assert.deepEqual(visible.warnings, []);
});
