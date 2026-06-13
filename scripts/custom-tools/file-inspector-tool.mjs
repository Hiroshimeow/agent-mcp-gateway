import fs from 'node:fs';
import path from 'node:path';
import { loadGatewayFlowConfig } from '../gateway-flow-config.mjs';
import { resolveInsideTrustedRoots, toRelativeFromRoot } from './path-utils.mjs';
import { fail, ok } from './response-utils.mjs';

const DEFAULT_NOISY_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);

function getFlowConfig(context = {}) {
  return loadGatewayFlowConfig({ env: context.env || process.env, repoRoot: context.packageRoot || process.cwd() });
}

function asPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function asNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function isBinaryBuffer(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

async function isBinaryFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return isBinaryBuffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function readTextFile(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  if (isBinaryBuffer(buffer)) {
    const error = new Error('Binary files are not supported by file_inspector text actions.');
    error.code = 'BINARY_FILE';
    throw error;
  }
  return buffer.toString('utf8');
}

function splitLines(text) {
  return String(text ?? '').split(/\r?\n/);
}

function lineCountFromText(text) {
  if (text === '') return 0;
  const lines = splitLines(text);
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function truncateLine(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return { text: value, line_truncated: false };
  return { text: value.slice(0, maxChars), line_truncated: true };
}

function buildLineRows(lines, startLine, endLine, previewChars) {
  const rows = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const truncated = truncateLine(lines[lineNumber - 1] ?? '', previewChars);
    rows.push({ line: lineNumber, ...truncated });
  }
  return rows;
}

function normalizeLineRange(args, totalLines, maxLines, defaultMaxLines) {
  const startLine = asPositiveInt(args.start_line ?? 1, 1);
  const requestedEnd = args.end_line === undefined || args.end_line === null
    ? startLine + defaultMaxLines - 1
    : asPositiveInt(args.end_line, startLine);
  const clampedStart = Math.min(startLine, Math.max(totalLines, 1));
  const clampedEnd = Math.min(totalLines, Math.max(clampedStart, Math.min(requestedEnd, clampedStart + maxLines - 1)));
  return { startLine: clampedStart, endLine: clampedEnd, requestedEnd };
}

async function metadataAction(args, context) {
  const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
  const stat = await fs.promises.stat(target.path);
  const data = {
    path: toRelativeFromRoot(target.path, target.root),
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
  if (stat.isFile() && !(await isBinaryFile(target.path))) {
    data.lineCount = lineCountFromText(await fs.promises.readFile(target.path, 'utf8'));
  }
  return ok('file_inspector', 'Read path metadata', data);
}

async function readAction(args, context) {
  const flowConfig = getFlowConfig(context);
  const maxLines = asPositiveInt(flowConfig.file_read?.max_lines, 500);
  const defaultMaxLines = asPositiveInt(flowConfig.file_read?.default_max_lines, maxLines);
  const previewChars = asPositiveInt(flowConfig.file_read?.preview_chars, 150);
  const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
  const stat = await fs.promises.stat(target.path);
  if (!stat.isFile()) throw new Error('Read action requires a file path.');
  const text = await readTextFile(target.path);
  const lines = splitLines(text);
  const totalLines = lineCountFromText(text);
  if (totalLines === 0) {
    return ok('file_inspector', 'Read file line range', {
      path: toRelativeFromRoot(target.path, target.root),
      total_lines: 0,
      start_line: 0,
      end_line: 0,
      has_more: false,
      lines: []
    });
  }
  const { startLine, endLine } = normalizeLineRange(args, totalLines, maxLines, defaultMaxLines);
  return ok('file_inspector', 'Read file line range', {
    path: toRelativeFromRoot(target.path, target.root),
    total_lines: totalLines,
    start_line: startLine,
    end_line: endLine,
    next_start_line: endLine < totalLines ? endLine + 1 : null,
    has_more: endLine < totalLines,
    lines: buildLineRows(lines, startLine, endLine, previewChars)
  });
}

async function listAction(args, context) {
  const flowConfig = getFlowConfig(context);
  const listConfig = flowConfig.list_directory || {};
  const maxEntries = asPositiveInt(listConfig.max_entries, 200);
  const maxDepth = asPositiveInt(args.maxDepth ?? listConfig.default_max_depth, 1);
  const offset = asNonNegativeInt(args.offset, 0);
  const limit = Math.min(maxEntries, asPositiveInt(args.limit, maxEntries));
  const hideDotFolders = listConfig.hide_dot_folders !== false;
  const hideBinaryFiles = listConfig.hide_binary_files !== false;
  const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
  const entries = [];

  async function visit(currentPath, depth) {
    if (entries.length > offset + limit) return;
    const children = await fs.promises.readdir(currentPath, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      if (entries.length > offset + limit) return;
      if (entry.isDirectory() && (DEFAULT_NOISY_DIRS.has(entry.name) || (hideDotFolders && entry.name.startsWith('.')))) continue;
      const fullPath = path.join(currentPath, entry.name);
      const stat = await fs.promises.stat(fullPath);
      if (entry.isFile() && hideBinaryFiles && await isBinaryFile(fullPath)) continue;
      entries.push({
        path: toRelativeFromRoot(fullPath, target.root),
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        depth
      });
      if (entry.isDirectory() && depth < maxDepth) await visit(fullPath, depth + 1);
    }
  }

  const stat = await fs.promises.stat(target.path);
  if (stat.isDirectory()) await visit(target.path, 1);
  else entries.push({ path: toRelativeFromRoot(target.path, target.root), type: 'file', size: stat.size, mtimeMs: stat.mtimeMs, depth: 0 });
  const paged = entries.slice(offset, offset + limit);
  return ok('file_inspector', 'Listed path entries', {
    path: toRelativeFromRoot(target.path, target.root),
    entries: paged,
    offset,
    limit,
    nextOffset: offset + paged.length < entries.length ? offset + paged.length : null,
    hasMore: offset + paged.length < entries.length,
    maxDepth,
    totalBuffered: entries.length
  });
}

function normalizeReplacements(args, totalLines) {
  const raw = Array.isArray(args.replacements) && args.replacements.length > 0
    ? args.replacements
    : [{ start_line: args.start_line, end_line: args.end_line, text: args.newText }];
  const replacements = raw.map(item => {
    const startLine = asPositiveInt(item.start_line, 0);
    const endLine = asPositiveInt(item.end_line ?? item.start_line, startLine);
    if (!startLine || !endLine || endLine < startLine) throw new Error('Invalid line replacement range.');
    if (startLine < 1 || endLine > totalLines) throw new Error('Line replacement range is outside file bounds.');
    return { startLine, endLine, text: String(item.text ?? '') };
  }).sort((a, b) => a.startLine - b.startLine);

  for (let index = 1; index < replacements.length; index += 1) {
    if (replacements[index].startLine <= replacements[index - 1].endLine) throw new Error('Line replacement ranges must not overlap.');
  }
  if (replacements.length === 1 && replacements[0].startLine === 1 && replacements[0].endLine === totalLines && totalLines > 0) {
    throw new Error('Full-file line replacement is not available. Use targeted ranges.');
  }
  return replacements;
}

function buildPreviewDiff(relativePath, beforeText, afterText) {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const max = Math.max(beforeLines.length, afterLines.length);
  const out = [`--- a/${relativePath}`, `+++ b/${relativePath}`];
  for (let index = 0; index < max; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (beforeLines[index] !== undefined) out.push(`-${beforeLines[index]}`);
    if (afterLines[index] !== undefined) out.push(`+${afterLines[index]}`);
  }
  return out.join('\n');
}

async function replaceLinesAction(args, context) {
  const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
  const stat = await fs.promises.stat(target.path);
  if (!stat.isFile()) throw new Error('replace_lines action requires a file path.');
  const before = await readTextFile(target.path);
  const lineEnding = before.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(before);
  const totalLines = lineCountFromText(before);
  const replacements = normalizeReplacements(args, totalLines);
  const nextLines = [...lines];
  for (const replacement of [...replacements].reverse()) {
    nextLines.splice(replacement.startLine - 1, replacement.endLine - replacement.startLine + 1, ...String(replacement.text).split(/\r?\n/));
  }
  const after = nextLines.join(lineEnding);
  const relativePath = toRelativeFromRoot(target.path, target.root);
  const diff = buildPreviewDiff(relativePath, before, after);
  if (!args.dryRun) await fs.promises.writeFile(target.path, after, 'utf8');
  return ok('file_inspector', args.dryRun ? 'Prepared line replacement preview' : 'Applied line replacements', {
    path: relativePath,
    dryRun: Boolean(args.dryRun),
    replacements: replacements.map(item => ({ start_line: item.startLine, end_line: item.endLine })),
    diff
  });
}

async function replaceTextAction(args, context) {
  const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
  const stat = await fs.promises.stat(target.path);
  if (!stat.isFile()) throw new Error('replace_text action requires a file path.');
  const oldText = String(args.oldText ?? '');
  if (!oldText) throw new Error('oldText is required for replace_text.');
  const newText = String(args.newText ?? '');
  const before = await readTextFile(target.path);
  const count = before.split(oldText).length - 1;
  if (count === 0) throw new Error('oldText was not found.');
  if (count > 1 && !args.replaceAll) {
    return ok('file_inspector', 'Multiple exact matches found; provide a narrower oldText or replaceAll=true', {
      path: toRelativeFromRoot(target.path, target.root),
      matchCount: count,
      applied: false,
      dryRun: Boolean(args.dryRun)
    });
  }
  const after = args.replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, newText);
  const relativePath = toRelativeFromRoot(target.path, target.root);
  const diff = buildPreviewDiff(relativePath, before, after);
  if (!args.dryRun) await fs.promises.writeFile(target.path, after, 'utf8');
  return ok('file_inspector', args.dryRun ? 'Prepared text replacement preview' : 'Applied text replacement', {
    path: relativePath,
    matchCount: count,
    applied: !args.dryRun,
    dryRun: Boolean(args.dryRun),
    diff
  });
}

export async function fileInspectorTool(args = {}, context = {}) {
  const action = String(args.action || 'metadata');
  try {
    if (action === 'metadata') return await metadataAction(args, context);
    if (action === 'read') return await readAction(args, context);
    if (action === 'list') return await listAction(args, context);
    if (action === 'replace_lines') return await replaceLinesAction(args, context);
    if (action === 'replace_text') return await replaceTextAction(args, context);
    throw new Error(`Unsupported file_inspector action: ${action}`);
  } catch (error) {
    return fail('file_inspector', error.code || 'VALIDATION_ERROR', error.message, error.details || {});
  }
}
