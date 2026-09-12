import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const smokeCredential = `placeholder_mcp_smoke_${process.pid}`;
const observedProfiles = {};
const observedResponseBudgets = {};

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
  assert.match(response.result.instructions || '', /routing policy/i);
  assert.match(response.result.instructions || '', /do not probe shell_execute first/i);
  return response;
}

async function listTools(baseUrl) {
  return (await mcpRequest(baseUrl, 2, 'tools/list', {})).result.tools || [];
}

async function callTool(baseUrl, id, name, args = {}, extraHeaders = {}) {
  return await mcpRequest(baseUrl, id, 'tools/call', { name, arguments: args }, extraHeaders);
}

function names(tools) {
  return tools.map(tool => tool.name).sort();
}

function portablePath(value) {
  return path.resolve(value).replaceAll('\\', '/');
}

function nodeByteOutputCommand(bytes, value = 120) {
  const executable = `'${process.execPath.replaceAll("'", "''")}'`;
  const script = `'process.stdout.write(Buffer.alloc(${bytes}, ${value}))'`;
  return process.platform === 'win32' ? `& ${executable} -e ${script}` : `${executable} -e ${script}`;
}

function nodeOutputCommand(bytes) {
  return nodeByteOutputCommand(bytes);
}

function nodeSleepCommand(ms) {
  const executable = `'${process.execPath.replaceAll("'", "''")}'`;
  const script = `'setTimeout(() => {}, ${ms})'`;
  return process.platform === 'win32' ? `& ${executable} -e ${script}` : `${executable} -e ${script}`;
}


