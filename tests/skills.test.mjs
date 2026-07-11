import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSkillPrompt, getSkillDefinition, getSkillTool, listSkillPromptDefinitions, listSkillResources, readSkillResource } from '../scripts/skills/index.mjs';
import { getRepoPrompt, listRepoPrompts } from '../scripts/prompts/index.mjs';
import { listRepoResources, readRepoResource } from '../scripts/resources/index.mjs';

const ponytailUri = 'skill://ponytail/ponytail/SKILL.md';
const superpowersUri = 'skill://superpowers/using-superpowers/SKILL.md';

test('skills expose prompt definitions without requiring a custom tool', () => {
  const prompts = listSkillPromptDefinitions();
  assert.ok(prompts.some(prompt => prompt.name === 'ponytail'));
  assert.ok(prompts.some(prompt => prompt.name === 'ponytail_review'));
  assert.ok(prompts.some(prompt => prompt.name === 'using_superpowers'));
  assert.match(prompts.find(prompt => prompt.name === 'ponytail').description, /Read once per task/);
  assert.match(prompts.find(prompt => prompt.name === 'using_superpowers').description, /MCP skill bootstrap/);
});

test('skill lookup accepts slash-style aliases and builds MCP prompt text', () => {
  assert.equal(getSkillDefinition('/ponytail-review')?.name, 'ponytail_review');
  assert.equal(getSkillDefinition('superpower')?.name, 'using_superpowers');
  const text = buildSkillPrompt('ponytail', { mode: 'ultra' });
  assert.match(text, /Read this definition once/);
  assert.match(text, /Requested intensity: ultra/);
  assert.match(text, /The Ladder/);
});

test('repo prompts include skills and return MCP-shaped skill prompt messages', () => {
  const prompts = listRepoPrompts();
  assert.ok(prompts.some(prompt => prompt.name === 'ponytail'));
  assert.ok(prompts.some(prompt => prompt.name === 'using_superpowers'));
  const prompt = getRepoPrompt('ponytail_review');
  assert.equal(prompt.messages[0].role, 'user');
  assert.equal(prompt.messages[0].content.type, 'text');
  assert.match(prompt.messages[0].content.text, /Ponytail Review/);
  assert.match(prompt.messages[0].content.text, /Do not reload/);
});

test('skill resources are listed and readable through repo resources', async () => {
  assert.ok(listSkillResources().some(resource => resource.uri === ponytailUri));
  assert.ok(listSkillResources().some(resource => resource.uri === superpowersUri));
  assert.match(readSkillResource(ponytailUri).contents[0].text, /The Ladder/);
  assert.match(readSkillResource(superpowersUri).contents[0].text, /get_skill/);
  assert.ok(listRepoResources().some(resource => resource.uri === ponytailUri));
  const resource = await readRepoResource(ponytailUri);
  assert.equal(resource.contents[0].mimeType, 'text/markdown');
  assert.match(resource.contents[0].text, /Read this skill once/);
});

test('get_skill defaults to the superpowers bootstrap for skillless agents', () => {
  const payload = getSkillTool();
  assert.equal(payload.name, 'using_superpowers');
  assert.equal(payload.mcpSurfaces.tool, 'get_skill');
  assert.ok(payload.availableSkills.includes('ponytail'));
  assert.ok(payload.availableSkills.includes('local_coding'));
  assert.match(payload.body, /turns a normal MCP tool-using agent into a skill-capable agent/);
});
