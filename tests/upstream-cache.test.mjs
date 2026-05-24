import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExternalMcpManager, buildExternalCatalog, closeClientWithTimeout } from '../scripts/upstreams/manager.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dynamicServer = path.join(root, 'tests/fixtures/dynamic-mcp-server.mjs');
const toolOnlyServer = path.join(root, 'tests/fixtures/tool-only-mcp-server.mjs');

async function tempDir() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-cache-'));
}

async function writeState(file, state) {
  await fs.promises.writeFile(file, JSON.stringify({ tools: ['a'], resources: ['main'], prompts: ['review'], ...state }));
}

async function readCount(file) {
  try { return Number(await fs.promises.readFile(file, 'utf8')) || 0; } catch { return 0; }
}

async function makeDynamicManager({ mode = 'startup', ttl = 1000, prefix = 'dyn', envExtra = {}, localToolNames = [] } = {}) {
  const dir = await tempDir();
  const statePath = path.join(dir, 'state.json');
  const countPath = path.join(dir, 'count.txt');
  const configPath = path.join(dir, 'mcp-servers.toml');
  await writeState(statePath, { tools: ['a'] });
  await fs.promises.writeFile(configPath, `
[external_mcp]
catalog_cache = "${mode}"
catalog_cache_ttl_ms = ${ttl}

[mcp_servers.dyn]
transport = "stdio"
command = "${process.execPath.replaceAll('\\', '\\\\')}"
args = ["${dynamicServer.replaceAll('\\', '\\\\')}", "${statePath.replaceAll('\\', '\\\\')}", "${countPath.replaceAll('\\', '\\\\')}"]
tool_prefix = "${prefix}"
`);
  const manager = await createExternalMcpManager({
    repoRoot: root,
    env: { MCP_UPSTREAM_CONFIG: configPath, DYNAMIC_MCP_STATE: statePath, DYNAMIC_MCP_COUNT: countPath, ...envExtra },
    localToolNames
  });
  return { manager, statePath, countPath };
}

async function toolNames(manager) {
  return (await manager.listAllToolsUnfiltered()).map(tool => tool.name).sort();
}

async function promptNames(manager) {
  return (await manager.listPrompts()).map(prompt => prompt.name).sort();
}

async function externalResourceNames(manager) {
  return (await manager.listResources())
    .filter(resource => resource.uri.startsWith('external-mcp://dyn/') && !resource.uri.endsWith('/status'))
    .map(resource => resource.name)
    .sort();
}

async function assertGeneration(manager, expected) {
  assert.equal(manager._catalogStateForTests.generation, expected);
}

test('startup cache does not refresh when upstream catalog changes', async () => {
  const { manager, statePath, countPath } = await makeDynamicManager({ mode: 'startup' });
  try {
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    await writeState(statePath, { tools: ['a', 'b'] });
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    assert.equal(await readCount(countPath), 1);
  } finally {
    await manager.shutdown();
  }
});

test('ttl cache refreshes only after ttl expires', async () => {
  const { manager, statePath, countPath } = await makeDynamicManager({ mode: 'ttl', ttl: 100 });
  try {
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    await writeState(statePath, { tools: ['a', 'b'] });
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    assert.equal(await readCount(countPath), 1);
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.deepEqual(await toolNames(manager), ['dyn_a', 'dyn_b']);
    assert.equal(await readCount(countPath), 2);
    const call = await manager.callTool('dyn_b', {});
    assert.match(call.content[0].text, /dynamic:b/);
  } finally {
    await manager.shutdown();
  }
});

test('none cache refreshes on every catalog list', async () => {
  const { manager, statePath, countPath } = await makeDynamicManager({ mode: 'none' });
  try {
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    await writeState(statePath, { tools: ['a', 'b'] });
    assert.deepEqual(await toolNames(manager), ['dyn_a', 'dyn_b']);
    assert.equal(await readCount(countPath), 3);
  } finally {
    await manager.shutdown();
  }
});

