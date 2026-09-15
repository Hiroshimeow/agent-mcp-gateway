import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAccountStore } from '../scripts/account-store.mjs';

function fixture(now = () => Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcu-account-store-'));
  const dbPath = path.join(dir, 'gateway.sqlite');
  const store = createAccountStore({ dbPath, now });
  return { dir, dbPath, store };
}

test('normal account creation normalizes email and verifies scrypt password', () => {
  const f = fixture();
  try {
    const account = f.store.createAccount({ email: '  User@Example.COM ', password: 'correct horse battery staple' });
    assert.match(account.accountId, /^[0-9a-f-]{36}$/i);
    assert.equal(account.email, 'user@example.com');
    assert.equal(account.role, 'user');
    assert.equal(account.revokedAt, null);
    assert.equal(f.store.verifyPassword('USER@example.com', 'correct horse battery staple')?.accountId, account.accountId);
    assert.equal(f.store.verifyPassword('user@example.com', 'wrong'), null);
    assert.equal(JSON.stringify(f.store.getAccount(account.accountId)).includes('correct horse'), false);
  } finally {
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('invite codes are uppercase unambiguous, hashed, single-use, and revocable', () => {
  const f = fixture();
  try {
    const first = f.store.createInvite();
    assert.match(first.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    assert.equal(f.store.listInvites()[0].code, undefined);
    assert.equal(fs.readFileSync(f.dbPath).includes(first.code), false);

    const account = f.store.createAccount({ email: 'invite@example.com', password: 'password-1234', inviteCode: first.code, requireInvite: true });
    assert.equal(account.email, 'invite@example.com');
    assert.throws(
      () => f.store.createAccount({ email: 'second@example.com', password: 'password-1234', inviteCode: first.code, requireInvite: true }),
      /INVITE_INVALID/
    );

    const second = f.store.createInvite();
    f.store.revokeInvite(second.code);
    assert.throws(
      () => f.store.createAccount({ email: 'third@example.com', password: 'password-1234', inviteCode: second.code, requireInvite: true }),
      /INVITE_INVALID/
    );
  } finally {
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requireInvite controls signup and invite consumption is atomic with account creation', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.createAccount({ email: 'gated@example.com', password: 'password-1234', requireInvite: true }), /INVITE_REQUIRED/);
    const open = f.store.createAccount({ email: 'open@example.com', password: 'password-1234', requireInvite: false });
    assert.equal(open.email, 'open@example.com');
  } finally {
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('browser sessions are hash-at-rest, expire, and die when the account is revoked', () => {
  let now = 1_000_000;
  const f = fixture(() => now);
  try {
    const user = f.store.createAccount({ email: 'session@example.com', password: 'session-password' });
    const session = f.store.createSession(user.accountId, { ttlMs: 60_000 });
    assert.equal(typeof session.sessionId, 'string');
    assert.equal(f.store.getSessionAccount(session.sessionId)?.accountId, user.accountId);
    assert.equal(fs.readFileSync(f.dbPath).includes(session.sessionId), false);

    now += 60_001;
    assert.equal(f.store.getSessionAccount(session.sessionId), null);

    const next = f.store.createSession(user.accountId, { ttlMs: 60_000 });
    f.store.revokeAccount(user.accountId);
    assert.equal(f.store.getSessionAccount(next.sessionId), null);
  } finally {
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('admin role can only be assigned by local store API and accounts can be revoked or deleted', () => {
  const f = fixture();
  try {
    const admin = f.store.createAdmin({ email: 'admin@example.com', password: 'admin-password' });
    const user = f.store.createAccount({ email: 'user@example.com', password: 'user-password' });
    assert.equal(admin.role, 'admin');
    assert.equal(user.role, 'user');

    const revoked = f.store.revokeAccount(user.accountId);
    assert.ok(revoked.revokedAt);
    assert.equal(f.store.verifyPassword(user.email, 'user-password'), null);

    assert.equal(f.store.deleteAccount(user.accountId), true);
    assert.equal(f.store.getAccount(user.accountId), null);
  } finally {
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
