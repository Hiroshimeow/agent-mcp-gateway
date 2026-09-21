import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillRegistry, SkillRegistryError } from '../scripts/skills/index.mjs';
import { listRepoResources, readRepoResource } from '../scripts/resources/index.mjs';

function tempRoot(prefix = 'skill-registry-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(root, name, {
  description = 'Use when testing a reusable workflow.',
  body = '# Test Skill\n\nFollow the tested workflow.',
  frontmatter = '',
  resources = {}
} = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${frontmatter}---\n\n${body}\n`);
  for (const [relative, value] of Object.entries(resources)) {
    const file = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  return dir;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

test('registry scans valid skills and a valid empty root is healthy', () => {
  const empty = tempRoot();
  const emptyRegistry = createSkillRegistry({ directory: empty });
  assert.deepEqual(emptyRegistry.list(), []);
  assert.deepEqual(emptyRegistry.health().status, 'healthy');

  writeSkill(empty, 'systematic-debugging');
  const registry = createSkillRegistry({ directory: empty });
  const skill = registry.getByName('systematic-debugging');
  assert.equal(skill.name, 'systematic-debugging');
  assert.match(skill.body, /tested workflow/);
  assert.equal(registry.health().count, 1);
});

test('missing skill root is degraded and never becomes an empty healthy catalog', () => {
  const root = path.join(tempRoot(), 'missing');
  const registry = createSkillRegistry({ directory: root });
  assert.throws(() => registry.snapshot(), error => error instanceof SkillRegistryError && error.code === 'skill_root_unavailable');
  assert.deepEqual(registry.health(), { status: 'degraded', error: 'skill_root_unavailable' });
});

test('registry rejects malformed and incomplete SKILL.md frontmatter', () => {
  const cases = [
    ['malformed', '---\nname: [\n---\n\nBody\n'],
    ['scalar-frontmatter', '---\nhello\n---\n\nBody\n'],
    ['missing-name', '---\ndescription: okay\n---\n\nBody\n'],
    ['missing-description', '---\nname: missing-description\n---\n\nBody\n'],
    ['empty-body', '---\nname: empty-body\ndescription: okay\n---\n']
  ];
  for (const [name, contents] of cases) {
    const root = tempRoot();
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), contents);
    const registry = createSkillRegistry({ directory: root });
    assert.throws(() => registry.list(), SkillRegistryError, name);
    assert.equal(registry.health().status, 'degraded');
  }
});

test('registry enforces portable canonical names and directory/name equality', () => {
  const badNames = ['Uppercase', 'has_underscore', 'two--hyphens'];
  for (const name of badNames) {
    const root = tempRoot();
    const dir = path.join(root, 'fixture');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\nBody\n`);
    assert.throws(() => createSkillRegistry({ directory: root }).list(), SkillRegistryError);
  }

  const root = tempRoot();
  const dir = path.join(root, 'directory-name');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: other-name\ndescription: fixture\n---\n\nBody\n');
  assert.throws(() => createSkillRegistry({ directory: root }).list(), /must equal directory basename/);
});

test('full YAML frontmatter is preserved verbatim by meaning', () => {
  const root = tempRoot();
  writeSkill(root, 'yaml-skill', {
    frontmatter: 'license: MIT\ncompatibility: Requires git\nmetadata:\n  owner: platform\n  flags:\n    - one\n    - two\nallowed-tools: Bash(git:*)\n'
  });
  const skill = createSkillRegistry({ directory: root }).getByName('yaml-skill');
  assert.deepEqual(skill.frontmatter.metadata, { owner: 'platform', flags: ['one', 'two'] });
  assert.equal(skill.frontmatter.license, 'MIT');
  assert.equal(skill.frontmatter['allowed-tools'], 'Bash(git:*)');
});

test('manifest covers text and binary resources, hashes raw bytes, and excludes provenance', () => {
  const root = tempRoot();
  const dir = writeSkill(root, 'manifest-skill', {
    resources: {
      'references/notes.md': Buffer.from('line1\r\nline2\r\n', 'utf8'),
      'assets/pixel.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
      '.skill-source.json': Buffer.from('{"source":"ignored"}')
    }
  });
  const skill = createSkillRegistry({ directory: root }).getByName('manifest-skill');
  assert.deepEqual(skill.resources.map(item => item.uri), [
    'skill://skills/manifest-skill/assets/pixel.png',
    'skill://skills/manifest-skill/references/notes.md',
    'skill://skills/manifest-skill/SKILL.md'
  ]);
  for (const item of skill.resources) {
    const relative = decodeURIComponent(item.uri.split('/').slice(4).join('/'));
    const bytes = fs.readFileSync(path.join(dir, ...relative.split('/')));
    assert.equal(item.digest, sha256(bytes));
    assert.equal(item.size, bytes.length);
  }
  assert.equal(skill.resources.some(item => item.uri.includes('.skill-source.json')), false);

  const registry = createSkillRegistry({ directory: root });
  const text = registry.readResource('skill://skills/manifest-skill/references/notes.md');
  assert.equal(text.text, 'line1\r\nline2\r\n');
  const binary = registry.readResource('skill://skills/manifest-skill/assets/pixel.png');
  assert.equal(binary.mimeType, 'image/png');
  assert.equal(binary.blob, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]).toString('base64'));
});

