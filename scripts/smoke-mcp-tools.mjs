import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const smokeCredential = `placeholder_mcp_smoke_${process.pid}`;
const observedProfiles = {};
const observedCatalogBytes = {};
const observedToolBytes = {};

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  if (!dataLines.length) throw new Error(`Unexpected MCP response: ${trimmed.slice(0, 500)}`);
  return JSON.parse(dataLines.join('\n'));
}

async function waitForHealth(baseUrl, child, profile) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrapper exited before health check for ${profile}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for wrapper health check for ${profile}`);
}

async function withServer(profile, fn) {
  const port = await findFreePort();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-smoke-${profile}-`));
  const configPath = path.join(workspace, 'mcp-servers.toml');
  const runtimeDirectory = path.join(workspace, '.runtime');
  fs.writeFileSync(configPath, `
[server]
name = "smoke-local-coding"
title = "Local Coding Gateway"
description = "Local coding workspace smoke instance."
instructions = "Use the six core local coding tools."

[trusted_roots]
roots = ["${workspace.replaceAll('\\', '/')}"]

[surface]
mode = "agent"

[external_mcp]
enabled = false
default_enabled = false
`, 'utf8');

  const env = {
    ...process.env,
    REPO_ROOT: root,
    MCP_UPSTREAM_CONFIG: configPath,
    MCP_GATEWAY_HOST: '127.0.0.1',
    MCP_ADVERTISE_HOST: '127.0.0.1',
    MCP_GATEWAY_PORT: String(port),
    MCP_BEARER_TOKEN: smokeCredential,
    MCP_RUNTIME_PROFILE: profile,
    ENABLE_FILESYSTEM: 'true',
    ENABLE_SHELL: 'true',
    MCP_STATEFUL_SESSIONS: 'false',
    MCP_RUNTIME_DIR: runtimeDirectory
  };

  const child = spawn(process.execPath, ['scripts/authenticated-mcp-wrapper.mjs'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForHealth(baseUrl, child, profile);
    return await fn({ baseUrl, profile, workspace, configPath, runtimeDirectory });
  } catch (error) {
    error.message += `\n--- wrapper logs (${profile}) ---\n${logs.slice(-6000)}`;
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
}

async function mcpRequestRaw(baseUrl, id, method, params = {}, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${smokeCredential}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...extraHeaders
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const body = Buffer.from(await response.arrayBuffer());
  const text = body.toString('utf8');
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
  return { parsed: parseMcpResponse(text), wireBytes: body.length };
}

async function mcpRequest(baseUrl, id, method, params = {}, extraHeaders = {}) {
  return (await mcpRequestRaw(baseUrl, id, method, params, extraHeaders)).parsed;
}

async function initialize(baseUrl) {
  const response = await mcpRequest(baseUrl, 1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'local-coding-tools-smoke', version: '1.0.0' }
  });
  assert.equal(response.result.serverInfo.title, 'Local Coding Gateway');
  assert.match(response.result.serverInfo.description || '', /Local coding workspace/i);
  assert.match(response.result.instructions || '', /get_skill\(name\)/i);
  assert.match(response.result.instructions || '', /project_list.*project_inspect/i);
  assert.match(response.result.instructions || '', /read_text_file/i);
  assert.doesNotMatch(response.result.instructions || '', /Routing policy:/i);
  return response;
}

async function listTools(baseUrl) {
  return (await mcpRequest(baseUrl, 2, 'tools/list', {})).result.tools || [];
}

async function listResources(baseUrl, id) {
  return (await mcpRequest(baseUrl, id, 'resources/list', {})).result.resources || [];
}

async function listResourceTemplates(baseUrl, id) {
  return (await mcpRequest(baseUrl, id, 'resources/templates/list', {})).result.resourceTemplates || [];
}

async function callTool(baseUrl, id, name, args = {}, extraHeaders = {}) {
  return await mcpRequest(baseUrl, id, 'tools/call', { name, arguments: args }, extraHeaders);
}

