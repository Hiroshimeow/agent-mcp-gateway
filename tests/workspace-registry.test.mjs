import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyWorkspaceChange,
  createWorkspaceRegistry,
  deriveWorkspaceRoot,
  insertTrustedRootText,
  isPathInsideWorkspace,
  normalizeWorkspacePath,
  persistTrustedRoot,
  toPortableTomlPath,
  workspacePathKey
} from '../scripts/workspace-registry.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-registry-'));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return pid;
}

test('normalizes Windows drive, slash, case, long path, UNC, Unicode, and file roots', () => {
  assert.equal(normalizeWorkspacePath('C:/Work/Repo/', { platform: 'win32', realpath: false }), 'C:\\Work\\Repo');
  assert.equal(normalizeWorkspacePath('\\\\?\\C:\\Work\\Repo', { platform: 'win32', realpath: false }), 'C:\\Work\\Repo');
  assert.equal(normalizeWorkspacePath('\\\\server\\share\\repo\\', { platform: 'win32', realpath: false }), '\\\\server\\share\\repo');
  assert.equal(workspacePathKey('C:\\WORK\\Repo', { platform: 'win32', realpath: false }), 'c:\\work\\repo');
  assert.equal(deriveWorkspaceRoot('C:\\Dữ liệu\\日本語\\file.txt', 'file', { platform: 'win32', realpath: false }), 'C:\\Dữ liệu\\日本語');
  assert.equal(toPortableTomlPath('C:\\Work\\Repo', { platform: 'win32' }), 'C:/Work/Repo');
});

test('contains uses platform-correct ancestor semantics', () => {
  assert.equal(isPathInsideWorkspace('C:\\Repo', 'c:/repo/src/a.js', { platform: 'win32', realpath: false }), true);
  assert.equal(isPathInsideWorkspace('C:\\Repo', 'C:\\Repo2\\a.js', { platform: 'win32', realpath: false }), false);
  assert.equal(isPathInsideWorkspace('/srv/repo', '/srv/repo/src/a.js', { platform: 'linux', realpath: false }), true);
  assert.equal(isPathInsideWorkspace('/srv/repo', '/srv/Repo/a.js', { platform: 'linux', realpath: false }), false);
});

