import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveSafeFile } from '../scripts/skill-source-safety.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('resolveSafeFile accepts a regular file contained by the declared root', () => {
  const root = tempDir('skill-source-safe-');
  fs.mkdirSync(path.join(root, 'docs'));
  const file = path.join(root, 'docs', 'guide.md');
  fs.writeFileSync(file, '# Guide\n');

  assert.equal(
    resolveSafeFile(root, 'docs/guide.md', 'guide'),
    fs.realpathSync(file)
  );
});

test('resolveSafeFile rejects lexical traversal outside the declared root', () => {
  const root = tempDir('skill-source-traversal-root-');
  const outsideRoot = tempDir('skill-source-traversal-outside-');
  const outside = path.join(outsideRoot, 'outside.txt');
  fs.writeFileSync(outside, 'outside');

  assert.throws(
    () => resolveSafeFile(root, path.relative(root, outside), 'outside file'),
    /Unsafe outside file path/
  );
});

test('resolveSafeFile enforces regular-file, size, and extension guards', () => {
  const root = tempDir('skill-source-guards-');
  fs.mkdirSync(path.join(root, 'directory'));
  fs.writeFileSync(path.join(root, 'large.md'), '12345');
  fs.writeFileSync(path.join(root, 'font.woff2'), 'font');

  assert.throws(
    () => resolveSafeFile(root, 'directory', 'directory'),
    /Expected file/
  );
  assert.throws(
    () => resolveSafeFile(root, 'large.md', 'large file', { maxFileBytes: 4 }),
    /exceeds 4 bytes/
  );
  assert.throws(
    () => resolveSafeFile(root, 'font.woff2', 'font file', { forbiddenExtensions: new Set(['.woff2']) }),
    /Font files are not vendored/
  );
});

test('resolveSafeFile rejects a symlinked ancestor that escapes the declared root', t => {
  const root = tempDir('skill-source-link-root-');
  const outside = tempDir('skill-source-link-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const link = path.join(root, 'linked');

  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('Creating filesystem links is not permitted on this host.');
      return;
    }
    throw error;
  }

  assert.throws(
    () => resolveSafeFile(root, 'linked/secret.txt', 'linked file'),
    /Symlink is not allowed/
  );
});