function names(tools) {
  return tools.map(tool => tool.name).sort();
}

await withServer('yolo', async ({ baseUrl, workspace, runtimeDirectory }) => {
  await initialize(baseUrl);
  const tools = await listTools(baseUrl);
  const resources = await listResources(baseUrl, 42);
  const resourceTemplates = await listResourceTemplates(baseUrl, 43);
  assert.deepEqual(
    resources.filter(resource => resource.uri.startsWith('repo://')).map(resource => resource.uri),
    ['repo://gateway/runtime-profile', 'repo://gateway/tool-manifest']
  );
  assert.deepEqual(resourceTemplates, []);
  assert.deepEqual(names(tools), [
    'edit_file',
    'external_tool_call_read',
    'external_tool_call_write',
    'external_tool_search',
    'get_skill',
    'image_preview',
    'interact_with_process',
    'list_devices',
    'project_inspect',
    'project_list',
    'read_process_output',
    'read_text_file',
    'shell_execute',
    'start_process',
    'terminate_process',
    'write_file'
  ]);
  for (const name of ['edit_file', 'shell_execute', 'write_file']) {
    assert.match(tools.find(tool => tool.name === name)?.description || '', /get_skill\(name\)/i);
  }
  assert.doesNotMatch(tools.find(tool => tool.name === 'read_text_file')?.description || '', /get_skill\(name\)/i);
  assert.equal(tools.find(tool => tool.name === 'get_skill')?.outputSchema?.type, 'object');
  const deviceList = await callTool(baseUrl, 38, 'list_devices', {});
  const deviceListPayload = JSON.parse(deviceList.result.content[0].text);
  assert.deepEqual(deviceListPayload.devices, []);

  for (const tool of tools.filter(item => !item?._meta?.upstream)) {
    assert.equal(tool?._meta?.trusted_roots, undefined, `${tool.name} leaked trusted_roots`);
    assert.equal(tool?._meta?.root_repo, undefined, `${tool.name} leaked root_repo`);
    assert.equal(tool?._meta?.repo_root, undefined, `${tool.name} leaked repo_root`);
  }
  const projectListSchema = tools.find(tool => tool.name === 'project_list')?.inputSchema;
  assert.deepEqual(projectListSchema?.required, ['device_id']);
  const projectInspectSchema = tools.find(tool => tool.name === 'project_inspect')?.inputSchema;
  assert.deepEqual(projectInspectSchema?.required, ['device_id', 'project_id', 'view']);

  // Static bearer intentionally has no account_id and therefore no visible
  // tenant device/project inventory. Project routing must fail closed rather
  // than silently falling back to the local workspace.
  const missingProjectDevice = await callTool(baseUrl, 39, 'project_list', { limit: 10 });
  assert.match(JSON.stringify(missingProjectDevice), /DEVICE_ID_REQUIRED/);
  const missingInspectDevice = await callTool(baseUrl, 40, 'project_inspect', { project_id: 'workspace', view: 'summary' });
  assert.match(JSON.stringify(missingInspectDevice), /DEVICE_ID_REQUIRED/);

  const externalSearch = await callTool(baseUrl, 44, 'external_tool_search', { query: 'missing', limit: 10 });
  const externalSearchPayload = JSON.parse(externalSearch.result.content[0].text);
  assert.equal(externalSearchPayload.ok, true);
  assert.deepEqual(externalSearchPayload.data, { items: [], truncated: false, nextCursor: null });

  const editInputSchema = tools.find(tool => tool.name === 'edit_file')?.inputSchema;
  assert.deepEqual(Object.keys(editInputSchema?.properties || {}).sort(), [
    'device_id', 'dry_run', 'expected_replacements', 'new_text', 'old_text', 'path'
  ]);
  assert.deepEqual(editInputSchema?.required, ['path', 'old_text', 'new_text', 'device_id']);
  assert.equal(editInputSchema?.properties?.expected_replacements?.default, 1);
  assert.equal(editInputSchema?.properties?.old_text?.minLength, 1);
  assert.equal(editInputSchema?.anyOf, undefined);
  const shellOutputSchema = tools.find(tool => tool.name === 'shell_execute')?.outputSchema;
  assert.equal(shellOutputSchema?.type, 'object');
  const shellInputSchema = tools.find(tool => tool.name === 'shell_execute')?.inputSchema;
  assert.equal(shellInputSchema?.properties?.timeout_ms?.maximum, 28000);
  assert.equal(shellInputSchema?.properties?.device_id?.minLength, 1);
  assert.deepEqual(shellInputSchema?.required, ['command', 'working_directory', 'device_id']);
  const readInputSchema = tools.find(tool => tool.name === 'read_text_file')?.inputSchema;
  const writeInputSchema = tools.find(tool => tool.name === 'write_file')?.inputSchema;
  const startProcessInputSchema = tools.find(tool => tool.name === 'start_process')?.inputSchema;
  const imagePreviewInputSchema = tools.find(tool => tool.name === 'image_preview')?.inputSchema;
  assert.equal(readInputSchema?.properties?.device_id?.minLength, 1);
  assert.ok(readInputSchema?.required?.includes('device_id'));
  assert.equal(writeInputSchema?.properties?.device_id?.minLength, 1);
  assert.ok(writeInputSchema?.required?.includes('device_id'));
  assert.equal(editInputSchema?.properties?.device_id?.minLength, 1);
  assert.ok(editInputSchema?.required?.includes('device_id'));
  assert.equal(startProcessInputSchema?.properties?.device_id?.minLength, 1);
  assert.deepEqual(startProcessInputSchema?.required, ['command', 'working_directory', 'device_id']);
  assert.deepEqual(imagePreviewInputSchema?.required, ['device_id']);
  assert.equal(tools.find(tool => tool.name === 'read_process_output')?.inputSchema?.properties?.device_id, undefined);
  assert.equal(tools.find(tool => tool.name === 'start_process')?.inputSchema?.properties?.timeout_ms?.default, 10000);
  assert.equal(tools.find(tool => tool.name === 'start_process')?.inputSchema?.properties?.timeout_ms?.maximum, 30000);
  for (const redundantField of [
    'command',
    'commandBytes',
    'returnedCommandBytes',
    'commandTruncated',
    'workingDirectoryRequested',
    'workingDirectoryRequestedBytes',
    'returnedWorkingDirectoryRequestedBytes',
    'workingDirectoryRequestedTruncated',
    'workingDirectoryResolvedBytes',
    'returnedWorkingDirectoryResolvedBytes',
    'workingDirectoryResolvedTruncated',
    'durationMs',
    'stderrClassification',
    'returnedStdoutBytes',
    'returnedStderrBytes',
    'stdoutHeadBytes',
    'stdoutTailBytes',
    'stderrHeadBytes',
    'stderrTailBytes',
    'encoding'
  ]) assert.equal(shellOutputSchema?.properties?.[redundantField], undefined);

  const target = path.join(workspace, 'smoke.txt');
  fs.writeFileSync(target, 'must-not-be-read-by-gateway-host', 'utf8');

  for (const [id, name, args] of [
    [3, 'read_text_file', { path: target }],
    [4, 'write_file', { path: target, content: 'must-not-write' }],
    [5, 'edit_file', { path: target, old_text: 'must-not', new_text: 'changed', expected_replacements: 1 }],
    [6, 'shell_execute', { command: 'echo must-not-run', working_directory: workspace }],
    [7, 'start_process', { command: 'echo must-not-run', working_directory: workspace }],
    [8, 'image_preview', { path: target }]
  ]) {
    const missingDevice = await callTool(baseUrl, id, name, args);
    assert.match(JSON.stringify(missingDevice), /device_id/i, `${name} must require device_id`);
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'must-not-be-read-by-gateway-host');

  const absentDeviceRead = await callTool(baseUrl, 17, 'read_text_file', { device_id: 'missing-device', path: target });
  assert.match(JSON.stringify(absentDeviceRead), /device|offline|connected|available|found/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'must-not-be-read-by-gateway-host');

  const invalidSkill = await callTool(baseUrl, 18, 'get_skill', { name: 'missing-smoke-skill' });
  assert.match(invalidSkill.error?.message || '', /Unknown skill/i);

  const bootstrap = await callTool(baseUrl, 9, 'get_skill', { name: 'local_coding' });
  assert.notEqual(bootstrap.result.isError, true);
  const bootstrapPayload = JSON.parse(bootstrap.result.content[0].text);
  assert.equal(bootstrapPayload.data.name, 'local_coding');
  assert.equal(bootstrapPayload.data.skillCatalog, undefined);
  assert.deepEqual(bootstrap.result.structuredContent, bootstrapPayload);

  const discovery = await callTool(baseUrl, 13, 'get_skill', {});
  const discoveryPayload = JSON.parse(discovery.result.content[0].text);
  assert.equal(discoveryPayload.data.mode, 'discovery');
  assert.equal(discoveryPayload.data.body, undefined);
  assert.deepEqual(discovery.result.structuredContent, discoveryPayload);

  const metricsText = fs.readFileSync(path.join(runtimeDirectory, 'mcp-calls.ndjson'), 'utf8');
  const metrics = metricsText.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(metrics.some(metric => metric.tool === 'read_text_file' && metric.success === false));
  assert.ok(metrics.some(metric => metric.tool === 'shell_execute' && metric.success === false));
  assert.ok(metrics.every(metric => metric.callerCategory === 'static-bearer'));
  assert.doesNotMatch(metricsText, /must-not-run|must-not-be-read-by-gateway-host/);
  observedProfiles.yolo = names(tools);
  observedCatalogBytes.yolo = Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
  observedToolBytes.shell_execute = Buffer.byteLength(JSON.stringify(tools.find(tool => tool.name === 'shell_execute')), 'utf8');
  observedToolBytes.edit_file = Buffer.byteLength(JSON.stringify(tools.find(tool => tool.name === 'edit_file')), 'utf8');
  assert.ok(observedCatalogBytes.yolo <= 32 * 1024, `yolo core catalog exceeded 32 KiB: ${observedCatalogBytes.yolo}`);
});

