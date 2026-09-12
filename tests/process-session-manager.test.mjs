import test from 'node:test';
import assert from 'node:assert/strict';

import { createProcessSessionManager } from '../scripts/process-session-manager.mjs';

const directNodeShell = () => ({ executable: process.execPath, args: ['-e'] });

function manager(options = {}) {
  return createProcessSessionManager({
    getShell: directNodeShell,
    completedTtlMs: 5000,
    maxOutputBytes: 1024,
    ...options
  });
}

test('short process completes inside initial wait and stays readable', async t => {
  const sessions = manager();
  t.after(() => sessions.shutdown());

  const started = await sessions.start({
    command: "process.stdout.write('done')",
    cwd: process.cwd(),
    ownerKey: 'alice',
    timeoutMs: 1000
  });

  assert.equal(started.status, 'COMPLETED');
  assert.equal(started.exitCode, 0);
  assert.match(started.output, /done/);

  const read = sessions.read({ sessionId: started.sessionId, ownerKey: 'alice', offset: 0, length: 100 });
  assert.equal(read.status, 'COMPLETED');
  assert.match(read.output, /done/);
});

test('long process yields RUNNING without being killed', async t => {
  const sessions = manager();
  t.after(() => sessions.shutdown());

  const started = await sessions.start({
    command: "setTimeout(() => process.stdout.write('late'), 250)",
    cwd: process.cwd(),
    ownerKey: 'alice',
    timeoutMs: 20
  });

  assert.equal(started.status, 'RUNNING');
  assert.equal(started.exitCode, null);
  let read = sessions.read({ sessionId: started.sessionId, ownerKey: 'alice', offset: 0, length: 100 });
  const deadline = Date.now() + 3000;
  while (read.status === 'RUNNING' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    read = sessions.read({ sessionId: started.sessionId, ownerKey: 'alice', offset: 0, length: 100 });
  }
  assert.equal(read.status, 'COMPLETED');
  assert.match(read.output, /late/);
});

test('interactive process accepts raw stdin and preserves caller ownership', async t => {
  const sessions = manager();
  t.after(() => sessions.shutdown());

  const started = await sessions.start({
    command: "process.stdin.once('data', d => { process.stdout.write('got:' + d.toString().trim()); process.exit(0); }); setTimeout(() => {}, 2000)",
    cwd: process.cwd(),
    ownerKey: 'alice',
    timeoutMs: 20
  });

  assert.equal(started.status, 'RUNNING');
  assert.throws(() => sessions.read({ sessionId: started.sessionId, ownerKey: 'bob' }), /does not belong/i);
  await sessions.interact({ sessionId: started.sessionId, ownerKey: 'alice', input: 'hello\n', timeoutMs: 1000 });
  const read = sessions.read({ sessionId: started.sessionId, ownerKey: 'alice', offset: 0, length: 100 });
  assert.equal(read.status, 'COMPLETED');
  assert.match(read.output, /got:hello/);
});

test('output is bounded and exposes paged absolute offsets', async t => {
  const sessions = manager({ maxOutputBytes: 64 });
  t.after(() => sessions.shutdown());

  const started = await sessions.start({
    command: "process.stdout.write('x'.repeat(200))",
    cwd: process.cwd(),
    ownerKey: 'alice',
    timeoutMs: 1000
  });

  const read = sessions.read({ sessionId: started.sessionId, ownerKey: 'alice', offset: 0, length: 20 });
  assert.equal(read.outputTruncated, true);
  assert.ok(read.baseOffset > 0);
  assert.equal(read.offset, read.baseOffset);
  assert.equal(read.output.length, 20);
  assert.equal(read.nextOffset, read.baseOffset + 20);
});

test('terminate stops a running session', async t => {
  const sessions = manager();
  t.after(() => sessions.shutdown());

  const started = await sessions.start({
    command: "setInterval(() => process.stdout.write('.'), 50)",
    cwd: process.cwd(),
    ownerKey: 'alice',
    timeoutMs: 20
  });
  assert.equal(started.status, 'RUNNING');

  const terminated = await sessions.terminate({ sessionId: started.sessionId, ownerKey: 'alice' });
  assert.ok(['CANCELLED', 'COMPLETED', 'FAILED'].includes(terminated.status));
});

test('completed sessions expire after retention TTL', async t => {
  let now = 1000;
  const sessions = manager({ completedTtlMs: 50, now: () => now });
  t.after(() => sessions.shutdown());

  const started = await sessions.start({
    command: "process.stdout.write('done')",
    cwd: process.cwd(),
    ownerKey: 'alice',
    timeoutMs: 1000
  });
  assert.equal(started.status, 'COMPLETED');

  now += 51;
  assert.throws(() => sessions.read({ sessionId: started.sessionId, ownerKey: 'alice' }), /Unknown or expired process session/i);
});
