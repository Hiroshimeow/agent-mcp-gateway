import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_EXCLUDES = ['node_modules/**', '.git/**', 'logs/**', 'packages/**', '_zip_temp/**'];

export function normalizeWindowsPath(value) {
  return String(value ?? '').trim().replace(/^['"]|['"]$/g, '').replace(/^\\\\\?\\/, '').replaceAll('/', path.sep);
}

export function getTrustedRoots(context = {}) {
  const roots = Array.isArray(context.resolvedRepoRoots) && context.resolvedRepoRoots.length > 0
    ? context.resolvedRepoRoots
    : [context.resolvedRepoRoot || context.packageRoot || process.cwd()];
  return [...new Set(roots.filter(Boolean).map(root => path.resolve(normalizeWindowsPath(root))))];
}

export function assertInsideTrustedRoots(targetPath, roots) {
  const resolved = path.resolve(normalizeWindowsPath(targetPath));
  const trustedRoots = getTrustedRoots({ resolvedRepoRoots: roots });
  const root = trustedRoots.find(candidate => {
    const relative = path.relative(candidate, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!root) {
    const error = new Error(`Path is outside trusted roots: ${targetPath}`);
    error.code = 'PATH_OUTSIDE_TRUSTED_ROOTS';
    error.details = { path: targetPath, trustedRoots };
    throw error;
  }
  return { path: resolved, root };
}

export function resolveInsideTrustedRoots(inputPath, context = {}, options = {}) {
  const roots = getTrustedRoots(context);
  const base = options.workingDirectory
    ? assertInsideTrustedRoots(options.workingDirectory, roots).path
    : roots[0];
  const raw = inputPath === undefined || inputPath === null || String(inputPath).trim() === '' ? base : normalizeWindowsPath(inputPath);
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  const checked = assertInsideTrustedRoots(resolved, roots);
  if (options.mustExist && !fs.existsSync(checked.path)) {
    const error = new Error(`Path does not exist: ${checked.path}`);
    error.code = 'PATH_NOT_FOUND';
    error.details = { path: checked.path };
    throw error;
  }
  return checked;
}

export function toRelativeFromRoot(targetPath, root) {
  return path.relative(path.resolve(root), path.resolve(targetPath)).replaceAll(path.sep, '/');
}

export function defaultExcludePatterns(extra = [], options = {}) {
  const base = DEFAULT_EXCLUDES.filter(pattern => !options.includeGit || pattern !== '.git/**');
  return [...new Set([...base, ...extra])];
}

function escapeRegex(text) {
  return String(text).replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(pattern) {
  const normalized = String(pattern || '**/*').replaceAll('\\', '/');
  let out = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === '*' && next === '*') {
      const after = normalized[i + 2];
      if (after === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(ch);
    }
  }
  out += '$';
  return new RegExp(out);
}

export function matchesAnyGlob(relativePath, patterns = ['**/*']) {
  const value = String(relativePath).replaceAll('\\', '/');
  return patterns.some(pattern => globToRegExp(pattern).test(value));
}

export function shouldExclude(relativePath, patterns = []) {
  const value = String(relativePath).replaceAll('\\', '/');
  return patterns.some(pattern => globToRegExp(pattern).test(value) || value === String(pattern).replace(/\/\*\*$/, ''));
}

export async function walkFiles(startPath, root, options = {}) {
  const include = options.include?.length ? options.include : ['**/*'];
  const exclude = options.exclude || defaultExcludePatterns();
  const files = [];
  async function visit(current) {
    const stat = await fs.promises.stat(current);
    const rel = toRelativeFromRoot(current, root);
    if (rel && shouldExclude(rel, exclude)) return;
    if (stat.isDirectory()) {
      const entries = await fs.promises.readdir(current);
      for (const entry of entries) await visit(path.join(current, entry));
      return;
    }
    if (stat.isFile() && matchesAnyGlob(rel, include) && !shouldExclude(rel, exclude)) files.push(current);
  }
  await visit(startPath);
  return files;
}
