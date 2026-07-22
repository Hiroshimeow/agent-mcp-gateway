import fs from 'node:fs';
import path from 'node:path';

export function assertSafeRelativePath(value, label) {
  const normalized = path.normalize(String(value || ''));
  if (!normalized || path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
    throw new Error(`Unsafe ${label} path: ${value}`);
  }
  return normalized;
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe ${label} path: ${candidate}`);
  }
}

export function resolveSafeFile(root, relativePath, label, {
  maxFileBytes = Number.POSITIVE_INFINITY,
  forbiddenExtensions = new Set()
} = {}) {
  const rootReal = fs.realpathSync(root);
  const normalized = assertSafeRelativePath(relativePath, label);
  const candidate = path.resolve(rootReal, normalized);
  assertContained(rootReal, candidate, label);

  let current = rootReal;
  for (const segment of path.relative(rootReal, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) throw new Error(`Missing ${label}: ${current}`);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink is not allowed for ${label}: ${current}`);
    }
  }

  const resolved = fs.realpathSync(candidate);
  assertContained(rootReal, resolved, label);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile()) throw new Error(`Expected file for ${label}: ${resolved}`);
  if (stat.size > maxFileBytes) throw new Error(`${label} exceeds ${maxFileBytes} bytes: ${resolved}`);
  if (forbiddenExtensions.has(path.extname(resolved).toLowerCase())) {
    throw new Error(`Font files are not vendored: ${resolved}`);
  }
  return resolved;
}
