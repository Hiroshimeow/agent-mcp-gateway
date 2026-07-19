import test from 'node:test';
import assert from 'node:assert/strict';

import { applyToolRisk, getToolRisk, shouldExposeToolForProfile } from '../scripts/tool-risk.mjs';

const safe = { name: 'safe', exposeShell: false, exposeDestructiveTools: false, exposeOpenWorldTools: false };
const yolo = { name: 'yolo', exposeShell: true, exposeDestructiveTools: true, exposeOpenWorldTools: true };

test('retained read tools are read-only', () => {
  for (const name of ['read_text_file', 'image_preview', 'get_skill']) {
    const risk = getToolRisk(name);
    assert.equal(risk.readOnlyHint, true);
    assert.equal(risk.destructiveHint, false);
    assert.equal(risk.openWorldHint, false);
  }
});

test('retained file writes are destructive but not open-world', () => {
  for (const name of ['write_file', 'edit_file']) {
    const risk = getToolRisk(name);
    assert.equal(risk.readOnlyHint, false);
    assert.equal(risk.destructiveHint, true);
    assert.equal(risk.openWorldHint, false);
  }
});

test('shell remains destructive open-world and profile semantics are unchanged', () => {
  const risk = getToolRisk('shell_execute');
  assert.equal(risk.destructiveHint, true);
  assert.equal(risk.openWorldHint, true);
  assert.equal(shouldExposeToolForProfile('shell_execute', safe), false);
  assert.equal(shouldExposeToolForProfile('shell_execute', yolo), true);
});

test('applyToolRisk preserves description and applies core annotations', () => {
  const tool = applyToolRisk({ name: 'image_preview', description: 'Preview', annotations: { readOnlyHint: false } });
  assert.equal(tool.description, 'Preview');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool._meta.category, 'filesystem');
});
