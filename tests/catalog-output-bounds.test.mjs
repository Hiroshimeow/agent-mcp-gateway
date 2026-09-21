import test from 'node:test';
import assert from 'node:assert/strict';

import { createExternalToolBroker } from '../scripts/external-tool-broker.mjs';
import { RUNTIME_PROFILES } from '../scripts/runtime-profile.mjs';

test('external tool search reports truncation instead of silently clipping', () => {
  const tools = Array.from({ length: 60 }, (_, index) => ({
    name: `read_tool_${String(index).padStart(3, '0')}`,
    description: `Read synthetic item ${index}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { upstream: { upstreamId: 'synthetic', source: 'external-mcp' } }
  }));
  const broker = createExternalToolBroker({ getTools: () => tools, invokeTool: async () => ({}) });
  const first = broker.search({ limit: 20 }, RUNTIME_PROFILES.safe);
  assert.equal(first.items.length, 20);
  assert.equal(first.truncated, true);
  assert.equal(typeof first.nextCursor, 'string');

  const last = broker.search({ limit: 50, cursor: first.nextCursor }, RUNTIME_PROFILES.safe);
  assert.equal(last.items.length, 40);
  assert.equal(last.truncated, false);
  assert.equal(last.nextCursor, null);
});