await withServer('safe', async ({ baseUrl }) => {
  await initialize(baseUrl);
  const tools = await listTools(baseUrl);
  assert.deepEqual(names(tools), ['external_tool_call_read', 'external_tool_search', 'get_skill', 'image_preview', 'list_devices', 'project_inspect', 'project_list', 'read_text_file']);
  const blocked = await callTool(baseUrl, 3, 'shell_execute', { command: 'echo blocked' });
  assert.match(blocked.error?.message || '', /disabled by MCP_SAFETY_PROFILE=safe/);
  observedProfiles.safe = names(tools);
  observedCatalogBytes.safe = Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
});

await withServer('assisted', async ({ baseUrl }) => {
  await initialize(baseUrl);
  const tools = await listTools(baseUrl);
  assert.deepEqual(names(tools), ['edit_file', 'external_tool_call_read', 'external_tool_call_write', 'external_tool_search', 'get_skill', 'image_preview', 'list_devices', 'project_inspect', 'project_list', 'read_text_file', 'write_file']);
  const blocked = await callTool(baseUrl, 3, 'shell_execute', { command: 'echo blocked' });
  assert.match(blocked.error?.message || '', /disabled by MCP_SAFETY_PROFILE=assisted/);
  observedProfiles.assisted = names(tools);
  observedCatalogBytes.assisted = Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
});

console.log(JSON.stringify({
  ok: true,
  checked: 'exact core catalog, progressive skill advisory, profile filtering, explicit device routing, and no gateway-host execution fallback',
  observedProfiles,
  observedCatalogBytes,
  observedToolBytes
}, null, 2));