test('insertTrustedRootText preserves comments and line endings', () => {
  const source = '# top\r\n[trusted_roots]\r\n# roots comment\r\nroots = [\r\n  "C:/one" # inline\r\n]\r\n\r\n[external_mcp]\r\nenabled = true\r\n';
  const updated = insertTrustedRootText(source, 'C:/two');
  assert.match(updated, /# top\r\n/);
  assert.match(updated, /"C:\/one", # inline\r\n  "C:\/two"\r\n\]/);
  assert.match(updated, /\[external_mcp\]/);
  assert.equal(updated.includes('\n') && !updated.includes('\r\n'), false);
});

test('insertTrustedRootText creates missing property and section', () => {
  assert.match(insertTrustedRootText('[trusted_roots]\n# comment\n', '/tmp/new'), /roots = \[\n  "\/tmp\/new"\n\]/);
  assert.match(insertTrustedRootText('[external_mcp]\nenabled = true\n', '/tmp/new'), /\[trusted_roots\]\nroots = \[/);
});

test('persistTrustedRoot appends to inline-table root arrays used by the real config', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  const existing = path.join(directory, 'existing');
  const added = path.join(directory, 'added');
  fs.mkdirSync(existing);
  fs.mkdirSync(added);
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = [\n  { path = "${existing.replaceAll('\\', '/')}", project_id = "existing" }\n]\n`, 'utf8');
  const result = await persistTrustedRoot(configPath, added, { repoRoot: existing });
  assert.equal(result.added, true);
  const content = fs.readFileSync(configPath, 'utf8');
  assert.match(content, /project_id = "existing"/);
  assert.ok(content.includes(added.replaceAll('\\', '/')));
});

test('persistTrustedRoot dedupes ancestors and retains concurrent additions', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = [\n  "${directory.replaceAll('\\', '/')}"\n]\n`, 'utf8');
  const covered = await persistTrustedRoot(configPath, path.join(directory, 'child'), { repoRoot: directory });
  assert.equal(covered.added, false);

  const one = path.join(path.dirname(directory), `${path.basename(directory)}-one`);
  const two = path.join(path.dirname(directory), `${path.basename(directory)}-two`);
  await Promise.all([
    persistTrustedRoot(configPath, one, { repoRoot: directory }),
    persistTrustedRoot(configPath, two, { repoRoot: directory })
  ]);
  const content = fs.readFileSync(configPath, 'utf8');
  assert.match(content, new RegExp(one.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(content, new RegExp(two.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('registry hot reloads valid changes and keeps last valid snapshot', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  fs.writeFileSync(configPath, `[server]\ntitle = "Initial"\n[trusted_roots]\nroots = ["${directory.replaceAll('\\', '/')}"]\n`, 'utf8');
  const registry = createWorkspaceRegistry({ configPath, repoRoot: directory, watchIntervalMs: 25 });
  try {
    assert.equal(registry.snapshot().server.title, 'Initial');
    fs.writeFileSync(configPath, `[server]\ntitle = "Changed"\n[trusted_roots]\nroots = ["${directory.replaceAll('\\', '/')}"]\n`, 'utf8');
    const changed = await registry.reloadFromDisk('test');
    assert.equal(changed.changed, true);
    assert.equal(registry.snapshot().server.title, 'Changed');

    fs.writeFileSync(configPath, '[trusted_roots\ninvalid =', 'utf8');
    const invalid = await registry.reloadFromDisk('test-invalid');
    assert.ok(invalid.error);
    assert.equal(registry.snapshot().server.title, 'Changed');
  } finally {
    registry.close();
  }
});

test('ensureTrustedPath persists containing directory for a file target', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  const initialRoot = path.join(directory, 'initial');
  const newRoot = path.join(directory, 'new-root');
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(newRoot);
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}"]\n`, 'utf8');
  const registry = createWorkspaceRegistry({ configPath, repoRoot: initialRoot, watchIntervalMs: 25 });
  try {
    const result = await registry.ensureTrustedPath(path.join(newRoot, 'future.txt'), 'file');
    assert.equal(result.added, true);
    assert.equal(registry.contains(path.join(newRoot, 'future.txt')), true);
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes(newRoot.replaceAll('\\', '/')));
  } finally {
    registry.close();
  }
});

test('concurrent grants return only after each requested root and subscriber activation are live', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  const initialRoot = path.join(directory, 'initial');
  const firstRoot = path.join(directory, 'first');
  const secondRoot = path.join(directory, 'second');
  for (const root of [initialRoot, firstRoot, secondRoot]) fs.mkdirSync(root);
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}"]\n`, 'utf8');
  const registry = createWorkspaceRegistry({ configPath, repoRoot: initialRoot, watchIntervalMs: 25 });
  const firstGate = deferred();
  const secondGate = deferred();
  const firstEntered = deferred();
  const secondEntered = deferred();
  const activated = new Set();
  const unsubscribe = registry.subscribe(async next => {
    if (next.roots.some(root => isPathInsideWorkspace(root, firstRoot)) && !activated.has(firstRoot)) {
      firstEntered.resolve();
      await firstGate.promise;
      activated.add(firstRoot);
    }
    if (next.roots.some(root => isPathInsideWorkspace(root, secondRoot)) && !activated.has(secondRoot)) {
      secondEntered.resolve();
      await secondGate.promise;
      activated.add(secondRoot);
    }
  });

  try {
    let firstResolved = false;
    let secondResolved = false;
    const first = registry.ensureTrustedPath(path.join(firstRoot, 'one.txt'), 'file').then(result => {
      firstResolved = true;
      assert.equal(activated.has(firstRoot), true);
      return result;
    });
    const second = registry.ensureTrustedPath(path.join(secondRoot, 'two.txt'), 'file').then(result => {
      secondResolved = true;
      assert.equal(activated.has(secondRoot), true);
      return result;
    });

    await firstEntered.promise;
    assert.equal(firstResolved, false);
    assert.equal(secondResolved, false);
    firstGate.resolve();
    await first;
    assert.equal(registry.contains(firstRoot), true);

    await secondEntered.promise;
    assert.equal(secondResolved, false);
    secondGate.resolve();
    await second;
    assert.equal(registry.contains(secondRoot), true);
  } finally {
    unsubscribe();
    registry.close();
  }
});

test('dead owner lock is reclaimed and live owner lock remains exclusive', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  const initialRoot = path.join(directory, 'initial');
  const addedRoot = path.join(directory, 'added');
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(addedRoot);
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}"]\n`, 'utf8');
  const lockPath = `${configPath}.lock`;

  fs.writeFileSync(lockPath, JSON.stringify({ pid: await exitedPid(), createdAt: new Date().toISOString() }), 'utf8');
  const recovered = await persistTrustedRoot(configPath, addedRoot, { repoRoot: initialRoot, lockRetries: 2, lockDelayMs: 1 });
  assert.equal(recovered.added, true);
  assert.equal(fs.existsSync(lockPath), false);

  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
  await assert.rejects(
    () => persistTrustedRoot(configPath, path.join(directory, 'blocked'), { repoRoot: initialRoot, lockRetries: 1, lockDelayMs: 1 }),
    error => error?.code === 'EEXIST'
  );
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
  fs.rmSync(lockPath, { force: true });

  const staleRoot = path.join(directory, 'stale-threshold');
  fs.mkdirSync(staleRoot);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date(0).toISOString() }), 'utf8');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  const thresholdRecovered = await persistTrustedRoot(configPath, staleRoot, {
    repoRoot: initialRoot,
    lockRetries: 2,
    lockDelayMs: 1,
    lockStaleMs: 1000
  });
  assert.equal(thresholdRecovered.added, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('TOML roots are the sole allowlist and change projections isolate roots from upstream lifecycle', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  const initialRoot = path.join(directory, 'initial');
  const envOnlyRoot = path.join(directory, 'env-only');
  const addedRoot = path.join(directory, 'added');
  for (const root of [initialRoot, envOnlyRoot, addedRoot]) fs.mkdirSync(root);
  const upstream = '[external_mcp]\ndefault_enabled = false\n[mcp_servers.fake]\nenabled = false\ncommand = "node"\n';
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}"]\n${upstream}`, 'utf8');
  const registry = createWorkspaceRegistry({
    configPath,
    repoRoot: initialRoot,
    env: { ...process.env, MCP_TRUSTED_ROOTS: envOnlyRoot },
    watchIntervalMs: 25
  });

  try {
    assert.equal(registry.contains(envOnlyRoot), false);
    const before = registry.snapshot();
    fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}", "${addedRoot.replaceAll('\\', '/')}"]\n${upstream}`, 'utf8');
    await registry.reloadFromDisk('root-only');
    const rootOnly = registry.snapshot();
    assert.deepEqual(classifyWorkspaceChange(rootOnly, before), { rootsChanged: true, upstreamChanged: false });

    fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}", "${addedRoot.replaceAll('\\', '/')}"]\n${upstream.replace('enabled = false', 'enabled = true')}`, 'utf8');
    await registry.reloadFromDisk('upstream-only');
    assert.deepEqual(classifyWorkspaceChange(registry.snapshot(), rootOnly), { rootsChanged: false, upstreamChanged: true });
  } finally {
    registry.close();
  }
});

