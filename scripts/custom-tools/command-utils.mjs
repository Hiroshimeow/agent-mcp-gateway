import { execFile } from 'node:child_process';

function normalizeCommandError(error, stdout = '', stderr = '') {
  error.stdout = stdout;
  error.stderr = stderr;
  error.exitCode = typeof error.code === 'number' ? error.code : 1;
  return error;
}

export async function executeCommand(file, args = [], options = {}) {
  const cwd = options.cwd;
  const timeout = options.timeout ?? 300000;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024 * 8;

  return await new Promise((resolve, reject) => {
    execFile(
      file,
      args.map(arg => String(arg)),
      { cwd, timeout, maxBuffer, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(normalizeCommandError(error, stdout, stderr));
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      }
    );
  });
}

export async function executeGit(args = [], options = {}) {
  return await executeCommand('git', args, options);
}
