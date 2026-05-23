import test from 'node:test';
import assert from 'node:assert/strict';
import { getRepoPrompt, listRepoPrompts } from '../scripts/prompts/index.mjs';

test('lists all required repo prompts', () => {
  const names = listRepoPrompts().map(p => p.name);
  for (const name of ['review_repo', 'security_audit', 'cross_platform_review', 'release_readiness', 'explain_diff', 'generate_pr_description', 'plan_feature', 'fix_with_tests']) {
    assert.equal(names.includes(name), true);
  }
});

test('getRepoPrompt returns MCP-shaped messages', () => {
  const prompt = getRepoPrompt('review_repo', { projectId: 'fixture' }, { safetyProfile: { name: 'yolo' } });
  assert.equal(prompt.messages[0].role, 'user');
  assert.equal(prompt.messages[0].content.type, 'text');
  assert.match(prompt.messages[0].content.text, /Active MCP safety profile: yolo/);
  assert.match(prompt.messages[0].content.text, /Use MCP Resources first/);
  assert.match(prompt.messages[0].content.text, /Prefer read-only resources\/tools before mutating/);
});

test('unknown prompt is rejected', () => {
  assert.throws(() => getRepoPrompt('missing'), /Unknown prompt/);
});

test('security and cross-platform prompts mention required caveats', () => {
  assert.match(getRepoPrompt('security_audit', { projectId: 'fixture' }).messages[0].content.text, /prompt injection/);
  assert.match(getRepoPrompt('cross_platform_review', { projectId: 'fixture' }).messages[0].content.text, /POSIX non-login -c/);
  assert.match(getRepoPrompt('release_readiness', { projectId: 'fixture' }).messages[0].content.text, /untracked imported files/);
});
