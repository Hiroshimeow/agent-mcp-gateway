import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMap, parseDocument } from 'yaml';

const DEFAULT_SKILLS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MAX_SKILL_MD_BYTES = 1024 * 1024;
const MAX_RESOURCES_PER_SKILL = 512;
const MAX_SERVED_BYTES_PER_SKILL = 16 * 1024 * 1024;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVENANCE_FILES = new Set(['.skill-source.json']);

const TEXT_MIME_TYPES = new Map([
  ['.md', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.jsx', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.sh', 'text/x-shellscript'],
  ['.ps1', 'text/plain'],
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.svg', 'image/svg+xml'],
  ['.xml', 'application/xml'],
  ['.csv', 'text/csv'],
  ['.toml', 'application/toml']
]);

const BINARY_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.pdf', 'application/pdf'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.wasm', 'application/wasm']
]);

export class SkillRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillRegistryError';
    this.code = code;
  }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new SkillRegistryError('skill_catalog_invalid', `${label} is unavailable: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw new SkillRegistryError('skill_catalog_invalid', `${label} must not be a symlink.`);
  }
  if (!stat.isFile()) {
    throw new SkillRegistryError('skill_catalog_invalid', `${label} must be a regular file.`);
  }
  return stat;
}

function parseSkillDocument(buffer, filePath) {
  if (buffer.length > MAX_SKILL_MD_BYTES) {
    throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes.`);
  }
  const raw = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: SKILL.md must start with closed YAML frontmatter.`);
  }

  const document = parseDocument(match[1]);
  if (document.errors.length) {
    throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: invalid YAML frontmatter: ${document.errors[0].message}`);
  }
  if (!isMap(document.contents)) {
    throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: frontmatter must be a YAML mapping.`);
  }
  const frontmatter = document.toJS();
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: frontmatter must be a mapping.`);
  }

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  const body = raw.slice(match[0].length).trim();

  if (!name) throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: name must be a non-empty string.`);
  if (name.length > MAX_NAME_LENGTH || !SKILL_NAME_PATTERN.test(name)) {
    throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: name must match ${SKILL_NAME_PATTERN} and be at most ${MAX_NAME_LENGTH} characters.`);
  }
  if (!description) throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: description must be a non-empty string.`);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  if (!body) throw new SkillRegistryError('skill_catalog_invalid', `${filePath}: body must be non-empty.`);

  return { frontmatter, name, description, body };
}

function shouldExcludeServedPath(relativePath) {
  const segments = relativePath.split('/');
  if (segments.some(segment => PROVENANCE_FILES.has(segment))) return true;
  if (segments.some(segment => segment.startsWith('.skill-sync-') || segment.startsWith('.skill-backup-'))) return true;
  if (segments[0] === '_upstream_licenses') return true;
  return false;
}

function encodeResourcePath(relativePath) {
  return relativePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

export function skillResourceUri(name, relativePath = 'SKILL.md') {
  const skillName = String(name || '');
  if (!SKILL_NAME_PATTERN.test(skillName)) throw new Error('Invalid skill name.');
  const raw = String(relativePath || '').replaceAll('\\', '/');
  if (!raw || raw.startsWith('/') || raw.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid skill resource path.');
  }
  return `skill://skills/${skillName}/${encodeResourcePath(raw)}`;
}

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return TEXT_MIME_TYPES.get(extension) || BINARY_MIME_TYPES.get(extension) || 'application/octet-stream';
}

function isTextMimeType(mimeType) {
  return mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType === 'application/yaml'
    || mimeType === 'application/toml'
    || mimeType === 'application/xml'
    || mimeType.endsWith('+json')
    || mimeType.endsWith('+xml');
}

