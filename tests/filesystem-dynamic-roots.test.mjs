import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createExternalMcpManager } from '../scripts/upstreams/manager.mjs';
import { loadExternalMcpConfig } from '../scripts/upstreams/config.mjs';
import { classifyWorkspaceChange, createWorkspaceRegistry, isPathInsideWorkspace, normalizeWorkspacePath, toFilesystemRootUri } from '../scripts/workspace-registry.mjs';

const filesystemEntrypoint = fileURLToPath(
  new URL('../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', import.meta.url)
);
const dynamicServer = fileURLToPath(new URL('./fixtures/dynamic-mcp-server.mjs', import.meta.url));

async function readCount(file) {
  try { return Number(await fs.promises.readFile(file, 'utf8')) || 0; } catch { return 0; }
}
async function waitForRoots(client, expectedRoots, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let reported = [];
  while (Date.now() <= deadline) {
    const result = await client.callTool({ name: 'list_allowed_directories', arguments: {} });
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    reported = text.split(/\r?\n/).slice(1).filter(Boolean).map(value => normalizeWorkspacePath(value));
    const exactRoots = reported.length === expectedRoots.length && expectedRoots.every(root =>
      reported.some(active => isPathInsideWorkspace(active, root) && isPathInsideWorkspace(root, active))
    );
    if (exactRoots) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Root activation timeout. Expected=${expectedRoots.join(';')} reported=${reported.join(';')}`);
}

test('official filesystem hot-activates a persisted path before the same operation continues', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-roots-'));
  const initialRoot = path.join(temp, 'initial');
  const addedRoot = path.join(temp, 'added');
  const configPath = path.join(temp, 'mcp-servers.toml');
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(addedRoot);
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}"]\n`, 'utf8');

  const registry = createWorkspaceRegistry({ configPath, repoRoot: initialRoot, watchIntervalMs: 25 });
  const transport = new StdioClientTransport({ command: process.execPath, args: [filesystemEntrypoint], stderr: 'pipe' });
  const client = new Client({ name: 'dynamic-root-test', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: registry.snapshot().roots.map(root => ({ uri: toFilesystemRootUri(root), name: path.basename(root) }))
  }));

  await client.connect(transport);
  await client.sendRootsListChanged();
  await waitForRoots(client, [initialRoot]);
  const unsubscribe = registry.subscribe(async (next, previous) => {
    if (JSON.stringify(next.roots) === JSON.stringify(previous?.roots)) return;
    await client.sendRootsListChanged();
    await waitForRoots(client, next.roots);
  });

  try {
    const target = path.join(addedRoot, 'new.txt');
    await registry.ensureTrustedPath(target, 'file');
    await client.callTool({ name: 'write_file', arguments: { path: target, content: 'first' } });
    await client.callTool({
      name: 'edit_file',
      arguments: { path: target, edits: [{ oldText: 'first', newText: 'second' }], dryRun: false }
    });
    const read = await client.callTool({ name: 'read_text_file', arguments: { path: target } });
    assert.equal(read.content[0].text, 'second');

    const persisted = fs.readFileSync(configPath, 'utf8');
    assert.equal((persisted.match(new RegExp(addedRoot.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);

    fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}"]\n`, 'utf8');
    await registry.reloadFromDisk('revoke-test');
    const denied = await client.callTool({ name: 'read_text_file', arguments: { path: target } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /outside allowed directories|Access denied/i);
  } finally {
    unsubscribe();
    registry.close();
    await client.close().catch(() => {});
  }
});

test('two concurrent grants activate official filesystem immediately without reconciling unchanged upstreams', { timeout: 12000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-concurrent-roots-'));
  const initialRoot = path.join(temp, 'initial');
  const firstRoot = path.join(temp, 'first');
  const secondRoot = path.join(temp, 'second');
  const statePath = path.join(temp, 'state.json');
  const countPath = path.join(temp, 'count.txt');
  const configPath = path.join(temp, 'mcp-servers.toml');
  for (const root of [initialRoot, firstRoot, secondRoot]) fs.mkdirSync(root);
  await fs.promises.writeFile(statePath, JSON.stringify({ tools: ['a'], resources: ['main'], prompts: ['review'] }));
  const escapeToml = value => String(value).replaceAll('\\', '\\\\');
  await fs.promises.writeFile(configPath, `
[trusted_roots]
roots = ["${initialRoot.replaceAll('\\', '/')}"]

[external_mcp]
catalog_cache = "startup"

[mcp_servers.dyn]
enabled = true
transport = "stdio"
command = "${escapeToml(process.execPath)}"
args = ["${escapeToml(dynamicServer)}", "${escapeToml(statePath)}", "${escapeToml(countPath)}"]
tool_prefix = "dyn"
`);

  const registry = createWorkspaceRegistry({ configPath, repoRoot: initialRoot, watchIntervalMs: 25 });
  const transport = new StdioClientTransport({ command: process.execPath, args: [filesystemEntrypoint], stderr: 'pipe' });
  const client = new Client({ name: 'concurrent-root-test', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: registry.snapshot().roots.map(root => ({ uri: toFilesystemRootUri(root), name: path.basename(root) }))
  }));
  const manager = await createExternalMcpManager({ repoRoot: temp, env: { MCP_UPSTREAM_CONFIG: configPath } });

  await client.connect(transport);
  await client.sendRootsListChanged();
  await waitForRoots(client, [initialRoot]);
  const unsubscribe = registry.subscribe(async (next, previous) => {
    const changes = classifyWorkspaceChange(next, previous);
    if (changes.rootsChanged) {
      await client.sendRootsListChanged();
      await waitForRoots(client, next.roots);
    }
    if (changes.upstreamChanged) {
      await manager.reconcile(await loadExternalMcpConfig({ repoRoot: temp, env: { MCP_UPSTREAM_CONFIG: configPath } }));
    }
  });

  try {
    assert.equal(await readCount(countPath), 1);
    await fs.promises.writeFile(statePath, JSON.stringify({ tools: ['a'], resources: ['main'], prompts: ['review'], failToolsList: true }));
    const targets = [path.join(firstRoot, 'one.txt'), path.join(secondRoot, 'two.txt')];
    await Promise.all(targets.map(async (target, index) => {
      await registry.ensureTrustedPath(target, 'file');
      const write = await client.callTool({ name: 'write_file', arguments: { path: target, content: `value-${index}` } });
      assert.notEqual(write.isError, true);
      const read = await client.callTool({ name: 'read_text_file', arguments: { path: target } });
      assert.equal(read.content[0].text, `value-${index}`);
    }));
    assert.equal(await readCount(countPath), 1);
  } finally {
    unsubscribe();
    registry.close();
    await manager.shutdown();
    await client.close().catch(() => {});
  }
});

