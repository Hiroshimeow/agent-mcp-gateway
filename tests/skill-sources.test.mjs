import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSkillRegistry } from '../scripts/skills/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDirectory = path.join(root, 'scripts', 'skills');
const manifest = JSON.parse(fs.readFileSync(path.join(skillsDirectory, 'sources.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(skillsDirectory, 'sources.lock.json'), 'utf8'));
const forbiddenExtensions = new Set(['.ttf', '.otf', '.woff', '.woff2', '.eot']);

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

test('managed lock matches source manifest without per-skill provenance files', () => {
  assert.equal(manifest.version, 1);
  assert.equal(lock.version, 1);
  assert.deepEqual(lock.sources.map(source => source.id), manifest.sources.map(source => source.id));

  const targets = new Set();
  for (const source of lock.sources) {
    const configured = manifest.sources.find(item => item.id === source.id);
    assert.ok(configured);
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.equal(source.repository, configured.repository);
    assert.equal(source.ref, configured.ref);
    assert.deepEqual(source.skills.map(skill => skill.target), configured.include);

    for (const skill of source.skills) {
      assert.equal(targets.has(skill.target), false, `duplicate managed target: ${skill.target}`);
      targets.add(skill.target);
      const directory = path.join(skillsDirectory, skill.target);
      assert.equal(fs.existsSync(path.join(directory, 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(directory, '.skill-source.json')), false);
      assert.equal(skill.path, `${configured.skillRoot}/${skill.target}`);
      assert.deepEqual(skill.compatibility || {}, configured.compatibility?.[skill.target] || {});
      if (configured.requireSkillLicense) {
        const license = fs.readFileSync(path.join(directory, configured.requireSkillLicense.path), 'utf8');
        assert.match(license, new RegExp(configured.requireSkillLicense.contains));
      }
    }

    for (const rootFile of configured.rootFiles || []) {
      assert.equal(fs.existsSync(path.join(skillsDirectory, '_upstream_licenses', rootFile.target)), true);
    }
  }
});

test('managed catalog excludes disallowed packages and font files', () => {
  const anthropic = manifest.sources.find(source => source.id === 'anthropic');
  assert.ok(anthropic);
  for (const excluded of Object.keys(anthropic.excluded || {})) {
    assert.equal(anthropic.include.includes(excluded), false);
    assert.equal(fs.existsSync(path.join(skillsDirectory, excluded)), false);
  }

  const managedTargets = new Set(lock.sources.flatMap(source => source.skills.map(skill => skill.target)));
  for (const target of managedTargets) {
    for (const file of walkFiles(path.join(skillsDirectory, target))) {
      assert.equal(forbiddenExtensions.has(path.extname(file).toLowerCase()), false, `font file vendored: ${file}`);
    }
  }
});

test('every lock target is accepted by the same live registry', () => {
  const registry = createSkillRegistry({ directory: skillsDirectory });
  const names = new Set(registry.list().map(skill => skill.name));
  for (const source of lock.sources) {
    for (const skill of source.skills) assert.ok(names.has(skill.target), `managed skill rejected: ${skill.target}`);
  }
});

test('runtime descriptions come from resulting SKILL.md frontmatter', () => {
  const registry = createSkillRegistry({ directory: skillsDirectory });
  for (const skill of registry.list()) {
    const source = fs.readFileSync(path.join(skillsDirectory, skill.name, 'SKILL.md'), 'utf8');
    const descriptionLine = skill.description;
    assert.ok(source.includes(descriptionLine) || source.includes('description:'), skill.name);
  }
  assert.match(registry.getByName('frontend-design').description, /^Use when designing, building, or materially reshaping/);
  assert.match(registry.getByName('enhance-prompt').description, /^Use when rewriting a vague UI request/);
  assert.match(registry.getByName('extract-design-md').description, /^Use when analyzing an existing frontend source tree/);
  assert.match(registry.getByName('hallmark').description, /^Use when the user explicitly invokes Hallmark/);
});

test('extract-design-md identity and removed meta-skill stay reproducible in source config', () => {
  const removedMetaSkill = ['using', 'superpowers'].join('-');
  const stitch = manifest.sources.find(source => source.id === 'stitch-design');
  assert.equal(stitch.compatibility['extract-design-md'].frontmatter.name, 'extract-design-md');
  const actual = fs.readFileSync(path.join(skillsDirectory, 'extract-design-md', 'SKILL.md'), 'utf8');
  assert.match(actual, /^---\r?\nname: extract-design-md\r?$/m);

  const superpowers = manifest.sources.find(source => source.id === 'superpowers');
  assert.equal(superpowers.include.includes(removedMetaSkill), false);
  assert.equal(Object.hasOwn(superpowers.compatibility || {}, removedMetaSkill), false);
  assert.equal(fs.existsSync(path.join(skillsDirectory, removedMetaSkill)), false);
});

test('source config contains no runtime aliases or runtime URI overrides', () => {
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /"aliases"/);
  assert.doesNotMatch(serialized, /"uri"/);
  assert.doesNotMatch(serialized, /"overrides"/);
});

test('Hallmark compatibility remains pinned and self-contained', () => {
  const source = manifest.sources.find(item => item.id === 'hallmark');
  assert.ok(source);
  assert.equal(source.repository, 'https://github.com/nutlope/hallmark.git');
  assert.equal(source.license, 'MIT');
  assert.equal(source.compatibility.hallmark.files.length, 3);
  assert.equal(source.compatibility.hallmark.replacements.length, 22);

  const hallmarkDirectory = path.join(skillsDirectory, 'hallmark');
  const markdownFiles = walkFiles(hallmarkDirectory).filter(file => path.extname(file).toLowerCase() === '.md');
  for (const markdownFile of markdownFiles) {
    const markdown = fs.readFileSync(markdownFile, 'utf8');
    const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1].split('#')[0].split('?')[0]);
    for (const link of links.filter(value => value && !/^(?:https?:|mailto:|data:|#|\/\/)/i.test(value))) {
      assert.equal(fs.existsSync(path.resolve(path.dirname(markdownFile), decodeURIComponent(link))), true);
    }
  }
});

test('package exposes cross-platform sync commands', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['skills:sync'], 'node scripts/sync-skills.mjs');
  assert.equal(packageJson.scripts['skills:check'], 'node scripts/sync-skills.mjs --check');
});
