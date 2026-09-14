import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { measureCatalogPayload, parseSyntheticCounts } from '../scripts/benchmark-mcp-catalog.mjs';

test('catalog benchmark measures exact UTF-8 JSON bytes', () => {
  const toolsPayload = {
    tools: [
      { name: 'core_read', description: 'đọc dữ liệu', inputSchema: { type: 'object', properties: {} } },
      { name: 'github_issue', description: 'Create issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }
    ]
  };
  const resourcesPayload = { resources: [{ uri: 'repo://project/a', name: 'A' }] };
  const templatesPayload = { resourceTemplates: [{ uriTemplate: 'repo://project/{id}', name: 'project' }] };
  const promptsPayload = { prompts: [{ name: 'review' }] };

  const report = measureCatalogPayload({
    toolsPayload,
    resourcesPayload,
    templatesPayload,
    promptsPayload,
    classifyTool: tool => tool.name.startsWith('github_') ? 'external' : 'core'
  });

  assert.equal(report.toolCount, 2);
  assert.equal(report.toolSchemaBytes, Buffer.byteLength(JSON.stringify(toolsPayload), 'utf8'));
  assert.equal(report.resourceCount, 1);
  assert.equal(report.resourceTemplateCount, 1);
  assert.equal(report.promptCount, 1);
  assert.equal(report.groups.core.count, 1);
  assert.equal(report.groups.external.count, 1);
  assert.equal(report.groups.core.bytes, Buffer.byteLength(JSON.stringify(toolsPayload.tools[0]), 'utf8'));
  assert.equal(report.groups.external.bytes, Buffer.byteLength(JSON.stringify(toolsPayload.tools[1]), 'utf8'));
});

test('synthetic counts build deterministic benchmark input', () => {
  assert.deepEqual(parseSyntheticCounts('11,5,3,2'), {
    tools: 11,
    resources: 5,
    templates: 3,
    prompts: 2
  });
  assert.throws(() => parseSyntheticCounts('1,-1,0,0'), /synthetic/i);
});

test('package exposes benchmark:catalog command', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['benchmark:catalog'], 'node scripts/benchmark-mcp-catalog.mjs');
});
