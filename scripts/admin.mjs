#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccountStore } from './account-store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = path.resolve(process.env.MCP_RUNTIME_DIR || path.join(packageRoot, '.runtime'));
const dbPath = path.resolve(process.env.MCP_GATEWAY_DB_PATH || path.join(runtimeDirectory, 'gateway.sqlite'));
const [area, action, ...args] = process.argv.slice(2);

function usage() {
  console.error([
    'Usage:',
    '  node scripts/admin.mjs account create-admin <email>   # password from HCU_ADMIN_PASSWORD',
    '  node scripts/admin.mjs account list',
    '  node scripts/admin.mjs account revoke <account_id|email>',
    '  node scripts/admin.mjs account delete <account_id|email>',
    '  node scripts/admin.mjs invite create [count]',
    '  node scripts/admin.mjs invite list',
    '  node scripts/admin.mjs invite revoke <code>'
  ].join('\n'));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function resolveAccount(store, value) {
  const key = String(value || '').trim();
  if (!key) throw new Error('account_id or email is required.');
  return key.includes('@') ? store.getAccountByEmail(key) : store.getAccount(key);
}

const store = createAccountStore({ dbPath });
try {
  if (area === 'account' && action === 'create-admin') {
    const email = args[0];
    const password = process.env.HCU_ADMIN_PASSWORD;
    if (!email || !password) throw new Error('create-admin requires <email> and HCU_ADMIN_PASSWORD in the local environment.');
    print({ ok: true, account: store.createAdmin({ email, password }) });
  } else if (area === 'account' && action === 'list') {
    print({ ok: true, accounts: store.listAccounts() });
  } else if (area === 'account' && ['revoke', 'delete'].includes(action)) {
    const account = resolveAccount(store, args[0]);
    if (!account) throw new Error('Unknown account.');
    if (action === 'revoke') print({ ok: true, account: store.revokeAccount(account.accountId) });
    else print({ ok: true, account_id: account.accountId, deleted: store.deleteAccount(account.accountId) });
  } else if (area === 'invite' && action === 'create') {
    const count = args[0] === undefined ? 1 : Number(args[0]);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('invite create count must be an integer from 1 to 100.');
    const codes = Array.from({ length: count }, () => store.createInvite().code);
    print({ ok: true, codes });
  } else if (area === 'invite' && action === 'list') {
    print({ ok: true, invites: store.listInvites() });
  } else if (area === 'invite' && action === 'revoke') {
    print({ ok: true, invite: store.revokeInvite(args[0]) });
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error?.code || 'ADMIN_COMMAND_FAILED', error: error?.message || String(error) }));
  process.exitCode = 1;
} finally {
  store.close();
}
