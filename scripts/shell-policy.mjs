import path from 'node:path';

function tokenizeCommand(command) {
  const matches = command.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) || [];
  return matches.map(token => token.replace(/^['"]|['"]$/g, ''));
}

export function validateShellCommand(args, options = {}) {
  if (!args || typeof args !== 'object') {
    throw new Error('shell_execute requires an arguments object.');
  }

  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) {
    throw new Error('shell_execute requires a non-empty command string.');
  }

  const resolvedRepoRoots = options.resolvedRepoRoots || (options.resolvedRepoRoot ? [options.resolvedRepoRoot] : []);
  let cwd = options.defaultCwd;
  if (args.working_directory !== undefined && resolvedRepoRoots.length > 0) {
    const resolvedDirectory = path.resolve(args.working_directory);
    const isWithinAllowedRoot = resolvedRepoRoots.some(root => {
      const relative = path.relative(root, resolvedDirectory);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!isWithinAllowedRoot) {
      throw new Error(`working_directory must stay inside trusted roots: ${resolvedRepoRoots.join(', ')}`);
    }
    cwd = resolvedDirectory;
  }

  return { command, cwd };
}

export function toSuperShellArguments(commandText) {
  const parts = tokenizeCommand(commandText);
  const [command, ...args] = parts;
  if (!command) {
    throw new Error('Unable to parse command.');
  }

  return { command, args };
}
