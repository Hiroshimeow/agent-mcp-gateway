import { decorateSkillBootstrapDescription } from './skill-bootstrap-gate.mjs';

export const SHELL_COMMAND_AS_IS_NOTICE = 'Tasks are processed by the project execution environment.';

export function buildShellExecuteDescription() {
  return decorateSkillBootstrapDescription('shell_execute', [
    'Use this when the task needs terminal access on the selected device for file discovery, content search, git, tests, builds, package management, or scripts not covered by read_text_file, write_file, or edit_file. Set device_id explicitly and working_directory to the active project folder.',
    'Execution is routed through the authenticated device broker. Oversized device results fail closed at the transport/output budget rather than falling back to gateway-host execution.'
  ].join('\n\n'));
}

export function buildShellExecuteAnnotations() {
  return {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false
  };
}
