import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExternalMcpManager, buildExternalCatalog, closeClientWithTimeout } from '../scripts/upstreams/manager.mjs';
import { loadExternalMcpConfig } from '../scripts/upstreams/config.mjs';

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
enabled = true
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

function trackedClientFactory(tracker) {
  let sequence = 0;
  return async server => {
    const instance = `${server.id}:${server.command}:${++sequence}`;
    const client = {
      id: server.id,
      config: server,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      closed: false,
      async listTools() {
        if (server.command.includes('fail-list')) throw new Error(`candidate list failure: ${instance}`);
        return { tools: [{ name: 'a', inputSchema: { type: 'object' } }] };
      },
      async listResources() { return { resources: [] }; },
      async listResourceTemplates() { return { resourceTemplates: [] }; },
      async listPrompts() { return { prompts: [] }; },
      async callTool() {
        if (this.closed) throw new Error(`closed client: ${instance}`);
        return { content: [{ type: 'text', text: instance }] };
      },
      async close() {
        this.closed = true;
        tracker.closed.push(instance);
      }
    };
    tracker.created.push(instance);
    tracker.clients.set(instance, client);
    return client;
  };
}

async function makeTrackedManager(serverBlocks, tracker, changes = []) {
  const dir = await tempDir();
  const configPath = path.join(dir, 'mcp-servers.toml');
  await fs.promises.writeFile(configPath, `[external_mcp]\ncatalog_cache = "startup"\n${serverBlocks}`);
  const env = { MCP_UPSTREAM_CONFIG: configPath };
  const manager = await createExternalMcpManager({
    repoRoot: dir,
    env,
    clientFactory: trackedClientFactory(tracker),
    onCatalogChanged: change => changes.push(change)
  });
  return { manager, dir, configPath, env };
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
  const ttl = 60_000;
  const { manager, statePath, countPath } = await makeDynamicManager({ mode: 'ttl', ttl });
  try {
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    await writeState(statePath, { tools: ['a', 'b'] });
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    assert.equal(await readCount(countPath), 1);
    manager._catalogStateForTests.lastRefreshAt = new Date(Date.now() - ttl - 1).toISOString();
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
enabled = true
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


test('reconcile hot-enables and hot-disables an upstream and emits catalog changes', async () => {
  const dir = await tempDir();
  const statePath = path.join(dir, 'state.json');
  const countPath = path.join(dir, 'count.txt');
  const configPath = path.join(dir, 'mcp-servers.toml');
  await writeState(statePath, { tools: ['a'] });

  const serverBlock = `
[mcp_servers.dyn]
enabled = false
transport = "stdio"
command = "${process.execPath.replaceAll('\\', '\\\\')}"
args = ["${dynamicServer.replaceAll('\\', '\\\\')}", "${statePath.replaceAll('\\', '\\\\')}", "${countPath.replaceAll('\\', '\\\\')}"]
tool_prefix = "dyn"
`;
  await fs.promises.writeFile(configPath, serverBlock);
  const changes = [];
  const manager = await createExternalMcpManager({
    repoRoot: root,
    env: { MCP_UPSTREAM_CONFIG: configPath },
    onCatalogChanged: change => changes.push(change)
  });
  try {
    assert.deepEqual(await toolNames(manager), []);

    await fs.promises.writeFile(configPath, serverBlock.replace('enabled = false', 'enabled = true'));
    await manager.reconcile(await loadExternalMcpConfig({ repoRoot: root, env: { MCP_UPSTREAM_CONFIG: configPath } }));
    assert.deepEqual(await toolNames(manager), ['dyn_a']);
    assert.deepEqual(changes.at(-1), { toolsChanged: true, resourcesChanged: true, promptsChanged: true });

    await fs.promises.writeFile(configPath, serverBlock);
    await manager.reconcile(await loadExternalMcpConfig({ repoRoot: root, env: { MCP_UPSTREAM_CONFIG: configPath } }));
    assert.deepEqual(await toolNames(manager), []);
    assert.deepEqual(changes.at(-1), { toolsChanged: true, resourcesChanged: true, promptsChanged: true });
  } finally {
    await manager.shutdown();
  }
});

test('failed reconcile preserves removed-server routes and all original clients', async () => {
  const tracker = { created: [], closed: [], clients: new Map() };
  const blocks = `
[mcp_servers.alpha]
enabled = true
transport = "stdio"
command = "old-alpha"

[mcp_servers.beta]
enabled = true
transport = "stdio"
command = "old-beta"
`;
  const { manager } = await makeTrackedManager(blocks, tracker);
  try {
    const alphaBefore = (await manager.callTool('alpha_a', {})).content[0].text;
    const betaBefore = (await manager.callTool('beta_a', {})).content[0].text;
    const generation = manager._catalogStateForTests.generation;
    const alpha = manager.config.servers.find(server => server.id === 'alpha');

    await assert.rejects(
      () => manager.reconcile({ ...manager.config, servers: [{ ...alpha, command: 'fail-list-alpha' }] }),
      /committed topology preserved.*candidate list failure/
    );

    assert.equal(manager._catalogStateForTests.generation, generation);
    assert.equal((await manager.callTool('alpha_a', {})).content[0].text, alphaBefore);
    assert.equal((await manager.callTool('beta_a', {})).content[0].text, betaBefore);
    assert.equal(tracker.clients.get(alphaBefore).closed, false);
    assert.equal(tracker.clients.get(betaBefore).closed, false);
    const staged = tracker.created.find(name => name.includes('fail-list-alpha'));
    assert.equal(tracker.clients.get(staged).closed, true);
  } finally {
    await manager.shutdown();
  }
});

test('failed signature replacement closes staged client and leaves old route callable', async () => {
  const tracker = { created: [], closed: [], clients: new Map() };
  const blocks = `
[mcp_servers.dyn]
enabled = true
transport = "stdio"
command = "old-dyn"
`;
  const { manager } = await makeTrackedManager(blocks, tracker);
  try {
    const before = (await manager.callTool('dyn_a', {})).content[0].text;
    const generation = manager._catalogStateForTests.generation;
    const current = manager.config.servers[0];
    await assert.rejects(
      () => manager.reconcile({ ...manager.config, servers: [{ ...current, command: 'fail-list-dyn' }] }),
      /committed topology preserved/
    );
    assert.equal(manager._catalogStateForTests.generation, generation);
    assert.equal((await manager.callTool('dyn_a', {})).content[0].text, before);
    assert.equal(tracker.clients.get(before).closed, false);
    const staged = tracker.created.find(name => name.includes('fail-list-dyn'));
    assert.equal(tracker.clients.get(staged).closed, true);
  } finally {
    await manager.shutdown();
  }
});

test('successful signature replacement commits new client and emits no list change when catalog keys are unchanged', async () => {
  const tracker = { created: [], closed: [], clients: new Map() };
  const changes = [];
  const blocks = `
[mcp_servers.dyn]
enabled = true
transport = "stdio"
command = "old-dyn"
`;
  const { manager } = await makeTrackedManager(blocks, tracker, changes);
  try {
    const before = (await manager.callTool('dyn_a', {})).content[0].text;
    const generation = manager._catalogStateForTests.generation;
    const current = manager.config.servers[0];
    await manager.reconcile({ ...manager.config, servers: [{ ...current, command: 'new-dyn' }] });
    const after = (await manager.callTool('dyn_a', {})).content[0].text;
    assert.notEqual(after, before);
    assert.match(after, /new-dyn/);
    assert.equal(tracker.clients.get(before).closed, true);
    assert.equal(manager._catalogStateForTests.generation, generation + 1);
    assert.deepEqual(changes, []);
  } finally {
    await manager.shutdown();
  }
});
