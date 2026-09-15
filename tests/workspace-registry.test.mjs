import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyWorkspaceChange,
  createWorkspaceRegistry
} from '../scripts/workspace-registry.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-registry-'));
}

test('registry hot reloads static config changes and keeps last valid snapshot', async () => {
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

test('registry exposes only existing static trusted roots', () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  const existingRoot = path.join(directory, 'existing');
  const missingRoot = path.join(directory, 'missing');
  fs.mkdirSync(existingRoot);
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${existingRoot.replaceAll('\\', '/')}", "${missingRoot.replaceAll('\\', '/')}"]\n`, 'utf8');

  const registry = createWorkspaceRegistry({ configPath, repoRoot: existingRoot, watchIntervalMs: 25 });
  try {
    assert.deepEqual(registry.snapshot().roots, [path.resolve(existingRoot)]);
  } finally {
    registry.close();
  }
});

test('static TOML roots are the sole registry source and changes stay separated from upstream lifecycle', async () => {
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
    assert.deepEqual(registry.snapshot().roots, [path.resolve(initialRoot)]);
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

test('subscriber failure restores the previous static snapshot and the same config can retry', async () => {
  const directory = tempDir();
  const configPath = path.join(directory, 'mcp-servers.toml');
  fs.writeFileSync(configPath, `[server]\ntitle = "Initial"\n[trusted_roots]\nroots = ["${directory.replaceAll('\\', '/')}"]\n`, 'utf8');
  const registry = createWorkspaceRegistry({ configPath, repoRoot: directory, watchIntervalMs: 60_000 });
  let rejectChange = true;
  const unsubscribe = registry.subscribe(async next => {
    if (rejectChange && next.server.title === 'Changed') throw new Error('activation failed');
  });

  try {
    fs.writeFileSync(configPath, `[server]\ntitle = "Changed"\n[trusted_roots]\nroots = ["${directory.replaceAll('\\', '/')}"]\n`, 'utf8');
    const failed = await registry.reloadFromDisk('first');
    assert.match(String(failed.error?.message), /activation failed/);
    assert.equal(registry.snapshot().server.title, 'Initial');

    rejectChange = false;
    const retried = await registry.reloadFromDisk('retry');
    assert.equal(retried.changed, true);
    assert.equal(registry.snapshot().server.title, 'Changed');
  } finally {
    unsubscribe();
    registry.close();
  }
});
