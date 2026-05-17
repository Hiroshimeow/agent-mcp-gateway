import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeGit } from './command-utils.mjs';
import { resolveInsideTrustedRoots } from './path-utils.mjs';
import { fail, ok } from './response-utils.mjs';

function parsePatchFiles(patch) {
  const files = new Set();
  for (const line of String(patch || '').split(/\r?\n/)) {
    const match = line.match(/^(?:---|\+\+\+)\s+(?:a|b)\/(.+)$/);
    if (match && match[1] !== '/dev/null') files.add(match[1]);
    const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitMatch) { files.add(gitMatch[1]); files.add(gitMatch[2]); }
  }
  return [...files];
}

export async function applyPatchTool(args = {}, context = {}) {
  const tool = 'apply_patch';
  let tempFile = '';
  try {
    if (!args.patch || typeof args.patch !== 'string') throw new Error('patch is required.');
    const cwd = resolveInsideTrustedRoots(args.workingDirectory, context, { mustExist: true }).path;
    const files = parsePatchFiles(args.patch);
    for (const file of files) resolveInsideTrustedRoots(file, context, { workingDirectory: cwd });
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-patch-'));
    tempFile = path.join(tmpDir, 'change.patch');
    await fs.promises.writeFile(tempFile, args.patch, 'utf8');
    await executeGit(['apply', '--check', tempFile], { cwd, timeout: 300000 });
    if (!args.dryRun) await executeGit(['apply', tempFile], { cwd, timeout: 300000 });
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    const plus = (args.patch.match(/^\+/gm) || []).length;
    const minus = (args.patch.match(/^-/gm) || []).length;
    return ok(tool, args.dryRun ? 'Patch validated; nothing applied' : 'Patch applied', {
      applied: !args.dryRun,
      dryRun: Boolean(args.dryRun),
      files,
      diffSummary: `+${plus} -${minus}`,
      warnings: []
    });
  } catch (error) {
    if (tempFile) await fs.promises.rm(path.dirname(tempFile), { recursive: true, force: true }).catch(() => {});
    return fail(tool, error.code || 'PATCH_ERROR', error.message, error.details || {});
  }
}
