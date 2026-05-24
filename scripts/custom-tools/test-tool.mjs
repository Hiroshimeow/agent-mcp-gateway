import { resolveInsideTrustedRoots } from './path-utils.mjs';
import { fail, ok, truncateText } from './response-utils.mjs';

const ALLOWED_COMMANDS = new Set([
  'npm test',
  'npm run test',
  'node --test tests/*.test.mjs',
  'npm run smoke:mcp:tools',
  'node scripts/smoke-mcp-tools.mjs',
  'npm run smoke:mcp:upstreams',
  'node scripts/smoke-mcp-upstreams.mjs'
]);

export async function runTestsTool(args = {}, context = {}) {
  try {
    const command = String(args.command || 'npm test').trim();
    if (!ALLOWED_COMMANDS.has(command)) throw new Error('Command is not allowed by custom_run_tests. Use custom_shell_execute for arbitrary commands.');
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    const started = Date.now();
    let result;
    let passed = true;
    try {
      result = await context.executeDirectShell(command, { cwd: target.path, timeout: Number(args.timeoutMs || 300000) });
    } catch (error) {
      passed = false;
      result = {
        stdout: error.stdout || '',
        stderr: [error.message, error.stderr].filter(Boolean).join('\n'),
        exitCode: typeof error.exitCode === 'number' ? error.exitCode : 1
      };
    }
    const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (/\nnot ok \d+\b|# fail [1-9]\d*|ERR_ASSERTION|ERR_TEST_FAILURE/.test(combinedOutput)) passed = false;
    const stdout = truncateText(result.stdout || '', Number(args.maxOutputBytes || 200000));
    const stderr = truncateText(result.stderr || '', Number(args.maxOutputBytes || 200000));
    return ok('run_tests', passed ? 'Tests passed' : 'Tests failed', {
      passed,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : passed ? 0 : 1,
      command,
      durationMs: Date.now() - started,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated
    });
  } catch (error) {
    return fail('run_tests', error.code || 'TEST_ERROR', error.message, error.details || {});
  }
}
