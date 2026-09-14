import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRemoteFilesystemResult } from '../scripts/remote-tool-result.mjs';

test('remote filesystem results gain structuredContent matching the stable output schema', () => {
  const result = normalizeRemoteFilesystemResult({
    content: [{ type: 'text', text: 'hello' }]
  });
  assert.deepEqual(result.structuredContent, { content: 'hello' });
  assert.equal(result.content[0].text, 'hello');
});

test('existing structuredContent is preserved', () => {
  const result = normalizeRemoteFilesystemResult({
    content: [{ type: 'text', text: 'display' }],
    structuredContent: { content: 'canonical' }
  });
  assert.deepEqual(result.structuredContent, { content: 'canonical' });
});
