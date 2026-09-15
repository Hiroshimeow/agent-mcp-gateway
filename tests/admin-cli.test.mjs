import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createAccountStore } from '../scripts/account-store.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'scripts', 'admin.mjs');

function run(args, env) {
  return execFileSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' }).trim();
}

test('local admin CLI creates admin and one-time invites without exposing password hashes', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'hcu-admin-cli-'));
  const env = { ...process.env, MCP_RUNTIME_DIR: runtime, HCU_ADMIN_PASSWORD: 'local-admin-password' };
  try {
    const created = JSON.parse(run(['account', 'create-admin', 'admin@example.com'], env));
    assert.equal(created.ok, true);
    assert.equal(created.account.role, 'admin');
    assert.equal(JSON.stringify(created).includes('local-admin-password'), false);

    const invites = JSON.parse(run(['invite', 'create', '3'], env));
    assert.equal(invites.codes.length, 3);
    assert.ok(invites.codes.every(code => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)));

    const store = createAccountStore({ dbPath: path.join(runtime, 'gateway.sqlite') });
    try {
      assert.equal(store.listAccounts().length, 1);
      assert.equal(store.listInvites().length, 3);
      assert.equal(store.listInvites().some(item => item.code !== undefined), false);
    } finally { store.close(); }
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});

test('local admin CLI lists, revokes and deletes accounts, and revokes invites', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'hcu-admin-cli-actions-'));
  const env = { ...process.env, MCP_RUNTIME_DIR: runtime, HCU_ADMIN_PASSWORD: 'local-admin-password' };
  try {
    JSON.parse(run(['account', 'create-admin', 'admin@example.com'], env));
    const store = createAccountStore({ dbPath: path.join(runtime, 'gateway.sqlite') });
    const user = store.createAccount({ email: 'user@example.com', password: 'user-password' });
    store.close();

    const listed = JSON.parse(run(['account', 'list'], env));
    assert.equal(listed.accounts.some(account => account.email === 'user@example.com'), true);
    assert.equal(JSON.stringify(listed).includes('password_hash'), false);

    const revoked = JSON.parse(run(['account', 'revoke', user.accountId], env));
    assert.ok(revoked.account.revokedAt);
    const deleted = JSON.parse(run(['account', 'delete', user.accountId], env));
    assert.equal(deleted.deleted, true);

    const invite = JSON.parse(run(['invite', 'create'], env)).codes[0];
    const inviteRevoked = JSON.parse(run(['invite', 'revoke', invite], env));
    assert.ok(inviteRevoked.invite.revokedAt);
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
