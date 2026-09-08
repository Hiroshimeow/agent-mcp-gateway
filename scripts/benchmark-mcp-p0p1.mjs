import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildNodeOutputCommand } from './benchmark-command.mjs';

const root = process.cwd();
const credential = `benchmark_mcp_${process.pid}`;
const warmup = Number(process.env.MCP_BENCH_WARMUP || 1);
const iterations = Number(process.env.MCP_BENCH_ITERATIONS || 10);
const outputArg = process.argv.indexOf('--output');
const outputPath = outputArg >= 0 ? path.resolve(process.argv[outputArg + 1]) : '';

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function summarize(samples) {
  const meanMs = samples.reduce((sum, sample) => sum + sample.durationMs, 0) / samples.length;
  return {
    iterations: samples.length,
    wireBytes: Math.round(samples.reduce((sum, sample) => sum + sample.wireBytes, 0) / samples.length),
    latencyMs: {
      mean: Number(meanMs.toFixed(3)),
      p50: Number(percentile(samples.map(sample => sample.durationMs), 0.5).toFixed(3)),
      p95: Number(percentile(samples.map(sample => sample.durationMs), 0.95).toFixed(3))
    },
    callsPerSecond: Number((1000 / meanMs).toFixed(2))
  };
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  if (!dataLines.length) throw new Error(`Unexpected MCP response: ${trimmed.slice(0, 500)}`);
  return JSON.parse(dataLines.join('\n'));
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('wrapper exited before health check');
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for benchmark wrapper');
}

async function mcpRequest(baseUrl, id, method, params = {}) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const body = Buffer.from(await response.arrayBuffer());
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body.toString('utf8', 0, 500)}`);
  return { parsed: parseMcpResponse(body.toString('utf8')), wireBytes: body.length, durationMs };
}

function initializeParams() {
  return {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'mcp-p0p1-benchmark', version: '1.0.0' }
  };
}

async function bench(label, fn) {
  for (let index = 0; index < warmup; index += 1) await fn();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) samples.push(await fn());
  return [label, summarize(samples)];
}

const port = await findFreePort();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-p0p1-benchmark-'));
const configPath = path.join(workspace, 'mcp-servers.toml');
fs.writeFileSync(configPath, `
[server]
name = "mcp-p0p1-benchmark"
title = "MCP P0/P1 Benchmark"
description = "Deterministic benchmark instance."
instructions = "Benchmark only."

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
  MCP_BEARER_TOKEN: credential,
  MCP_AUTH_PASSWORD: `benchmark_password_${process.pid}`,
  MCP_RUNTIME_PROFILE: 'yolo',
  ENABLE_FILESYSTEM: 'true',
  ENABLE_SHELL: 'true',
  MCP_STATEFUL_SESSIONS: 'false',
  MCP_RUNTIME_DIR: path.join(workspace, '.runtime'),
  MCP_METRICS_ENABLED: process.env.MCP_METRICS_ENABLED || 'false'
};

const child = spawn(process.execPath, ['scripts/authenticated-mcp-wrapper.mjs'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let logs = '';
child.stdout.on('data', chunk => { logs = `${logs}${chunk}`.slice(-12000); });
child.stderr.on('data', chunk => { logs = `${logs}${chunk}`.slice(-12000); });
const baseUrl = `http://127.0.0.1:${port}`;
let nextId = 1;

try {
  await waitForHealth(baseUrl, child);

  // Prime the stable static-bearer caller once so shell_execute is unblocked for all measured calls.
  const bootstrap = await mcpRequest(baseUrl, nextId++, 'tools/call', { name: 'get_skill', arguments: { name: 'local_coding' } });
  assert.ok(bootstrap.parsed?.result && !bootstrap.parsed.result.isError);

  const measurements = {};
  for (const [label, fn] of [
    ['initialize', () => mcpRequest(baseUrl, nextId++, 'initialize', initializeParams())],
    ['toolsList', () => mcpRequest(baseUrl, nextId++, 'tools/list', {})],
    ['getSkillDiscovery', () => mcpRequest(baseUrl, nextId++, 'tools/call', { name: 'get_skill', arguments: {} })],
    ['getSkillNamed', () => mcpRequest(baseUrl, nextId++, 'tools/call', { name: 'get_skill', arguments: { name: 'local_coding' } })]
  ]) {
    const [, summary] = await bench(label, fn);
    measurements[label] = summary;
  }

  const shellSizes = String(process.env.MCP_BENCH_SHELL_SIZES || '1024,65536,262144,1048576,4194304')
    .split(',').map(Number).filter(value => Number.isFinite(value) && value > 0);
  const shell = {};
  const spillChecks = {};
  for (const bytes of shellSizes) {
    const key = String(bytes);
    const [, summary] = await bench(`shell-${key}`, () => mcpRequest(baseUrl, nextId++, 'tools/call', {
      name: 'shell_execute',
      arguments: { command: buildNodeOutputCommand(bytes), working_directory: workspace }
    }));
    shell[key] = summary;

    const sample = await mcpRequest(baseUrl, nextId++, 'tools/call', {
      name: 'shell_execute',
      arguments: { command: buildNodeOutputCommand(bytes), working_directory: workspace }
    });
    const payload = JSON.parse(sample.parsed.result.content[0].text);
    const observedStdoutBytes = payload.stdoutTruncated ? payload.stdoutBytes : Buffer.byteLength(payload.stdout || '', 'utf8');
    assert.equal(observedStdoutBytes, bytes);
    assert.equal(payload.exitCode, 0);
    if (payload.stdoutSpillPath) {
      const raw = fs.readFileSync(payload.stdoutSpillPath);
      spillChecks[key] = {
        path: payload.stdoutSpillPath,
        bytes: raw.length,
        exact: raw.length === bytes && raw.every(byte => byte === 120)
      };
      assert.equal(spillChecks[key].exact, true);
    } else {
      spillChecks[key] = { path: null, bytes: 0, exact: payload.stdout === 'x'.repeat(bytes) };
      assert.equal(spillChecks[key].exact, true);
    }
  }

  const workflowCalls = [];
  const workflow = async (method, params) => {
    const result = await mcpRequest(baseUrl, nextId++, method, params);
    workflowCalls.push(result);
    return result;
  };
  await workflow('initialize', initializeParams());
  await workflow('tools/list', {});
  await workflow('tools/call', { name: 'get_skill', arguments: { name: 'local_coding' } });
  await workflow('tools/call', { name: 'shell_execute', arguments: { command: buildNodeOutputCommand(1024), working_directory: workspace } });

  const result = {
    schemaVersion: 1,
    commit: process.env.BENCH_COMMIT || '',
    platform: process.platform,
    node: process.version,
    warmup,
    iterations,
    measurements,
    shell,
    spillChecks,
    workflowReplay: {
      totalMcpCalls: workflowCalls.length,
      totalWireBytes: workflowCalls.reduce((sum, call) => sum + call.wireBytes, 0),
      rereadCalls: 0
    }
  };

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, 'utf8');
  }
  process.stdout.write(json);
} catch (error) {
  error.message += `\n--- wrapper logs ---\n${logs}`;
  throw error;
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(workspace, { recursive: true, force: true });
}
