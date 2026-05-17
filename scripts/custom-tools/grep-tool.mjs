import fs from 'node:fs';
import path from 'node:path';
import { defaultExcludePatterns, resolveInsideTrustedRoots, toRelativeFromRoot, walkFiles } from './path-utils.mjs';
import { fail, ok } from './response-utils.mjs';

function isBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

function buildMatcher(args) {
  if (typeof args.query !== 'string' || args.query.length === 0) throw new Error('query is required');
  if (args.regex) return new RegExp(args.query, args.caseSensitive ? 'g' : 'gi');
  const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
  return { plain: true, needle };
}

export async function grepTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    const stat = await fs.promises.stat(target.path);
    const root = target.root;
    const include = args.include?.length ? args.include : ['**/*'];
    const exclude = defaultExcludePatterns(args.exclude || []);
    const maxResults = Math.max(1, Number(args.maxResults || 100));
    const contextLines = Math.max(0, Number(args.contextLines || 0));
    const matcher = buildMatcher(args);
    const files = stat.isDirectory() ? await walkFiles(target.path, root, { include, exclude }) : [target.path];
    const matches = [];
    let searchedFiles = 0;

    for (const file of files) {
      if (matches.length >= maxResults) break;
      const buffer = await fs.promises.readFile(file);
      if (isBinary(buffer)) continue;
      searchedFiles += 1;
      const text = buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        let column = -1;
        if (matcher.plain) column = (args.caseSensitive ? line : line.toLowerCase()).indexOf(matcher.needle);
        else {
          matcher.lastIndex = 0;
          const found = matcher.exec(line);
          column = found ? found.index : -1;
        }
        if (column >= 0) {
          const entry = { path: toRelativeFromRoot(file, root), line: i + 1, column: column + 1, preview: line };
          if (contextLines > 0) {
            entry.context = lines.slice(Math.max(0, i - contextLines), Math.min(lines.length, i + contextLines + 1));
          }
          matches.push(entry);
          if (matches.length >= maxResults) break;
        }
      }
    }

    return ok('grep', `Found ${matches.length} match(es)`, { matches, truncated: matches.length >= maxResults, searchedFiles });
  } catch (error) {
    return fail('grep', error.code || 'VALIDATION_ERROR', error.message, error.details || {});
  }
}
