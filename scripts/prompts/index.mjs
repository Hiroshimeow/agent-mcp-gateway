import { buildSkillPrompt, getSkillDefinition, listSkillPromptDefinitions } from '../skills/index.mjs';

const PROMPTS = new Map([
  ['explore_project', { description: 'Explore the project structure and understand the codebase layout.', args: ['projectId', 'focus', 'depth'] }],
  ['quality_check', { description: 'Review project structure, documentation, and general code quality standards.', args: ['projectId', 'depth'] }],
  ['cross_platform_review', { description: 'Review Windows/Linux/macOS shell, path, environment, child-process, and test behavior.', args: ['projectId'] }],
  ['release_readiness', { description: 'Check release readiness, git state, tests, secret scan, schema smoke, and docs consistency.', args: ['projectId'] }],
  ['explain_diff', { description: 'Explain the working-tree or staged diff.', args: ['projectId', 'staged'] }],
  ['generate_pr_description', { description: 'Generate a PR description from repo context and diff.', args: ['projectId', 'baseBranch', 'headBranch'] }],
  ['plan_feature', { description: 'Create a small, reviewable implementation plan for a feature.', args: ['projectId', 'feature'] }],
  ['fix_with_tests', { description: 'Run an agent coding loop that fixes a scoped issue and validates with tests.', args: ['projectId', 'issue'] }]
]);

function profileName(context) {
  return context.runtimeProfile?.name || context.profile || context.safetyProfile?.name || 'yolo';
}

function promptArguments(names) {
  return names.map(name => ({ name, required: name === 'projectId' }));
}

export function listRepoPrompts(_context = {}) {
  const repoPrompts = [...PROMPTS.entries()].map(([name, prompt]) => ({
    name,
    description: prompt.description,
    arguments: promptArguments(prompt.args)
  }));
  const skillPrompts = listSkillPromptDefinitions().map(prompt => ({
    name: prompt.name,
    description: prompt.description,
    arguments: promptArguments(prompt.args)
  }));
  return [...repoPrompts, ...skillPrompts];
}

function textMessage(text) {
  return { role: 'user', content: { type: 'text', text } };
}

export function getRepoPrompt(name, args = {}, context = {}) {
  const skill = getSkillDefinition(name);
  if (skill) return { description: skill.description, messages: [textMessage(buildSkillPrompt(name, args))] };

  const prompt = PROMPTS.get(name);
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  const projectId = args.projectId || context.defaultProjectId || '<projectId>';
  const safety = profileName(context);
  const common = `Project: ${projectId}\nActive MCP runtime profile: ${safety}. You are an expert software developer assistant working in a standard local workspace. Your goal is to help with routine coding, file management, and project tasks efficiently. Command strings are executed as-is by the selected OS shell; do not assume PowerShell and POSIX syntax are interchangeable.`;
  const bodies = {
    explore_project: `${common}\nExplore focus: ${args.focus || 'structure,entrypoints,config,tests,docs'}. Depth: ${args.depth || 'normal'}. Map the project layout, main files, runnable commands, and risk areas before suggesting changes.`,
    quality_check: `${common}\nReview the project for consistency, adherence to style guides, and general architectural health.`,
    cross_platform_review: `${common}\nReview Windows/Linux/macOS behavior: path handling, env vars, direct shell args, child_process usage, quoting, test coverage, and CI matrix gaps. Preserve POSIX non-login -c behavior and Windows PowerShell flags.`,
    release_readiness: `${common}\nCheck clean git state, tests, secret scan, runtime schema smoke, untracked imported files, package/docs consistency, and release blockers. Do not publish or push without explicit user intent.`,
    explain_diff: `${common}\nExplain the ${String(args.staged) === 'true' ? 'staged' : 'working-tree'} diff. Summarize intent, behavior, tests affected, and review concerns.`,
    generate_pr_description: `${common}\nGenerate a PR description from ${args.baseBranch || '<baseBranch>'} to ${args.headBranch || '<headBranch>'}. Include summary, changes, validation, behavior, and rollout notes.`,
    plan_feature: `${common}\nCreate a small, reviewable implementation plan for: ${args.feature || '<feature>'}. Include files to inspect, phases, tests, rollback concerns, and docs updates.`,
    fix_with_tests: `${common}\nFix this issue: ${args.issue || '<issue>'}. Inspect first, make minimal changes, run targeted tests after each major phase where practical, then run the full relevant suite and report results.`
  };
  return { description: prompt.description, messages: [textMessage(bodies[name])] };
}
