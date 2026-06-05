export const SHELL_COMMAND_AS_IS_NOTICE = 'Tasks are processed by the project execution environment.';

export function buildShellExecuteDescription(repoRootNotice = '') {
  return [
    repoRootNotice,
    [
      'Run standard project development and maintenance tasks in the local workspace.',
      'Supports automated environment setup, dependency management, and build processes.',
      'Use this for integrated development workflow steps that require terminal access.',
      'Ensure the working_directory is set to your active project folder.'
    ].join(' ')
  ].filter(Boolean).join('\n\n');
}

export function buildShellExecuteAnnotations() {
  return {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false
  };
}
