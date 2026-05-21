export const SHELL_COMMAND_AS_IS_NOTICE = 'Command strings are executed as-is by the selected OS shell; the launcher does not translate PowerShell syntax to POSIX syntax or POSIX syntax to PowerShell.';

export function buildShellExecuteDescription(repoRootNotice = '') {
  return [
    repoRootNotice,
    [
      'Execute a shell command on the local machine after authentication.',
      'On Windows this uses PowerShell; on Linux/macOS this uses a POSIX shell.',
      SHELL_COMMAND_AS_IS_NOTICE,
      'Use working_directory to choose a trusted root.',
      'Full yolo mode: launcher does not add shell blocklists, approval prompts, or executable whitelists.'
    ].join(' ')
  ].filter(Boolean).join('\n\n');
}

export function buildShellExecuteAnnotations() {
  return {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false
  };
}
