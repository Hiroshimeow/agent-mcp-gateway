import fs from 'node:fs';
import path from 'node:path';
import { executeGit } from './command-utils.mjs';
import { resolveInsideTrustedRoots } from './path-utils.mjs';
import { fail, ok } from './response-utils.mjs';
import { secretScanTool } from './secret-scan-tool.mjs';
import { runTestsTool } from './test-tool.mjs';
import { gitStatusTool, gitDiffTool } from './git-tools.mjs';

function parseJsonResult(result) {
  return JSON.parse(result.content.find(entry => entry.type === 'text').text);
}

async function runGit(_context, cwd, args) {
  return await executeGit(args, { cwd, timeout: 300000 });
}

function addFinding(findings, severity, category, pathName, line, title, detail, suggestion = '') {
  findings.push({ severity, category, path: pathName, line, title, detail, suggestion });
}

export async function reviewDiffTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    const focus = args.focus?.length ? args.focus : ['security', 'bugs', 'tests'];
    const maxFindings = Math.max(1, Number(args.maxFindings || 50));
    const diffResult = await gitDiffTool({ path: target.path, staged: Boolean(args.staged), maxBytes: 500000 }, context);
    const diffPayload = parseJsonResult(diffResult);
    if (!diffPayload.ok) return diffResult;
    const diff = diffPayload.data.diff || '';
    const findings = [];
    let currentPath = '';
    let newLine = 0;
    for (const line of diff.split(/\r?\n/)) {
      if (findings.length >= maxFindings) break;
      const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
      if (fileMatch) { currentPath = fileMatch[1]; newLine = 0; continue; }
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunkMatch) { newLine = Number(hunkMatch[1]); continue; }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const added = line.slice(1);
        if (/(\.env$|logs\/|\.log$)/i.test(currentPath)) addFinding(findings, 'warning', 'release', currentPath, newLine, 'Sensitive/generated file changed', 'Avoid committing .env or log files.', 'Remove from staging or verify .gitignore.');
        if (/(ghp_|github_pat_|sk-|BEGIN .*PRIVATE KEY|MCP_BEARER_TOKEN|MCP_AUTH_PASSWORD)/.test(added)) addFinding(findings, 'error', 'security', currentPath, newLine, 'Token-like value added', 'Changed line appears to contain a secret-like value.', 'Remove the value and run custom_secret_scan.');
        if (/executeDirectShell|execFile|spawn\(/.test(added) && focus.includes('security')) addFinding(findings, 'warning', 'security', currentPath, newLine, 'Shell execution changed', 'Review validation and trusted-root handling around shell execution.', 'Prefer dedicated wrappers and validate inputs.');
        if (/OAuth|Bearer|authPassword|staticBearerToken|requireBearerAuth/.test(added)) addFinding(findings, 'warning', 'security', currentPath, newLine, 'Auth logic changed', 'Review OAuth/static bearer behavior before publish.', 'Run auth tests and release review.');
        if (/TODO|FIXME/.test(added)) addFinding(findings, 'note', 'maintainability', currentPath, newLine, 'TODO/FIXME added', 'Changed line adds a TODO or FIXME.', 'Resolve before release or track in TODO.md.');
        if (/fs\.promises\.rm|rmSync|unlinkSync|rmdirSync/.test(added)) addFinding(findings, 'warning', 'security', currentPath, newLine, 'Destructive file operation added', 'Confirm path validation and dry-run behavior.', 'Ensure trusted-root validation is enforced.');
        newLine += 1;
      } else if (!line.startsWith('-')) {
        newLine += 1;
      }
    }
    return ok('review_diff', findings.length === 0 ? 'No review findings' : 'Review findings detected', { passed: findings.every(f => f.severity !== 'error'), diffScope: args.staged ? 'staged' : 'working-tree', findings });
  } catch (error) {
    return fail('review_diff', error.code || 'REVIEW_ERROR', error.message, error.details || {});
  }
}

export async function releaseReviewTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    const blockers = [];
    const warnings = [];
    const checks = [];
    const nextActions = [];
    function check(name, status, message) {
      checks.push({ name, status, message });
      if (status === 'fail') blockers.push(message || `${name} failed`);
      if (status === 'warn') warnings.push(message || `${name} warning`);
    }

    try { await runGit(context, target.path, ['rev-parse', '--show-toplevel']); check('git_repo', 'pass'); } catch { check('git_repo', 'fail', 'Path is not inside a git repo.'); }
    check('gitignore', fs.existsSync(path.join(target.path, '.gitignore')) ? 'pass' : 'fail', '.gitignore is missing.');
    const tracked = await runGit(context, target.path, ['ls-files']);
    const trackedFiles = String(tracked.stdout || '').split(/\r?\n/).filter(Boolean);
    check('env_not_tracked', trackedFiles.includes('.env') ? 'fail' : 'pass', '.env is tracked.');
    check('logs_not_tracked', trackedFiles.some(f => f.startsWith('logs/') && f !== 'logs/.gitkeep') ? 'fail' : 'pass', 'logs/ files are tracked.');
    check('node_modules_not_tracked', trackedFiles.some(f => f.startsWith('node_modules/')) ? 'fail' : 'pass', 'node_modules/ is tracked.');

    if (args.checkPackage !== false) {
      const pkgPath = path.join(target.path, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
        check('package_json', pkg.name && pkg.version && pkg.scripts?.test ? 'pass' : 'fail', 'package.json must include name, version, and scripts.test.');
      } else check('package_json', 'fail', 'package.json is missing.');
    }
    if (args.checkDocs !== false) {
      check('readme', fs.existsSync(path.join(target.path, 'README.vi.md')) || fs.existsSync(path.join(target.path, 'README.md')) ? 'pass' : 'fail', 'README is missing.');
      check('security', fs.existsSync(path.join(target.path, 'SECURITY.md')) ? 'pass' : 'fail', 'SECURITY.md is missing.');
      check('plan_or_todo', fs.existsSync(path.join(target.path, '.plan')) || fs.existsSync(path.join(target.path, 'TODO.md')) ? 'pass' : 'warn', 'No .plan/ or TODO.md found.');
    }

    if (args.scanSecrets !== false) {
      const scan = parseJsonResult(await secretScanTool({ path: target.path }, context));
      check('secret_scan', scan.ok && scan.data.passed ? 'pass' : 'fail', `Secret scan failed: ${scan.data?.counts?.high || 0} high severity finding(s).`);
    }
    if (args.runTests !== false) {
      const tests = parseJsonResult(await runTestsTool({ path: target.path }, context));
      check('tests', tests.ok && tests.data.passed ? 'pass' : 'fail', 'Tests failed.');
    }
    const status = parseJsonResult(await gitStatusTool({ path: target.path }, context));
    if (status.ok && !status.data.clean) check('git_status', args.requireCleanGit ? 'fail' : 'warn', 'Git working tree has uncommitted or untracked files.'); else check('git_status', 'pass');
    if (fs.existsSync(path.join(target.path, 'packages'))) check('packages_artifacts', 'warn', 'Untracked release artifacts may exist in packages/.');

    if (blockers.length) nextActions.push('Resolve blockers and rerun custom_release_review.');
    if (warnings.length) nextActions.push('Review warnings before publishing.');
    return ok('release_review', blockers.length === 0 ? 'Release review passed with no blockers' : 'Release review found blockers', { ready: blockers.length === 0, blockers, warnings, checks, nextActions });
  } catch (error) {
    return fail('release_review', error.code || 'RELEASE_REVIEW_ERROR', error.message, error.details || {});
  }
}
