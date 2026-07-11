import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const root = process.cwd();
const smokeCredential = `placeholder_mcp_upstream_smoke_${process.pid}`;

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

async function waitForHealth(baseUrl, child, profile, logsRef) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrapper exited before health check for ${profile}\n${logsRef()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for wrapper health check for ${profile}\n${logsRef()}`);
}

async function makeConfig() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upstream-smoke-'));
  const fakeServer = path.join(root, 'tests/fixtures/fake-mcp-server.mjs').replaceAll('\\', '\\\\');
  const node = process.execPath.replaceAll('\\', '\\\\');
  const config = path.join(dir, 'mcp-servers.toml');
  await fs.promises.writeFile(config, `
[trusted_roots]
roots = ["${root.replaceAll('\\', '/')}"]

[external_mcp]
fail_gateway_on_startup_error = false
catalog_cache = "startup"

[mcp_servers.fake]
enabled = true
transport = "stdio"
command = "${node}"
args = ["${fakeServer}"]

[mcp_servers.failed_optional]
enabled = true
transport = "stdio"
command = "definitely-not-a-real-command-for-mcp"
`);
  return config;
}

async function withServer(profile, fn) {
  const port = await findFreePort();
  const configPath = await makeConfig();
  const env = {
    ...process.env,
    REPO_ROOT: root,
    MCP_GATEWAY_HOST: '127.0.0.1',
    MCP_ADVERTISE_HOST: '127.0.0.1',
    MCP_GATEWAY_PORT: String(port),
    MCP_BEARER_TOKEN: smokeCredential,
    MCP_AUTH_PASSWORD: `placeholder_mcp_password_${process.pid}`,
    MCP_SAFETY_PROFILE: profile,
    ENABLE_FILESYSTEM: 'true',
    ENABLE_SHELL: 'true',
    MCP_STATEFUL_SESSIONS: 'false',
    MCP_UPSTREAM_CONFIG: configPath
  };
  const child = spawn(process.execPath, ['scripts/authenticated-mcp-wrapper.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, child, profile, () => logs.slice(-4000));
    return await fn({ baseUrl });
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
    headers: { authorization: `Bearer ${smokeCredential}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
  return parseMcpResponse(text);
}

async function initialize(baseUrl) {
  const response = await mcpRequest(baseUrl, 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'upstream-smoke', version: '1.0.0' } });
  assert.ok(response.result.serverInfo);
}

async function listTools(baseUrl) {
  const response = await mcpRequest(baseUrl, 2, 'tools/list', {});
  return new Map((response.result.tools || []).map(tool => [tool.name, tool]));
}

await withServer('yolo', async ({ baseUrl }) => {
  await initialize(baseUrl);
  const tools = await listTools(baseUrl);
  for (const name of ['fake_read_context', 'fake_write_context', 'fake_push_context', 'fake_unknown_context']) assert.ok(tools.has(name), `yolo exposes ${name}`);
  assert.equal(tools.get('fake_read_context')._meta.upstream.upstreamToolName, 'read_context');
  assert.equal(tools.get('fake_unknown_context')._meta.upstream.upstreamToolName, 'unknown_context');
  const resourceList = await mcpRequest(baseUrl, 3, 'resources/list', {});
  const resource = resourceList.result.resources.find(item => item.uri.startsWith('external-mcp://fake/') && !item.uri.endsWith('/status'));
  assert.ok(resource, 'resource proxy listed');
  const read = await mcpRequest(baseUrl, 4, 'resources/read', { uri: resource.uri });
  assert.match(read.result.contents[0].text, /resource:fake:\/\/context\/main/);
  const prompts = await mcpRequest(baseUrl, 5, 'prompts/list', {});
  assert.ok(prompts.result.prompts.some(prompt => prompt.name === 'fake_review_context'));
  const prompt = await mcpRequest(baseUrl, 6, 'prompts/get', { name: 'fake_review_context', arguments: { topic: 'smoke' } });
  assert.match(prompt.result.messages[0].content.text, /smoke/);
  const diag = await mcpRequest(baseUrl, 7, 'resources/read', { uri: 'external-mcp://_diagnostics/status' });
  const data = JSON.parse(diag.result.contents[0].text);
  assert.equal(data.upstreams.fake.available, true);
  assert.equal(data.upstreams.failed_optional.available, false);
});

await withServer('safe', async ({ baseUrl }) => {
  await initialize(baseUrl);
  const tools = await listTools(baseUrl);
  assert.ok(tools.has('fake_read_context'));
  assert.ok(tools.has('fake_write_context'));
  assert.ok(tools.has('fake_push_context'));
  assert.ok(tools.has('fake_unknown_context'));
  const call = await mcpRequest(baseUrl, 8, 'tools/call', { name: 'fake_unknown_context', arguments: {} });
  assert.ok(call.result);
});

console.log(JSON.stringify({ ok: true, checked: 'dynamic external MCP upstream smoke' }, null, 2));
