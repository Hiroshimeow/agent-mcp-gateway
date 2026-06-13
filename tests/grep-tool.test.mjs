import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { callCustomTool } from '../scripts/custom-tools/index.mjs';

function parse(result) {
  return JSON.parse(result.content.find(entry => entry.type === 'text').text);
}

async function hasRipgrep() {
  return await new Promise(resolve => {
    const child = spawn('rg', ['--version'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-grep-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'src', 'app.mjs'), 'const Token = process.env.MCP_BEARER_TOKEN;\nTODO here\n');
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.mjs'), 'process.env.MCP_BEARER_TOKEN');
  return { root, context: { resolvedRepoRoots: [root], resolvedRepoRoot: root } };
}

test('custom_grep finds plain text case-insensitively by default', async () => {
  const { context } = await fixture();
  const out = parse(await callCustomTool('grep', { query: 'token', include: ['**/*.mjs'] }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.matches.length, 1);
  assert.equal(out.data.matches[0].path, 'src/app.mjs');
});

test('custom_grep supports caseSensitive and regex modes', async () => {
  const { context } = await fixture();
  const sensitive = parse(await callCustomTool('grep', { query: 'token', caseSensitive: true }, context));
  assert.equal(sensitive.data.matches.length, 0);
  const regex = parse(await callCustomTool('grep', { query: 'process\\.env\\.[A-Z_]+', regex: true }, context));
  assert.equal(regex.data.matches.length, 1);
});

test('custom_grep excludes node_modules by default and reports pagination accurately', async () => {
  const { context } = await fixture();
  const out = parse(await callCustomTool('grep', { query: 'process.env', maxResults: 1 }, context));
  assert.equal(out.data.matches.length, 1);
  assert.equal(out.data.hasMore, false);
  assert.equal(out.data.truncated, false);
  assert.equal(out.data.matches.some(match => match.path.includes('node_modules')), false);
});

test('custom_grep ripgrep engine excludes node_modules', async t => {
  if (!await hasRipgrep()) {
    t.skip('ripgrep is not available');
    return;
  }
  const { context } = await fixture();
  const out = parse(await callCustomTool('grep', { query: 'process.env', maxResults: 10 }, context));
  assert.equal(out.data.engine, 'ripgrep');
  assert.equal(out.data.matches.some(match => match.path.includes('node_modules')), false);
});

test('custom_grep includes contextLines with the active engine', async () => {
  const { context } = await fixture();
  const out = parse(await callCustomTool('grep', { query: 'TODO', contextLines: 1 }, context));
  assert.equal(out.data.matches.length, 1);
  assert.ok(Array.isArray(out.data.matches[0].context));
  assert.ok(out.data.matches[0].context.some(line => line.includes('const Token')));
  assert.ok(out.data.matches[0].context.some(line => line.includes('TODO here')));
});


test('custom_grep rejects outside trusted root', async () => {
  const { context } = await fixture();
  const out = parse(await callCustomTool('grep', { path: '..', query: 'x' }, context));
  assert.equal(out.ok, false);
});
