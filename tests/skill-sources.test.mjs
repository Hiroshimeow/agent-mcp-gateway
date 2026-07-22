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

test('managed skill lock matches the source manifest and vendored metadata', () => {
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
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, '.skill-source.json'), 'utf8'));
      assert.equal(metadata.source, source.id);
      assert.equal(metadata.repository, source.repository);
      assert.equal(metadata.commit, source.commit);
      assert.equal(metadata.path, skill.path);
      assert.deepEqual(metadata.overrides, skill.overrides || {});
      assert.deepEqual(metadata.compatibility || {}, skill.compatibility || {});

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

test('vendored catalog excludes non-redistributable and font-bearing Anthropic skills', () => {
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

test('all managed skill folders are accepted by the live registry', () => {
  const expected = lock.sources.reduce((total, source) => total + source.skills.length, 0);
  const registry = createSkillRegistry({ directory: skillsDirectory, builtins: new Map() });
  assert.equal(registry.listSkills().length, expected);
});

test('design skills expose non-overlapping selection triggers in the live catalog', () => {
  const registry = createSkillRegistry({ directory: skillsDirectory, builtins: new Map() });
  const descriptions = new Map(registry.listSkills().map(skill => [skill.name, skill.description]));

  assert.match(descriptions.get('frontend_design'), /^Use when designing, building, or materially reshaping a web or application UI\b/);
  assert.match(descriptions.get('enhance_prompt'), /^Use when rewriting a vague UI request into a precise Google Stitch generation or editing prompt\b/);
  assert.match(descriptions.get('stitch_extract_design_md'), /^Use when analyzing an existing frontend source tree\b/);
  assert.match(descriptions.get('theme_factory'), /^Use when applying or generating a coherent visual theme for slides, documents, reports, or standalone artifacts\b/);
  assert.match(descriptions.get('web_artifacts_builder'), /^Use when implementing a complex interactive HTML artifact\b/);
  assert.match(descriptions.get('hallmark'), /^Use when the user explicitly invokes Hallmark, requests anti-AI-slop UI design\b/);
});

test('Hallmark is a pinned managed MIT skill with explicit aliases', () => {
  const source = manifest.sources.find(item => item.id === 'hallmark');
  assert.ok(source);
  assert.equal(source.repository, 'https://github.com/nutlope/hallmark.git');
  assert.equal(source.skillRoot, 'skills');
  assert.deepEqual(source.include, ['hallmark']);
  assert.equal(source.license, 'MIT');
  assert.equal(source.compatibility.hallmark.files.length, 3);
  assert.equal(source.compatibility.hallmark.replacements.length, 23);

  const registry = createSkillRegistry({ directory: skillsDirectory, builtins: new Map() });
  assert.equal(registry.getSkillDefinition('anti_ai_slop')?.name, 'hallmark');
  assert.equal(registry.getSkillDefinition('hallmark_audit')?.name, 'hallmark');
  assert.equal(registry.getSkillDefinition('design_audit'), null);
});

test('Hallmark Markdown references are self-contained after sync', () => {
  const hallmarkDirectory = path.join(skillsDirectory, 'hallmark');
  const markdownFiles = walkFiles(hallmarkDirectory).filter(file => path.extname(file).toLowerCase() === '.md');

  for (const markdownFile of markdownFiles) {
    const markdown = fs.readFileSync(markdownFile, 'utf8');
    const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1].split('#')[0].split('?')[0]);
    const localLinks = links.filter(link => link && !/^(?:https?:|mailto:|data:|#|\/\/)/i.test(link));

    for (const link of localLinks) {
      const target = path.resolve(path.dirname(markdownFile), decodeURIComponent(link));
      const relativeFile = path.relative(hallmarkDirectory, markdownFile);
      assert.equal(fs.existsSync(target), true, `broken Hallmark reference in ${relativeFile}: ${link}`);
    }
  }
});

test('package exposes cross-platform skill sync commands', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['skills:sync'], 'node scripts/sync-skills.mjs');
  assert.equal(packageJson.scripts['skills:check'], 'node scripts/sync-skills.mjs --check');
});
