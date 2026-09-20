import crypto from 'node:crypto';
import { escapeHtml, quickGuide } from './enduser-ui.mjs';

const CSRF_COOKIE = 'hcu_dashboard_csrf';
const CSRF_TTL_MS = 8 * 60 * 60 * 1000;

function parseCookies(header = '') {
  return String(header)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf('=');
      if (index <= 0) return cookies;
      try { cookies[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1)); } catch {}
      return cookies;
    }, {});
}

function secureRequest(req) {
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return Boolean(req.secure || forwarded === 'https');
}

function csrfEqual(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MiB`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', 'Z') : '—';
}

function shortId(value) {
  const text = String(value || '').trim();
  if (!text) return 'unknown';
  return text.length <= 12 ? text : `${text.slice(0, 8)}…${text.slice(-4)}`;
}

function clientLabel(clientId, oauthClientLookup, displayName = null) {
  const metadata = clientId && typeof oauthClientLookup === 'function' ? oauthClientLookup(clientId) : null;
  return {
    name: String(displayName || metadata?.client_name || metadata?.clientName || 'OAuth client'),
    raw: clientId ? shortId(clientId) : 'unknown'
  };
}

function csrfField(token) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

function metric(label, value, detail = '') {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div>`;
}

function renderDeviceRows(devices, csrf) {
  if (!devices.length) return '<tr><td colspan="6" class="empty">No paired devices.</td></tr>';
  return devices.map(device => {
    const status = device.online ? 'online' : 'offline';
    const usage = device.attributedUsage || {};
    return `<tr>
<td><span class="dot ${status}"></span><strong>${escapeHtml(device.deviceName)}</strong> <span class="muted">${escapeHtml(device.platform || 'unknown')} / ${escapeHtml(device.arch || 'unknown')}</span><small>${escapeHtml(device.deviceId)} · ${escapeHtml(status)}</small></td>
<td>${escapeHtml(formatTime(usage.lastSeenAt))}</td>
<td>${formatNumber(usage.succeeded || 0)} / ${formatNumber(usage.failed || 0)}</td>
<td>${formatBytes(usage.inputBytes || 0)} / ${formatBytes(usage.outputBytes || 0)}</td>
<td>~${formatNumber(usage.estimatedIoTokens || 0)}</td>
<td class="actions"><a href="/dashboard/devices/${encodeURIComponent(device.deviceId)}">View tools</a> <form method="post" action="/dashboard/devices/${encodeURIComponent(device.deviceId)}/rename">${csrfField(csrf)}<input name="device_name" maxlength="128" value="${escapeHtml(device.deviceName)}" aria-label="Device name"><button type="submit">Rename</button></form></td>
</tr>`;
  }).join('');
}

function renderToolRows(items) {
  if (!items.length) return '<tr><td colspan="5" class="empty">No tool activity yet.</td></tr>';
  return items.map(item => `<tr><td><code>${escapeHtml(item.tool)}</code></td><td>${formatNumber(item.calls)}</td><td>${formatNumber(item.failures)}</td><td>${formatBytes(item.inputBytes)}</td><td>${formatBytes(item.outputBytes)}</td></tr>`).join('');
}

function summarizeToolUsage(items) {
  const summary = items.reduce((total, item) => ({
    toolCalls: total.toolCalls + Number(item.calls || 0),
    failed: total.failed + Number(item.failures || 0),
    inputBytes: total.inputBytes + Number(item.inputBytes || 0),
    outputBytes: total.outputBytes + Number(item.outputBytes || 0)
  }), { toolCalls: 0, failed: 0, inputBytes: 0, outputBytes: 0 });
  return {
    ...summary,
    succeeded: summary.toolCalls - summary.failed,
    estimatedIoTokens: Math.ceil((summary.inputBytes + summary.outputBytes) / 4)
  };
}