test('official filesystem retries the same persisted root after one activation failure', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-root-retry-'));
  const initialRoot = path.join(temp, 'initial');
  const addedRoot = path.join(temp, 'added');
  const configPath = path.join(temp, 'mcp-servers.toml');
  fs.mkdirSync(initialRoot);
  fs.mkdirSync(addedRoot);
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${initialRoot.replaceAll('\\', '/')}"]\n`, 'utf8');

  const registry = createWorkspaceRegistry({ configPath, repoRoot: initialRoot, watchIntervalMs: 60_000 });
  const transport = new StdioClientTransport({ command: process.execPath, args: [filesystemEntrypoint], stderr: 'pipe' });
  const client = new Client({ name: 'root-retry-test', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: registry.snapshot().roots.map(root => ({ uri: toFilesystemRootUri(root), name: path.basename(root) }))
  }));

  await client.connect(transport);
  await client.sendRootsListChanged();
  await waitForRoots(client, [initialRoot]);

  let failActivation = true;
  let activationAttempts = 0;
  const unsubscribe = registry.subscribe(async (next, previous) => {
    if (JSON.stringify(next.roots) === JSON.stringify(previous?.roots)) return;
    activationAttempts += 1;
    if (failActivation) {
      failActivation = false;
      throw new Error('injected filesystem activation failure');
    }
    await client.sendRootsListChanged();
    await waitForRoots(client, next.roots);
  });

  try {
    const target = path.join(addedRoot, 'retry.txt');
    await assert.rejects(
      () => registry.ensureTrustedPath(target, 'file'),
      /injected filesystem activation failure/
    );
    assert.equal(registry.contains(addedRoot), false);
    await waitForRoots(client, [initialRoot]);

    const retried = await registry.ensureTrustedPath(target, 'file');
    assert.equal(retried.added, false);
    assert.equal(activationAttempts, 2);
    assert.equal(registry.contains(addedRoot), true);

    const write = await client.callTool({ name: 'write_file', arguments: { path: target, content: 'recovered' } });
    assert.notEqual(write.isError, true);
    const read = await client.callTool({ name: 'read_text_file', arguments: { path: target } });
    assert.equal(read.content[0].text, 'recovered');
  } finally {
    unsubscribe();
    registry.close();
    await client.close().catch(() => {});
  }
});
