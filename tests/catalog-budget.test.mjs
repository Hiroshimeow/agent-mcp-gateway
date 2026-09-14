import test from 'node:test';
import assert from 'node:assert/strict';

import {
  catalogToolBytes,
  classifyExternalToolLane,
  selectExternalCatalog
} from '../scripts/catalog-budget.mjs';

function tool(name, serverId, annotations) {
  return {
    name,
    description: `Tool ${name} – 日本語`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
    ...(annotations ? { annotations } : {}),
    _meta: { upstream: { upstreamId: serverId, source: 'external-mcp' } }
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function cfg(overrides = {}) {
  return {
    exposure_mode: 'hybrid',
    eager_schema_budget_bytes: 1_000_000,
    eager_allowlist: [],
    ...overrides
  };
}

test('catalogToolBytes measures exact serialized UTF-8 bytes', () => {
  const item = tool('alpha_read', 'alpha', READ_ONLY);
  assert.equal(catalogToolBytes(item), Buffer.byteLength(JSON.stringify(item), 'utf8'));
  assert.notEqual(catalogToolBytes(item), JSON.stringify(item).length);
});

test('missing or incomplete risk annotations use the conservative write lane', () => {
  assert.equal(classifyExternalToolLane(tool('read', 'alpha', READ_ONLY)), 'read');
  assert.equal(classifyExternalToolLane(tool('write', 'alpha', WRITE)), 'write');
  assert.equal(classifyExternalToolLane(tool('unknown', 'alpha')), 'write');
  assert.equal(classifyExternalToolLane(tool('partial', 'alpha', { readOnlyHint: true })), 'write');
});

test('hybrid selects allowlist first then fully annotated read-only tools by server order and name', () => {
  const items = [
    tool('beta_unknown', 'beta'),
    tool('alpha_read_b', 'alpha', READ_ONLY),
    tool('beta_write', 'beta', WRITE),
    tool('alpha_read_a', 'alpha', READ_ONLY)
  ];
  const required = catalogToolBytes(items[2]) + catalogToolBytes(items[3]);
  const selected = selectExternalCatalog(items, cfg({
    eager_allowlist: ['beta_write'],
    eager_schema_budget_bytes: required
  }), [{ id: 'alpha' }, { id: 'beta' }]);

  assert.deepEqual(selected.eagerTools.map(item => item.name), ['beta_write', 'alpha_read_a']);
  assert.deepEqual(selected.deferredTools.map(item => item.name).sort(), ['alpha_read_b', 'beta_unknown']);
  assert.equal(selected.diagnostics.eager.bytes, required);
  assert.deepEqual(selected.diagnostics, {
    mode: 'hybrid',
    budgetBytes: required,
    total: { count: 4, bytes: items.reduce((sum, item) => sum + catalogToolBytes(item), 0) },
    eager: { count: 2, bytes: required },
    deferred: {
      count: 2,
      bytes: catalogToolBytes(items[0]) + catalogToolBytes(items[1])
    }
  });
});

test('hybrid rejects unknown allowlist names and allowlists that cannot fit the byte budget', () => {
  const items = [tool('alpha_read', 'alpha', READ_ONLY)];
  assert.throws(
    () => selectExternalCatalog(items, cfg({ eager_allowlist: ['missing'] }), [{ id: 'alpha' }]),
    /allowlist.*missing|missing.*allowlist/i
  );
  assert.throws(
    () => selectExternalCatalog(items, cfg({ eager_allowlist: ['alpha_read'], eager_schema_budget_bytes: catalogToolBytes(items[0]) - 1 }), [{ id: 'alpha' }]),
    /budget/i
  );
});

test('direct exposes all tools while brokered exposes none without discarding cached tools', () => {
  const items = [tool('alpha_read', 'alpha', READ_ONLY), tool('beta_write', 'beta', WRITE)];
  const direct = selectExternalCatalog(items, cfg({ exposure_mode: 'direct', eager_schema_budget_bytes: 0 }), [{ id: 'alpha' }, { id: 'beta' }]);
  assert.deepEqual(direct.eagerTools, items);
  assert.deepEqual(direct.deferredTools, []);

  const brokered = selectExternalCatalog(items, cfg({ exposure_mode: 'brokered' }), [{ id: 'alpha' }, { id: 'beta' }]);
  assert.deepEqual(brokered.eagerTools, []);
  assert.deepEqual(brokered.deferredTools, items);
  assert.equal(brokered.diagnostics.total.count, 2);
  assert.equal(brokered.diagnostics.eager.count, 0);
  assert.equal(brokered.diagnostics.deferred.count, 2);
});