function walkSkillFiles(skillDirectory) {
  const files = [];
  const pending = [{ absolute: skillDirectory, relative: '' }];

  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch (error) {
      throw new SkillRegistryError('skill_catalog_invalid', `${current.absolute}: unreadable skill directory: ${error.message}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new SkillRegistryError('skill_catalog_invalid', `${absolute}: symlinks are not allowed in skill packages.`);
      }
      if (entry.isDirectory()) {
        pending.push({ absolute, relative });
        continue;
      }
      if (!entry.isFile()) {
        throw new SkillRegistryError('skill_catalog_invalid', `${absolute}: only regular files are allowed in skill packages.`);
      }
      if (shouldExcludeServedPath(relative)) continue;
      files.push({ absolute, relative: relative.replaceAll('\\', '/') });
    }
  }

  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return files;
}

function buildSkillSnapshot(skillDirectory, directoryName) {
  const skillFile = path.join(skillDirectory, 'SKILL.md');
  const skillStat = assertRegularFile(skillFile, skillFile);
  if (skillStat.size > MAX_SKILL_MD_BYTES) {
    throw new SkillRegistryError('skill_catalog_invalid', `${skillFile}: SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes.`);
  }
  const skillBytes = fs.readFileSync(skillFile);
  const parsed = parseSkillDocument(skillBytes, skillFile);

  if (parsed.name !== directoryName) {
    throw new SkillRegistryError('skill_catalog_invalid', `${skillFile}: frontmatter name "${parsed.name}" must equal directory basename "${directoryName}".`);
  }

  const files = walkSkillFiles(skillDirectory);
  if (!files.some(file => file.relative === 'SKILL.md')) {
    throw new SkillRegistryError('skill_catalog_invalid', `${skillFile}: SKILL.md is not a served regular file.`);
  }
  if (files.length > MAX_RESOURCES_PER_SKILL) {
    throw new SkillRegistryError('skill_catalog_invalid', `${skillDirectory}: served resource count exceeds ${MAX_RESOURCES_PER_SKILL}.`);
  }
  const resourceFiles = new Map();
  const resources = [];
  let totalBytes = 0;
  for (const file of files) {
    const bytes = file.relative === 'SKILL.md' ? skillBytes : fs.readFileSync(file.absolute);
    totalBytes += bytes.length;
    if (totalBytes > MAX_SERVED_BYTES_PER_SKILL) {
      throw new SkillRegistryError('skill_catalog_invalid', `${skillDirectory}: served bytes exceed ${MAX_SERVED_BYTES_PER_SKILL}.`);
    }
    const uri = skillResourceUri(parsed.name, file.relative);
    const digest = sha256(bytes);
    const mimeType = mimeTypeFor(file.relative);
    resourceFiles.set(uri, {
      absolutePath: file.absolute,
      relativePath: file.relative,
      digest,
      size: bytes.length,
      mimeType
    });
    resources.push({ uri, digest, size: bytes.length });
  }

  const revisionMaterial = resources
    .map(resource => `${resource.uri}\0${resource.digest}\0${resource.size}`)
    .join('\n');
  const skillRevision = sha256(Buffer.from(revisionMaterial, 'utf8'));
  const uri = skillResourceUri(parsed.name, 'SKILL.md');

  return {
    name: parsed.name,
    description: parsed.description,
    uri,
    frontmatter: cloneJson(parsed.frontmatter),
    body: parsed.body,
    resources,
    skillRevision,
    _resourceFiles: resourceFiles
  };
}

function publicSkill(skill, { includeBody = true } = {}) {
  const value = {
    name: skill.name,
    description: skill.description,
    uri: skill.uri,
    frontmatter: cloneJson(skill.frontmatter),
    resources: skill.resources.map(resource => ({ ...resource })),
    skillRevision: skill.skillRevision
  };
  if (includeBody) value.body = skill.body;
  return value;
}

function scanDirectory(directory) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(directory);
  } catch (error) {
    throw new SkillRegistryError('skill_root_unavailable', `Skill root is unavailable: ${error.message}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SkillRegistryError('skill_root_unavailable', 'Skill root must be a readable directory and not a symlink.');
  }

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new SkillRegistryError('skill_root_unavailable', `Skill root is unreadable: ${error.message}`);
  }

  const skills = [];
  const names = new Set();
  const uris = new Set();
  const allResourceUris = new Set();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === '_upstream_licenses') continue;
    const skillDirectory = path.join(directory, entry.name);
    const stat = fs.lstatSync(skillDirectory);
    if (stat.isSymbolicLink()) {
      throw new SkillRegistryError('skill_catalog_invalid', `${skillDirectory}: skill directories must not be symlinks.`);
    }
    if (!stat.isDirectory()) continue;
    if (!fs.existsSync(path.join(skillDirectory, 'SKILL.md'))) continue;

    const skill = buildSkillSnapshot(skillDirectory, entry.name);
    if (names.has(skill.name)) throw new SkillRegistryError('skill_catalog_invalid', `Duplicate skill name: ${skill.name}`);
    if (uris.has(skill.uri)) throw new SkillRegistryError('skill_catalog_invalid', `Duplicate skill URI: ${skill.uri}`);
    names.add(skill.name);
    uris.add(skill.uri);
    for (const resource of skill.resources) {
      if (allResourceUris.has(resource.uri)) throw new SkillRegistryError('skill_catalog_invalid', `Duplicate skill resource URI: ${resource.uri}`);
      allResourceUris.add(resource.uri);
    }
    skills.push(skill);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  const catalogMaterial = skills
    .map(skill => `${skill.name}\0${skill.description}\0${skill.uri}\0${skill.skillRevision}`)
    .join('\n');
  const catalogVersion = sha256(Buffer.from(catalogMaterial, 'utf8'));

  return { skills, catalogVersion };
}

