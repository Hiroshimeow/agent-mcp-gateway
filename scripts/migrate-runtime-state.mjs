#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { SQLiteAuthState } from './auth-session.mjs';
import { createDeviceStore } from './device-store.mjs';
import { createDevicePairingStore } from './device-pairing-store.mjs';
import { createDeviceUsageStore } from './device-usage.mjs';

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function tableColumns(db, name) {
  if (!tableExists(db, name)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name));
}

function value(row, columns, name, fallback = null) {
  return columns.has(name) ? row[name] : fallback;
}

function ensureTargetSchemas(targetDbPath) {
  const stores = [
    createDeviceStore({ dbPath: targetDbPath }),
    createDevicePairingStore({ dbPath: targetDbPath }),
    createDeviceUsageStore({ dbPath: targetDbPath }),
    new SQLiteAuthState(targetDbPath)
  ];
  for (const store of stores.reverse()) store.close();
}

export function migrateLegacyRuntimeState({ targetDbPath, legacyDeviceDbPath = null, legacyAuthStatePath = null } = {}) {
  if (!targetDbPath) throw new Error('targetDbPath is required.');
  const target = path.resolve(targetDbPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  ensureTargetSchemas(target);

  const report = {
    devicesImported: 0,
    usageImported: 0,
    pairingsSkipped: 0,
    oauthClientsImported: 0,
    legacyAccessTokensIgnored: 0,
    legacyRefreshTokensIgnored: 0
  };

  const legacyDevice = legacyDeviceDbPath ? path.resolve(legacyDeviceDbPath) : null;
  if (legacyDevice && legacyDevice !== target && fs.existsSync(legacyDevice)) {
    const source = new DatabaseSync(legacyDevice, { readOnly: true });
    const destination = new DatabaseSync(target);
    try {
      destination.exec('PRAGMA busy_timeout = 5000');
      if (tableExists(source, 'devices')) {
        const columns = tableColumns(source, 'devices');
        const insert = destination.prepare(`
          INSERT OR IGNORE INTO devices (
            device_id, device_name, owner_account_id, account_label, hostname, platform, arch, path_style,
            public_key_pem, enrolled_at, revoked_at, authorization_generation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of source.prepare('SELECT * FROM devices ORDER BY device_id').all()) {
          const result = insert.run(
            row.device_id,
            value(row, columns, 'device_name', row.device_id),
            value(row, columns, 'owner_account_id'),
            value(row, columns, 'account_label'),
            value(row, columns, 'hostname'),
            value(row, columns, 'platform'),
            value(row, columns, 'arch'),
            value(row, columns, 'path_style'),
            row.public_key_pem,
            row.enrolled_at,
            value(row, columns, 'revoked_at'),
            Number(value(row, columns, 'authorization_generation', 1)) || 1
          );
          report.devicesImported += Number(result.changes);
        }
      }

      if (tableExists(source, 'device_usage')) {
        const insert = destination.prepare(`
          INSERT OR IGNORE INTO device_usage (
            device_id, connections, reconnects, tool_calls_started, tool_calls_succeeded, tool_calls_failed,
            request_bytes, response_bytes, last_seen_at, last_error_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of source.prepare('SELECT * FROM device_usage ORDER BY device_id').all()) {
          const result = insert.run(
            row.device_id,
            Number(row.connections || 0),
            Number(row.reconnects || 0),
            Number(row.tool_calls_started || 0),
            Number(row.tool_calls_succeeded || 0),
            Number(row.tool_calls_failed || 0),
            Number(row.request_bytes || 0),
            Number(row.response_bytes || 0),
            Number(row.last_seen_at || 0),
            row.last_error_code || null
          );
          report.usageImported += Number(result.changes);
        }
      }

      if (tableExists(source, 'device_pairings')) {
        report.pairingsSkipped = Number(source.prepare('SELECT COUNT(*) AS count FROM device_pairings').get().count || 0);
      }
    } finally {
      destination.close();
      source.close();
    }
  }

  const legacyAuth = legacyAuthStatePath ? path.resolve(legacyAuthStatePath) : null;
  if (legacyAuth && fs.existsSync(legacyAuth)) {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(legacyAuth, 'utf8')); } catch {}
    if (parsed && typeof parsed === 'object') {
      const auth = new SQLiteAuthState(target);
      try {
        for (const client of Object.values(parsed.clients || {})) {
          if (!client?.client_id || auth.getClient(client.client_id)) continue;
          auth.setClient(client);
          report.oauthClientsImported += 1;
        }
        report.legacyAccessTokensIgnored = Object.keys(parsed.tokens || {}).length;
        report.legacyRefreshTokensIgnored = Object.keys(parsed.refreshTokens || {}).length;
      } finally {
        auth.close();
      }
    }
  }

  return report;
}

function argumentValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runtimeDir = path.resolve(process.env.MCP_RUNTIME_DIR || path.join(repoRoot, '.runtime'));
  const args = process.argv.slice(2);
  const report = migrateLegacyRuntimeState({
    targetDbPath: argumentValue(args, '--target', process.env.MCP_GATEWAY_DB_PATH || path.join(runtimeDir, 'gateway.sqlite')),
    legacyDeviceDbPath: argumentValue(args, '--legacy-devices', path.join(runtimeDir, 'devices.sqlite')),
    legacyAuthStatePath: argumentValue(args, '--legacy-auth', path.join(repoRoot, 'logs', 'auth-state.json'))
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`);
}
