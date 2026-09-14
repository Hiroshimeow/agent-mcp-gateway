import test from 'node:test';
import assert from 'node:assert/strict';

import { paginateSkillDiscovery } from '../scripts/skills/index.mjs';
import { createExternalToolBroker } from '../scripts/external-tool-broker.mjs';
import { RUNTIME_PROFILES } from '../scripts/runtime-profile.mjs';

function syntheticSkills(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `skill_${String(index).padStart(4, '0')}`,
    description: `Synthetic skill ${index}.`,
    modelInvocable: true
  }));
}

test('skill discovery is paginated and reports truncation for a 1000-skill catalog', () => {
  const skills = syntheticSkills(1000).reverse();
  const first = paginateSkillDiscovery(skills, { limit: 25 });
  assert.equal(first.skillCatalog.length, 25);
  assert.equal(first.skillCatalog[0].name, 'skill_0000');
  assert.equal(first.truncated, true);
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal(first.total, 1000);

  const second = paginateSkillDiscovery(skills, { limit: 25, cursor: first.nextCursor });
  assert.equal(second.skillCatalog[0].name, 'skill_0025');
  assert.equal(second.truncated, true);
});

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
