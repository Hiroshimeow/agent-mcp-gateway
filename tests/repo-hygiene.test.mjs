import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('trusted roots local config and package artifacts are ignored', () => {
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^config\/trusted-roots\.txt$/m);
  assert.match(gitignore, /^packages\/$/m);
});

test('.env.example does not enable a local trusted roots file by default', () => {
  const envExample = read('.env.example');
  assert.match(envExample, /^MCP_TRUSTED_ROOTS_FILE=$/m);
  assert.match(envExample, /^# MCP_TRUSTED_ROOTS_FILE=config\\trusted-roots\.txt$/m);
});

test('trusted-roots.example.txt contains placeholders only', () => {
  const example = read('config/trusted-roots.example.txt');
  assert.match(example, /One trusted root per line/);
  assert.match(example, /Do not commit config\\trusted-roots\.txt/);
  assert.doesNotMatch(example, /^[A-Z]:\\(?!path\\to\\project|work\\another-project)/m);
});
