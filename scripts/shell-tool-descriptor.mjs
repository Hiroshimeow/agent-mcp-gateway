export const SHELL_COMMAND_AS_IS_NOTICE = 'Command strings are executed as-is by the selected OS shell; the launcher does not translate PowerShell syntax to POSIX syntax or POSIX syntax to PowerShell.';

export function buildShellExecuteDescription(repoRootNotice = '') {
  return [
    repoRootNotice,
    [
      'Execute a shell command on the local machine after authentication. This tool is exposed only in private yolo developer mode.',
      'On Windows this uses PowerShell; on Linux/macOS this uses a POSIX shell.',
      SHELL_COMMAND_AS_IS_NOTICE,
      'This tool can modify or delete files, run network commands, install packages, publish changes, or access data available to the server process.',
      'Use dedicated safer tools when possible.',
      'Use working_directory to choose a trusted root.',
      'Yolo mode removes extra gateway-side restrictions for trusted local development, but it does not control ChatGPT host confirmations, user confirmations, or platform policy.'
    ].join(' ')
  ].filter(Boolean).join('\n\n');
}

export function buildShellExecuteAnnotations() {
  return {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: true
  };
}