await withServer('yolo', async ({ baseUrl, workspace, configPath, runtimeDirectory }) => {
  const baseConfig = fs.readFileSync(configPath, 'utf8');
  await initialize(baseUrl);
  const tools = await listTools(baseUrl);
  assert.deepEqual(names(tools), [
    'edit_file',
    'get_skill',
    'image_preview',
    'interact_with_process',
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
  const editInputSchema = tools.find(tool => tool.name === 'edit_file')?.inputSchema;
  assert.equal(editInputSchema?.properties?.expected_replacements?.default, 1);
  assert.equal(editInputSchema?.properties?.old_text?.minLength, 1);
  assert.ok(editInputSchema?.anyOf?.some(entry => entry.required?.includes('edits')));
  assert.ok(editInputSchema?.anyOf?.some(entry => entry.required?.includes('old_text') && entry.required?.includes('new_text')));
  const shellOutputSchema = tools.find(tool => tool.name === 'shell_execute')?.outputSchema;
  assert.equal(shellOutputSchema?.type, 'object');
  const shellInputSchema = tools.find(tool => tool.name === 'shell_execute')?.inputSchema;
  assert.equal(shellInputSchema?.properties?.timeout_ms?.maximum, 300000);
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
    'returnedStdoutBytes',
    'returnedStderrBytes',
    'stdoutHeadBytes',
    'stdoutTailBytes',
    'stderrHeadBytes',
    'stderrTailBytes',
    'encoding'
  ]) assert.equal(shellOutputSchema?.properties?.[redundantField], undefined);

  const target = path.join(workspace, 'smoke.txt');
  fs.writeFileSync(target, 'context', 'utf8');

  const firstRead = await callTool(baseUrl, 3, 'read_text_file', { path: target }, { 'mcp-session-id': 'stale-a' });
  assert.equal(firstRead.result.content[0].text, 'context');
  assert.equal(firstRead.result.content[0].text, 'context');
  assert.ok(firstRead.result.content.some(item => item.type === 'text' && /Skill hint.*get_skill/i.test(item.text)));

  const secondRead = await callTool(baseUrl, 4, 'read_text_file', { path: target }, { 'mcp-session-id': 'stale-b' });
  assert.equal(secondRead.result.content.length, 1);

  const firstWrite = await callTool(baseUrl, 5, 'write_file', { path: target, content: 'first' });
  assert.notEqual(firstWrite.result.isError, true);

  const invalidSkill = await callTool(baseUrl, 6, 'get_skill', { name: 'missing-smoke-skill' });
  assert.match(invalidSkill.error?.message || '', /Unknown skill/i);

  const directEdit = await callTool(baseUrl, 7, 'edit_file', {
    path: target,
    edits: [{ oldText: 'first', newText: 'edited' }],
    dryRun: false
  });
  assert.notEqual(directEdit.result.isError, true);

  const directShell = await callTool(baseUrl, 8, 'shell_execute', {
    command: nodeOutputCommand(2),
    working_directory: workspace
  });
  assert.notEqual(directShell.result.isError, true);
  assert.equal(JSON.parse(directShell.result.content[0].text).stdout, 'xx');

  const timedShell = await callTool(baseUrl, 17, 'shell_execute', {
    command: nodeSleepCommand(2000),
    working_directory: workspace,
    timeout_ms: 100
  });
  const timedPayload = JSON.parse(timedShell.result.content[0].text);
  assert.equal(timedPayload.timedOut, true);
  assert.equal(timedPayload.exitCode, 124);

  const shortProcess = await callTool(baseUrl, 18, 'start_process', {
    command: nodeOutputCommand(4),
    working_directory: workspace,
    timeout_ms: 5000
  });
  const shortProcessPayload = JSON.parse(shortProcess.result.content[0].text);
  assert.equal(shortProcessPayload.status, 'COMPLETED');
  assert.equal(shortProcessPayload.output, 'xxxx');

  const longProcess = await callTool(baseUrl, 19, 'start_process', {
    command: nodeSleepCommand(600),
    working_directory: workspace,
    timeout_ms: 50
  });
  const longProcessPayload = JSON.parse(longProcess.result.content[0].text);
  assert.equal(longProcessPayload.status, 'RUNNING');
  let completedProcessPayload = longProcessPayload;
  const processDeadline = Date.now() + 5000;
  while (completedProcessPayload.status === 'RUNNING' && Date.now() < processDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const completedProcess = await callTool(baseUrl, 30, 'read_process_output', {
      session_id: longProcessPayload.sessionId,
      offset: 0,
      length: 128
    });
    completedProcessPayload = JSON.parse(completedProcess.result.content[0].text);
  }
  assert.equal(completedProcessPayload.status, 'COMPLETED');

  const interactiveScript = path.join(workspace, 'interactive-smoke.js');
  fs.writeFileSync(interactiveScript, 'process.stdin.once(\"data\",d=>{process.stdout.write(\"got:\"+d.toString().trim());process.exit(0)});setTimeout(()=>{},5000);', 'utf8');
  const interactiveCommand = process.platform === 'win32'
    ? `& '${process.execPath.replaceAll("'", "''")}' '${interactiveScript.replaceAll("'", "''")}'`
    : `'${process.execPath.replaceAll("'", "'\"'\"'")}' '${interactiveScript.replaceAll("'", "'\"'\"'")}'`;
  const interactiveProcess = await callTool(baseUrl, 36, 'start_process', {
    command: interactiveCommand,
    working_directory: workspace,
    timeout_ms: 50
  });
  const interactivePayload = JSON.parse(interactiveProcess.result.content[0].text);
  assert.equal(interactivePayload.status, 'RUNNING');
  const interacted = await callTool(baseUrl, 37, 'interact_with_process', {
    session_id: interactivePayload.sessionId,
    input: 'hello\n',
    timeout_ms: 3000
  });
  const interactedPayload = JSON.parse(interacted.result.content[0].text);
  assert.equal(interactedPayload.status, 'COMPLETED');
  assert.match(interactedPayload.output, /got:hello/);

  const bootstrap = await callTool(baseUrl, 9, 'get_skill', { name: 'local_coding' });
  assert.notEqual(bootstrap.result.isError, true);
  const bootstrapPayload = JSON.parse(bootstrap.result.content[0].text);
  assert.equal(bootstrapPayload.data.name, 'local_coding');
  assert.equal(bootstrapPayload.data.skillCatalog, undefined);
  assert.deepEqual(bootstrap.result.structuredContent, bootstrapPayload);

  await callTool(baseUrl, 10, 'write_file', { path: target, content: 'first' });
  await callTool(baseUrl, 11, 'edit_file', {
    path: target,
    edits: [{ oldText: 'first', newText: 'second' }],
    dryRun: false
  });
  const read = await callTool(baseUrl, 12, 'read_text_file', { path: target });
  assert.equal(read.result.content[0].text, 'second');
  assert.equal(read.result.content.length, 1);

  await callTool(baseUrl, 14, 'write_file', { path: target, content: 'alpha\r\nbeta\r\n' });
  const guardedMismatch = await callTool(baseUrl, 15, 'edit_file', {
    path: target,
    old_text: 'beta',
    new_text: 'gamma',
    expected_replacements: 2
  });
  const mismatchPayload = JSON.parse(guardedMismatch.result.content[0].text);
  assert.equal(mismatchPayload.code, 'EXPECTED_REPLACEMENTS_MISMATCH');
  assert.equal(mismatchPayload.actualCount, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\r\nbeta\r\n');

  const guardedEdit = await callTool(baseUrl, 16, 'edit_file', {
    path: target,
    old_text: 'beta',
    new_text: 'gamma',
    expected_replacements: 1
  });
  const guardedPayload = JSON.parse(guardedEdit.result.content[0].text);
  assert.equal(guardedPayload.ok, true);
  assert.equal(guardedPayload.actualCount, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\r\ngamma\r\n');

  const discovery = await callTool(baseUrl, 13, 'get_skill', {});
  const discoveryPayload = JSON.parse(discovery.result.content[0].text);
  assert.equal(discoveryPayload.data.mode, 'discovery');
  assert.equal(discoveryPayload.data.body, undefined);
  assert.deepEqual(discovery.result.structuredContent, discoveryPayload);

  const concurrentRoots = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-dynamic-root-a-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-dynamic-root-b-'))
  ];
  await Promise.all(concurrentRoots.map(async (dynamicRoot, index) => {
    const dynamicTarget = path.join(dynamicRoot, `auto-trusted-${index}.txt`);
    const write = await callTool(baseUrl, 20 + index * 2, 'write_file', { path: dynamicTarget, content: `auto-trusted-${index}` });
    assert.notEqual(write.result?.isError, true);
    const dynamicRead = await callTool(baseUrl, 21 + index * 2, 'read_text_file', { path: dynamicTarget });
    assert.equal(dynamicRead.result.content[0].text, `auto-trusted-${index}`);
  }));
  const persistedConfig = fs.readFileSync(configPath, 'utf8');
  assert.equal(persistedConfig, baseConfig);
  const runtimeRoots = fs.readFileSync(path.join(runtimeDirectory, 'trusted-roots.toml'), 'utf8');
  for (const dynamicRoot of concurrentRoots) assert.ok(runtimeRoots.includes(portablePath(dynamicRoot)));

  const shellDynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-shell-root-'));
  const shellPathCommand = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd';
  const shellPath = await callTool(baseUrl, 30, 'shell_execute', {
    command: shellPathCommand,
    working_directory: shellDynamicRoot
  });
  const shellPathData = JSON.parse(shellPath.result.content[0].text);
  assert.equal(shellPathData.exitCode, 0);
  assert.equal(path.resolve(shellPathData.workingDirectoryResolved), path.resolve(shellDynamicRoot));
  assert.deepEqual(shellPath.result.structuredContent, shellPathData);
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseConfig);
  assert.ok(fs.readFileSync(path.join(runtimeDirectory, 'trusted-roots.toml'), 'utf8').includes(portablePath(shellDynamicRoot)));

  const command = process.platform === 'win32'
    ? "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Write-Output 'Tiếng Việt 日本語'; [Console]::Error.WriteLine('warning')"
    : "printf 'Tiếng Việt 日本語\\n'; printf 'warning\\n' >&2";
  const shell = await callTool(baseUrl, 31, 'shell_execute', { command, working_directory: workspace });
  const shellData = JSON.parse(shell.result.content[0].text);
  assert.equal(shellData.exitCode, 0);
  assert.match(shellData.stdout, /Tiếng Việt 日本語/);
  assert.match(shellData.stderr, /warning/);
  assert.equal(shellData.stderrClassification, 'warning');
  assert.equal(shellData.stdoutTruncated, false);
  assert.equal(shellData.stderrTruncated, false);
  assert.equal('command' in shellData, false);
  assert.equal('encoding' in shellData, false);
  assert.equal('returnedStdoutBytes' in shellData, false);
  assert.equal('returnedStderrBytes' in shellData, false);
  assert.deepEqual(shell.result.structuredContent, shellData);

  const largeShell = await callTool(baseUrl, 32, 'shell_execute', {
    command: nodeOutputCommand(256 * 1024),
    working_directory: workspace
  });
  const largeShellData = JSON.parse(largeShell.result.content[0].text);
  assert.equal(largeShellData.stdoutBytes, 256 * 1024);
  assert.equal(largeShellData.stdoutTruncated, true);
  assert.ok(largeShellData.stdoutSpillPath.startsWith(runtimeDirectory));
  assert.deepEqual(largeShell.result.structuredContent, largeShellData);
  const spillRead = await callTool(baseUrl, 33, 'read_text_file', { path: largeShellData.stdoutSpillPath });
  assert.equal(spillRead.result.content[0].text.length, 256 * 1024);
  assert.match(spillRead.result.content[0].text, /^x+$/);

  const longComment = 'x'.repeat(process.platform === 'win32' ? 16 * 1024 : 70 * 1024);
  const longCommand = `# ${longComment}\n${nodeOutputCommand(2)}`;
  const longShell = await mcpRequestRaw(baseUrl, 34, 'tools/call', {
    name: 'shell_execute',
    arguments: { command: longCommand, working_directory: workspace }
  });
  const longShellData = JSON.parse(longShell.parsed.result.content[0].text);
  assert.equal(longShellData.exitCode, 0);
  assert.equal(longShellData.stdout, 'xx');
  assert.equal('command' in longShellData, false);
  assert.equal('commandBytes' in longShellData, false);
  assert.equal('commandTruncated' in longShellData, false);
  assert.ok(longShell.wireBytes <= 128 * 1024);
  observedResponseBudgets.longCommandWireBytes = longShell.wireBytes;
  assert.deepEqual(longShell.parsed.result.structuredContent, longShellData);

  let compositeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-smoke-budget-cwd-'));
  const depth = process.platform === 'win32' ? 1 : 17;
  const componentBytes = process.platform === 'win32' ? 120 : 190;
  for (let index = 0; index < depth; index += 1) {
    compositeCwd = path.join(compositeCwd, `${index}-${'d'.repeat(componentBytes)}`);
    fs.mkdirSync(compositeCwd);
  }
  const compositeCommand = `#${'\u0001'.repeat(900)}\n${nodeByteOutputCommand(64 * 1024, 0)}`;
  const compositeShell = await mcpRequestRaw(baseUrl, 35, 'tools/call', {
    name: 'shell_execute',
    arguments: { command: compositeCommand, working_directory: compositeCwd }
  });
  const compositeShellData = JSON.parse(compositeShell.parsed.result.content[0].text);
  assert.equal(compositeShellData.exitCode, 0);
  assert.equal(compositeShellData.stdoutBytes, 64 * 1024);
  assert.equal(compositeShellData.stdoutTruncated, true);
  assert.ok(compositeShell.wireBytes <= 128 * 1024);
  observedResponseBudgets.compositeWireBytes = compositeShell.wireBytes;
  assert.deepEqual(compositeShell.parsed.result.structuredContent, compositeShellData);

  const metricsText = fs.readFileSync(path.join(runtimeDirectory, 'mcp-calls.ndjson'), 'utf8');
  const metrics = metricsText.trim().split('\n').map(JSON.parse);
  assert.ok(metrics.some(metric => metric.tool === 'shell_execute' && metric.truncated && metric.spill));
  assert.ok(metrics.every(metric => metric.callerCategory === 'static-bearer'));
  assert.doesNotMatch(metricsText, /process\.stdout\.write|Tiếng Việt|warning/);
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
  checked: 'exact core catalog, progressive skill advisory, profile filtering, concurrent path grants, filesystem calls, structured UTF-8 shell output, and final serialized shell response budgets',
  observedProfiles,
  observedResponseBudgets
}, null, 2));
