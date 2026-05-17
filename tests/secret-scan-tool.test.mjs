import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { callCustomTool } from '../scripts/custom-tools/index.mjs';

function parse(result) {
  return JSON.parse(result.content.find(entry => entry.type === 'text').text);
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-secret-'));
  return { root, context: { resolvedRepoRoots: [root], resolvedRepoRoot: root } };
}

test('custom_secret_scan detects and redacts token-like values', async () => {
  const { root, context } = await fixture();
  const token = 'ghp_1234567890abcdefghijklmnop';
  await fs.writeFile(path.join(root, 'config.txt'), `TOKEN=${token}\n`);
  const out = parse(await callCustomTool('secret_scan', { path: root }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, false);
  assert.equal(out.data.counts.high >= 1, true);
  assert.equal(JSON.stringify(out).includes(token), false);
});

test('custom_secret_scan detects private key block', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, 'key.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
  const out = parse(await callCustomTool('secret_scan', { path: root }, context));
  assert.equal(out.data.findings.some(f => f.rule === 'private_key'), true);
});

test('custom_secret_scan ignores placeholders and default excluded logs', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, '.env.example'), 'MCP_AUTH_PASSWORD=changeme\n');
  await fs.mkdir(path.join(root, 'logs'));
  await fs.writeFile(path.join(root, 'logs', 'app.log'), 'ghp_1234567890abcdefghijklmnop\n');
  const out = parse(await callCustomTool('secret_scan', { path: root }, context));
  assert.equal(out.data.passed, true);
  assert.equal(out.data.findings.length, 0);
});

test('custom_secret_scan respects maxFindings', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, 'a.txt'), 'ghp_1234567890abcdefghijklmnop\nghp_2234567890abcdefghijklmnop\n');
  const out = parse(await callCustomTool('secret_scan', { path: root, maxFindings: 1 }, context));
  assert.equal(out.data.findings.length, 1);
  assert.equal(out.data.truncated, true);
});

test('custom_secret_scan ignores common placeholder values', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, '.env.example'), [
    'TOKEN=your-token-here',
    'API_KEY=replace-me',
    'SECRET=dummy',
    'PASSWORD=example-token',
    'MCP_BEARER_TOKEN=',
    ''
  ].join('\n'));
  const out = parse(await callCustomTool('secret_scan', { path: root }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, true);
  assert.equal(out.data.findings.length, 0);
});
