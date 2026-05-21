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

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-release-'));
  await shell('git init; git config user.email test@example.com; git config user.name Tester', root);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test tests' } }));
  await fs.writeFile(path.join(root, 'README.md'), 'readme\n');
  await fs.writeFile(path.join(root, 'SECURITY.md'), 'security\n');
  await fs.writeFile(path.join(root, 'TODO.md'), 'todo\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.env\nlogs/\nnode_modules/\n');
  await fs.writeFile(path.join(root, 'tests', 'ok.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n");
  await shell('git add .; git commit -m init', root);
  return { root, context: { resolvedRepoRoots: [root], resolvedRepoRoot: root, executeDirectShell: shell } };
}

test('custom_release_review passes on clean fixture repo', async () => {
  const { root, context } = await fixture();
  const out = parse(await callCustomTool('release_review', { path: root }, context));
  assert.equal(out.ok, true);
  assert.equal(out.data.ready, true);
});

test('custom_release_review fails if .env is tracked', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, '.env'), 'MCP_BEARER_TOKEN=abc\n');
  await shell('git add -f .env; git commit -m env', root);
  const out = parse(await callCustomTool('release_review', { path: root, runTests: false, scanSecrets: false }, context));
  assert.equal(out.data.ready, false);
  assert.equal(out.data.blockers.some(item => item.includes('.env')), true);
});

test('custom_release_review fails on secret scan and failing tests', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, 'secret.txt'), 'ghp_1234567890abcdefghijklmnop\n');
  await fs.writeFile(path.join(root, 'tests', 'bad.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('bad', () => assert.equal(1, 2));\n");
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test tests/bad.test.mjs' } }));
  const originalShell = context.executeDirectShell;
  context.executeDirectShell = async (command, options) => {
    if (command === 'npm test') return { stdout: '# fail 1\n', stderr: '' };
    return originalShell(command, options);
  };
  const out = parse(await callCustomTool('release_review', { path: root }, context));
  assert.equal(out.data.ready, false);
  assert.equal(out.data.blockers.some(item => item.includes('Secret scan')), true);
  assert.equal(out.data.blockers.some(item => item.includes('Tests failed')), true);
});

test('custom_release_review warns or blocks on dirty git depending on requireCleanGit', async () => {
  const { root, context } = await fixture();
  await fs.writeFile(path.join(root, 'dirty.txt'), 'dirty\n');
  let out = parse(await callCustomTool('release_review', { path: root, runTests: false, scanSecrets: false }, context));
  assert.equal(out.data.ready, true);
  assert.equal(out.data.warnings.some(item => item.includes('Git working tree')), true);
  out = parse(await callCustomTool('release_review', { path: root, runTests: false, scanSecrets: false, requireCleanGit: true }, context));
  assert.equal(out.data.ready, false);
});

test('custom_release_review respects checkPackage and checkDocs flags', async () => {
  const { root, context } = await fixture();
  await fs.rm(path.join(root, 'package.json'));
  await fs.rm(path.join(root, 'README.md'));
  await fs.rm(path.join(root, 'SECURITY.md'));
  await fs.rm(path.join(root, 'TODO.md'));

  let out = parse(await callCustomTool('release_review', {
    path: root,
    runTests: false,
    scanSecrets: false,
    checkPackage: false,
    checkDocs: false
  }, context));
  assert.equal(out.data.ready, true);
  assert.equal(out.data.checks.some(check => check.name === 'package_json'), false);
  assert.equal(out.data.checks.some(check => check.name === 'readme'), false);
  assert.equal(out.data.checks.some(check => check.name === 'security'), false);
  assert.equal(out.data.checks.some(check => check.name === 'plan_or_todo'), false);

  out = parse(await callCustomTool('release_review', {
    path: root,
    runTests: false,
    scanSecrets: false,
    checkPackage: true,
    checkDocs: true
  }, context));
  assert.equal(out.data.ready, false);
  assert.equal(out.data.blockers.some(item => item.includes('package.json')), true);
  assert.equal(out.data.blockers.some(item => item.includes('README')), true);
  assert.equal(out.data.blockers.some(item => item.includes('SECURITY')), true);
});
