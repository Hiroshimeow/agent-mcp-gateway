import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertSafeRelativePath, resolveSafeFile } from './skill-source-safety.mjs';
import { createSkillRegistry } from './skills/index.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillsDirectory = path.join(scriptDirectory, 'skills');
const manifestPath = path.join(skillsDirectory, 'sources.json');
const lockPath = path.join(skillsDirectory, 'sources.lock.json');
const licensesDirectoryName = '_upstream_licenses';
const checkOnly = process.argv.includes('--check');
const forbiddenExtensions = new Set(['.ttf', '.otf', '.woff', '.woff2', '.eot']);
const maxFileBytes = 20 * 1024 * 1024;

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim();
}

function assertSafeSegment(value, label) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value === '.' || value === '..') {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function assertSafeFile(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed for ${label}: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Expected file for ${label}: ${filePath}`);
  if (stat.size > maxFileBytes) throw new Error(`${label} exceeds ${maxFileBytes} bytes: ${filePath}`);
  if (forbiddenExtensions.has(path.extname(filePath).toLowerCase())) {
    throw new Error(`Font files are not vendored: ${filePath}`);
  }
}

function assertSafeTree(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') throw new Error(`Nested .git directory is not allowed: ${current}`);
      const entryPath = path.join(current, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in vendored skills: ${entryPath}`);
      if (stat.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      assertSafeFile(entryPath, 'skill file');
    }
  }
}

function applyCompatibility(cloneDirectory, targetDirectory, compatibility, sourceId, folder) {
  for (const file of compatibility.files || []) {
    const sourceFile = resolveSafeFile(cloneDirectory, file.path, `compatibility file for ${sourceId}/${folder}`, {
      maxFileBytes,
      forbiddenExtensions
    });
    const targetFile = path.join(targetDirectory, assertSafeRelativePath(file.target, 'compatibility target path'));
    if (fs.existsSync(targetFile)) throw new Error(`Compatibility target already exists: ${targetFile}`);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(sourceFile, targetFile);
  }

  for (const replacement of compatibility.replacements || []) {
    const targetFile = resolveSafeFile(targetDirectory, replacement.path, `compatibility replacement file for ${sourceId}/${folder}`, {
      maxFileBytes,
      forbiddenExtensions
    });
    if (typeof replacement.search !== 'string' || !replacement.search) {
      throw new Error(`Compatibility replacement search is required for ${sourceId}/${folder}`);
    }
    if (typeof replacement.replace !== 'string') {
      throw new Error(`Compatibility replacement value is required for ${sourceId}/${folder}`);
    }
    const text = fs.readFileSync(targetFile, 'utf8');
    const occurrences = text.split(replacement.search).length - 1;
    const expectedOccurrences = replacement.count ?? 1;
    if (!Number.isInteger(expectedOccurrences) || expectedOccurrences < 1) {
      throw new Error(`Compatibility replacement count must be a positive integer for ${sourceId}/${folder}`);
    }
    if (occurrences !== expectedOccurrences) {
      throw new Error(`Expected ${expectedOccurrences} compatibility replacement matches in ${targetFile}, found ${occurrences}`);
    }
    fs.writeFileSync(targetFile, text.replaceAll(replacement.search, replacement.replace));
  }

  assertSafeTree(targetDirectory);
}

function replaceDirectory(target, staged) {
  const backup = path.join(path.dirname(target), `.skill-backup-${process.pid}-${path.basename(target)}`);
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  try {
    fs.renameSync(staged, target);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
}

function sourceSummary(lock) {
  return new Map((lock?.sources || []).map(source => [source.id, source.commit]));
}

const manifest = readJson(manifestPath);
if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.sources)) {
  throw new Error(`Invalid skill source manifest: ${manifestPath}`);
}

