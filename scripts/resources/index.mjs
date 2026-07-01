import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { buildRuntimeProfileStatus, getRuntimeProfile } from '../runtime-profile.mjs';
import { applyToolRisk, buildToolRiskManifest } from '../tool-risk.mjs';
import { listSkillResources, readSkillResource } from '../skills/index.mjs';

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'logs', 'packages', '_zip_temp']);
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

function exposePaths(context) {
  return Boolean(context.projectRegistry?.exposeProjectPaths || context.env?.MCP_EXPOSE_PROJECT_PATHS === 'true');
}

function hasReadme(project) {
  return fs.existsSync(path.join(project.repoRoot, 'README.md')) || fs.existsSync(path.join(project.repoRoot, 'README.vi.md'));
}

function hasPackageJson(project) {
  return fs.existsSync(path.join(project.repoRoot, 'package.json'));
}

function projectSummary(project, context) {
  const data = {
    projectId: project.projectId,
    displayName: project.displayName,
    defaultRootName: path.basename(project.repoRoot) || project.projectId,
    default: context.projectRegistry?.defaultProjectId === project.projectId,
    hasPackageJson: hasPackageJson(project),
    hasReadme: hasReadme(project),
    runtimeProfile: getRuntimeProfile(context.env || process.env).name
  };
  if (exposePaths(context)) data.repoRoot = project.repoRoot;
  return data;
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

function readTree(root, maxDepth = 3, maxEntries = 500) {
  let count = 0;
  function walk(dir, depth) {
    if (count >= maxEntries) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !DEFAULT_EXCLUDES.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    const out = [];
    for (const entry of entries) {
      if (count >= maxEntries) break;
      count += 1;
      const item = { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' };
      if (entry.isDirectory() && depth < maxDepth) item.children = walk(path.join(dir, entry.name), depth + 1);
      out.push(item);
    }
    return out;
  }
  return { rootName: path.basename(root), maxDepth, maxEntries, truncated: count >= maxEntries, entries: walk(root, 1) };
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
  return { projectId: project.projectId, ok: result.ok, status: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

async function gitDiff(project, staged = false) {
  const result = await execGitRead(project.repoRoot, staged ? ['diff', '--staged'] : ['diff']);
  return textContent(`repo://project/${encodeURIComponent(project.projectId)}/git/diff${staged ? '?staged=true' : ''}`, result.ok ? result.stdout : result.stderr, 'text/plain');
}

export async function readRepoResource(uri, context = {}) {
  const parsed = new URL(uri);
  if (parsed.protocol === 'skill:') return readSkillResource(uri);
  if (parsed.protocol !== 'repo:') throw new Error(`Unsupported resource URI: ${uri}`);
  if (uri === 'repo://projects') {
    const projects = [...(context.projectRegistry?.projects?.values() || [])].map(project => {
      const item = { projectId: project.projectId, displayName: project.displayName, default: context.projectRegistry?.defaultProjectId === project.projectId };
      if (exposePaths(context)) item.repoRoot = project.repoRoot;
      return item;
    });
    return jsonContent(uri, { projects, pathExposure: exposePaths(context) });
  }

  const match = uri.match(/^repo:\/\/project\/([^/?#]+)\/(.+)$/);
  if (!match) throw new Error(`Unknown resource URI: ${uri}`);
  const project = getProject(context, decodeURIComponent(match[1]));
  const rest = match[2].replace(/[?#].*$/, '');

  if (rest === 'summary') return jsonContent(uri, projectSummary(project, context));
  if (rest === 'runtime-profile' || rest === 'safety-profile') return jsonContent(uri, buildRuntimeProfileStatus(context.env || process.env));
  if (rest === 'tool-manifest') {
    const runtimeProfile = getRuntimeProfile(context.env || process.env);
    const tools = (context.listTools ? await context.listTools() : []).map(applyToolRisk);
    return jsonContent(uri, { profile: runtimeProfile.name, tools: buildToolRiskManifest(tools, runtimeProfile) });
  }
  if (rest === 'readme') {
    const readme = ['README.md', 'README.vi.md'].map(name => path.join(project.repoRoot, name)).find(file => fs.existsSync(file));
    if (!readme) throw new Error('README resource not found.');
    return textContent(uri, await fs.promises.readFile(readme, 'utf8'), 'text/markdown');
  }
  if (rest === 'package') {
    const pkg = path.join(project.repoRoot, 'package.json');
    if (!fs.existsSync(pkg)) throw new Error('package.json resource not found.');
    return jsonContent(uri, JSON.parse(await fs.promises.readFile(pkg, 'utf8')));
  }
  if (rest === 'tree') {
    const requestedDepth = Number(parsed.searchParams.get('depth') || 3);
    const depth = Number.isFinite(requestedDepth) ? Math.max(1, Math.min(10, requestedDepth)) : 3;
    return jsonContent(uri, readTree(project.repoRoot, depth));
  }
  if (rest === 'git/status') return jsonContent(uri, await gitStatus(project));
  if (rest === 'git/diff') return await gitDiff(project, parsed.searchParams.get('staged') === 'true');
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
