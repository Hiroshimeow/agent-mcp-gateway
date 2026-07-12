import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILL_BOOTSTRAP_CODE,
  SKILL_CHECK_ADVISORY,
  buildSkillCallerKey,
  createSkillBootstrapGate
} from '../scripts/skill-bootstrap-gate.mjs';

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: milliseconds => { now += milliseconds; }
  };
}

test('read advisory is emitted once per caller until TTL expiry', () => {
  const time = clock();
  const gate = createSkillBootstrapGate({ ttlMs: 100, now: time.now });

  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), SKILL_CHECK_ADVISORY);
  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), null);
  assert.equal(gate.takeReadAdvisory('caller-a', 'image_preview'), null);
  assert.equal(gate.takeReadAdvisory('caller-b', 'read_text_file'), SKILL_CHECK_ADVISORY);

  time.advance(101);
  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), SKILL_CHECK_ADVISORY);
});

test('project-changing tools receive one full block then a short repeated block', () => {
  const gate = createSkillBootstrapGate({ ttlMs: 1_000, now: () => 1_000 });

  const first = gate.checkTool('caller-a', 'edit_file');
  assert.equal(first?.code, SKILL_BOOTSTRAP_CODE);
  assert.match(first?.message || '', /before the first project-changing operation/i);

  const repeated = gate.checkTool('caller-a', 'write_file');
  assert.equal(repeated?.code, SKILL_BOOTSTRAP_CODE);
  assert.equal(repeated?.message, 'Call get_skill().');

  assert.equal(gate.checkTool('caller-a', 'read_text_file'), null);
  assert.equal(gate.checkTool('caller-a', 'image_preview'), null);
  assert.equal(gate.checkTool('caller-a', 'get_skill'), null);
});

test('a successful skill load unlocks the caller without repeated prompting', () => {
  const gate = createSkillBootstrapGate({ ttlMs: 1_000, now: () => 1_000 });

  assert.ok(gate.checkTool('caller-a', 'shell_execute'));
  gate.markBootstrapped('caller-a');

  assert.equal(gate.checkTool('caller-a', 'shell_execute'), null);
  assert.equal(gate.checkTool('caller-a', 'edit_file'), null);
  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), null);
});

test('bootstrap state expires and starts a fresh advisory/block cycle', () => {
  const time = clock();
  const gate = createSkillBootstrapGate({ ttlMs: 100, now: time.now });

  gate.markBootstrapped('caller-a');
  assert.equal(gate.checkTool('caller-a', 'write_file'), null);

  time.advance(101);
  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), SKILL_CHECK_ADVISORY);
  assert.match(gate.checkTool('caller-a', 'write_file')?.message || '', /before the first project-changing operation/i);
});

test('caller key is stable without storing raw credentials', () => {
  const input = {
    authorization: 'Bearer secret-token',
    userAgent: 'test-client/1.0',
    remoteAddress: '127.0.0.1',
    sessionId: ''
  };
  const key = buildSkillCallerKey(input);

  assert.equal(key, buildSkillCallerKey(input));
  assert.notEqual(key, buildSkillCallerKey({ ...input, authorization: 'Bearer another-token' }));
  assert.doesNotMatch(key, /secret-token/);
  assert.match(key, /^caller:[0-9a-f]{24}$/);
});