fs.mkdirSync(skillsDirectory, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-skills-'));
const preparedSkills = path.join(temporaryRoot, 'prepared');
const preparedLicenses = path.join(preparedSkills, licensesDirectoryName);
fs.mkdirSync(preparedLicenses, { recursive: true });

try {
  const targetOwners = new Map();
  const sourceLocks = [];

  for (const source of manifest.sources) {
    assertSafeSegment(source.id, 'source id');
    if (!source.repository || !source.ref || !source.skillRoot || !Array.isArray(source.include)) {
      throw new Error(`Incomplete source configuration: ${source.id}`);
    }

    const cloneDirectory = path.join(temporaryRoot, `source-${source.id}`);
    console.log(`[skills] fetching ${source.id} (${source.ref})`);
    git(['clone', '--depth', '1', '--single-branch', '--branch', source.ref, source.repository, cloneDirectory]);
    const commit = git(['rev-parse', 'HEAD'], cloneDirectory);
    const installed = [];

    if (source.requireRootLicense) {
      const licensePath = resolveSafeFile(cloneDirectory, source.requireRootLicense.path, `root license for ${source.id}`, {
        maxFileBytes,
        forbiddenExtensions
      });
      const licenseText = fs.readFileSync(licensePath, 'utf8');
      if (!licenseText.includes(source.requireRootLicense.contains)) {
        throw new Error(`Unexpected root license for ${source.id}`);
      }
    }

    for (const folder of source.include) {
      assertSafeSegment(folder, `skill folder for ${source.id}`);
      const owner = targetOwners.get(folder);
      if (owner) throw new Error(`Skill folder collision: ${folder} (${owner}, ${source.id})`);
      targetOwners.set(folder, source.id);

      const skillFile = resolveSafeFile(
        cloneDirectory,
        path.join(source.skillRoot, folder, 'SKILL.md'),
        `SKILL.md for ${source.id}/${folder}`,
        { maxFileBytes, forbiddenExtensions }
      );
      const sourceDirectory = path.dirname(skillFile);
      assertSafeTree(sourceDirectory);

      if (source.requireSkillLicense) {
        const licensePath = resolveSafeFile(sourceDirectory, source.requireSkillLicense.path, `required license for ${source.id}/${folder}`, {
          maxFileBytes,
          forbiddenExtensions
        });
        const licenseText = fs.readFileSync(licensePath, 'utf8');
        if (!licenseText.includes(source.requireSkillLicense.contains)) {
          throw new Error(`Unexpected license for ${source.id}/${folder}`);
        }
      }

      const targetDirectory = path.join(preparedSkills, folder);
      fs.cpSync(sourceDirectory, targetDirectory, { recursive: true, errorOnExist: true, force: false });
      const overrides = source.overrides?.[folder] || {};
      const compatibility = source.compatibility?.[folder] || {};
      if (Object.keys(compatibility).length) {
        applyCompatibility(cloneDirectory, targetDirectory, compatibility, source.id, folder);
      }
      writeJsonAtomic(path.join(targetDirectory, '.skill-source.json'), {
        source: source.id,
        repository: source.repository,
        ref: source.ref,
        commit,
        path: `${source.skillRoot}/${folder}`,
        license: source.license,
        overrides,
        ...(Object.keys(compatibility).length ? { compatibility } : {})
      });
      installed.push({
        target: folder,
        path: `${source.skillRoot}/${folder}`,
        ...(Object.keys(overrides).length ? { overrides } : {}),
        ...(Object.keys(compatibility).length ? { compatibility } : {})
      });
    }

    for (const rootFile of source.rootFiles || []) {
      const sourceFile = resolveSafeFile(cloneDirectory, rootFile.path, `root notice for ${source.id}`, {
        maxFileBytes,
        forbiddenExtensions
      });
      assertSafeSegment(rootFile.target, 'root notice target');
      fs.copyFileSync(sourceFile, path.join(preparedLicenses, rootFile.target));
    }

    sourceLocks.push({
      id: source.id,
      repository: source.repository,
      ref: source.ref,
      commit,
      license: source.license,
      skills: installed
    });
  }

  const expectedCount = sourceLocks.reduce((total, source) => total + source.skills.length, 0);
  const registry = createSkillRegistry({ directory: preparedSkills, builtins: new Map() });
  const discovered = registry.listSkills();
  if (discovered.length !== expectedCount) {
    throw new Error(`Prepared catalog validation failed: expected ${expectedCount}, discovered ${discovered.length}`);
  }

  const nextLock = { version: 1, sources: sourceLocks };
  const currentLock = readJson(lockPath, { version: 1, sources: [] });
  const unchanged = JSON.stringify(currentLock) === JSON.stringify(nextLock);

  if (checkOnly) {
    if (unchanged) {
      console.log('[skills] all managed sources are up to date');
      process.exitCode = 0;
    } else {
      const current = sourceSummary(currentLock);
      for (const source of sourceLocks) {
        console.log(`[skills] update available ${source.id}: ${current.get(source.id) || '<not installed>'} -> ${source.commit}`);
      }
      process.exitCode = 1;
    }
  } else {
    const oldManaged = new Set((currentLock.sources || []).flatMap(source => (source.skills || []).map(skill => skill.target)));
    const newManaged = new Set(sourceLocks.flatMap(source => source.skills.map(skill => skill.target)));

    for (const target of newManaged) {
      const livePath = path.join(skillsDirectory, target);
      if (fs.existsSync(livePath) && !oldManaged.has(target)) {
        throw new Error(`Refusing to overwrite unmanaged skill directory: ${livePath}`);
      }
    }

    const staged = new Map();
    for (const target of newManaged) {
      const stagedPath = path.join(skillsDirectory, `.skill-sync-${process.pid}-${target}`);
      fs.rmSync(stagedPath, { recursive: true, force: true });
      fs.cpSync(path.join(preparedSkills, target), stagedPath, { recursive: true });
      staged.set(target, stagedPath);
    }
    const stagedLicenses = path.join(skillsDirectory, `.skill-sync-${process.pid}-${licensesDirectoryName}`);
    fs.rmSync(stagedLicenses, { recursive: true, force: true });
    fs.cpSync(preparedLicenses, stagedLicenses, { recursive: true });

    for (const [target, stagedPath] of staged) {
      replaceDirectory(path.join(skillsDirectory, target), stagedPath);
    }
    replaceDirectory(path.join(skillsDirectory, licensesDirectoryName), stagedLicenses);

    for (const stale of oldManaged) {
      if (!newManaged.has(stale)) fs.rmSync(path.join(skillsDirectory, stale), { recursive: true, force: true });
    }

    writeJsonAtomic(lockPath, nextLock);
    console.log(`[skills] synchronized ${expectedCount} skills from ${sourceLocks.length} sources`);
    for (const source of sourceLocks) console.log(`[skills] ${source.id}: ${source.commit} (${source.skills.length} skills)`);
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
