import crypto from 'node:crypto';
import path from 'node:path';

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeProjectId(value) {
  return String(value ?? '').trim();
}

export function isValidProjectId(value) {
  const projectId = normalizeProjectId(value);
  return PROJECT_ID_PATTERN.test(projectId) && !projectId.includes('/') && !projectId.includes('\\') && !projectId.includes(':');
}

export function assertValidProjectId(value) {
  const projectId = normalizeProjectId(value);
  if (!isValidProjectId(projectId)) {
    const error = new Error(`Invalid projectId: ${value}`);
    error.code = 'INVALID_PROJECT_ID';
    error.details = {
      projectId: value,
      pattern: PROJECT_ID_PATTERN.source
    };
    throw error;
  }
  return projectId;
}

export function slugifyProjectId(value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);

  return isValidProjectId(slug) ? slug : 'project';
}

function shortPathHash(rootPath) {
  return crypto.createHash('sha1').update(path.resolve(String(rootPath))).digest('hex').slice(0, 8);
}

function finalPathSegments(rootPath) {
  const resolved = path.resolve(String(rootPath));
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length);
  return relative.split(/[\\/]+/).filter(Boolean);
}

export function generateProjectIdForRoot(rootPath, usedProjectIds = new Set()) {
  const used = usedProjectIds instanceof Set ? usedProjectIds : new Set(usedProjectIds || []);
  const segments = finalPathSegments(rootPath);
  const folder = segments.at(-1) || 'project';
  const parent = segments.at(-2);

  const candidates = [slugifyProjectId(folder)];
  if (parent) candidates.push(slugifyProjectId(`${parent}-${folder}`));

  for (const candidate of candidates) {
    if (!used.has(candidate)) return candidate;
  }

  const base = candidates.at(-1) || 'project';
  const suffix = shortPathHash(rootPath);
  const maxBaseLength = 64 - suffix.length - 1;
  return `${base.slice(0, maxBaseLength).replace(/[._-]+$/g, '')}-${suffix}`;
}
