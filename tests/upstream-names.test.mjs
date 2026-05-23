import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCapabilityName, toExternalPromptName, toExternalToolName, validateUpstreamId } from '../scripts/upstreams/names.mjs';

test('validates upstream ids and prefixes', () => {
  assert.equal(validateUpstreamId('codegraph_1'), 'codegraph_1');
  assert.throws(() => validateUpstreamId('CodeGraph'), /Invalid/);
  assert.throws(() => validateUpstreamId('../x'), /Invalid/);
});

test('normalizes capability names', () => {
  assert.equal(normalizeCapabilityName('repo.summary'), 'repo_summary');
  assert.equal(normalizeCapabilityName('search/symbols'), 'search_symbols');
  assert.equal(toExternalToolName('gitnexus', 'repo.summary'), 'custom_gitnexus_repo_summary');
  assert.equal(toExternalPromptName('gitnexus', 'explain-history'), 'external_gitnexus_explain_history');
});
