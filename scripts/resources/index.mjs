import { buildRuntimeProfileStatus, getRuntimeProfile } from '../runtime-profile.mjs';
import { inspectProject, listProjects, readProjectResourceFile, resolveProjectRoute } from '../project-inspection.mjs';
import { applyToolRisk, buildToolRiskManifest } from '../tool-risk.mjs';

const GATEWAY_RESOURCES = Object.freeze([
  {
    uri: 'repo://gateway/runtime-profile',
    name: 'Gateway runtime profile',
    mimeType: 'application/json',
    description: 'Current gateway runtime profile.'
  },
  {
    uri: 'repo://gateway/tool-manifest',
    name: 'Gateway tool manifest',
    mimeType: 'application/json',
    description: 'Current gateway tool risk and visibility manifest.'
  }
]);

const LEGACY_RESOURCE_TEMPLATES = Object.freeze([
  { uriTemplate: 'repo://device/{device_id}/project/{project_id}/file/{path}', name: 'Project file', mimeType: 'text/plain' },
  { uriTemplate: 'repo://device/{device_id}/project/{project_id}/tree{?depth}', name: 'Project tree', mimeType: 'application/json' },
  { uriTemplate: 'repo://device/{device_id}/project/{project_id}/git/diff{?staged}', name: 'Git diff', mimeType: 'text/plain' }
]);

const NATIVE_RESOURCE_TEMPLATES = Object.freeze([
  { uriTemplate: 'repo://device/{device_id}/project/{project_id}/summary', name: 'Project summary', mimeType: 'application/json' },
  { uriTemplate: 'repo://device/{device_id}/project/{project_id}/tree{?depth}', name: 'Project tree', mimeType: 'application/json' },
  { uriTemplate: 'repo://device/{device_id}/project/{project_id}/git/status', name: 'Git status', mimeType: 'application/json' },
  { uriTemplate: 'repo://device/{device_id}/project/{project_id}/git/diff{?staged}', name: 'Git diff', mimeType: 'text/plain' },
  { uriTemplate: 'repo://device/{device_id}/project/{project_id}/file/{path}', name: 'Project file', mimeType: 'text/plain' }
]);

function jsonContent(uri, data) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}

function textContent(uri, text, mimeType = 'text/plain') {
  return { contents: [{ uri, mimeType, text }] };
}

function surfaceMode(surfaceConfig) {
  return surfaceConfig?.mode || 'legacy';
}

export function listRepoResources(context = {}, surfaceConfig = context.surfaceConfig) {
  const mode = surfaceMode(surfaceConfig);
  if (mode === 'agent' || mode === 'native') return GATEWAY_RESOURCES.map(resource => ({ ...resource }));

  const visibleDevices = typeof context.listVisibleDevices === 'function'
    ? context.listVisibleDevices().filter(device => device?.online && !device?.revoked)
    : [];
  const visibleDeviceIds = new Set(visibleDevices.map(device => String(device.deviceId || '').trim()).filter(Boolean));
  const projects = [...(context.projectRegistry?.projectRoutes?.values() || [])]
    .filter(project => visibleDeviceIds.has(project.deviceId));
  const resources = GATEWAY_RESOURCES.map(resource => ({ ...resource }));
  for (const deviceId of [...visibleDeviceIds].sort()) {
    resources.push({
      uri: `repo://device/${encodeURIComponent(deviceId)}/projects`,
      name: `${deviceId} projects`,
      mimeType: 'application/json',
      description: 'Configured projects for one owned online device.'
    });
  }
  for (const project of projects) {
    const base = `repo://device/${encodeURIComponent(project.deviceId)}/project/${encodeURIComponent(project.projectId)}`;
    resources.push(
      { uri: `${base}/summary`, name: `${project.displayName} summary`, mimeType: 'application/json' },
      { uri: `${base}/tree`, name: `${project.displayName} directory tree`, mimeType: 'application/json' },
      { uri: `${base}/git/status`, name: `${project.displayName} git status`, mimeType: 'application/json' },
      { uri: `${base}/readme`, name: `${project.displayName} README`, mimeType: 'text/markdown' },
      { uri: `${base}/package`, name: `${project.displayName} package.json`, mimeType: 'application/json' }
    );
  }
  return resources;
}

export function listRepoResourceTemplates(context = {}, surfaceConfig = context.surfaceConfig) {
  const mode = surfaceMode(surfaceConfig);
  if (mode === 'agent') return [];
  if (mode === 'native') return NATIVE_RESOURCE_TEMPLATES.map(template => ({ ...template }));
  return LEGACY_RESOURCE_TEMPLATES.map(template => ({ ...template }));
}