export function createSkillRegistry({ directory = DEFAULT_SKILLS_DIRECTORY } = {}) {
  if (!directory) throw new Error('Skill registry directory is required.');
  const root = path.resolve(directory);
  let lastHealth = { status: 'degraded', error: 'skill_not_scanned' };

  function refresh() {
    try {
      const scanned = scanDirectory(root);
      const byName = new Map(scanned.skills.map(skill => [skill.name, skill]));
      const byUri = new Map(scanned.skills.map(skill => [skill.uri, skill]));
      const byResourceUri = new Map();
      for (const skill of scanned.skills) {
        for (const [uri, resource] of skill._resourceFiles) byResourceUri.set(uri, { skill, resource });
      }
      const snapshot = {
        catalogVersion: scanned.catalogVersion,
        skills: scanned.skills,
        byName,
        byUri,
        byResourceUri
      };
      lastHealth = { status: 'healthy', count: scanned.skills.length, version: scanned.catalogVersion };
      return snapshot;
    } catch (error) {
      lastHealth = {
        status: 'degraded',
        error: error?.code === 'skill_root_unavailable' ? 'skill_root_unavailable' : 'skill_catalog_invalid'
      };
      throw error;
    }
  }

  function snapshot() {
    const current = refresh();
    return {
      catalogVersion: current.catalogVersion,
      skills: current.skills.map(skill => publicSkill(skill))
    };
  }

  function list() {
    return snapshot().skills;
  }

  function getByName(name) {
    const current = refresh();
    const skill = current.byName.get(String(name || ''));
    return skill ? publicSkill(skill) : null;
  }

  function getByUri(uri) {
    const current = refresh();
    const skill = current.byUri.get(String(uri || ''));
    return skill ? publicSkill(skill) : null;
  }

  function readResource(uri) {
    const current = refresh();
    const found = current.byResourceUri.get(String(uri || ''));
    if (!found) return null;

    let bytes = fs.readFileSync(found.resource.absolutePath);
    let digest = sha256(bytes);
    if (digest !== found.resource.digest || bytes.length !== found.resource.size) {
      const retried = refresh().byResourceUri.get(String(uri || ''));
      if (!retried) return null;
      bytes = fs.readFileSync(retried.resource.absolutePath);
      digest = sha256(bytes);
      if (digest !== retried.resource.digest || bytes.length !== retried.resource.size) {
        throw new SkillRegistryError('skill_catalog_invalid', 'Skill resource changed during refresh/read.');
      }
      return {
        uri: String(uri),
        mimeType: retried.resource.mimeType,
        digest,
        size: bytes.length,
        ...(isTextMimeType(retried.resource.mimeType)
          ? { text: bytes.toString('utf8') }
          : { blob: bytes.toString('base64') })
      };
    }

    return {
      uri: String(uri),
      mimeType: found.resource.mimeType,
      digest,
      size: bytes.length,
      ...(isTextMimeType(found.resource.mimeType)
        ? { text: bytes.toString('utf8') }
        : { blob: bytes.toString('base64') })
    };
  }

  function health() {
    try {
      refresh();
    } catch {}
    return { ...lastHealth };
  }

  return Object.freeze({
    refresh,
    snapshot,
    list,
    getByName,
    getByUri,
    readResource,
    health
  });
}