test('symlinks inside served packages are rejected where the platform permits creating them', t => {
  const root = tempRoot();
  const dir = writeSkill(root, 'symlink-skill');
  const target = path.join(dir, 'target.txt');
  fs.writeFileSync(target, 'target');
  try {
    fs.symlinkSync(target, path.join(dir, 'link.txt'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('platform does not permit symlink creation');
      return;
    }
    throw error;
  }
  assert.throws(() => createSkillRegistry({ directory: root }).list(), /symlinks are not allowed/);
});

test('resource count and total-byte limits are enforced', () => {
  const countRoot = tempRoot();
  const dir = writeSkill(countRoot, 'count-limit');
  for (let index = 0; index < 512; index += 1) fs.writeFileSync(path.join(dir, `r-${index}.txt`), 'x');
  assert.throws(() => createSkillRegistry({ directory: countRoot }).list(), /resource count exceeds 512/);

  const byteRoot = tempRoot();
  writeSkill(byteRoot, 'byte-limit', { resources: { 'asset.bin': Buffer.alloc(16 * 1024 * 1024, 1) } });
  assert.throws(() => createSkillRegistry({ directory: byteRoot }).list(), /served bytes exceed/);
});

test('hot add/edit/resource add-remove/delete changes snapshots without registry recreation', () => {
  const root = tempRoot();
  const registry = createSkillRegistry({ directory: root });
  const emptyVersion = registry.snapshot().catalogVersion;

  writeSkill(root, 'hot-skill', { description: 'Initial description.' });
  const added = registry.getByName('hot-skill');
  const addedVersion = registry.snapshot().catalogVersion;
  assert.ok(added);
  assert.notEqual(addedVersion, emptyVersion);

  writeSkill(root, 'hot-skill', { description: 'Changed description.', body: '# Changed\n\nNew body.' });
  const edited = registry.getByName('hot-skill');
  assert.equal(edited.description, 'Changed description.');
  assert.notEqual(edited.skillRevision, added.skillRevision);
  assert.notEqual(registry.snapshot().catalogVersion, addedVersion);

  fs.mkdirSync(path.join(root, 'hot-skill', 'references'));
  fs.writeFileSync(path.join(root, 'hot-skill', 'references', 'note.md'), 'one');
  const withReference = registry.getByName('hot-skill');
  assert.notEqual(withReference.skillRevision, edited.skillRevision);
  const referenceVersion = registry.snapshot().catalogVersion;

  fs.writeFileSync(path.join(root, 'hot-skill', 'references', 'note.md'), 'two');
  const changedReference = registry.getByName('hot-skill');
  assert.notEqual(changedReference.skillRevision, withReference.skillRevision);
  assert.notEqual(registry.snapshot().catalogVersion, referenceVersion);

  fs.rmSync(path.join(root, 'hot-skill', 'references', 'note.md'));
  const withoutReference = registry.getByName('hot-skill');
  assert.equal(withoutReference.resources.some(item => item.uri.endsWith('/note.md')), false);

  fs.rmSync(path.join(root, 'hot-skill'), { recursive: true });
  assert.equal(registry.getByName('hot-skill'), null);
});

test('repo resources do not enumerate skills but resources/read resolves registry skill URIs', async () => {
  const root = tempRoot();
  writeSkill(root, 'resource-skill');
  const skillRegistry = createSkillRegistry({ directory: root });
  const resources = listRepoResources({ listVisibleDevices: () => [] });
  assert.equal(resources.some(resource => resource.uri.startsWith('skill://')), false);
  const result = await readRepoResource('skill://skills/resource-skill/SKILL.md', { skillRegistry });
  assert.equal(result.contents[0].mimeType, 'text/markdown');
  assert.match(result.contents[0].text, /name: resource-skill/);
});

test('human-comms remains a normal exact-name skill', () => {
  const registry = createSkillRegistry();
  const skill = registry.getByName('human-comms');
  assert.ok(skill);
  assert.equal(registry.getByName('human_comms'), null);
  assert.match(skill.description, /Use when/i);
});