test('refresh failure keeps previous snapshot and reports diagnostics error', async () => {
  const { manager, statePath } = await makeDynamicManager({ mode: 'none' });
  try {
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    const baselineGeneration = manager._catalogStateForTests.generation;
    await writeState(statePath, { failToolsList: true });
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    const diag = JSON.parse((await manager.readResource('external-mcp://_diagnostics/status')).contents[0].text);
    assert.match(diag.lastRefreshError, /tools\/list.*dynamic tools\/list failure/);
    await assertGeneration(manager, baselineGeneration);
  } finally {
    await manager.shutdown();
  }
});

test('collision during refresh keeps previous snapshot and routes intact', async () => {
  const { manager, statePath } = await makeDynamicManager({ mode: 'none' });
  try {
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    await writeState(statePath, { tools: ['a', 'A'] });
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    const diag = JSON.parse((await manager.readResource('external-mcp://_diagnostics/status')).contents[0].text);
    assert.match(diag.lastRefreshError, /collision/);
    const call = await manager.callTool('dyn_a', {});
    assert.match(call.content[0].text, /dynamic:a/);
  } finally {
    await manager.shutdown();
  }
});

test('tool-only upstream imports tools and exposes empty optional catalogs', async () => {
  const dir = await tempDir();
  const statePath = path.join(dir, 'state.json');
  const countPath = path.join(dir, 'count.txt');
  const configPath = path.join(dir, 'mcp-servers.toml');
  await writeState(statePath, { tools: ['a'] });
  await fs.promises.writeFile(configPath, `
[external_mcp]
catalog_cache = "startup"

[mcp_servers.dyn]
transport = "stdio"
command = "${process.execPath.replaceAll('\\', '\\\\')}"
args = ["${toolOnlyServer.replaceAll('\\', '\\\\')}"]
tool_prefix = "dyn"
`);
  const manager = await createExternalMcpManager({ repoRoot: root, env: { MCP_UPSTREAM_CONFIG: configPath } });
  try {
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    assert.deepEqual(await externalResourceNames(manager), []);
    assert.deepEqual(await manager.listResourceTemplates(), []);
    assert.deepEqual(await promptNames(manager), []);
    const diag = JSON.parse((await manager.readResource('external-mcp://_diagnostics/status')).contents[0].text);
    assert.equal(diag.lastRefreshError, null);
  } finally {
    await manager.shutdown();
  }
});

test('buildExternalCatalog rejects collisions with local exposed custom names', async () => {
  const fakeClient = {
    capabilities: { tools: {} },
    async listTools() { return { tools: [{ name: 'read_file', inputSchema: { type: 'object' } }] }; }
  };
  const server = { id: 'ext', toolPrefix: 'custom', transport: 'stdio' };
  await assert.rejects(() => buildExternalCatalog({
    servers: [server],
    clients: new Map([['ext', fakeClient]]),
    localToolNames: ['read_file', 'custom_read_file']
  }), /collision|custom_read_file/);
});

test('external prefix does not shadow local tool names that were never external', async () => {
  const { manager } = await makeDynamicManager({ mode: 'startup', prefix: 'read', localToolNames: ['read_file'] });
  try {
    assert.deepEqual(await toolNames(manager), ['read_a']);
    assert.equal(manager.isExternalToolName('read_a'), true);
    assert.equal(manager.isExternalToolName('read_file'), false);
  } finally {
    await manager.shutdown();
  }
});

test('partial non-tool list failure keeps previous snapshot and generation', async () => {
  for (const [flag, endpoint] of [
    ['failResourcesList', 'resources/list'],
    ['failResourceTemplatesList', 'resources/templates/list'],
    ['failPromptsList', 'prompts/list']
  ]) {
    const { manager, statePath } = await makeDynamicManager({ mode: 'none' });
    try {
      assert.deepEqual(await toolNames(manager), ['dyn_a']);
      assert.deepEqual(await externalResourceNames(manager), ['Dynamic resource main']);
      assert.deepEqual(await promptNames(manager), ['dyn_review']);
      const baselineGeneration = manager._catalogStateForTests.generation;
      await writeState(statePath, { tools: ['a', 'b'], resources: ['changed'], prompts: ['changed'], [flag]: true });
      assert.deepEqual(await toolNames(manager), ['dyn_a']);
      assert.deepEqual(await externalResourceNames(manager), ['Dynamic resource main']);
      assert.deepEqual(await promptNames(manager), ['dyn_review']);
      await assertGeneration(manager, baselineGeneration);
      const diag = JSON.parse((await manager.readResource('external-mcp://_diagnostics/status')).contents[0].text);
      assert.match(diag.lastRefreshError, new RegExp(endpoint.replace('/', '\\/')));
    } finally {
      await manager.shutdown();
    }
  }
});