function renderSkillRows(items) {
  if (!items.length) return '<tr><td colspan="5" class="empty">No named skill loads yet.</td></tr>';
  return items.map(item => `<tr><td><code>${escapeHtml(item.skillName)}</code></td><td>${formatNumber(item.loads)}</td><td>${formatNumber(item.failures)}</td><td>${formatBytes(item.outputBytes)}</td><td>~${formatNumber(item.estimatedTokens)}</td></tr>`).join('');
}

function renderErrorRows(items) {
  if (!items.length) return '<tr><td colspan="4" class="empty">No recent errors.</td></tr>';
  return items.map(item => `<tr><td>${escapeHtml(formatTime(item.eventAt))}</td><td><code>${escapeHtml(item.tool)}</code></td><td>${item.deviceName ? `<strong>${escapeHtml(item.deviceName)}</strong><small>${escapeHtml(shortId(item.deviceId))}</small>` : '—'}</td><td><code>${escapeHtml(item.errorCode || 'TOOL_ERROR')}</code></td></tr>`).join('');
}

function renderRecentErrors(items) {
  const newest = items.slice(0, 5);
  const remaining = items.slice(5, 20);
  const main = `<table><thead><tr><th>Time</th><th>Tool</th><th>Device</th><th>Error code</th></tr></thead><tbody>${renderErrorRows(newest)}</tbody></table>`;
  if (!remaining.length) return main;
  return `${main}<details><summary>Show ${remaining.length} more (max 20)</summary><table><tbody>${renderErrorRows(remaining)}</tbody></table></details>`;
}

function renderSessionRows(items, csrf) {
  if (!items.length) return '<tr><td colspan="6" class="empty">No OAuth client sessions.</td></tr>';
  return items.map(item => {
    const devices = item.devices?.length
      ? item.devices.map(device => `<strong>${escapeHtml(device.deviceName)}</strong><small>${escapeHtml(shortId(device.deviceId))}</small>`).join('')
      : '<span class="muted">No device activity yet</span>';
    const rename = `<form method="post" action="/dashboard/sessions/${encodeURIComponent(item.activitySessionId)}/rename">${csrfField(csrf)}<input name="client_name" maxlength="128" value="${escapeHtml(item.clientName)}" aria-label="OAuth client name"><button type="submit">Rename</button></form>`;
    return `<tr><td><code>${escapeHtml(item.activitySessionId)}</code></td><td><strong>${escapeHtml(item.clientName)}</strong><small>${escapeHtml(item.clientRaw)}</small>${rename}</td><td>${devices}</td><td>${escapeHtml(formatTime(item.startedAt))}</td><td>${escapeHtml(formatTime(item.lastSeenAt))}</td><td>${item.endedAt ? `disconnected ${escapeHtml(formatTime(item.endedAt))}` : `<form method="post" action="/dashboard/sessions/${encodeURIComponent(item.activitySessionId)}/end">${csrfField(csrf)}<button type="submit">Disconnect client session</button></form>`}</td></tr>`;
  }).join('');
}

function renderToolDefinitions(toolUsage, toolDefinitions) {
  if (!toolUsage.length) return '<div class="empty">No tool definitions to show yet.</div>';
  const byName = new Map((toolDefinitions || []).map(tool => [tool.name, tool]));
  return toolUsage.map(item => {
    const tool = byName.get(item.tool);
    const description = tool?.description || 'Definition unavailable in the current catalog.';
    const schema = tool?.inputSchema || { type: 'object' };
    return `<article class="tool-contract"><h3><code>${escapeHtml(item.tool)}</code></h3><p>${escapeHtml(description)}</p><pre>${escapeHtml(JSON.stringify(schema, null, 2))}</pre></article>`;
  }).join('');
}

function renderRecentCallRows(items) {
  if (!items.length) return '<tr><td colspan="8" class="empty">No recent metadata calls.</td></tr>';
  return items.map(item => `<tr><td>${escapeHtml(formatTime(item.eventAt))}</td><td><code>${escapeHtml(item.tool)}</code></td><td>${item.success ? 'success' : 'error'}</td><td>${formatNumber(item.durationMs)} ms</td><td>${formatBytes(item.inputBytes)}</td><td>${formatBytes(item.outputBytes)}</td><td><code>${escapeHtml(item.errorCode || '—')}</code></td><td>${item.activitySessionId ? `<code>${escapeHtml(item.activitySessionId)}</code><small>${escapeHtml(item.clientName)} · ${escapeHtml(item.clientRaw)}</small>` : '—'}</td></tr>`).join('');
}

