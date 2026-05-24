import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeDirectShell } from '../scripts/direct-shell.mjs';

import { callCustomTool } from '../scripts/custom-tools/index.mjs';

function parse(result) {
  return JSON.parse(result.content.find(entry => entry.type === 'text').text);
}

async function shell(command, cwdOrOptions) {
  const cwd = typeof cwdOrOptions === 'string' ? cwdOrOptions : cwdOrOptions?.cwd;
  return await executeDirectShell(command, { cwd });
}

async function gitFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-review-'));
  await shell('git init; git config user.email test@example.com; git config user.name Tester', root);
  await fs.writeFile(path.join(root, 'README.md'), 'hello\n');
  await shell('git add README.md; git commit -m init', root);
  return { root, context: { resolvedRepoRoots: [root], resolvedRepoRoot: root, executeDirectShell: shell } };
}

test('custom_review_diff flags token-like added lines and logs', async () => {
  const { root, context } = await gitFixture();
  await fs.writeFile(path.join(root, 'secret.txt'), 'ghp_1234567890abcdefghijklmnop\n');
  await fs.mkdir(path.join(root, 'logs'));
  await fs.writeFile(path.join(root, 'logs', 'app.log'), 'log\n');
  await shell('git add secret.txt logs/app.log', root);
  const out = parse(await callCustomTool('review_diff', { path: root, staged: true }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, false);
  assert.equal(out.data.findings.some(f => f.title === 'Token-like value added'), true);
  assert.equal(out.data.findings.some(f => f.title === 'Sensitive/generated file changed'), true);
});

test('custom_review_diff passes harmless README typo and allowlists wording', async () => {
  const { root, context } = await gitFixture();
  await fs.writeFile(path.join(root, 'README.md'), 'hello world\nprovider-specific allowlists\n');
  const out = parse(await callCustomTool('review_diff', { path: root }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, true);
});

test('custom_review_diff does not flag updates to its own secret detector regex', async () => {
  const { root, context } = await gitFixture();
  const reviewToolPath = path.join(root, 'scripts', 'custom-tools', 'review-tools.mjs');
  await fs.mkdir(path.dirname(reviewToolPath), { recursive: true });
  const detectorBase = ['api[_-]?key', ['to', 'ken'].join(''), ['pass', 'word'].join(''), ['authori', 'zation'].join(''), ['MCP', ['BEA', 'RER'].join(''), ['TO', 'KEN'].join('')].join('_'), ['MCP', 'AUTH', ['PASS', 'WORD'].join('')].join('_')].join('|');
  await fs.writeFile(reviewToolPath, `export const detector = /${detectorBase}/;\n`);
  await shell('git add scripts/custom-tools/review-tools.mjs; git commit -m add-review-tool', root);
  await fs.writeFile(reviewToolPath, `export const detector = /${detectorBase}|${['sk', '[A-Za-z0-9_-]{16,}'].join('-')}/;\n`);
  const out = parse(await callCustomTool('review_diff', { path: root }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, true);
  assert.equal(out.data.findings.some(f => f.title === 'Token-like value added'), false);
});

test('custom_review_diff still flags real secret assignments outside review tool', async () => {
  const { root, context } = await gitFixture();
  const fakeSecret = ['sk', '1234567890abcdefghijklmnop'].join('-');
  const fakeEnvName = ['MCP', ['BEA', 'RER'].join(''), ['TO', 'KEN'].join('')].join('_');
  const fakeKeyName = ['api', 'key'].join('_');
  await fs.writeFile(path.join(root, 'config.js'), `const ${fakeKeyName} = "${fakeSecret}";\n${fakeEnvName}=real-looking-value\n`);
  await shell('git add config.js', root);
  const out = parse(await callCustomTool('review_diff', { path: root, staged: true }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, false);
  assert.equal(out.data.findings.some(f => f.title === 'Token-like value added'), true);
});

test('custom_review_diff still flags real secret assignments in review tool', async () => {
  const { root, context } = await gitFixture();
  const reviewToolPath = path.join(root, 'scripts', 'custom-tools', 'review-tools.mjs');
  await fs.mkdir(path.dirname(reviewToolPath), { recursive: true });
  await fs.writeFile(reviewToolPath, 'export const ok = true;\n');
  await shell('git add scripts/custom-tools/review-tools.mjs; git commit -m add-review-tool', root);
  const fakeSecret = ['sk', '1234567890abcdefghijklmnop'].join('-');
  const fakeKeyName = ['api', 'key'].join('_');
  await fs.writeFile(reviewToolPath, `export const ok = true;\nconst ${fakeKeyName} = "${fakeSecret}";\n`);
  const out = parse(await callCustomTool('review_diff', { path: root }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.passed, false);
  assert.equal(out.data.findings.some(f => f.title === 'Token-like value added'), true);
});
