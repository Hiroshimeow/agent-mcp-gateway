import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LOCAL_TOOL_NAMES, callCustomTool, isLocalCustomTool, listCustomTools } from '../scripts/custom-tools/index.mjs';
import { createSkillRegistry } from '../scripts/skills/index.mjs';

function parse(result) {
  return result.structuredContent || JSON.parse(result.content[0].text);
}

function fixtureRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-skills-'));
  const dir = path.join(root, 'systematic-debugging');
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: systematic-debugging\ndescription: Use when debugging a failing behavior.\n---\n\n# Debug\n\nReproduce and isolate.\n');
  fs.writeFileSync(path.join(dir, 'references', 'checklist.md'), '# Checklist\n');
  return { root, registry: createSkillRegistry({ directory: root }) };
}

test('local custom registry has exactly the two intended skill fallback tools', () => {
  const retiredSkillTool = ['get', 'skill'].join('_');
  const names = listCustomTools().map(tool => tool.name);
  assert.ok(names.includes('skill_catalog'));
  assert.ok(names.includes('load_skill'));
  assert.equal(names.includes(retiredSkillTool), false);
  assert.equal(LOCAL_TOOL_NAMES.filter(name => name.includes('skill')).length, 2);
  assert.equal(isLocalCustomTool('skill_catalog'), true);
  assert.equal(isLocalCustomTool('load_skill'), true);
  assert.equal(isLocalCustomTool(retiredSkillTool), false);

  for (const name of ['skill_catalog', 'load_skill']) {
    const tool = listCustomTools().find(item => item.name === name);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false
    });
  }
});

test('skill_catalog supports changed true, current false, and stale true', async () => {
  const { root, registry } = fixtureRegistry();
  const context = { skillRegistry: registry };

  const first = parse(await callCustomTool('skill_catalog', {}, context));
  assert.equal(first.ok, true);
  assert.equal(first.data.changed, true);
  assert.equal(first.data.skills.length, 1);
  assert.equal(first.data.skills[0].name, 'systematic-debugging');
  assert.equal(first.data.skills[0].body, undefined);

  const current = parse(await callCustomTool('skill_catalog', { known_version: first.data.version }, context));
  assert.deepEqual(current.data, { changed: false, version: first.data.version });

  fs.appendFileSync(path.join(root, 'systematic-debugging', 'SKILL.md'), '\nChanged.\n');
  const stale = parse(await callCustomTool('skill_catalog', { known_version: first.data.version }, context));
  assert.equal(stale.data.changed, true);
  assert.notEqual(stale.data.version, first.data.version);
  assert.notEqual(stale.data.skills[0].revision, first.data.skills[0].revision);
});

test('load_skill returns body and manifest, and can lazily read exact listed resources', async () => {
  const { registry } = fixtureRegistry();
  const context = { skillRegistry: registry };

  const loaded = parse(await callCustomTool('load_skill', { name: 'systematic-debugging' }, context));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.data.name, 'systematic-debugging');
  assert.match(loaded.data.body, /Reproduce and isolate/);
  assert.ok(loaded.data.resources.some(resource => resource.uri.endsWith('/references/checklist.md')));

  const resource = parse(await callCustomTool('load_skill', {
    name: 'systematic-debugging',
    resource: 'references/checklist.md'
  }, context));
  assert.equal(resource.ok, true);
  assert.equal(resource.data.text, '# Checklist\n');
  assert.equal(resource.data.mimeType, 'text/markdown');
});

test('load_skill rejects unknown names, traversal, and unlisted resources', async () => {
  const { registry } = fixtureRegistry();
  const context = { skillRegistry: registry };

  await assert.rejects(() => callCustomTool('load_skill', { name: 'missing' }, context), /Unknown skill/);
  await assert.rejects(() => callCustomTool('load_skill', {
    name: 'systematic-debugging',
    resource: '../secret.txt'
  }, context), /Invalid skill resource path/);
  await assert.rejects(() => callCustomTool('load_skill', {
    name: 'systematic-debugging',
    resource: 'references/missing.md'
  }, context), /Unknown resource/);
  await assert.rejects(() => callCustomTool('load_skill', {
    name: 'systematic-debugging',
    resource: 'checklist.md'
  }, context), /Unknown resource/);
});