function deviceUsageHtml({ device, toolUsage, recentCalls, toolDefinitions, csrf }) {
  const status = device.revoked ? 'revoked' : device.online ? 'online' : 'offline';
  const summary = summarizeToolUsage(toolUsage);
  const lastSeenAt = recentCalls[0]?.eventAt || null;
  const revokeConfirm = escapeHtml(JSON.stringify(`Revoke ${device.deviceName}? This disconnects this device, and the revoked identity cannot reconnect.`));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(device.deviceName)} · MCP Gateway</title>
<style>
:root{color-scheme:dark;--bg:#080a0d;--panel:#0d1117;--line:#252b34;--text:#e6edf3;--muted:#8b949e;--good:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px ui-monospace,SFMono-Regular,Consolas,monospace}main{width:min(1100px,94vw);margin:24px auto 48px}a{color:var(--accent)}header{border-bottom:1px solid var(--line);padding-bottom:14px}.muted{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));border:1px solid var(--line);background:var(--panel);margin-top:18px}.metric{padding:12px;border-right:1px solid var(--line)}.metric:last-child{border-right:0}.metric span,.metric small{display:block;color:var(--muted);font-size:11px}.metric strong{display:block;font-size:20px;margin:5px 0 2px}section{margin-top:20px;border-top:1px solid var(--line);overflow-x:auto}h1{font-size:20px;margin:10px 0 6px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:10px 0}table{width:100%;border-collapse:collapse;background:var(--panel);min-width:680px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500;font-size:11px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px}.dot.online{background:var(--good)}.dot.offline{background:var(--warn)}.dot.revoked{background:var(--bad)}.tool-contract{border:1px solid var(--line);background:var(--panel);padding:12px;margin:8px 0}.tool-contract h3{margin:0 0 8px}.tool-contract p{color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#080a0d;padding:10px;border:1px solid var(--line)}.danger-zone{border:1px solid #5b2525;padding:14px;overflow:visible}.danger-zone p{color:var(--muted)}button.danger{color:#ffb4ad;border:1px solid #5b2525;background:#241313;padding:7px 10px;font:inherit;cursor:pointer}@media(max-width:760px){.metrics{grid-template-columns:repeat(2,1fr)}.metric:nth-child(even){border-right:0}}
</style></head><body><main>
<header><a href="/dashboard">← Dashboard</a><h1><span class="dot ${status}"></span>${escapeHtml(device.deviceName)}</h1><div class="muted">${escapeHtml(device.deviceId)} · ${escapeHtml(status)} · last seen ${escapeHtml(formatTime(lastSeenAt))}</div></header>
<div class="metrics">${metric('Tool calls', formatNumber(summary.toolCalls))}${metric('Success', formatNumber(summary.succeeded))}${metric('Failed', formatNumber(summary.failed))}${metric('Input / Output', `${formatBytes(summary.inputBytes)} / ${formatBytes(summary.outputBytes)}`)}${metric('Estimated tokens', `~${formatNumber(summary.estimatedIoTokens)}`)}</div>
<section><h2>Tools used by this device</h2><table><thead><tr><th>Tool</th><th>Calls</th><th>Failures</th><th>Input</th><th>Output</th></tr></thead><tbody>${renderToolRows(toolUsage)}</tbody></table></section>
<section><h2>Tool definitions & input contracts</h2>${renderToolDefinitions(toolUsage, toolDefinitions)}</section>
<section><h2>Recent metadata calls</h2><table><thead><tr><th>Time</th><th>Tool</th><th>Result</th><th>Duration</th><th>Input</th><th>Output</th><th>Error code</th><th>Activity / OAuth client</th></tr></thead><tbody>${renderRecentCallRows(recentCalls)}</tbody></table></section>
<section class="danger-zone"><h2>Danger zone</h2><p>Revoking disconnects this device immediately. The revoked identity cannot reconnect.</p>${device.revoked ? '<span class="muted">This device is already revoked.</span>' : `<form method="post" action="/dashboard/devices/${encodeURIComponent(device.deviceId)}/revoke" onsubmit="return confirm(${revokeConfirm})">${csrfField(csrf)}<button class="danger" type="submit">Revoke ${escapeHtml(device.deviceName)}</button></form>`}</section>
</main></body></html>`;
}

function renderGatewayStatus(devices, schema, serverVersion) {
  const online = devices.filter(device => device.online).length;
  const offline = devices.length - online;
  return `<span class="health">● Gateway online</span><span><strong>${online}</strong> online · <strong>${offline}</strong> offline</span><span><strong>${formatNumber(schema.toolCount)} tools</strong></span><span><strong>${formatNumber(schema.schemaBytes)} B schema</strong></span><span><strong>Server ${escapeHtml(serverVersion || 'unknown')}</strong></span>`;
}

function renderAccountMetrics(usage) {
  const schema = usage.schema || {};
  const estimatedTokens = Math.ceil((Number(usage.totals.inputBytes || 0) + Number(usage.totals.outputBytes || 0)) / 4);
  return `${metric('Tool calls', formatNumber(usage.totals.toolCalls))}${metric('Success', formatNumber(usage.totals.succeeded))}${metric('Failed', formatNumber(usage.totals.failed))}${metric('Input / Output', `${formatBytes(usage.totals.inputBytes)} / ${formatBytes(usage.totals.outputBytes)}`)}${metric('Estimated tokens', `~${formatNumber(estimatedTokens)}`)}${metric('tools/list', formatNumber(usage.catalog.listCalls))}${metric('Schema tokens', `~${formatNumber(schema.estimatedTokens)}`)}`;
}

function renderDevicesTable(devices, csrf) {
  return `<table><thead><tr><th>Device</th><th>Last seen</th><th>OK / Fail</th><th>Input / Output</th><th>Estimated tokens</th><th>Controls</th></tr></thead><tbody>${renderDeviceRows(devices, csrf)}</tbody></table>`;
}

function renderTopToolsTable(items) {
  return `<table><thead><tr><th>Tool</th><th>Calls</th><th>Failures</th><th>Input</th><th>Output</th></tr></thead><tbody>${renderToolRows(items)}</tbody></table>`;
}

function renderSkillLoadsTable(items) {
  return `<table><thead><tr><th>Skill</th><th>Loads</th><th>Failures</th><th>Output</th><th>Estimated tokens</th></tr></thead><tbody>${renderSkillRows(items)}</tbody></table>`;
}

function renderSessionsTable(items, csrf) {
  return `<table><thead><tr><th>Client session</th><th>OAuth client</th><th>Devices used</th><th>Started</th><th>Last seen</th><th>State</th></tr></thead><tbody>${renderSessionRows(items, csrf)}</tbody></table>`;
}

function dashboardFragments({ usage, devices, csrf, serverVersion }) {
  return {
    status: renderGatewayStatus(devices, usage.schema || {}, serverVersion),
    metrics: renderAccountMetrics(usage),
    devices: renderDevicesTable(devices, csrf),
    topTools: renderTopToolsTable(usage.topTools),
    skillLoads: renderSkillLoadsTable(usage.skillLoads),
    errors: renderRecentErrors(usage.recentErrors),
    sessions: renderSessionsTable(usage.activitySessions, csrf)
  };
}

function dashboardHtml({ account, usage, devices, csrf, baseUrl, serverVersion }) {
  const fragments = dashboardFragments({ usage, devices, csrf, serverVersion });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Gateway Dashboard</title>
<style>
:root{color-scheme:dark;--bg:#080a0d;--panel:#0d1117;--line:#252b34;--text:#e6edf3;--muted:#8b949e;--good:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px ui-monospace,SFMono-Regular,Consolas,monospace}main{width:min(1500px,96vw);margin:24px auto 48px}.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding:0 0 14px}.brand{font-size:18px;letter-spacing:.18em}.account{color:var(--muted);text-align:right}.strip{display:flex;gap:18px;flex-wrap:wrap;padding:12px 0;color:var(--muted)}.strip strong{color:var(--text)}.health{color:var(--good)}.scope{padding:16px 0 8px;color:var(--muted)}.scope strong{color:var(--text)}.metrics{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));border:1px solid var(--line);background:var(--panel)}.metric{padding:12px;border-right:1px solid var(--line);min-width:0}.metric:last-child{border-right:0}.metric span,.metric small{display:block;color:var(--muted);font-size:11px}.metric strong{display:block;font-size:20px;margin:5px 0 2px}section{margin-top:20px;border-top:1px solid var(--line)}h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:10px 0}table{width:100%;border-collapse:collapse;background:var(--panel)}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:11px}tr:last-child td{border-bottom:0}td small{display:block;color:var(--muted);margin-top:3px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px}.dot.online{background:var(--good)}.dot.offline{background:var(--warn)}.dot.revoked{background:var(--bad)}code{color:#c9d1d9}form{display:inline-flex;gap:5px;margin:0 5px 3px 0}input{max-width:180px;background:#080a0d;color:var(--text);border:1px solid var(--line);padding:5px 7px}button{background:#1f2937;color:var(--text);border:1px solid #374151;padding:5px 8px;font:inherit;cursor:pointer}button:hover{border-color:var(--accent)}button.danger{color:#ffb4ad;border-color:#5b2525}.empty,.muted{color:var(--muted)}.onboarding{margin:18px 0;padding:18px;border:1px solid var(--line);background:var(--panel)}.onboarding h2{font-size:18px;text-transform:none;letter-spacing:0;color:var(--text);margin-top:0}.onboarding .button{display:inline-block;background:#1769aa;color:#fff;border:1px solid #2586d7;padding:9px 12px;text-decoration:none}.privacy{padding:12px 0;color:var(--muted);line-height:1.55}.foot{margin-top:18px;color:var(--muted);font-size:11px}.foot form{float:right}@media(max-width:900px){.metrics{grid-template-columns:repeat(2,1fr)}.metric:nth-child(even){border-right:0}section{overflow-x:auto}table{min-width:760px}.top{align-items:flex-start;flex-direction:column}.account{text-align:left}}
</style></head><body><main>
<header class="top"><div><div class="brand">MCP GATEWAY</div><div><a href="/dashboard">Dashboard</a> · <a href="/pair">Pair device</a> · <a href="/help">Help</a></div><div class="strip" data-live="status">${fragments.status}</div></div><div class="account">${escapeHtml(account.email || account.accountId)}<br>${escapeHtml(account.accountId)}</div></header>
${devices.length ? '' : `<div class="onboarding"><h2>Pair your first device</h2><p>Connect a device to make its tools available through this gateway.</p><a class="button" href="/pair">Pair a device</a>${quickGuide(baseUrl)}</div>`}
<div class="scope"><strong>Usage for this account</strong> · tool traffic below is attributed from observed MCP gateway events only.</div>
<div class="metrics" data-live="metrics">${fragments.metrics}</div>
<section><h2>Devices</h2><div data-live="devices">${fragments.devices}</div></section>
<section><h2>Top tools</h2><div data-live="topTools">${fragments.topTools}</div></section>
<section><h2>Skill loads</h2><div data-live="skillLoads">${fragments.skillLoads}</div></section>
<section><h2>Recent errors</h2><div data-live="errors">${fragments.errors}</div></section>
<section><h2>OAuth client sessions</h2><div data-live="sessions">${fragments.sessions}</div></section>
<section class="privacy"><h2>Privacy and connection model</h2><p>Your account only lists devices owned by this account. The private device key stays on the local device; the gateway stores public identity, ownership, and operational usage metadata. Devices connect outbound to the gateway, so no inbound device port is required.</p></section>
<div class="foot"><form method="post" action="/logout"><button type="submit">Sign out</button></form></div>
<script>
(() => {
  let dirty = false;
  let inFlight = false;
  const controls = 'input,button,select,textarea,[contenteditable="true"]';
  document.addEventListener('input', event => {
    if (event.target?.matches?.('input,textarea,select,[contenteditable="true"]')) dirty = true;
  });
  async function refreshDashboard() {
    const focused = document.activeElement?.matches?.(controls);
    if (document.visibilityState !== 'visible' || dirty || focused || inFlight) return;
    inFlight = true;
    try {
      const response = await fetch('/dashboard/state', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) return;
      const fragments = await response.json();
      for (const [key, html] of Object.entries(fragments)) {
        const target = document.querySelector('[data-live="' + key + '"]');
        if (target && target.innerHTML !== html) target.innerHTML = html;
      }
    } catch { /* retain the last known dashboard state */ }
    finally { inFlight = false; }
  }
  const timer = setInterval(refreshDashboard, 3500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshDashboard();
  });
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
})();
</script>
</main></body></html>`;
}

