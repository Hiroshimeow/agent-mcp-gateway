import assert from 'node:assert/strict';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { listRepoPrompts, getRepoPrompt } from './prompts/index.mjs';
import { listRepoResources, listRepoResourceTemplates } from './resources/index.mjs';
import { buildTrustedRootsProjectRegistry } from './projects/trusted-roots-projects.mjs';

const root = process.cwd();
const registry = buildTrustedRootsProjectRegistry([`${root} | gateway | Gateway`], { defaultProjectId: 'gateway' });
const context = { projectRegistry: registry, env: { MCP_SAFETY_PROFILE: 'yolo' }, listTools: async () => [] };

for (const schema of [ListResourcesRequestSchema, ReadResourceRequestSchema, ListResourceTemplatesRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema]) {
  assert.equal(typeof schema.parse, 'function');
}

const resources = listRepoResources(context);
const templates = listRepoResourceTemplates(context);
const prompts = listRepoPrompts({ safetyProfile: { name: 'yolo' } });
const prompt = getRepoPrompt('release_readiness', { projectId: 'gateway' }, { safetyProfile: { name: 'yolo' } });

assert.ok(resources.some(r => r.uri === 'repo://projects'));
assert.ok(templates.some(t => t.uriTemplate.includes('{projectId}')));
assert.ok(prompts.some(p => p.name === 'release_readiness'));
assert.equal(prompt.messages[0].role, 'user');

console.log(JSON.stringify({ ok: true, resources: resources.length, templates: templates.length, prompts: prompts.length }, null, 2));
