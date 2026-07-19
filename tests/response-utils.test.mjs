import test from 'node:test';
import assert from 'node:assert/strict';

import { fail, ok, parseToolResult, redactSecret, truncateText } from '../scripts/custom-tools/response-utils.mjs';

test('ok and fail return structured JSON text responses', () => {
  assert.deepEqual(parseToolResult(ok('grep', 'done', { count: 1 })), {
    ok: true,
    tool: 'grep',
    summary: 'done',
    data: { count: 1 }
  });
  assert.deepEqual(parseToolResult(fail('grep', 'VALIDATION_ERROR', 'bad', { field: 'query' })), {
    ok: false,
    tool: 'grep',
    error: { code: 'VALIDATION_ERROR', message: 'bad', details: { field: 'query' } }
  });
});

test('redactSecret never returns full long secret', () => {
  assert.equal(redactSecret('ghp_1234567890abcdef'), 'ghp_...cdef');
  assert.equal(redactSecret('short'), '****');
});

test('truncateText respects byte limits', () => {
  const result = truncateText('abcdef', 3);
  assert.equal(result.text, 'abc');
  assert.equal(result.truncated, true);
  assert.equal(truncateText('abc', 3).truncated, false);
});
