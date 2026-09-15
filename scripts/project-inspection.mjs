import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

import { getRuntimeProfile } from './runtime-profile.mjs';
import { projectRouteKey } from './projects/trusted-roots-projects.mjs';

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'logs', 'packages', '_zip_temp']);
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_TREE_LIMIT = 200;
const MAX_TREE_LIMIT = 500;
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_DEPTH = 10;
const CURSOR_VERSION = 1;

export const PROJECT_INSPECTION_VIEWS = Object.freeze([
  'summary',
  'tree',
  'git_status',
  'git_diff',
  'readme',
  'package'
]);

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Invalid ${label}: ${value}. Expected an integer from ${min} to ${max}.`);
  }
  return number;
}

function cursorVersion(kind, parts) {
  return createHash('sha256').update(`${kind}\n${parts.join('\n')}`).digest('base64url').slice(0, 16);
}

function encodeCursor(kind, offset, version) {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, kind, offset, version }), 'utf8').toString('base64url');
}

function decodeCursor(cursor, { kind, version }) {
  if (!cursor) return 0;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid cursor: expected an opaque cursor returned by the previous page.');
  }
  if (
    parsed?.v !== CURSOR_VERSION ||
    parsed?.kind !== kind ||
    parsed?.version !== version ||
    !Number.isInteger(parsed?.offset) ||
    parsed.offset < 0
  ) {
    throw new Error('Invalid or stale cursor: request parameters or catalog version changed.');
  }
  return parsed.offset;
}

function projectPathExposure(context = {}) {
  if (typeof context.exposePaths === 'boolean') return context.exposePaths;
  return Boolean(
    context.projectRegistry?.exposeProjectPaths ||
    context.env?.MCP_EXPOSE_PROJECT_PATHS === 'true'
  );
}

function projectLookupError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function visibleDevices(context = {}) {
  if (typeof context.listVisibleDevices === 'function') {
    const devices = context.listVisibleDevices();
    return Array.isArray(devices) ? devices : [];
  }
  return Array.isArray(context.devices) ? context.devices : [];
}

function requireVisibleOnlineDevice(context, deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) throw projectLookupError('DEVICE_ID_REQUIRED', 'device_id is required.');
  const device = visibleDevices(context).find(item => String(item?.deviceId || '').trim() === id);
  if (!device) throw projectLookupError('DEVICE_NOT_FOUND', `Unknown or unavailable device_id: ${id}`);
  if (device.revoked || !device.online) throw projectLookupError('DEVICE_OFFLINE', `Device ${id} is offline or revoked.`);
  return device;
}

function getProject(projectRegistry, deviceId, projectId) {
  const id = String(projectId || '').trim();
  if (!id) throw projectLookupError('PROJECT_ID_REQUIRED', 'project_id is required.');
  const project = projectRegistry?.projectRoutes?.get(projectRouteKey(deviceId, id));
  if (!project) throw projectLookupError('PROJECT_DEVICE_MISMATCH', `project_id ${id} is not configured for device_id ${deviceId}.`);
  return project;
}

export function resolveProjectRoute(context = {}, { deviceId, projectId } = {}) {
  const normalizedDeviceId = String(deviceId || '').trim();
  requireVisibleOnlineDevice(context, normalizedDeviceId);
  return getProject(context.projectRegistry, normalizedDeviceId, projectId);
}

function hasReadme(project) {
  return fs.existsSync(path.join(project.repoRoot, 'README.md')) || fs.existsSync(path.join(project.repoRoot, 'README.vi.md'));
}

function hasPackageJson(project) {
  return fs.existsSync(path.join(project.repoRoot, 'package.json'));
}

function projectSummary(project, context = {}) {
  const data = {
    device_id: project.deviceId,
    project_id: project.projectId,
    displayName: project.displayName,
    defaultRootName: path.basename(project.repoRoot) || project.projectId,
    default: context.projectRegistry?.defaultProjectId === project.projectId,
    hasPackageJson: hasPackageJson(project),
    hasReadme: hasReadme(project),
    runtimeProfile: getRuntimeProfile(context.env || process.env).name
  };
  if (projectPathExposure(context)) data.repoRoot = project.repoRoot;
  return data;
}

function projectListItem(project, projectRegistry, exposePaths) {
  const item = {
    device_id: project.deviceId,
    project_id: project.projectId,
    displayName: project.displayName,
    default: projectRegistry?.defaultProjectId === project.projectId
  };
  if (exposePaths) item.repoRoot = project.repoRoot;
  return item;
}

export function listProjects(context = {}, options = {}) {
  const projectRegistry = context.projectRegistry;
  const exposePaths = projectPathExposure(context);
  const deviceId = String(options.device_id ?? options.deviceId ?? '').trim();
  requireVisibleOnlineDevice(context, deviceId);
  const query = String(options.query || '').trim().toLowerCase();
  const limit = boundedInteger(options.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT, 'limit');
  const all = [...(projectRegistry?.projectRoutes?.values() || [])]
    .filter(project => project.deviceId === deviceId);
  const matched = all
    .map(project => {
      const id = String(project.projectId || '').toLowerCase();
      const display = String(project.displayName || '').toLowerCase();
      const exact = query && (id === query || display === query);
      const contains = !query || id.includes(query) || display.includes(query);
      return { project, exact, contains };
    })
    .filter(entry => entry.contains)
    .sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return a.project.projectId.localeCompare(b.project.projectId);
    });
  const version = cursorVersion('projects', [
    deviceId,
    query,
    ...matched.map(entry => `${entry.project.projectId}:${entry.project.displayName}`)
  ]);
  const offset = decodeCursor(options.cursor, { kind: 'projects', version });
  if (offset > matched.length) throw new Error('Invalid or stale cursor: project offset is outside the current result set.');
  const page = matched.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const truncated = nextOffset < matched.length;
  return {
    items: page.map(entry => projectListItem(entry.project, projectRegistry, exposePaths)),
    truncated,
    nextCursor: truncated ? encodeCursor('projects', nextOffset, version) : null,
    total: matched.length,
    pathExposure: exposePaths
  };
}

function collectTreeEntries(root, maxDepth, stopAfter) {
  const entries = [];
  function walk(dir, depth, relativeDir = '') {
    if (entries.length >= stopAfter || depth > maxDepth) return;
    const dirEntries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => !DEFAULT_EXCLUDES.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirEntries) {
      if (entries.length >= stopAfter) return;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const isDirectory = entry.isDirectory();
      entries.push({ path: relativePath, name: entry.name, type: isDirectory ? 'directory' : 'file', depth });
      if (isDirectory && depth < maxDepth) walk(path.join(dir, entry.name), depth + 1, relativePath);
    }
  }
  walk(root, 1);
  return entries;
}

function readTree(project, options = {}) {
  const depth = boundedInteger(options.depth, DEFAULT_TREE_DEPTH, 1, MAX_TREE_DEPTH, 'depth');
  const limit = boundedInteger(options.limit, DEFAULT_TREE_LIMIT, 1, MAX_TREE_LIMIT, 'limit');
  const version = cursorVersion('project-tree', [project.projectId, String(depth)]);
  const offset = decodeCursor(options.cursor, { kind: 'project-tree', version });
  const entries = collectTreeEntries(project.repoRoot, depth, offset + limit + 1);
  if (offset > entries.length) throw new Error('Invalid or stale cursor: tree offset is outside the current result set.');
  const page = entries.slice(offset, offset + limit);
  const truncated = entries.length > offset + page.length;
  return {
    device_id: project.deviceId,
    project_id: project.projectId,
    rootName: path.basename(project.repoRoot),
    maxDepth: depth,
    maxEntries: limit,
    entries: page,
    truncated,
    nextCursor: truncated ? encodeCursor('project-tree', offset + page.length, version) : null
  };
}

function execGitRead(cwd, args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout, stderr, exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0 });
    });
  });
}

async function gitStatus(project) {
  const result = await execGitRead(project.repoRoot, ['status', '--short', '--branch']);
  return {
    device_id: project.deviceId,
    project_id: project.projectId,
    ok: result.ok,
    status: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}

async function gitDiff(project, staged = false) {
  const result = await execGitRead(project.repoRoot, staged ? ['diff', '--staged'] : ['diff']);
  return {
    device_id: project.deviceId,
    project_id: project.projectId,
    ok: result.ok,
    staged: Boolean(staged),
    text: result.ok ? result.stdout : result.stderr,
    stderr: result.stderr,
    exitCode: result.exitCode
  };
}

async function readReadme(project) {
  const readme = ['README.md', 'README.vi.md']
    .map(name => path.join(project.repoRoot, name))
    .find(file => fs.existsSync(file));
  if (!readme) throw new Error(`README not found for project_id: ${project.projectId}`);
  return {
    device_id: project.deviceId,
    project_id: project.projectId,
    fileName: path.basename(readme),
    text: await fs.promises.readFile(readme, 'utf8')
  };
}

async function readPackage(project) {
  const packagePath = path.join(project.repoRoot, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error(`package.json not found for project_id: ${project.projectId}`);
  return {
    device_id: project.deviceId,
    project_id: project.projectId,
    data: JSON.parse(await fs.promises.readFile(packagePath, 'utf8'))
  };
}

export async function inspectProject(context = {}, options = {}) {
  const view = String(options.view || 'summary');
  if (!PROJECT_INSPECTION_VIEWS.includes(view)) {
    throw new Error(`Invalid project inspection view: ${view}. Expected one of: ${PROJECT_INSPECTION_VIEWS.join(', ')}.`);
  }
  const deviceId = String(options.deviceId ?? options.device_id ?? '').trim();
  const project = resolveProjectRoute(context, { deviceId, projectId: options.projectId ?? options.project_id });
  if (view === 'summary') return projectSummary(project, context);
  if (view === 'tree') return readTree(project, options);
  if (view === 'git_status') return await gitStatus(project);
  if (view === 'git_diff') return await gitDiff(project, options.staged === true);
  if (view === 'readme') return await readReadme(project);
  if (view === 'package') return await readPackage(project);
  throw new Error(`Invalid project inspection view: ${view}.`);
}
