import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const root = process.cwd();
const smokeCredential = `placeholder_mcp_smoke_${process.pid}`;

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
  const dataLines = trimmed.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
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
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for wrapper health check for ${profile}`);
}

async function withServer(profile, fn) {
  const port = await findFreePort();
  const env = {
    ...process.env,
    REPO_ROOT: root,
    MCP_TRUSTED_ROOTS: root,
    MCP_GATEWAY_HOST: '127.0.0.1',
    MCP_ADVERTISE_HOST: '127.0.0.1',
    MCP_GATEWAY_PORT: String(port),
    MCP_BEARER_TOKEN: smokeCredential,
    MCP_AUTH_PASSWORD: `placeholder_mcp_password_${process.pid}`,
    MCP_SAFETY_PROFILE: profile,
    ENABLE_FILESYSTEM: 'true',
    // Deliberately do not set ENABLE_SHELL. This smoke validates the default.
    MCP_STATEFUL_SESSIONS: 'false'
  };
  delete env.ENABLE_SHELL;
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
    return await fn({ baseUrl, profile });
  } catch (error) {
    error.message += `\n--- wrapper logs (${profile}) ---\n${logs.slice(-4000)}`;
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
    clientInfo: { name: 'agent-mcp-gateway-tools-smoke', version: '1.0.0' }
  });
  assert.ok(response.result.serverInfo, 'initialize returns serverInfo');
}

function toolMap(tools) {
  return new Map(tools.map(tool => [tool.name, tool]));
}

async function listTools(baseUrl) {
  const response = await mcpRequest(baseUrl, 2, 'tools/list', {});
  return response.result.tools || [];
}

async function callTool(baseUrl, id, name, args = {}) {
  return await mcpRequest(baseUrl, id, 'tools/call', { name, arguments: args });
}

await withServer('yolo', async ({ baseUrl }) => {
  await initialize(baseUrl);
  const tools = toolMap(await listTools(baseUrl));
  assert.ok(tools.has('custom_shell_execute'), 'yolo exposes custom_shell_execute by default');
  assert.ok(tools.has('custom_git_push'), 'yolo exposes custom_git_push');
  assert.ok(tools.has('custom_get_safety_profile'), 'yolo exposes custom_get_safety_profile');
  const shell = tools.get('custom_shell_execute');
  assert.equal(shell.annotations.destructiveHint, true);
  assert.equal(shell.annotations.openWorldHint, true);
  assert.doesNotMatch(shell.description, /local Windows machine/i);
  assert.match(shell.description, /private yolo developer mode/i);
});

await withServer('safe', async ({ baseUrl }) => {
  await initialize(baseUrl);
  const tools = toolMap(await listTools(baseUrl));
  assert.equal(tools.has('custom_shell_execute'), false, 'safe hides shell');
  assert.equal(tools.has('custom_git_push'), false, 'safe hides git_push');
  assert.ok(tools.has('custom_read_text_file'), 'safe keeps read-only file tools');
  assert.ok(tools.has('custom_get_safety_profile'), 'safe keeps safety profile tool');
  const manifestResponse = await mcpRequest(baseUrl, 6, 'resources/read', { uri: 'repo://project/agent-mcp-gateway/tool-manifest' });
  const manifest = JSON.parse(manifestResponse.result.contents[0].text);
  const shellManifest = manifest.tools.find(tool => tool.name === 'custom_shell_execute');
  const pushManifest = manifest.tools.find(tool => tool.name === 'custom_git_push');
  const readManifest = manifest.tools.find(tool => tool.name === 'custom_read_text_file');
  assert.equal(shellManifest?.visible, false, 'safe manifest includes shell as hidden');
  assert.equal(pushManifest?.visible, false, 'safe manifest includes git_push as hidden');
  assert.equal(readManifest?.visible, true, 'safe manifest includes read tool as visible');
  const blocked = await callTool(baseUrl, 3, 'custom_shell_execute', { command: 'echo should-not-run' });
  assert.match(blocked.error?.message || '', /disabled by MCP_SAFETY_PROFILE=safe/);
  const profile = await callTool(baseUrl, 4, 'custom_get_safety_profile', {});
  assert.ok(profile.result?.content?.length, 'safe allows read-only safety profile call');
});

await withServer('assisted', async ({ baseUrl }) => {
  await initialize(baseUrl);
  const tools = toolMap(await listTools(baseUrl));
  assert.equal(tools.has('custom_shell_execute'), false, 'assisted hides shell');
  assert.equal(tools.has('custom_git_push'), false, 'assisted hides git_push');
  assert.ok(tools.has('custom_delete_file'), 'assisted exposes local mutating tools');
  assert.ok(tools.has('custom_apply_patch'), 'assisted exposes preview/apply workflow tools');
  const blocked = await callTool(baseUrl, 5, 'custom_git_push', { path: root });
  assert.match(blocked.error?.message || '', /disabled by MCP_SAFETY_PROFILE=assisted/);
});

console.log(JSON.stringify({ ok: true, profiles: ['yolo', 'safe', 'assisted'], checked: 'runtime tools/list and call-time profile enforcement' }, null, 2));
