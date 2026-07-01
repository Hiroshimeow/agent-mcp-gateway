import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fail } from './response-utils.mjs';
import { getTrustedRoots, normalizeWindowsPath } from './path-utils.mjs';

const TOOL = 'image_preview';
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_BYTES_LIMIT = 32 * 1024 * 1024;
const IMAGE_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif']
]);

function bool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

function numberInRange(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function imagePreviewRoots(context = {}) {
  const roots = [...getTrustedRoots(context)];
  const home = os.homedir();
  if (home) {
    roots.push(path.join(home, 'Downloads'));
    roots.push(path.join(home, 'Pictures'));
    roots.push(path.join(home, 'Desktop'));
  }
  const extra = String(process.env.MCP_IMAGE_PREVIEW_ROOTS || '')
    .split(/[;\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  roots.push(...extra);
  return [...new Set(roots.map(root => path.resolve(normalizeWindowsPath(root))))];
}

function resolveInsideImagePreviewRoots(inputPath, context = {}) {
  const resolved = path.resolve(normalizeWindowsPath(inputPath));
  const roots = imagePreviewRoots(context);
  const root = roots.find(candidate => {
    const relative = path.relative(candidate, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!root) {
    const error = new Error(`Path is outside image preview scope: ${inputPath}`);
    error.code = 'PATH_OUT_OF_SCOPE';
    error.details = { path: resolved, trustedRoots: roots };
    throw error;
  }
  return { path: resolved, root };
}

async function imageContent(filePath, includeImage) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    const error = new Error(`Path is not a file: ${filePath}`);
    error.code = 'NOT_FILE';
    error.details = { path: filePath };
    throw error;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_EXT.get(ext);
  if (!mimeType) {
    const error = new Error('Unsupported image file type.');
    error.code = 'UNSUPPORTED_FILE';
    error.details = { path: filePath, supported: [...IMAGE_EXT.keys()] };
    throw error;
  }
  const meta = { path: filePath, bytes: stat.size, mimeType, ext, modifiedAt: stat.mtime.toISOString() };
  if (!includeImage) return { meta, image: null };
  const data = await fs.promises.readFile(filePath, 'base64');
  return { meta, image: { type: 'image', data, mimeType } };
}

export async function imagePreviewTool(args = {}, context = {}) {
  const input = args.path || args.file || args.sourcePath;
  if (!input || typeof input !== 'string') {
    return fail(TOOL, 'PATH_REQUIRED', 'path is required.');
  }
  try {
    const checked = resolveInsideImagePreviewRoots(input, context);
    await fs.promises.access(checked.path, fs.constants.R_OK);
    const stat = await fs.promises.stat(checked.path);
    const maxBytes = numberInRange(args.maxBytes, DEFAULT_MAX_BYTES, 1, MAX_BYTES_LIMIT);
    if (stat.size > maxBytes) {
      return fail(TOOL, 'FILE_TOO_LARGE', 'File is larger than maxBytes.', {
        path: checked.path,
        bytes: stat.size,
        maxBytes
      });
    }
    const includeImage = bool(args.embed ?? args.includeImage ?? args.includeData, true);
    const { meta, image } = await imageContent(checked.path, includeImage);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            tool: 'custom_image_preview',
            summary: image ? 'Loaded image preview content.' : 'Loaded image preview metadata.',
            data: {
              ...meta,
              source: 'file',
              root: checked.root,
              embedded: Boolean(image)
            }
          }, null, 2)
        },
        ...(image ? [image] : [])
      ]
    };
  } catch (error) {
    return fail(TOOL, error.code || 'IMAGE_PREVIEW_FAILED', error.message, error.details || {});
  }
}
