import crypto from 'node:crypto';
import { escapeHtml, quickGuide } from './enduser-ui.mjs';
import { compareStableVersions, isNewerStableVersion } from './device-release.mjs';

const CSRF_COOKIE = 'hcu_dashboard_csrf';
const CSRF_TTL_MS = 8 * 60 * 60 * 1000;
const USAGE_PERIODS = Object.freeze({
  day: { label: '24H', ms: 24 * 60 * 60 * 1000 },
  week: { label: '7D', ms: 7 * 24 * 60 * 60 * 1000 },
  month: { label: '30D', ms: 30 * 24 * 60 * 60 * 1000 }
});

function usagePeriod(value, now = Date.now()) {
  const key = Object.hasOwn(USAGE_PERIODS, String(value || '')) ? String(value) : 'day';
  const config = USAGE_PERIODS[key];
  return { key, label: config.label, since: Number(now) - config.ms };
}

function renderPeriodControls(period, { basePath = '/dashboard' } = {}) {
  return `<nav class="periods" aria-label="Usage period">${Object.entries(USAGE_PERIODS).map(([key, config]) => `<a class="${period.key === key ? 'active' : ''}" href="${basePath}?range=${key}">${config.label}</a>`).join('')}</nav>`;
}

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

function renderDeviceRows(devices, csrf, period) {
  if (!devices.length) return '<tr><td colspan="7" class="empty">No paired devices.</td></tr>';
  return devices.map(device => {
    const status = device.online ? 'online' : 'offline';
    const usage = device.attributedUsage || {};
    const update = device.update || null;
    const currentVersion = device.packageVersion || 'unknown';
    const trafficBytes = Number(usage.inputBytes || 0) + Number(usage.outputBytes || 0);
    const searchable = [device.deviceName, device.hostname, device.deviceId, device.platform, device.arch].filter(Boolean).join(' ').toLowerCase();
    let updateControl = '';
    if (update && ['requested', 'accepted', 'installed'].includes(update.state)) {
      updateControl = `<span class="muted">Updating → ${escapeHtml(update.targetVersion)}</span>`;
    } else if (device.updateAvailable && device.selfUpdateSupported && device.online) {
      updateControl = `<form method="post" action="/dashboard/devices/${encodeURIComponent(device.deviceId)}/update">${csrfField(csrf)}<button type="submit">Update → ${escapeHtml(device.latestPackageVersion)}</button></form>`;
    } else if (device.updateAvailable && !device.selfUpdateSupported) {
      updateControl = '<span class="muted">Bootstrap 1.0.5 once</span>';
    } else if (device.packageVersion && device.latestPackageVersion && !device.updateAvailable) {
      updateControl = '<span class="muted">Up to date</span>';
    }
    if (update?.state === 'failed') {
      updateControl = `<span class="muted">Update failed${update.error?.code ? ` · ${escapeHtml(update.error.code)}` : ''}</span> ${updateControl}`;
    }
    return `<tr data-device-id="${escapeHtml(device.deviceId)}" data-device-name="${escapeHtml(searchable)}" data-device-status="${status}" data-last-seen="${Number(usage.lastSeenAt || 0)}" data-traffic="${trafficBytes}" data-errors="${Number(usage.failed || 0)}">
<td><span class="dot ${status}"></span><strong>${escapeHtml(device.deviceName)}</strong> <span class="muted">${escapeHtml(device.platform || 'unknown')} / ${escapeHtml(device.arch || 'unknown')}</span><small>${escapeHtml(device.hostname || device.deviceId)} · ${escapeHtml(status)}</small><small class="live-activity" data-activity>idle</small></td>
<td><code>${escapeHtml(currentVersion)}</code>${device.latestPackageVersion ? `<small>latest ${escapeHtml(device.latestPackageVersion)}</small>` : ''}</td>
<td>${escapeHtml(formatTime(usage.lastSeenAt))}</td>
<td>${formatNumber(usage.succeeded || 0)} / ${formatNumber(usage.failed || 0)}</td>
<td><span class="io io-in" data-io="in" title="Gateway → device">IN ${formatBytes(usage.inputBytes || 0)}</span><span class="io-sep"> / </span><span class="io io-out" data-io="out" title="Device → gateway">OUT ${formatBytes(usage.outputBytes || 0)}</span></td>
<td>~${formatNumber(usage.estimatedIoTokens || 0)}</td>
<td class="actions"><a href="/dashboard/devices/${encodeURIComponent(device.deviceId)}?range=${encodeURIComponent(period.key)}">View tools</a> ${updateControl} <form method="post" action="/dashboard/devices/${encodeURIComponent(device.deviceId)}/rename">${csrfField(csrf)}<input name="device_name" maxlength="128" value="${escapeHtml(device.deviceName)}" aria-label="Device name"><button type="submit">Rename</button></form></td>
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
  if (!items.length) return '<tr><td colspan="5" class="empty">No active OAuth client sessions.</td></tr>';
  return items.map(item => {
    const devices = item.devices?.length
      ? `<div class="session-devices">${item.devices.map(device => `<span class="session-device"><strong>${escapeHtml(device.deviceName)}</strong><small>${escapeHtml(shortId(device.deviceId))}</small></span>`).join('')}</div>`
      : '<div class="session-devices"><span class="muted">No device activity yet</span></div>';
    const rename = `<form method="post" action="/dashboard/sessions/${encodeURIComponent(item.activitySessionId)}/rename">${csrfField(csrf)}<input name="client_name" maxlength="128" value="${escapeHtml(item.clientName)}" aria-label="OAuth client name"><button type="submit">Rename</button></form>`;
    return `<tr><td class="session-client"><strong>${escapeHtml(item.clientName)}</strong><small>${escapeHtml(item.clientRaw)}</small>${rename}${devices}</td><td>${escapeHtml(formatTime(item.startedAt))}</td><td>${escapeHtml(formatTime(item.lastSeenAt))}</td><td><code>${escapeHtml(item.activitySessionId)}</code></td><td><form method="post" action="/dashboard/sessions/${encodeURIComponent(item.activitySessionId)}/end">${csrfField(csrf)}<button type="submit">Disconnect client session</button></form></td></tr>`;
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

function deviceUsageHtml({ device, toolUsage, recentCalls, toolDefinitions, csrf, period }) {
  const status = device.online ? 'online' : 'offline';
  const summary = summarizeToolUsage(toolUsage);
  const lastSeenAt = recentCalls[0]?.eventAt || null;
  const revokeConfirm = escapeHtml(JSON.stringify(`Revoke and forget ${device.deviceName}? This disconnects the device and removes its product state. Pairing again creates a new enrollment.`));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(device.deviceName)} · MCP Gateway</title>
<style>
:root{color-scheme:dark;--bg:#080a0d;--panel:#0d1117;--line:#252b34;--text:#e6edf3;--muted:#8b949e;--good:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px ui-monospace,SFMono-Regular,Consolas,monospace}main{width:min(1100px,94vw);margin:24px auto 48px}a{color:var(--accent)}header{border-bottom:1px solid var(--line);padding-bottom:14px}.muted{color:var(--muted)}.periods{display:inline-flex;margin-top:10px;border:1px solid var(--line);background:var(--panel)}.periods a{padding:6px 10px;color:var(--muted);text-decoration:none;border-right:1px solid var(--line)}.periods a:last-child{border-right:0}.periods a.active{color:var(--text);background:#1f2937}.metrics{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));border:1px solid var(--line);background:var(--panel);margin-top:18px}.metric{padding:12px;border-right:1px solid var(--line)}.metric:last-child{border-right:0}.metric span,.metric small{display:block;color:var(--muted);font-size:11px}.metric strong{display:block;font-size:20px;margin:5px 0 2px}section{margin-top:20px;border-top:1px solid var(--line);overflow-x:auto}h1{font-size:20px;margin:10px 0 6px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:10px 0}table{width:100%;border-collapse:collapse;background:var(--panel);min-width:680px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500;font-size:11px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px}.dot.online{background:var(--good)}.dot.offline{background:var(--warn)}.dot.revoked{background:var(--bad)}.tool-contract{border:1px solid var(--line);background:var(--panel);padding:12px;margin:8px 0}.tool-contract h3{margin:0 0 8px}.tool-contract p{color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#080a0d;padding:10px;border:1px solid var(--line)}.danger-zone{border:1px solid #5b2525;padding:14px;overflow:visible}.danger-zone p{color:var(--muted)}button.danger{color:#ffb4ad;border:1px solid #5b2525;background:#241313;padding:7px 10px;font:inherit;cursor:pointer}@media(max-width:760px){.metrics{grid-template-columns:repeat(2,1fr)}.metric:nth-child(even){border-right:0}}
</style></head><body><main>
<header><a href="/dashboard?range=${encodeURIComponent(period.key)}">← Dashboard</a><h1><span class="dot ${status}"></span>${escapeHtml(device.deviceName)}</h1><div class="muted">${escapeHtml(device.deviceId)} · ${escapeHtml(status)} · ${escapeHtml(period.label)} usage · last seen ${escapeHtml(formatTime(lastSeenAt))}</div>${renderPeriodControls(period, { basePath: `/dashboard/devices/${encodeURIComponent(device.deviceId)}` })}</header>
<div class="metrics">${metric('Tool calls', formatNumber(summary.toolCalls))}${metric('Success', formatNumber(summary.succeeded))}${metric('Failed', formatNumber(summary.failed))}${metric('Input / Output', `${formatBytes(summary.inputBytes)} / ${formatBytes(summary.outputBytes)}`)}${metric('Estimated tokens', `~${formatNumber(summary.estimatedIoTokens)}`)}</div>
<section><h2>Tools used by this device</h2><table><thead><tr><th>Tool</th><th>Calls</th><th>Failures</th><th>Input</th><th>Output</th></tr></thead><tbody>${renderToolRows(toolUsage)}</tbody></table></section>
<section><h2>Tool definitions & input contracts</h2>${renderToolDefinitions(toolUsage, toolDefinitions)}</section>
<section><h2>Recent metadata calls</h2><table><thead><tr><th>Time</th><th>Tool</th><th>Result</th><th>Duration</th><th>Input</th><th>Output</th><th>Error code</th><th>Activity / OAuth client</th></tr></thead><tbody>${renderRecentCallRows(recentCalls)}</tbody></table></section>
<section class="danger-zone"><h2>Danger zone</h2><p>Revoke disconnects this device immediately and forgets all product-facing device state. Server-side audit logs are retained only for manual forensic access.</p><form method="post" action="/dashboard/devices/${encodeURIComponent(device.deviceId)}/revoke" onsubmit="return confirm(${revokeConfirm})">${csrfField(csrf)}<button class="danger" type="submit">Revoke & forget ${escapeHtml(device.deviceName)}</button></form></section>
</main></body></html>`;
}

function renderGatewayStatus(devices, schema) {
  const online = devices.filter(device => device.online).length;
  const offline = devices.length - online;
  return `<span class="health">● Gateway online</span><span><strong>${online}</strong> online · <strong>${offline}</strong> offline</span><span><strong>${formatNumber(schema.toolCount)} tools</strong></span><span><strong>${formatNumber(schema.schemaBytes)} B schema</strong></span><span id="freshness">Updated now</span>`;
}

function renderAccountMetrics(usage) {
  const schema = usage.schema || {};
  const estimatedTokens = Math.ceil((Number(usage.totals.inputBytes || 0) + Number(usage.totals.outputBytes || 0)) / 4);
  return `${metric('Tool calls', formatNumber(usage.totals.toolCalls))}${metric('Success', formatNumber(usage.totals.succeeded))}${metric('Failed', formatNumber(usage.totals.failed))}${metric('Input / Output', `${formatBytes(usage.totals.inputBytes)} / ${formatBytes(usage.totals.outputBytes)}`)}${metric('Estimated tokens', `~${formatNumber(estimatedTokens)}`)}${metric('tools/list', formatNumber(usage.catalog.listCalls))}${metric('Schema tokens', `~${formatNumber(schema.estimatedTokens)}`)}`;
}

function renderDevicesTable(devices, csrf, period) {
  return `<table id="devices-table"><thead><tr><th>Device</th><th>Version</th><th>Last seen</th><th>OK / Fail</th><th>Input / Output</th><th>Estimated tokens</th><th>Controls</th></tr></thead><tbody>${renderDeviceRows(devices, csrf, period)}</tbody></table>`;
}

function renderTopToolsTable(items) {
  return `<table><thead><tr><th>Tool</th><th>Calls</th><th>Failures</th><th>Input</th><th>Output</th></tr></thead><tbody>${renderToolRows(items)}</tbody></table>`;
}

function renderSkillLoadsTable(items) {
  return `<table><thead><tr><th>Skill</th><th>Loads</th><th>Failures</th><th>Output</th><th>Estimated tokens</th></tr></thead><tbody>${renderSkillRows(items)}</tbody></table>`;
}

function renderSessionsTable(items, csrf) {
  return `<table class="sessions-table"><thead><tr><th>OAuth client</th><th>Started</th><th>Last seen</th><th>Client session</th><th>State</th></tr></thead><tbody>${renderSessionRows(items, csrf)}</tbody></table>`;
}

function dashboardFragments({ usage, devices, csrf, period }) {
  return {
    status: renderGatewayStatus(devices, usage.schema || {}),
    metrics: renderAccountMetrics(usage),
    devices: renderDevicesTable(devices, csrf, period),
    topTools: renderTopToolsTable(usage.topTools),
    skillLoads: renderSkillLoadsTable(usage.skillLoads),
    errors: renderRecentErrors(usage.recentErrors),
    sessions: renderSessionsTable(usage.activitySessions, csrf),
    sessionCount: String(usage.activitySessions.length)
  };
}

function dashboardHtml({ account, usage, devices, csrf, baseUrl, serverVersion, period }) {
  const fragments = dashboardFragments({ usage, devices, csrf, period });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Gateway Dashboard</title>
<style>
:root{color-scheme:dark;--bg:#080a0d;--panel:#0d1117;--line:#252b34;--text:#e6edf3;--muted:#8b949e;--good:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px ui-monospace,SFMono-Regular,Consolas,monospace}main{width:min(1500px,96vw);margin:24px auto 48px}a{color:var(--accent)}.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding:0 0 14px}.brand{font-size:18px;letter-spacing:.18em}.version{margin-left:10px;font-size:11px;letter-spacing:0;color:var(--muted);white-space:nowrap}.account{color:var(--muted);text-align:right}.strip{display:flex;gap:18px;flex-wrap:wrap;padding:12px 0;color:var(--muted)}.strip strong{color:var(--text)}.health{color:var(--good)}.scope-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0 8px}.scope{color:var(--muted)}.scope strong{color:var(--text)}.periods{display:inline-flex;border:1px solid var(--line);background:var(--panel)}.periods a{padding:6px 10px;color:var(--muted);text-decoration:none;border-right:1px solid var(--line)}.periods a:last-child{border-right:0}.periods a.active{color:var(--text);background:#1f2937}.metrics{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));border:1px solid var(--line);background:var(--panel)}.metric{padding:12px;border-right:1px solid var(--line);min-width:0}.metric:last-child{border-right:0}.metric span,.metric small{display:block;color:var(--muted);font-size:11px}.metric strong{display:block;font-size:20px;margin:5px 0 2px}section{margin-top:20px;border-top:1px solid var(--line)}h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:10px 0}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.device-tools{display:flex;gap:7px;flex-wrap:wrap}.device-tools input,.device-tools select{background:#080a0d;color:var(--text);border:1px solid var(--line);padding:6px 8px;font:inherit}.device-tools input{min-width:240px}table{width:100%;border-collapse:collapse;background:var(--panel)}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:11px}tr:last-child td{border-bottom:0}tr.busy{box-shadow:inset 2px 0 0 var(--accent)}td small{display:block;color:var(--muted);margin-top:3px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px}.dot.online{background:var(--good)}.dot.offline{background:var(--warn)}code{color:#c9d1d9}form{display:inline-flex;gap:5px;margin:0 5px 3px 0}input,select{max-width:260px;background:#080a0d;color:var(--text);border:1px solid var(--line);padding:5px 7px}button{background:#1f2937;color:var(--text);border:1px solid #374151;padding:5px 8px;font:inherit;cursor:pointer}button:hover{border-color:var(--accent)}button.danger{color:#ffb4ad;border-color:#5b2525}.empty,.muted{color:var(--muted)}.onboarding{margin:18px 0;padding:18px;border:1px solid var(--line);background:var(--panel)}.onboarding h2{font-size:18px;text-transform:none;letter-spacing:0;color:var(--text);margin-top:0}.onboarding .button{display:inline-block;background:#1769aa;color:#fff;border:1px solid #2586d7;padding:9px 12px;text-decoration:none}.privacy{padding:12px 0;color:var(--muted);line-height:1.55}.foot{margin-top:18px;color:var(--muted);font-size:11px}.foot form{float:right}.live-activity{min-height:16px}.io{display:inline-block;padding:2px 4px;border-radius:3px;transition:box-shadow .2s,background .2s}.io.hot{animation:ioPulse .9s ease-in-out infinite alternate;background:#12233a;box-shadow:0 0 0 1px #274d78,0 0 12px rgba(88,166,255,.28)}.io-out.hot{background:#102817;box-shadow:0 0 0 1px #245b32,0 0 12px rgba(63,185,80,.25)}@keyframes ioPulse{from{filter:brightness(.9)}to{filter:brightness(1.35)}}.panel-details{margin-top:20px;border-top:1px solid var(--line)}.panel-details>summary{cursor:pointer;padding:10px 0;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;font-size:12px}.panel-details>summary span{color:var(--text);letter-spacing:0;text-transform:none}.sessions-table .session-client{min-width:360px}.session-client form{display:flex;gap:8px;align-items:center;margin-top:6px}.session-client form input{min-width:220px}.session-devices{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin-top:9px}.session-device{display:inline-flex;align-items:baseline;gap:6px;white-space:nowrap;padding:3px 7px;border:1px solid var(--line);border-radius:4px;background:#0a0e13}.session-device small{display:inline;margin:0}.sessions-table td:last-child form{margin:0}@media(max-width:900px){.metrics{grid-template-columns:repeat(2,1fr)}.metric:nth-child(even){border-right:0}section,.panel-details{overflow-x:auto}table{min-width:760px}.top,.scope-row,.section-head{align-items:flex-start;flex-direction:column}.account{text-align:left}.device-tools input{min-width:180px}}
</style></head><body><main>
<header class="top"><div><div class="brand">MCP GATEWAY <span class="version">v${escapeHtml(serverVersion || 'unknown')}</span></div><div><a href="/dashboard">Dashboard</a> · <a href="/pair">Pair device</a> · <a href="/help">Help</a></div><div class="strip" data-live="status">${fragments.status}</div></div><div class="account">${escapeHtml(account.email || account.accountId)}<br>${escapeHtml(account.accountId)}</div></header>
${devices.length ? '' : `<div class="onboarding"><h2>Pair your first device</h2><p>Connect a device to make its tools available through this gateway.</p><a class="button" href="/pair">Pair a device</a>${quickGuide(baseUrl)}</div>`}
<div class="scope-row"><div class="scope"><strong>Usage for this account</strong> · rolling ${escapeHtml(period.label)} window · IN = gateway → device · OUT = device → gateway.</div>${renderPeriodControls(period)}</div>
<div class="metrics" data-live="metrics">${fragments.metrics}</div>
<section><div class="section-head"><h2>Devices</h2><div class="device-tools"><input id="device-search" data-device-filter type="search" placeholder="Search name / host / id" aria-label="Search devices"><select id="device-status" data-device-filter aria-label="Filter device status"><option value="all">All status</option><option value="online">Online</option><option value="offline">Offline</option></select><select id="device-sort" data-device-filter aria-label="Sort devices"><option value="activity">Recent activity</option><option value="name">Name</option><option value="traffic">Traffic</option><option value="errors">Errors</option></select></div></div><div data-live="devices">${fragments.devices}</div></section>
<section><h2>Top tools</h2><div data-live="topTools">${fragments.topTools}</div></section>
<section><h2>Skill loads</h2><div data-live="skillLoads">${fragments.skillLoads}</div></section>
<section><h2>Recent errors</h2><div data-live="errors">${fragments.errors}</div></section>
<details class="panel-details" data-collapse-key="oauth-sessions" open><summary>OAuth client sessions · <span><span data-live="sessionCount">${fragments.sessionCount}</span> active</span></summary><div data-live="sessions">${fragments.sessions}</div></details>
<section class="privacy"><h2>Privacy and connection model</h2><p>Your account only lists currently paired devices owned by this account. The private device key stays on the local device. Revoking a device forgets its product state; operational audit logs remain server-side only. Devices connect outbound to the gateway, so no inbound device port is required.</p></section>
<div class="foot"><form method="post" action="/logout"><button type="submit">Sign out</button></form></div>
<script>
(() => {
  let dirty = false;
  let inFlight = false;
  let activityInFlight = false;
  let activityTimer;
  const editControls = 'input:not([data-device-filter]),button,select:not([data-device-filter]),textarea,[contenteditable="true"]';
  const search = document.getElementById('device-search');
  const status = document.getElementById('device-status');
  const sort = document.getElementById('device-sort');

  function applyDeviceFilters() {
    const body = document.querySelector('#devices-table tbody');
    if (!body) return;
    const query = String(search?.value || '').trim().toLowerCase();
    const state = String(status?.value || 'all');
    const mode = String(sort?.value || 'activity');
    const rows = Array.from(body.querySelectorAll('tr[data-device-id]'));
    for (const row of rows) {
      const matchQuery = !query || String(row.dataset.deviceName || '').includes(query);
      const matchState = state === 'all' || row.dataset.deviceStatus === state;
      row.hidden = !(matchQuery && matchState);
    }
    const compare = mode === 'name'
      ? (a, b) => String(a.dataset.deviceName || '').localeCompare(String(b.dataset.deviceName || ''))
      : mode === 'traffic'
        ? (a, b) => Number(b.dataset.traffic || 0) - Number(a.dataset.traffic || 0)
        : mode === 'errors'
          ? (a, b) => Number(b.dataset.errors || 0) - Number(a.dataset.errors || 0)
          : (a, b) => Number(b.dataset.lastSeen || 0) - Number(a.dataset.lastSeen || 0);
    rows.sort(compare).forEach(row => body.appendChild(row));
  }

  for (const control of [search, status, sort]) {
    control?.addEventListener(control === search ? 'input' : 'change', applyDeviceFilters);
  }
  document.addEventListener('input', event => {
    if (event.target?.matches?.('[data-device-filter]')) return;
    if (event.target?.matches?.('input,textarea,select,[contenteditable="true"]')) dirty = true;
  });

  async function refreshDashboard() {
    const focused = document.activeElement?.matches?.(editControls);
    if (document.visibilityState !== 'visible' || dirty || focused || inFlight) return;
    inFlight = true;
    try {
      const response = await fetch('/dashboard/state' + window.location.search, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) return;
      const fragments = await response.json();
      for (const [key, html] of Object.entries(fragments)) {
        const target = document.querySelector('[data-live="' + key + '"]');
        if (target && target.innerHTML !== String(html)) target.innerHTML = String(html);
      }
      applyDeviceFilters();
    } catch { /* retain the last known dashboard state */ }
    finally { inFlight = false; }
  }

  async function refreshActivity() {
    if (document.visibilityState !== 'visible' || activityInFlight) return scheduleActivity();
    activityInFlight = true;
    try {
      const response = await fetch('/dashboard/activity', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) return;
      const payload = await response.json();
      const byId = new Map((payload.devices || []).map(item => [item.deviceId, item]));
      const now = Date.now();
      for (const row of document.querySelectorAll('tr[data-device-id]')) {
        const item = byId.get(row.dataset.deviceId);
        const active = Number(item?.inFlight || 0) > 0;
        row.classList.toggle('busy', active);
        const label = row.querySelector('[data-activity]');
        const tool = String(item?.tool || '');
        const recentReceive = item?.lastReceivedAt && now - Number(item.lastReceivedAt) < 2000;
        if (label) label.textContent = active ? 'working · ' + (tool || 'tool call') + (Number(item.inFlight) > 1 ? ' ×' + item.inFlight : '') : recentReceive ? String(item.lastOutcome || 'done') + ' · ' + (tool || 'tool call') : 'idle';
        row.querySelector('[data-io="in"]')?.classList.toggle('hot', Boolean(item?.lastSentAt && now - Number(item.lastSentAt) < 1800));
        row.querySelector('[data-io="out"]')?.classList.toggle('hot', Boolean(item?.lastReceivedAt && now - Number(item.lastReceivedAt) < 1800));
      }
    } catch { /* visual activity is best-effort */ }
    finally { activityInFlight = false; scheduleActivity(); }
  }

  function scheduleActivity() {
    clearTimeout(activityTimer);
    if (document.visibilityState === 'visible') activityTimer = setTimeout(refreshActivity, 900);
  }

  for (const details of document.querySelectorAll('[data-collapse-key]')) {
    const key = 'dashboardCollapse:' + details.dataset.collapseKey;
    details.open = localStorage.getItem(key) !== 'closed';
    details.addEventListener('toggle', () => localStorage.setItem(key, details.open ? 'open' : 'closed'));
  }

  const timer = setInterval(refreshDashboard, 3500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { refreshDashboard(); refreshActivity(); }
    else clearTimeout(activityTimer);
  });
  applyDeviceFilters();
  refreshActivity();
  window.addEventListener('beforeunload', () => { clearInterval(timer); clearTimeout(activityTimer); }, { once: true });
})();
</script>
</main></body></html>`;
}

export function installDashboardRoutes(app, { accountFromRequest, usageStore, deviceBroker, baseUrlFromRequest, oauthClientLookup, listTools, serverVersion = 'unknown', deviceReleaseProvider = null } = {}) {
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

  async function loadDashboardData(account, period) {
    const latestPackageVersion = typeof deviceReleaseProvider?.latestVersion === 'function'
      ? await deviceReleaseProvider.latestVersion().catch(() => null)
      : null;
    const usage = usageStore.getAccountUsage(account.accountId, { since: period.since });
    const deviceUsage = usageStore.getDeviceUsageForAccount(account.accountId, { since: period.since });
    const usageByDevice = new Map(deviceUsage.map(item => [item.deviceId, item]));
    const devices = deviceBroker.listDevices({ accountId: account.accountId })
      .filter(device => !device.revoked)
      .map(device => {
        const packageVersion = device.packageVersion || null;
        let selfUpdateSupported = false;
        try { selfUpdateSupported = Boolean(packageVersion) && compareStableVersions(packageVersion, '1.0.5') >= 0; } catch {}
        const updateAvailable = Boolean(latestPackageVersion) && (!packageVersion || isNewerStableVersion(packageVersion, latestPackageVersion));
        return {
        ...device,
        latestPackageVersion,
        selfUpdateSupported,
        updateAvailable,
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
      };
      });
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

  app.get('/dashboard', async (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const csrf = ensureCsrf(req, res);
    const period = usagePeriod(req.query?.range);
    const { usage, devices } = await loadDashboardData(account, period);
    const baseUrl = typeof baseUrlFromRequest === 'function' ? baseUrlFromRequest(req) : `${req.protocol}://${req.get('host')}`;
    res.set('Cache-Control', 'no-store');
    res.status(200).type('html').send(dashboardHtml({ account, usage, devices, csrf, baseUrl, serverVersion, period }));
  });

  app.get('/dashboard/state', async (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const csrf = ensureCsrf(req, res);
    const period = usagePeriod(req.query?.range);
    const { usage, devices } = await loadDashboardData(account, period);
    res.set('Cache-Control', 'no-store');
    res.status(200).json(dashboardFragments({ usage, devices, csrf, period }));
  });

  app.get('/dashboard/activity', (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const devices = typeof deviceBroker.getActivitySnapshot === 'function'
      ? deviceBroker.getActivitySnapshot({ accountId: account.accountId })
      : [];
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ now: Date.now(), devices });
  });

  app.get('/dashboard/devices/:deviceId', async (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const device = deviceBroker.listDevices({ accountId: account.accountId })
      .find(item => !item.revoked && item.deviceId === req.params.deviceId);
    if (!device) return unavailable(res);
    const csrf = ensureCsrf(req, res);
    const period = usagePeriod(req.query?.range);
    const toolUsage = usageStore.getDeviceToolUsage(account.accountId, device.deviceId, { since: period.since });
    const recentCalls = (typeof usageStore.getDeviceRecentToolCalls === 'function'
      ? usageStore.getDeviceRecentToolCalls(account.accountId, device.deviceId, { limit: 20, since: period.since })
      : []).map(item => {
      const client = clientLabel(item.clientId, oauthClientLookup);
      return { ...item, clientName: client.name, clientRaw: client.raw };
    });
    const usedTools = new Set(toolUsage.map(item => item.tool));
    const toolDefinitions = typeof listTools === 'function'
      ? (await listTools()).filter(tool => usedTools.has(tool.name))
      : [];
    res.status(200).type('html').send(deviceUsageHtml({ device, toolUsage, recentCalls, toolDefinitions, csrf, period }));
  });

  app.post('/dashboard/devices/:deviceId/update', async (req, res) => {
    const account = requireAccount(req, res);
    if (!account || !requireCsrf(req, res)) return;
    const targetVersion = typeof deviceReleaseProvider?.latestVersion === 'function'
      ? await deviceReleaseProvider.latestVersion().catch(() => null)
      : null;
    if (!targetVersion) {
      res.status(503).type('text').send('Latest MCP Device release is temporarily unavailable.');
      return;
    }
    try {
      deviceBroker.requestDeviceUpdate({ accountId: account.accountId, deviceId: req.params.deviceId, targetVersion });
      res.redirect(303, '/dashboard');
    } catch (error) {
      if (error?.code === 'DEVICE_ACCESS_DENIED' || /Unknown device/i.test(String(error?.message || ''))) return unavailable(res);
      if (error?.code === 'DEVICE_UPDATE_NOT_NEEDED') {
        res.redirect(303, '/dashboard');
        return;
      }
      if (['DEVICE_OFFLINE', 'DEVICE_UPDATE_BOOTSTRAP_REQUIRED', 'DEVICE_UPDATE_IN_PROGRESS', 'DEVICE_UPDATE_SEND_ERROR'].includes(error?.code)) {
        res.status(409).type('text').send(String(error?.message || 'Device update is unavailable.'));
        return;
      }
      res.status(400).type('text').send('Invalid device update request.');
    }
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