async function readRuntimeProfile(uri, context) {
  return jsonContent(uri, buildRuntimeProfileStatus(context.env || process.env));
}

async function readToolManifest(uri, context) {
  const runtimeProfile = getRuntimeProfile(context.env || process.env);
  const tools = (context.listTools ? await context.listTools() : []).map(applyToolRisk);
  return jsonContent(uri, { profile: runtimeProfile.name, tools: buildToolRiskManifest(tools, runtimeProfile) });
}

export async function readRepoResource(uri, context = {}) {
  const parsed = new URL(uri);
  if (parsed.protocol === 'skill:') {
    if (!context.skillRegistry) throw new Error('Skill registry is unavailable.');
    const resource = context.skillRegistry.readResource(uri);
    if (!resource) throw new Error(`Unknown skill resource URI: ${uri}`);
    return {
      contents: [{
        uri: resource.uri,
        mimeType: resource.mimeType,
        ...(resource.text !== undefined ? { text: resource.text } : { blob: resource.blob })
      }],
      ttlMs: 30000,
      cacheScope: 'public'
    };
  }
  if (parsed.protocol !== 'repo:') throw new Error(`Unsupported resource URI: ${uri}`);
  if (uri === 'repo://gateway/runtime-profile') return await readRuntimeProfile(uri, context);
  if (uri === 'repo://gateway/tool-manifest') return await readToolManifest(uri, context);

  // Historical project-scoped diagnostic aliases are singleton gateway
  // diagnostics; they do not execute against a project path.
  const legacyDiagnosticMatch = uri.match(/^repo:\/\/project\/[^/?#]+\/(runtime-profile|safety-profile|tool-manifest)$/);
  if (legacyDiagnosticMatch?.[1] === 'tool-manifest') return await readToolManifest(uri, context);
  if (legacyDiagnosticMatch) return await readRuntimeProfile(uri, context);

  const deviceProjectsMatch = uri.match(/^repo:\/\/device\/([^/?#]+)\/projects(?:[?#].*)?$/);
  if (deviceProjectsMatch) {
    const deviceId = decodeURIComponent(deviceProjectsMatch[1]);
    const result = listProjects(context, { device_id: deviceId, limit: 200 });
    return jsonContent(uri, { device_id: deviceId, projects: result.items, pathExposure: result.pathExposure, nextCursor: result.nextCursor });
  }

  const match = uri.match(/^repo:\/\/device\/([^/?#]+)\/project\/([^/?#]+)\/(.+)$/);
  if (!match) throw new Error(`Unknown resource URI: ${uri}`);
  const deviceId = decodeURIComponent(match[1]);
  const projectId = decodeURIComponent(match[2]);
  const project = resolveProjectRoute(context, { deviceId, projectId });
  const rest = match[3].replace(/[?#].*$/, '');

  if (rest === 'summary') return jsonContent(uri, await inspectProject(context, { deviceId, projectId: project.projectId, view: 'summary' }));
  if (rest === 'runtime-profile' || rest === 'safety-profile') return await readRuntimeProfile(uri, context);
  if (rest === 'tool-manifest') return await readToolManifest(uri, context);
  if (rest === 'readme') {
    const result = await inspectProject(context, { deviceId, projectId: project.projectId, view: 'readme' });
    return textContent(uri, result.text, 'text/markdown');
  }
  if (rest === 'package') {
    const result = await inspectProject(context, { deviceId, projectId: project.projectId, view: 'package' });
    return jsonContent(uri, result.data);
  }
  if (rest === 'tree') {
    const depthText = parsed.searchParams.get('depth');
    const depthNumber = depthText === null || depthText === '' ? 3 : Number(depthText);
    const depth = Number.isInteger(depthNumber) && depthNumber >= 1 && depthNumber <= 10 ? depthNumber : 3;
    return jsonContent(uri, await inspectProject(context, { deviceId, projectId: project.projectId, view: 'tree', depth, limit: 500 }));
  }
  if (rest === 'git/status') return jsonContent(uri, await inspectProject(context, { deviceId, projectId: project.projectId, view: 'git_status' }));
  if (rest === 'git/diff') {
    const result = await inspectProject(context, { deviceId, projectId: project.projectId, view: 'git_diff', staged: parsed.searchParams.get('staged') === 'true' });
    return textContent(uri, result.text, 'text/plain');
  }
  if (rest.startsWith('file/')) {
    const text = await readProjectResourceFile(context, {
      deviceId,
      projectId: project.projectId,
      encodedPath: rest.slice('file/'.length)
    });
    return textContent(uri, text, 'text/plain');
  }
  throw new Error(`Unknown resource URI: ${uri}`);
}
