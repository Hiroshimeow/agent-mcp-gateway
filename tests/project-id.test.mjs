import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  assertValidProjectId,
  generateProjectIdForRoot,
  isValidProjectId,
  normalizeProjectId,
  slugifyProjectId
} from '../scripts/projects/project-id.mjs';

test('normalizeProjectId trims without changing case', () => {
  assert.equal(normalizeProjectId('  example-app  '), 'example-app');
  assert.equal(normalizeProjectId('ExampleApp'), 'ExampleApp');
});

test('slugifyProjectId converts folder names to stable lowercase ids', () => {
  assert.equal(slugifyProjectId('Example App'), 'example-app');
  assert.equal(slugifyProjectId('Sample Downloader'), 'sample-downloader');
  assert.equal(slugifyProjectId(' gateway_core.service '), 'gateway_core.service');
});

test('assertValidProjectId accepts planned id format', () => {
  assert.equal(assertValidProjectId('example-app'), 'example-app');
  assert.equal(assertValidProjectId('deer-flow'), 'deer-flow');
  assert.equal(assertValidProjectId('sample_downloader.1'), 'sample_downloader.1');
});

test('assertValidProjectId rejects empty uppercase spaces and path-like ids', () => {
  for (const value of ['', 'ExampleRepo', 'example repo', '../example', 'C:\\workspace\\example', 'example/repo']) {
    assert.throws(() => assertValidProjectId(value), { code: 'INVALID_PROJECT_ID' });
    assert.equal(isValidProjectId(value), false);
  }
});

test('generateProjectIdForRoot uses final folder name for legacy path-only roots', () => {
  const root = path.join(path.parse(process.cwd()).root, 'client-a', 'Example App');
  assert.equal(generateProjectIdForRoot(root), 'example-app');
});

test('generateProjectIdForRoot handles collisions with parent folder then hash fallback', () => {
  const root = path.join(path.parse(process.cwd()).root, 'client-a', 'frontend');
  assert.equal(generateProjectIdForRoot(root, new Set(['frontend'])), 'client-a-frontend');

  const fallback = generateProjectIdForRoot(root, new Set(['frontend', 'client-a-frontend']));
  assert.match(fallback, /^client-a-frontend-[a-f0-9]{8}$/);
  assert.ok(fallback.length <= 64);
});
