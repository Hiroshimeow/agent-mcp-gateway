import { createHash } from 'node:crypto';

import { getRuntimeProfile } from './runtime-profile.mjs';
import { projectRouteKey } from './projects/trusted-roots-projects.mjs';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
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

function projectRelativePath(encodedPath) {
  const decoded = decodeURIComponent(encodedPath || '');
  const portable = decoded.replaceAll('\\', '/');
  if (!decoded || portable.startsWith('/') || /^[A-Za-z]:\//.test(portable) || portable.split('/').includes('..')) {
    throw new Error('Invalid project-relative resource path.');
  }
  return decoded;
}

function remoteInspectionArguments(project, view, options = {}) {
  const args = {
    device_id: project.deviceId,
    path: project.repoRoot,
    project_id: project.projectId,
    view
  };
  if (view === 'tree') {
    if (options.depth !== undefined) args.depth = options.depth;
    if (options.limit !== undefined) args.limit = options.limit;
    if (options.cursor !== undefined) args.cursor = options.cursor;
  }
  if (view === 'git_diff' && options.staged !== undefined) args.staged = options.staged === true;
  return args;
}

function shapeInspectionResult(project, context, view, remote = {}) {
  const identity = { device_id: project.deviceId, project_id: project.projectId };
  if (view === 'summary') {
    const result = {
      ...identity,
      displayName: project.displayName,
      defaultRootName: remote.defaultRootName || project.projectId,
      default: context.projectRegistry?.defaultProjectId === project.projectId,
      hasPackageJson: Boolean(remote.hasPackageJson),
      hasReadme: Boolean(remote.hasReadme),
      runtimeProfile: getRuntimeProfile(context.env || process.env).name
    };
    if (projectPathExposure(context)) result.repoRoot = project.repoRoot;
    return result;
  }
  return { ...identity, ...remote };
}

export async function readProjectResourceFile(context = {}, { deviceId, projectId, encodedPath } = {}) {
  const project = resolveProjectRoute(context, { deviceId, projectId });
  if (typeof context.callDeviceTool !== 'function') {
    throw projectLookupError('DEVICE_EXECUTION_UNAVAILABLE', 'Project file access requires device execution routing.');
  }
  const remote = await context.callDeviceTool('project_inspect', {
    device_id: project.deviceId,
    path: project.repoRoot,
    project_id: project.projectId,
    view: 'file',
    relative_path: projectRelativePath(encodedPath)
  });
  if (!remote || typeof remote.text !== 'string') throw new Error('Invalid project file response from device.');
  return remote.text;
}

export async function inspectProject(context = {}, options = {}) {
  const view = String(options.view || 'summary');
  if (!PROJECT_INSPECTION_VIEWS.includes(view)) {
    throw new Error(`Invalid project inspection view: ${view}. Expected one of: ${PROJECT_INSPECTION_VIEWS.join(', ')}.`);
  }
  const deviceId = String(options.deviceId ?? options.device_id ?? '').trim();
  const project = resolveProjectRoute(context, { deviceId, projectId: options.projectId ?? options.project_id });
  if (typeof context.callDeviceTool !== 'function') {
    throw projectLookupError('DEVICE_EXECUTION_UNAVAILABLE', 'Project inspection requires device execution routing.');
  }
  const remote = await context.callDeviceTool('project_inspect', remoteInspectionArguments(project, view, options));
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
    throw new Error('Invalid project inspection response from device.');
  }
  return shapeInspectionResult(project, context, view, remote);
}