test('ensureTrustedPath waits for an in-flight watcher activation before fast-returning', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  const initialRoot = path.join(directory, 'initial');
  const addedRoot = path.join(directory, 'added');
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(addedRoot);
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}"]\n`, 'utf8');
  const registry = createWorkspaceRegistry({ configPath, repoRoot: initialRoot, watchIntervalMs: 60_000 });
  const entered = deferred();
  const release = deferred();
  let activations = 0;
  const unsubscribe = registry.subscribe(async next => {
    if (!next.roots.some(root => isPathInsideWorkspace(root, addedRoot))) return;
    activations += 1;
    entered.resolve();
    await release.promise;
  });

  try {
    fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}", "${addedRoot.replaceAll('\\', '/')}"]\n`, 'utf8');
    const reload = registry.reloadFromDisk('watch');
    await entered.promise;

    let settled = false;
    const ensure = registry.ensureTrustedPath(path.join(addedRoot, 'file.txt'), 'file').then(result => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false);

    release.resolve();
    await reload;
    const result = await ensure;
    assert.equal(result.added, false);
    assert.equal(activations, 1);
    assert.equal(registry.contains(addedRoot), true);
  } finally {
    unsubscribe();
    registry.close();
  }
});

test('failed activation restores synchronized state and the same persisted root retries successfully', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  const initialRoot = path.join(directory, 'initial');
  const addedRoot = path.join(directory, 'added');
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(addedRoot);
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}"]\n`, 'utf8');
  const registry = createWorkspaceRegistry({ configPath, repoRoot: initialRoot, watchIntervalMs: 60_000 });
  let failActivation = true;
  let activations = 0;
  const unsubscribe = registry.subscribe(async next => {
    if (!next.roots.some(root => isPathInsideWorkspace(root, addedRoot))) return;
    activations += 1;
    if (failActivation) throw new Error('activation failed');
  });

  try {
    const target = path.join(addedRoot, 'file.txt');
    await assert.rejects(() => registry.ensureTrustedPath(target, 'file'), /activation failed/);
    assert.equal(registry.contains(addedRoot), false);
    assert.ok(fs.readFileSync(configPath, 'utf8').includes(addedRoot.replaceAll('\\', '/')));

    failActivation = false;
    const retried = await registry.ensureTrustedPath(target, 'file');
    assert.equal(retried.added, false);
    assert.equal(activations, 2);
    assert.equal(registry.contains(addedRoot), true);
  } finally {
    unsubscribe();
    registry.close();
  }
});
