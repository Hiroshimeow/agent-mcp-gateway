import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const smokeCredential = `placeholder_mcp_smoke_${process.pid}`;
const observedProfiles = {};

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
  const deadline = Date.now() + 15000;
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
  fs.writeFileSync(configPath, `
[server]
name = "smoke-local-coding"
title = "Local Coding Gateway"
description = "Local coding workspace smoke instance."
instructions = "Use the six core local coding tools."

[trusted_roots]
roots = ["${workspace.replaceAll('\\', '/')}"]

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
    MCP_AUTH_PASSWORD: `placeholder_mcp_password_${process.pid}`,
    MCP_RUNTIME_PROFILE: profile,
    ENABLE_FILESYSTEM: 'true',
    ENABLE_SHELL: 'true',
    MCP_STATEFUL_SESSIONS: 'false'
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
    return await fn({ baseUrl, profile, workspace, configPath });
  } catch (error) {
    error.message += `\n--- wrapper logs (${profile}) ---\n${logs.slice(-6000)}`;
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
}

async function mcpRequest(baseUrl, id, method, params = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${smokeCredential}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
  return parseMcpResponse(text);
}

async function initialize(baseUrl) {
  const response = await mcpRequest(baseUrl, 1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'local-coding-tools-smoke', version: '1.0.0' }
  });
  assert.equal(response.result.serverInfo.title, 'Local Coding Gateway');
  assert.match(response.result.serverInfo.description || '', /Local coding workspace/i);
  return response;
}

async function listTools(baseUrl) {
  return (await mcpRequest(baseUrl, 2, 'tools/list', {})).result.tools || [];
}

async function callTool(baseUrl, id, name, args = {}) {
  return await mcpRequest(baseUrl, id, 'tools/call', { name, arguments: args });
}

function names(tools) {
  return tools.map(tool => tool.name).sort();
}

function portablePath(value) {
  return path.resolve(value).replaceAll('\\', '/');
}

await withServer('yolo', async ({ baseUrl, workspace, configPath }) => {
  await initialize(baseUrl);
  const tools = await listTools(baseUrl);
  assert.deepEqual(names(tools), [
    'edit_file',
    'get_skill',
    'image_preview',
    'read_text_file',
    'shell_execute',
    'write_file'
  ]);

  const target = path.join(workspace, 'smoke.txt');
  await callTool(baseUrl, 3, 'write_file', { path: target, content: 'first' });
  await callTool(baseUrl, 4, 'edit_file', {
    path: target,
    edits: [{ oldText: 'first', newText: 'second' }],
    dryRun: false
  });
  const read = await callTool(baseUrl, 5, 'read_text_file', { path: target });
  assert.equal(read.result.content[0].text, 'second');

  const concurrentRoots = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-dynamic-root-a-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-dynamic-root-b-'))
  ];
  await Promise.all(concurrentRoots.map(async (dynamicRoot, index) => {
    const dynamicTarget = path.join(dynamicRoot, `auto-trusted-${index}.txt`);
    const write = await callTool(baseUrl, 6 + index * 2, 'write_file', { path: dynamicTarget, content: `auto-trusted-${index}` });
    assert.notEqual(write.result?.isError, true);
    const dynamicRead = await callTool(baseUrl, 7 + index * 2, 'read_text_file', { path: dynamicTarget });
    assert.equal(dynamicRead.result.content[0].text, `auto-trusted-${index}`);
  }));
  const persistedConfig = fs.readFileSync(configPath, 'utf8');
  for (const dynamicRoot of concurrentRoots) assert.ok(persistedConfig.includes(portablePath(dynamicRoot)));

  const shellDynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-shell-root-'));
  const shellPathCommand = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd';
  const shellPath = await callTool(baseUrl, 10, 'shell_execute', {
    command: shellPathCommand,
    working_directory: shellDynamicRoot
  });
  const shellPathData = JSON.parse(shellPath.result.content[0].text);
  assert.equal(shellPathData.exitCode, 0);
  assert.equal(path.resolve(shellPathData.workingDirectoryResolved), path.resolve(shellDynamicRoot));
  assert.ok(fs.readFileSync(configPath, 'utf8').includes(portablePath(shellDynamicRoot)));

  const command = process.platform === 'win32'
    ? "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Write-Output 'Tiếng Việt 日本語'; [Console]::Error.WriteLine('warning')"
    : "printf 'Tiếng Việt 日本語\\n'; printf 'warning\\n' >&2";
  const shell = await callTool(baseUrl, 11, 'shell_execute', { command, working_directory: workspace });
  const shellData = JSON.parse(shell.result.content[0].text);
  assert.equal(shellData.exitCode, 0);
  assert.match(shellData.stdout, /Tiếng Việt 日本語/);
  assert.match(shellData.stderr, /warning/);
  assert.equal(shellData.stderrClassification, 'warning');
  assert.equal(shellData.encoding, 'utf-8');
  assert.equal(shellData.returnedStdoutBytes <= shellData.stdoutBytes, true);
  assert.equal(shellData.returnedStderrBytes <= shellData.stderrBytes, true);
  observedProfiles.yolo = names(tools);
});

await withServer('safe', async ({ baseUrl }) => {
  await initialize(baseUrl);
  const tools = await listTools(baseUrl);
  assert.deepEqual(names(tools), ['get_skill', 'image_preview', 'read_text_file']);
  const blocked = await callTool(baseUrl, 3, 'shell_execute', { command: 'echo blocked' });
  assert.match(blocked.error?.message || '', /disabled by MCP_SAFETY_PROFILE=safe/);
  observedProfiles.safe = names(tools);
});

await withServer('assisted', async ({ baseUrl }) => {
  await initialize(baseUrl);
  const tools = await listTools(baseUrl);
  assert.deepEqual(names(tools), ['edit_file', 'get_skill', 'image_preview', 'read_text_file', 'write_file']);
  const blocked = await callTool(baseUrl, 3, 'shell_execute', { command: 'echo blocked' });
  assert.match(blocked.error?.message || '', /disabled by MCP_SAFETY_PROFILE=assisted/);
  observedProfiles.assisted = names(tools);
});

console.log(JSON.stringify({
  ok: true,
  checked: 'exact core catalog, profile filtering, two concurrent automatic path grants, immediate filesystem calls, and structured UTF-8 shell output',
  observedProfiles
}, null, 2));
