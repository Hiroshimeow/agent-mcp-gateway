import fs from 'node:fs';
import path from 'node:path';
import { resolveInsideTrustedRoots, toRelativeFromRoot } from './path-utils.mjs';
import { fail, ok } from './response-utils.mjs';

function isGitPath(targetPath) {
  return targetPath.split(path.sep).includes('.git');
}

export async function deleteFileTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    if (target.path === target.root) throw new Error('Refusing to delete trusted root itself.');
    if (isGitPath(target.path)) throw new Error('Refusing to delete .git paths.');
    const stat = await fs.promises.stat(target.path);
    if (stat.isDirectory() && !args.recursive) throw new Error('Directory delete requires recursive=true.');
    if (!args.dryRun) await fs.promises.rm(target.path, { recursive: Boolean(args.recursive), force: Boolean(args.force) });
    return ok('delete_file', args.dryRun ? 'Dry run completed; nothing deleted' : 'Deleted path', {
      path: toRelativeFromRoot(target.path, target.root),
      recursive: Boolean(args.recursive),
      dryRun: Boolean(args.dryRun)
    });
  } catch (error) {
    return fail('delete_file', error.code || 'VALIDATION_ERROR', error.message, error.details || {});
  }
}

export async function copyFileTool(args = {}, context = {}) {
  try {
    const source = resolveInsideTrustedRoots(args.source, context, { mustExist: true });
    const destination = resolveInsideTrustedRoots(args.destination, context);
    const stat = await fs.promises.stat(source.path);
    if (stat.isDirectory() && !args.recursive) throw new Error('Directory copy requires recursive=true.');
    if (!args.overwrite && fs.existsSync(destination.path)) throw new Error('Destination exists; pass overwrite=true to replace it.');
    if (!args.dryRun) {
      await fs.promises.cp(source.path, destination.path, {
        recursive: Boolean(args.recursive),
        force: Boolean(args.overwrite),
        errorOnExist: !args.overwrite
      });
    }
    return ok('copy_file', args.dryRun ? 'Dry run completed; nothing copied' : 'Copied path', {
      source: toRelativeFromRoot(source.path, source.root),
      destination: toRelativeFromRoot(destination.path, destination.root),
      recursive: Boolean(args.recursive),
      dryRun: Boolean(args.dryRun)
    });
  } catch (error) {
    return fail('copy_file', error.code || 'VALIDATION_ERROR', error.message, error.details || {});
  }
}