export function installDashboardRoutes(app, { accountFromRequest, usageStore, deviceBroker, baseUrlFromRequest, oauthClientLookup, listTools, serverVersion = 'unknown' } = {}) {
  if (!app || typeof accountFromRequest !== 'function' || !usageStore || !deviceBroker) {
    throw new Error('app, accountFromRequest, usageStore, and deviceBroker are required.');
  }

  function requireAccount(req, res) {
    const account = accountFromRequest(req);
    if (!account) {
      res.redirect(302, `/login?return_to=${encodeURIComponent('/dashboard')}`);
      return null;
    }
    return account;
  }

  function ensureCsrf(req, res) {
    const cookies = parseCookies(req.headers?.cookie || '');
    const current = String(cookies[CSRF_COOKIE] || '').trim();
    if (current) return current;
    const token = crypto.randomBytes(24).toString('base64url');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureRequest(req),
      maxAge: CSRF_TTL_MS,
      path: '/dashboard'
    });
    return token;
  }

  function requireCsrf(req, res) {
    const cookie = parseCookies(req.headers?.cookie || '')[CSRF_COOKIE];
    if (!csrfEqual(cookie, req.body?._csrf)) {
      res.status(403).type('text').send('CSRF check failed.');
      return false;
    }
    return true;
  }

  function unavailable(res) {
    res.status(404).type('text').send('Resource unavailable.');
  }

  function loadDashboardData(account) {
    const usage = usageStore.getAccountUsage(account.accountId);
    const deviceUsage = usageStore.getDeviceUsageForAccount(account.accountId);
    const usageByDevice = new Map(deviceUsage.map(item => [item.deviceId, item]));
    const devices = deviceBroker.listDevices({ accountId: account.accountId })
      .filter(device => !device.revoked)
      .map(device => ({
        ...device,
        attributedUsage: usageByDevice.get(device.deviceId) || {
          deviceId: device.deviceId,
          lastSeenAt: null,
          toolCalls: 0,
          succeeded: 0,
          failed: 0,
          inputBytes: 0,
          outputBytes: 0,
          estimatedIoTokens: 0,
          estimationMethod: 'utf8_bytes_div_4_estimate'
        }
      }));
    const devicesById = new Map(devices.map(device => [device.deviceId, device]));
    usage.recentErrors = usage.recentErrors.map(item => ({
      ...item,
      deviceName: item.deviceId ? devicesById.get(item.deviceId)?.deviceName || null : null
    }));
    usage.activitySessions = usage.activitySessions.map(item => {
      const client = clientLabel(item.clientId, oauthClientLookup, item.displayName);
      const deviceIds = typeof usageStore.getActivitySessionDeviceIds === 'function'
        ? usageStore.getActivitySessionDeviceIds(account.accountId, item.activitySessionId, { limit: 20 })
        : [];
      return {
        ...item,
        clientName: client.name,
        clientRaw: client.raw,
        devices: deviceIds.map(deviceId => devicesById.get(deviceId)).filter(Boolean)
      };
    });
    return { usage, devices };
  }

  app.get('/dashboard', (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const csrf = ensureCsrf(req, res);
    const { usage, devices } = loadDashboardData(account);
    const baseUrl = typeof baseUrlFromRequest === 'function' ? baseUrlFromRequest(req) : `${req.protocol}://${req.get('host')}`;
    res.status(200).type('html').send(dashboardHtml({ account, usage, devices, csrf, baseUrl, serverVersion }));
  });

  app.get('/dashboard/state', (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const csrf = ensureCsrf(req, res);
    const { usage, devices } = loadDashboardData(account);
    res.set('Cache-Control', 'no-store');
    res.status(200).json(dashboardFragments({ usage, devices, csrf, serverVersion }));
  });

  app.get('/dashboard/devices/:deviceId', async (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const device = deviceBroker.listDevices({ accountId: account.accountId })
      .find(item => !item.revoked && item.deviceId === req.params.deviceId);
    if (!device) return unavailable(res);
    const csrf = ensureCsrf(req, res);
    const toolUsage = usageStore.getDeviceToolUsage(account.accountId, device.deviceId);
    const recentCalls = (typeof usageStore.getDeviceRecentToolCalls === 'function'
      ? usageStore.getDeviceRecentToolCalls(account.accountId, device.deviceId, { limit: 20 })
      : []).map(item => {
      const client = clientLabel(item.clientId, oauthClientLookup);
      return { ...item, clientName: client.name, clientRaw: client.raw };
    });
    const usedTools = new Set(toolUsage.map(item => item.tool));
    const toolDefinitions = typeof listTools === 'function'
      ? (await listTools()).filter(tool => usedTools.has(tool.name))
      : [];
    res.status(200).type('html').send(deviceUsageHtml({ device, toolUsage, recentCalls, toolDefinitions, csrf }));
  });

  app.post('/dashboard/devices/:deviceId/rename', (req, res) => {
    const account = requireAccount(req, res);
    if (!account || !requireCsrf(req, res)) return;
    try {
      deviceBroker.renameOwnedDevice({ accountId: account.accountId, deviceId: req.params.deviceId, deviceName: req.body?.device_name });
      res.redirect(303, '/dashboard');
    } catch (error) {
      if (error?.code === 'DEVICE_ACCESS_DENIED' || /Unknown device/i.test(String(error?.message || ''))) return unavailable(res);
      res.status(400).type('text').send('Invalid device update.');
    }
  });

  app.post('/dashboard/devices/:deviceId/revoke', (req, res) => {
    const account = requireAccount(req, res);
    if (!account || !requireCsrf(req, res)) return;
    try {
      deviceBroker.revokeOwnedDevice({ accountId: account.accountId, deviceId: req.params.deviceId });
      res.redirect(303, '/dashboard');
    } catch (error) {
      if (error?.code === 'DEVICE_ACCESS_DENIED' || /Unknown device/i.test(String(error?.message || ''))) return unavailable(res);
      res.status(400).type('text').send('Invalid device revoke.');
    }
  });

  app.post('/dashboard/sessions/:activitySessionId/rename', (req, res) => {
    const account = requireAccount(req, res);
    if (!account || !requireCsrf(req, res)) return;
    try {
      usageStore.renameActivitySession({
        activitySessionId: req.params.activitySessionId,
        accountId: account.accountId,
        displayName: req.body?.client_name
      });
      res.redirect(303, '/dashboard');
    } catch (error) {
      if (/not found/i.test(String(error?.message || ''))) return unavailable(res);
      res.status(400).type('text').send('Invalid OAuth client name.');
    }
  });

  app.post('/dashboard/sessions/:activitySessionId/end', (req, res) => {
    const account = requireAccount(req, res);
    if (!account || !requireCsrf(req, res)) return;
    try {
      usageStore.endActivitySession({ activitySessionId: req.params.activitySessionId, accountId: account.accountId });
      res.redirect(303, '/dashboard');
    } catch {
      unavailable(res);
    }
  });

  return { csrfCookieName: CSRF_COOKIE };
}
