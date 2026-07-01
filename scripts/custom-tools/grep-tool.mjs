import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadGatewayFlowConfig } from '../gateway-flow-config.mjs';
import { defaultExcludePatterns, resolveInsideTrustedRoots, toRelativeFromRoot, walkFiles } from './path-utils.mjs';
import { fail, ok } from './response-utils.mjs';

const REQUIRED_EXCLUDES = [
  'node_modules/**',
  '**/node_modules/**',
  '.git/**',
  '**/.git/**',
  'dist/**',
  '**/dist/**',
  'build/**',
  '**/build/**'
];

function isBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

function buildMatcher(args) {
  if (typeof args.query !== 'string' || args.query.length === 0) throw new Error('query is required');
  if (args.regex) return new RegExp(args.query, args.caseSensitive ? 'g' : 'gi');
  const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
  return { plain: true, needle };
}

function flowConfig(context = {}) {
  return loadGatewayFlowConfig({ env: context.env || process.env, repoRoot: context.packageRoot || process.cwd() });
}

function normalizeSearchOptions(args = {}, config = {}) {
  const searchConfig = config.search || {};
  const maxLimit = Math.min(50, Math.max(1, Number(searchConfig.max_limit || 50)));
  const defaultLimit = Math.min(maxLimit, Math.max(1, Number(searchConfig.default_limit || 50)));
  const rawLimit = args.limit ?? args.maxResults ?? defaultLimit;
  const limit = Math.min(maxLimit, Math.max(1, Number(rawLimit || defaultLimit)));
  const offset = Math.max(0, Number(args.offset || 0));
  const previewChars = Math.max(1, Number(searchConfig.preview_chars || 150));
  const contextLines = Math.max(0, Number(args.contextLines || 0));
  const mandatoryExcludes = [...new Set([...(searchConfig.mandatory_excludes || []), ...REQUIRED_EXCLUDES])];
  const exclude = [...new Set([...mandatoryExcludes, ...(args.exclude || [])])];
  const include = args.include?.length ? args.include : ['**/*'];
  return { limit, offset, previewChars, contextLines, include, exclude };
}

function truncatePreview(line, previewChars) {
  const value = String(line ?? '').replace(/[\r\n]+$/, '');
  if (value.length <= previewChars) return { preview: value, truncated: false };
  return { preview: value.slice(0, previewChars), truncated: true };
}

function rgArgs(args, targetPath, options) {
  const commandArgs = ['--json', '--line-number', '--column', '--hidden'];
  for (const pattern of options.include) commandArgs.push('--glob', pattern);
  for (const pattern of options.exclude) commandArgs.push('--glob', `!${pattern}`);
  if (options.contextLines > 0) commandArgs.push('-C', String(options.contextLines));
  if (!args.regex) commandArgs.push('-F');
  if (!args.caseSensitive) commandArgs.push('-i');
  commandArgs.push(String(args.query), targetPath);
  return commandArgs;
}

function ripgrepTargetPath(target) {
  const relative = toRelativeFromRoot(target.path, target.root);
  return relative && relative !== '.' ? relative : '.';
}

