import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SKILL_AGENT_INSTRUCTIONS, buildSkillPrompt, createSkillRegistry, getSkillDefinition, getSkillTool, listSkillPromptDefinitions, listSkillResources, readSkillResource } from '../scripts/skills/index.mjs';
import { getRepoPrompt, listRepoPrompts } from '../scripts/prompts/index.mjs';
import { listRepoResources, readRepoResource } from '../scripts/resources/index.mjs';

const ponytailUri = 'skill://ponytail/ponytail/SKILL.md';
const superpowersUri = 'skill://superpowers/using-superpowers/SKILL.md';

test('skills expose prompt definitions without requiring a custom tool', () => {
  const prompts = listSkillPromptDefinitions();
  const ponytail = prompts.find(prompt => prompt.name === 'ponytail');
  const superpowers = prompts.find(prompt => prompt.name === 'using_superpowers');
  assert.ok(ponytail);
  assert.ok(prompts.some(prompt => prompt.name === 'ponytail_review'));
  assert.ok(superpowers);
  assert.match(ponytail.description, /coding|solution|YAGNI/i);
  assert.match(superpowers.description, /skills|conversation/i);
});

test('skill lookup accepts slash-style aliases and builds MCP prompt text', () => {
  assert.equal(getSkillDefinition('/ponytail-review')?.name, 'ponytail_review');
  assert.equal(getSkillDefinition('superpower')?.name, 'using_superpowers');
  const text = buildSkillPrompt('ponytail', { mode: 'ultra' });
  assert.match(text, /Read this definition once/);
  assert.match(text, /Requested intensity: ultra/);
  assert.match(text, /The ladder/i);
});

test('repo prompts include skills and return MCP-shaped skill prompt messages', () => {
  const prompts = listRepoPrompts();
  assert.ok(prompts.some(prompt => prompt.name === 'ponytail'));
  assert.ok(prompts.some(prompt => prompt.name === 'using_superpowers'));
  const prompt = getRepoPrompt('ponytail_review');
  assert.equal(prompt.messages[0].role, 'user');
  assert.equal(prompt.messages[0].content.type, 'text');
  assert.match(prompt.messages[0].content.text, /Ponytail Review/);
  assert.match(prompt.messages[0].content.text, /do not load it again/i);
});

test('skill resources are listed and readable through repo resources', async () => {
  assert.ok(listSkillResources().some(resource => resource.uri === ponytailUri));
  assert.ok(listSkillResources().some(resource => resource.uri === superpowersUri));
  assert.match(readSkillResource(ponytailUri).contents[0].text, /The ladder/i);
  assert.match(readSkillResource(superpowersUri).contents[0].text, /invoke.*skills|skill.*priority/is);
  assert.ok(listRepoResources().some(resource => resource.uri === ponytailUri));
  const resource = await readRepoResource(ponytailUri);
  assert.equal(resource.contents[0].mimeType, 'text/markdown');
  assert.match(resource.contents[0].text, /lazy senior developer/i);
});

test('get_skill defaults to the superpowers bootstrap for skillless agents', () => {
  const payload = getSkillTool();
  const ponytail = payload.skillCatalog.find(skill => skill.name === 'ponytail');
  assert.equal(payload.name, 'using_superpowers');
  assert.equal(payload.mcpSurfaces.tool, 'get_skill');
  assert.ok(payload.availableSkills.includes('ponytail'));
  assert.ok(payload.availableSkills.includes('local_coding'));
  assert.ok(payload.availableSkills.includes('systematic_debugging'));
  assert.ok(ponytail?.description);
  assert.match(payload.body, /invoke relevant or requested skills|skill priority/i);
  assert.match(SKILL_AGENT_INSTRUCTIONS, /before the first project-changing tool call/i);
  assert.match(SKILL_AGENT_INSTRUCTIONS, /call get_skill without arguments/i);
});

function writeSkill(directory, folder, { description = 'Use for dynamic debugging work.', body = '# Dynamic Debugging\n\nInspect before changing.', extra = '' } = {}) {
  const skillDirectory = path.join(directory, folder);
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${description}\n${extra}---\n\n${body}\n`);
}

test('disk skills hot reload on add, edit, and remove without recreating the registry', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-skills-'));
  const registry = createSkillRegistry({ directory, builtins: new Map() });
  assert.deepEqual(registry.listSkills(), []);

  writeSkill(directory, 'systematic-debugging');
  assert.equal(registry.getSkillDefinition('systematic-debugging').name, 'systematic_debugging');
  assert.match(registry.getSkillDefinition('systematic_debugging').body, /Inspect before changing/);

  writeSkill(directory, 'systematic-debugging', {
    description: 'Use when a bug needs root-cause analysis.',
    body: '# Systematic Debugging\n\nReproduce, isolate, verify.'
  });
  assert.match(registry.getSkillDefinition('systematic-debugging').description, /root-cause analysis/);
  assert.match(registry.getSkillDefinition('systematic-debugging').body, /Reproduce, isolate, verify/);

  fs.rmSync(path.join(directory, 'systematic-debugging'), { recursive: true });
  assert.equal(registry.getSkillDefinition('systematic-debugging'), null);
});

test('skill-prefixed names remain canonical while skill: lookup syntax still works', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-skill-prefix-'));
  writeSkill(directory, 'skill-doctor', { description: 'Diagnose installed skill quality.' });
  const registry = createSkillRegistry({ directory, builtins: new Map() });
  assert.equal(registry.getSkillDefinition('skill-doctor').name, 'skill_doctor');
  assert.equal(registry.getSkillDefinition('skill:skill-doctor').name, 'skill_doctor');
});

test('disk skill metadata controls prompt and model discovery', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-skill-metadata-'));
  writeSkill(directory, 'manual-only', {
    description: 'Only load when explicitly requested.',
    extra: 'aliases:\n  - manual\n  - explicit\nuser-invocable: false\ndisable-model-invocation: true\n'
  });
  const registry = createSkillRegistry({ directory, builtins: new Map() });
  const skill = registry.getSkillDefinition('manual');
  assert.equal(skill.name, 'manual_only');
  assert.equal(skill.userInvocable, false);
  assert.equal(skill.modelInvocable, false);
});

test('invalid disk skill keeps the last valid catalog and loads after repair', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-skill-invalid-'));
  const skillDirectory = path.join(directory, 'broken');
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '---\nname: broken\n---\n');

  const registry = createSkillRegistry({ directory, builtins: new Map() });
  assert.deepEqual(registry.listSkills(), []);

  writeSkill(directory, 'broken', { description: 'Use after the file becomes valid.' });
  assert.equal(registry.getSkillDefinition('broken').name, 'broken');
});

test('skill watcher emits after a valid disk catalog change', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-skill-watch-'));
  const registry = createSkillRegistry({ directory, builtins: new Map() });
  let resolveChange;
  const changed = new Promise(resolve => { resolveChange = resolve; });
  const stop = registry.watch(resolveChange, { intervalMs: 10 });
  t.after(stop);

  writeSkill(directory, 'verification');
  const catalog = await Promise.race([
    changed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('skill watcher timed out')), 1000))
  ]);
  assert.ok(catalog.some(skill => skill.name === 'verification'));
});
