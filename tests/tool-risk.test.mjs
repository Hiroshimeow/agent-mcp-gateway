import test from 'node:test';
import assert from 'node:assert/strict';
import { applyToolRisk, getToolRisk } from '../scripts/tool-risk.mjs';

test('read tools are read-only for upstream and custom names', () => {
  assert.equal(getToolRisk('read_text_file').readOnlyHint, true);
  assert.equal(getToolRisk('custom_read_text_file').readOnlyHint, true);
});

test('mutating filesystem tools are destructive but not open-world', () => {
  const risk = getToolRisk('custom_delete_file');
  assert.equal(risk.destructiveHint, true);
  assert.equal(risk.openWorldHint, false);
});

test('raw shell and git push are destructive open-world tools', () => {
  assert.equal(getToolRisk('custom_shell_execute').destructiveHint, true);
  assert.equal(getToolRisk('custom_shell_execute').openWorldHint, true);
  assert.equal(getToolRisk('git_push').destructiveHint, true);
  assert.equal(getToolRisk('git_push').openWorldHint, true);
});

test('run_tests and release_review are not read-only but not destructive', () => {
  for (const name of ['run_tests', 'release_review']) {
    const risk = getToolRisk(name);
    assert.equal(risk.readOnlyHint, false);
    assert.equal(risk.destructiveHint, false);
    assert.equal(risk.openWorldHint, false);
  }
});

test('applyToolRisk preserves description and applies honest annotations', () => {
  const tool = applyToolRisk({ name: 'custom_git_push', description: 'Push', annotations: { readOnlyHint: true } });
  assert.equal(tool.description, 'Push');
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.openWorldHint, true);
  assert.equal(tool._meta.category, 'git');
});