async function runRipgrep(args, target, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn('rg', rgArgs(args, ripgrepTargetPath(target), options), { cwd: target.root, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => reject(error));
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (![0, 1].includes(code)) {
        const error = new Error(stderr || `ripgrep exited with code ${code}`);
        error.code = 'RG_ERROR';
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function resolveRipgrepPath(pathText, root) {
  return path.isAbsolute(pathText) ? pathText : path.join(root, pathText || '.');
}

function contextForRipgrepMatch(events, pathText, line, contextLines) {
  if (contextLines <= 0) return null;
  const context = events
    .filter(event => ['context', 'match'].includes(event.type))
    .filter(event => event.data?.path?.text === pathText)
    .filter(event => Math.abs(Number(event.data?.line_number || 0) - line) <= contextLines)
    .map(event => String(event.data?.lines?.text || '').replace(/[\r\n]+$/, ''));
  return context.length ? context : null;
}

function parseRipgrepJson(stdout, root, options) {
  const matches = [];
  const searchedFiles = new Set();
  const events = [];
  let seenMatches = 0;
  let hasMore = false;
  let truncatedPreview = false;

  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    try { events.push(JSON.parse(rawLine)); } catch {}
  }

  for (const event of events) {
    if (event.type === 'begin' && event.data?.path?.text) searchedFiles.add(event.data.path.text);
    if (event.type !== 'match') continue;
    const pathText = event.data?.path?.text || '';
    const line = Number(event.data?.line_number || 0);
    const submatch = event.data?.submatches?.[0];
    const column = Number(submatch?.start || 0) + 1;
    const preview = truncatePreview(event.data?.lines?.text || '', options.previewChars);
    truncatedPreview = truncatedPreview || preview.truncated;
    if (seenMatches >= options.offset && matches.length < options.limit) {
      const entry = {
        path: toRelativeFromRoot(resolveRipgrepPath(pathText, root), root),
        line,
        column,
        preview: preview.preview
      };
      const context = contextForRipgrepMatch(events, pathText, line, options.contextLines);
      if (context) entry.context = context;
      matches.push(entry);
    }
    seenMatches += 1;
    if (seenMatches > options.offset + options.limit) {
      hasMore = true;
      break;
    }
  }

  return {
    matches,
    offset: options.offset,
    limit: options.limit,
    nextOffset: hasMore ? options.offset + options.limit : null,
    hasMore,
    truncated: hasMore,
    truncatedPreview,
    engine: 'ripgrep',
    searchedFiles: searchedFiles.size
  };
}

async function fallbackSearch(args, target, options) {
  const stat = await fs.promises.stat(target.path);
  const contextLines = options.contextLines;
  const matcher = buildMatcher(args);
  const files = stat.isDirectory() ? await walkFiles(target.path, target.root, { include: options.include, exclude: defaultExcludePatterns(options.exclude) }) : [target.path];
  const matches = [];
  let seenMatches = 0;
  let searchedFiles = 0;
  let hasMore = false;
  let truncatedPreview = false;

  for (const file of files) {
    if (seenMatches > options.offset + options.limit) break;
    const buffer = await fs.promises.readFile(file);
    if (isBinary(buffer)) continue;
    searchedFiles += 1;
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      let column = -1;
      if (matcher.plain) column = (args.caseSensitive ? line : line.toLowerCase()).indexOf(matcher.needle);
      else {
        matcher.lastIndex = 0;
        const found = matcher.exec(line);
        column = found ? found.index : -1;
      }
      if (column < 0) continue;
      if (seenMatches >= options.offset && matches.length < options.limit) {
        const preview = truncatePreview(line, options.previewChars);
        truncatedPreview = truncatedPreview || preview.truncated;
        const entry = { path: toRelativeFromRoot(file, target.root), line: index + 1, column: column + 1, preview: preview.preview };
        if (contextLines > 0) {
          entry.context = lines.slice(Math.max(0, index - contextLines), Math.min(lines.length, index + contextLines + 1));
        }
        matches.push(entry);
      }
      seenMatches += 1;
      if (seenMatches > options.offset + options.limit) {
        hasMore = true;
        break;
      }
    }
  }

  return {
    matches,
    offset: options.offset,
    limit: options.limit,
    nextOffset: hasMore ? options.offset + options.limit : null,
    hasMore,
    truncated: hasMore,
    truncatedPreview,
    engine: 'node-fallback',
    searchedFiles
  };
}

export async function grepTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    buildMatcher(args);
    const options = normalizeSearchOptions(args, flowConfig(context));
    let data;
    try {
      data = parseRipgrepJson(await runRipgrep(args, target, options), target.root, options);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      data = await fallbackSearch(args, target, options);
    }
    return ok('grep', `Found ${data.matches.length} match(es)`, data);
  } catch (error) {
    return fail('grep', error.code || 'VALIDATION_ERROR', error.message, error.details || {});
  }
}
