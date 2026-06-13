import { loadGatewayFlowConfig } from '../gateway-flow-config.mjs';
import { executeGit } from './command-utils.mjs';
import { resolveInsideTrustedRoots, toRelativeFromRoot } from './path-utils.mjs';
import { fail, ok, truncateText } from './response-utils.mjs';

async function runGit(_context, cwd, args) {
  return await executeGit(args, { cwd, timeout: 300000 });
}

function parseStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
  const header = lines.shift() || '## unknown';
  const branchMatch = header.match(/^##\s+([^\.\s]+|[^\s]+)/);
  const aheadMatch = header.match(/ahead (\d+)/);
  const behindMatch = header.match(/behind (\d+)/);
  return {
    branch: branchMatch ? branchMatch[1].replace(/^heads\//, '') : 'unknown',
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
    clean: lines.length === 0,
    files: lines.map(line => ({ path: line.slice(3).trim(), index: line[0], workingTree: line[1] }))
  };
}

export async function gitStatusTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    const flags = ['status', '--porcelain=v1', '-b'];
    if (args.includeIgnored) flags.push('--ignored');
    const result = await runGit(context, target.path, flags);
    return ok('git_status', 'Read git status', parseStatus(result.stdout));
  } catch (error) {
    return fail('git_status', error.code || 'GIT_ERROR', error.message, error.details || {});
  }
}

function getFlowConfig(context = {}) {
  return loadGatewayFlowConfig({ env: context.env || process.env, repoRoot: context.packageRoot || process.cwd() });
}

function normalizeDiffFiles(files, context, cwd) {
  return (Array.isArray(files) ? files : []).map(file => {
    const checked = resolveInsideTrustedRoots(file, context, { workingDirectory: cwd });
    return toRelativeFromRoot(checked.path, cwd);
  });
}

async function readDiffStat(context, cwd, baseArgs) {
  const stat = await runGit(context, cwd, [...baseArgs, '--stat']);
  const names = await runGit(context, cwd, [...baseArgs, '--name-status']);
  return { stat: stat.stdout || '', changedFiles: names.stdout || '' };
}

export async function gitDiffTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    const flowConfig = getFlowConfig(context);
    const configuredMaxBytes = Number(flowConfig.git?.diff_max_bytes || 60000);
    const maxBytes = Number(args.maxBytes ?? configuredMaxBytes);
    const baseArgs = ['diff'];
    if (args.staged) baseArgs.push('--cached');
    const files = normalizeDiffFiles(args.files, context, target.path);

    if (args.statOnly) {
      const statArgs = [...baseArgs, '--stat'];
      if (files.length) statArgs.push('--', ...files);
      const result = await runGit(context, target.path, statArgs);
      return ok('git_diff', 'Read git diff stat', {
        staged: Boolean(args.staged),
        statOnly: true,
        stat: result.stdout || '',
        diff: '',
        truncated: false,
        summaryOnly: false
      });
    }

    const diffArgs = [...baseArgs];
    if (files.length) diffArgs.push('--', ...files);
    const result = await runGit(context, target.path, diffArgs);
    const diffText = result.stdout || '';
    const diffBytes = Buffer.byteLength(diffText, 'utf8');

    if (!files.length && flowConfig.git?.diff_stat_on_large_output !== false && diffBytes > maxBytes) {
      const summary = await readDiffStat(context, target.path, baseArgs);
      return ok('git_diff', 'Read git diff summary', {
        staged: Boolean(args.staged),
        statOnly: false,
        stat: summary.stat,
        changedFiles: summary.changedFiles,
        diff: '',
        truncated: true,
        summaryOnly: true,
        reason: 'diff output exceeded context limit',
        requestSpecificFilesWith: ['custom_git_diff', 'files']
      });
    }

    const truncated = truncateText(diffText, maxBytes);
    return ok('git_diff', 'Read git diff', {
      staged: Boolean(args.staged),
      statOnly: false,
      files,
      stat: '',
      diff: truncated.text,
      truncated: truncated.truncated,
      summaryOnly: false
    });
  } catch (error) {
    return fail('git_diff', error.code || 'GIT_ERROR', error.message, error.details || {});
  }
}

export async function gitAddTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    const files = Array.isArray(args.files) ? args.files : [];
    if (!args.all && files.length === 0) throw new Error('Require files or all=true.');
    if (args.dryRun) return ok('git_add', 'Dry run completed; nothing staged', { all: Boolean(args.all), files });
    if (args.all) await runGit(context, target.path, ['add', '-A']);
    else {
      const rels = files.map(file => {
        const checked = resolveInsideTrustedRoots(file, context, { workingDirectory: target.path });
        return toRelativeFromRoot(checked.path, target.path);
      });
      await runGit(context, target.path, ['add', '--', ...rels]);
    }
    return ok('git_add', 'Staged changes', { all: Boolean(args.all), files });
  } catch (error) {
    return fail('git_add', error.code || 'GIT_ERROR', error.message, error.details || {});
  }
}

export async function gitCommitTool(args = {}, context = {}) {
  try {
    const message = String(args.message || '').trim();
    if (!message) throw new Error('Commit message is required.');
    if (message.includes('\n') || message.includes('\r')) throw new Error('Commit message must be a single line.');
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    if (!args.allowEmpty) {
      const diff = await runGit(context, target.path, ['diff', '--cached', '--name-only']);
      if (!String(diff.stdout || '').trim()) throw new Error('No staged changes to commit.');
    }
    const commitArgs = ['commit', '-m', message];
    if (args.allowEmpty) commitArgs.push('--allow-empty');
    await runGit(context, target.path, commitArgs);
    const hash = await runGit(context, target.path, ['rev-parse', 'HEAD']);
    return ok('git_commit', 'Created git commit', { hash: String(hash.stdout || '').trim() });
  } catch (error) {
    return fail('git_commit', error.code || 'GIT_ERROR', error.message, error.details || {});
  }
}

export async function gitPushTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    let branch = args.branch;
    if (!branch) {
      const current = await runGit(context, target.path, ['branch', '--show-current']);
      branch = String(current.stdout || '').trim();
    }
    const remote = args.remote || 'origin';
    const pushArgs = ['push'];
    if (args.dryRun) pushArgs.push('--dry-run');
    if (args.setUpstream) pushArgs.push('-u');
    pushArgs.push(remote, branch);
    const result = await runGit(context, target.path, pushArgs);
    return ok('git_push', args.dryRun ? 'Dry run push completed' : 'Pushed branch', {
      remote,
      branch,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      dryRun: Boolean(args.dryRun)
    });
  } catch (error) {
    return fail('git_push', error.code || 'GIT_ERROR', error.message, error.details || {});
  }
}
