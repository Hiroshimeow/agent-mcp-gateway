import fs from 'node:fs';
import path from 'node:path';
import { buildRuntimeProfileStatus, getRuntimeProfile } from '../runtime-profile.mjs';
import { inspectProject, listProjects } from '../project-inspection.mjs';
import { applyToolRisk, buildToolRiskManifest } from '../tool-risk.mjs';
import { listSkillResources, readSkillResource } from '../skills/index.mjs';

const MAX_RESOURCE_FILE_BYTES = 1024 * 1024;

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function jsonContent(uri, data) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}

function textContent(uri, text, mimeType = 'text/plain') {
  return { contents: [{ uri, mimeType, text }] };
}

function getProject(context, projectId) {
  const registry = context.projectRegistry;
  const id = projectId || registry?.defaultProjectId;
  const project = registry?.projects?.get(id);
  if (!project) throw new Error(`Unknown projectId: ${projectId}`);
  return project;
}

function hasReadme(project) {
  return fs.existsSync(path.join(project.repoRoot, 'README.md')) || fs.existsSync(path.join(project.repoRoot, 'README.vi.md'));
}

function hasPackageJson(project) {
  return fs.existsSync(path.join(project.repoRoot, 'package.json'));
}

export function listRepoResources(context = {}) {
  const projects = [...(context.projectRegistry?.projects?.values() || [])];
  const resources = [
    ...listSkillResources(),
    { uri: 'repo://projects', name: 'Projects', mimeType: 'application/json', description: 'Configured MCP gateway projects.' }
  ];
  for (const p of projects) {
    const base = `repo://project/${encodeURIComponent(p.projectId)}`;
    resources.push(
      { uri: `${base}/summary`, name: `${p.displayName} summary`, mimeType: 'application/json' },
      { uri: `${base}/runtime-profile`, name: `${p.displayName} runtime profile`, mimeType: 'application/json' },
      { uri: `${base}/tool-manifest`, name: `${p.displayName} tool manifest`, mimeType: 'application/json' },
      { uri: `${base}/tree`, name: `${p.displayName} directory tree`, mimeType: 'application/json' },
      { uri: `${base}/git/status`, name: `${p.displayName} git status`, mimeType: 'application/json' }
    );
    if (hasReadme(p)) resources.push({ uri: `${base}/readme`, name: `${p.displayName} README`, mimeType: 'text/markdown' });
    if (hasPackageJson(p)) resources.push({ uri: `${base}/package`, name: `${p.displayName} package.json`, mimeType: 'application/json' });
  }
  return resources;
}

export function listRepoResourceTemplates(_context = {}) {
  return [
    { uriTemplate: 'repo://project/{projectId}/file/{path}', name: 'Project file', mimeType: 'text/plain' },
    { uriTemplate: 'repo://project/{projectId}/tree{?depth}', name: 'Project tree', mimeType: 'application/json' },
    { uriTemplate: 'repo://project/{projectId}/git/diff{?staged}', name: 'Git diff', mimeType: 'text/plain' }
  ];
}

function safeRelativePath(project, encodedPath) {
  const decoded = decodeURIComponent(encodedPath || '');
  if (!decoded || path.isAbsolute(decoded) || decoded.split(/[\\/]+/).includes('..')) throw new Error('Invalid project-relative resource path.');
  const resolved = path.resolve(project.repoRoot, decoded);
  const rel = path.relative(project.repoRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Resource path escapes project root.');
  return resolved;
}

export async function readRepoResource(uri, context = {}) {
  const parsed = new URL(uri);
  if (parsed.protocol === 'skill:') return readSkillResource(uri);
  if (parsed.protocol !== 'repo:') throw new Error(`Unsupported resource URI: ${uri}`);
  if (uri === 'repo://projects') {
    const result = listProjects(context, { limit: 200 });
    return jsonContent(uri, { projects: result.items, pathExposure: result.pathExposure, nextCursor: result.nextCursor });
  }

  const match = uri.match(/^repo:\/\/project\/([^/?#]+)\/(.+)$/);
  if (!match) throw new Error(`Unknown resource URI: ${uri}`);
  const project = getProject(context, decodeURIComponent(match[1]));
  const rest = match[2].replace(/[?#].*$/, '');

  if (rest === 'summary') return jsonContent(uri, await inspectProject(context, { projectId: project.projectId, view: 'summary' }));
  if (rest === 'runtime-profile' || rest === 'safety-profile') return jsonContent(uri, buildRuntimeProfileStatus(context.env || process.env));
  if (rest === 'tool-manifest') {
    const runtimeProfile = getRuntimeProfile(context.env || process.env);
    const tools = (context.listTools ? await context.listTools() : []).map(applyToolRisk);
    return jsonContent(uri, { profile: runtimeProfile.name, tools: buildToolRiskManifest(tools, runtimeProfile) });
  }
  if (rest === 'readme') {
    const result = await inspectProject(context, { projectId: project.projectId, view: 'readme' });
    return textContent(uri, result.text, 'text/markdown');
  }
  if (rest === 'package') {
    const result = await inspectProject(context, { projectId: project.projectId, view: 'package' });
    return jsonContent(uri, result.data);
  }
  if (rest === 'tree') {
    const depthText = parsed.searchParams.get('depth');
    const depthNumber = depthText === null || depthText === '' ? 3 : Number(depthText);
    const depth = Number.isInteger(depthNumber) && depthNumber >= 1 && depthNumber <= 10 ? depthNumber : 3;
    return jsonContent(uri, await inspectProject(context, { projectId: project.projectId, view: 'tree', depth, limit: 500 }));
  }
  if (rest === 'git/status') return jsonContent(uri, await inspectProject(context, { projectId: project.projectId, view: 'git_status' }));
  if (rest === 'git/diff') {
    const result = await inspectProject(context, { projectId: project.projectId, view: 'git_diff', staged: parsed.searchParams.get('staged') === 'true' });
    return textContent(uri, result.text, 'text/plain');
  }
  if (rest.startsWith('file/')) {
    const filePath = safeRelativePath(project, rest.slice('file/'.length));
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error('Resource file path must point to a regular file.');
    if (stat.size > MAX_RESOURCE_FILE_BYTES) throw new Error(`Resource file is too large for text preview: ${stat.size} bytes.`);
    const buffer = await fs.promises.readFile(filePath);
    if (looksBinary(buffer)) throw new Error('Resource file appears to be binary; text resources only support textual files.');
    return textContent(uri, buffer.toString('utf8'), 'text/plain');
  }
  throw new Error(`Unknown resource URI: ${uri}`);
}
