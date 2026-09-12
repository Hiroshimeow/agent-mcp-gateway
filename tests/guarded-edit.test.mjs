import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareGuardedEdit } from '../scripts/guarded-edit.mjs';

test('guarded edit refuses zero exact matches without mutation', () => {
  const result = prepareGuardedEdit('alpha\nbeta\n', {
    oldText: 'missing',
    newText: 'replacement',
    expectedReplacements: 1
  });

  assert.equal(result.ok, false);
  assert.equal(result.actualCount, 0);
  assert.equal(result.modifiedContent, null);
});

test('guarded edit replaces one exact match', () => {
  const result = prepareGuardedEdit('alpha\nbeta\n', {
    oldText: 'beta',
    newText: 'gamma',
    expectedReplacements: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.actualCount, 1);
  assert.equal(result.modifiedContent, 'alpha\ngamma\n');
});

test('guarded edit replaces exactly two original matches even when replacement contains search text', () => {
  const result = prepareGuardedEdit('x-x', {
    oldText: 'x',
    newText: 'xx',
    expectedReplacements: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.actualCount, 2);
  assert.equal(result.modifiedContent, 'xx-xx');
});

test('guarded edit preserves untouched CRLF line endings', () => {
  const result = prepareGuardedEdit('alpha\r\nbeta\r\n', {
    oldText: 'beta',
    newText: 'gamma',
    expectedReplacements: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.modifiedContent, 'alpha\r\ngamma\r\n');
});
