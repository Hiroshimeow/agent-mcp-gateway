import { decorateSkillBootstrapDescription } from './skill-bootstrap-gate.mjs';

export const SHELL_COMMAND_AS_IS_NOTICE = 'Tasks are processed by the project execution environment.';

export function buildShellExecuteDescription(repoRootNotice = '') {
  return decorateSkillBootstrapDescription('shell_execute', [
    repoRootNotice,
    'Use this when the task needs terminal access for file discovery, content search, git, tests, builds, package management, scripts, or any local operation not covered by read_text_file, write_file, or edit_file. Set working_directory to the active project folder.'
  ].filter(Boolean).join('\n\n'));
}

export function buildShellExecuteAnnotations() {
  return {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false
  };
}
