const PROMPTS = new Map([
  ['review_repo', { description: 'Review a repository using resources and read-only tools first.', args: ['projectId', 'focus', 'depth'] }],
  ['security_audit', { description: 'Audit secrets, auth, shell/file/network risk, path traversal, prompt injection, least privilege, and data leakage.', args: ['projectId', 'depth'] }],
  ['cross_platform_review', { description: 'Review Windows/Linux/macOS shell, path, environment, child-process, and test behavior.', args: ['projectId'] }],
  ['release_readiness', { description: 'Check release readiness, git state, tests, secret scan, schema smoke, and docs consistency.', args: ['projectId'] }],
  ['explain_diff', { description: 'Explain the working-tree or staged diff.', args: ['projectId', 'staged'] }],
  ['generate_pr_description', { description: 'Generate a PR description from repo context and diff.', args: ['projectId', 'baseBranch', 'headBranch'] }],
  ['plan_feature', { description: 'Create a small, reviewable implementation plan for a feature.', args: ['projectId', 'feature'] }],
  ['fix_with_tests', { description: 'Run an agent coding loop that fixes a scoped issue and validates with tests.', args: ['projectId', 'issue'] }]
]);

function profileName(context) {
  return context.safetyProfile?.name || context.profile || 'yolo';
}

function promptArguments(names) {
  return names.map(name => ({ name, required: name === 'projectId' }));
}

export function listRepoPrompts(_context = {}) {
  return [...PROMPTS.entries()].map(([name, prompt]) => ({
    name,
    description: prompt.description,
    arguments: promptArguments(prompt.args)
  }));
}

function textMessage(text) {
  return { role: 'user', content: { type: 'text', text } };
}

export function getRepoPrompt(name, args = {}, context = {}) {
  const prompt = PROMPTS.get(name);
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  const projectId = args.projectId || context.defaultProjectId || '<projectId>';
  const safety = profileName(context);
  const common = `Project: ${projectId}\nActive MCP safety profile: ${safety}. Yolo mode does not bypass ChatGPT host safety, user confirmations, or platform policy. Use MCP Resources first: repo://project/${projectId}/summary, /readme, /package, /safety-profile, and /tool-manifest. Prefer read-only resources/tools before mutating, destructive, shell, or open-world tools. Command strings are executed as-is by the selected OS shell; do not assume PowerShell and POSIX syntax are interchangeable.`;
  const bodies = {
    review_repo: `${common}\nReview focus: ${args.focus || 'security,tests,maintainability,docs,release'}. Depth: ${args.depth || 'normal'}. Report findings with severity, evidence, paths, and recommended tests.`,
    security_audit: `${common}\nPerform a security audit covering secrets, auth, shell/file/network risk, path traversal, prompt injection implications, least privilege, data leakage, and safety profile exposure.`,
    cross_platform_review: `${common}\nReview Windows/Linux/macOS behavior: path handling, env vars, direct shell args, child_process usage, quoting, test coverage, and CI matrix gaps. Preserve POSIX non-login -c behavior and Windows PowerShell flags.`,
    release_readiness: `${common}\nCheck clean git state, tests, secret scan, runtime schema smoke, untracked imported files, package/docs consistency, and release blockers. Do not publish or push without explicit user intent.`,
    explain_diff: `${common}\nExplain the ${String(args.staged) === 'true' ? 'staged' : 'working-tree'} diff. Summarize intent, risk, tests affected, and review concerns.`,
    generate_pr_description: `${common}\nGenerate a PR description from ${args.baseBranch || '<baseBranch>'} to ${args.headBranch || '<headBranch>'}. Include summary, changes, validation, risk, and rollout notes.`,
    plan_feature: `${common}\nCreate a small, reviewable implementation plan for: ${args.feature || '<feature>'}. Include files to inspect, phases, tests, rollback concerns, and docs updates.`,
    fix_with_tests: `${common}\nFix this issue: ${args.issue || '<issue>'}. Inspect first, make minimal changes, run targeted tests after each major phase where practical, then run the full relevant suite and report results.`
  };
  return { description: prompt.description, messages: [textMessage(bodies[name])] };
}