test('tool disappearance after refresh removes route', async () => {
  const { manager, statePath } = await makeDynamicManager({ mode: 'none' });
  try {
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    await writeState(statePath, { tools: [] });
    assert.deepEqual(await toolNames(manager), []);
    await assert.rejects(() => manager.callTool('dyn_a', {}), /Unknown external MCP tool/);
  } finally {
    await manager.shutdown();
  }
});

test('disappeared external tool and prompt remain classified as external names', async () => {
  const { manager, statePath } = await makeDynamicManager({ mode: 'none' });
  try {
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    assert.deepEqual(await promptNames(manager), ['dyn_review']);
    await writeState(statePath, { tools: [], prompts: [] });
    assert.deepEqual(await toolNames(manager), []);
    assert.deepEqual(await promptNames(manager), []);
    assert.equal(manager.isExternalToolName('dyn_a'), true);
    assert.equal(manager.isExternalPromptName('dyn_review'), true);
    await assert.rejects(() => manager.callTool('dyn_a', {}), /Unknown external MCP tool: dyn_a/);
    await assert.rejects(() => manager.getPrompt('dyn_review', {}), /Unknown external MCP prompt: dyn_review/);
  } finally {
    await manager.shutdown();
  }
});

test('buildExternalCatalog rejects local tool collisions before commit', async () => {
  const fakeClient = {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    async listTools() { return { tools: [{ name: 'a', inputSchema: { type: 'object' } }] }; },
    async listResources() { return { resources: [] }; },
    async listResourceTemplates() { return { resourceTemplates: [] }; },
    async listPrompts() { return { prompts: [] }; }
  };
  const server = { id: 'dyn', toolPrefix: 'dyn', transport: 'stdio' };
  await assert.rejects(() => buildExternalCatalog({ servers: [server], clients: new Map([['dyn', fakeClient]]), localToolNames: ['dyn_a'] }), /collision/);
});

test('dynamic resource template read routes encoded URI to upstream', async () => {
  const { manager } = await makeDynamicManager({ mode: 'startup' });
  try {
    const { toExternalResourceUri } = await import('../scripts/upstreams/resource-uri.mjs');
    const uri = toExternalResourceUri('dyn', 'dynamic://resource/from-template');
    const resource = await manager.readResource(uri);
    assert.match(resource.contents[0].text, /dynamic-resource:dynamic:\/\/resource\/from-template/);
  } finally {
    await manager.shutdown();
  }
});

test('shutdown timeout resolves when close never resolves and close rejection is swallowed', async () => {
  const signals = [];
  const never = {
    id: 'never',
    config: { shutdownTimeoutMs: 25 },
    kill(signal) { signals.push(signal); },
    async close() { return await new Promise(() => {}); }
  };
  const reject = {
    id: 'reject',
    config: { shutdownTimeoutMs: 25 },
    async close() { throw new Error('close failed'); }
  };
  const started = Date.now();
  await Promise.all([closeClientWithTimeout(never, 25), closeClientWithTimeout(reject, 25)]);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('shutdown timeout only sends SIGKILL when client reports still running', async () => {
  const stoppedSignals = [];
  const stopped = {
    id: 'stopped',
    config: { shutdownTimeoutMs: 10 },
    isRunning() { return false; },
    kill(signal) { stoppedSignals.push(signal); },
    async close() { return await new Promise(() => {}); }
  };
  await closeClientWithTimeout(stopped, 10);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(stoppedSignals, ['SIGTERM']);

  const runningSignals = [];
  const running = {
    id: 'running',
    config: { shutdownTimeoutMs: 10 },
    isRunning() { return true; },
    kill(signal) { runningSignals.push(signal); },
    async close() { return await new Promise(() => {}); }
  };
  await closeClientWithTimeout(running, 10);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(runningSignals, ['SIGTERM', 'SIGKILL']);
});
