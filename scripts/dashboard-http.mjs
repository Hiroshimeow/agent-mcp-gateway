import crypto from 'node:crypto';

const CSRF_COOKIE = 'hcu_dashboard_csrf';
const CSRF_TTL_MS = 8 * 60 * 60 * 1000;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function csrfField(token) {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

function metric(label, value, detail = '') {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div>`;
}

function renderDeviceRows(devices, csrf) {
  if (!devices.length) return '<tr><td colspan="7" class="empty">No paired devices.</td></tr>';
  return devices.map(device => {
    const status = device.revoked ? 'revoked' : device.online ? 'online' : 'offline';
    const usage = device.usage || {};
    return `<tr>
<td><span class="dot ${status}"></span><strong>${escapeHtml(device.deviceName)}</strong><small>${escapeHtml(device.deviceId)}</small></td>
<td>${escapeHtml(device.platform || 'unknown')} / ${escapeHtml(device.arch || 'unknown')}</td>
<td>${escapeHtml(device.agentVersion || 'unknown')}</td>
<td>${escapeHtml(formatTime(device.lastSeenAt || usage.lastSeenAt))}</td>
<td>${formatNumber(usage.toolCallsSucceeded || 0)} / ${formatNumber(usage.toolCallsFailed || 0)}</td>
<td>${formatBytes((usage.requestBytes || 0) + (usage.responseBytes || 0))}</td>
<td class="actions">${device.revoked ? 'revoked' : `<form method="post" action="/dashboard/devices/${encodeURIComponent(device.deviceId)}/rename">${csrfField(csrf)}<input name="device_name" maxlength="128" value="${escapeHtml(device.deviceName)}" aria-label="Device name"><button type="submit">Rename</button></form><form method="post" action="/dashboard/devices/${encodeURIComponent(device.deviceId)}/revoke">${csrfField(csrf)}<button class="danger" type="submit">Revoke</button></form>`}</td>
</tr>`;
  }).join('');
}

function renderToolRows(items) {
  if (!items.length) return '<tr><td colspan="5" class="empty">No tool activity yet.</td></tr>';
  return items.map(item => `<tr><td><code>${escapeHtml(item.tool)}</code></td><td>${formatNumber(item.calls)}</td><td>${formatNumber(item.failures)}</td><td>${formatBytes(item.inputBytes)}</td><td>${formatBytes(item.outputBytes)}</td></tr>`).join('');
}

function renderSkillRows(items) {
  if (!items.length) return '<tr><td colspan="5" class="empty">No named skill loads yet.</td></tr>';
  return items.map(item => `<tr><td><code>${escapeHtml(item.skillName)}</code></td><td>${formatNumber(item.loads)}</td><td>${formatNumber(item.failures)}</td><td>${formatBytes(item.outputBytes)}</td><td>~${formatNumber(item.estimatedTokens)}</td></tr>`).join('');
}

function renderErrorRows(items) {
  if (!items.length) return '<tr><td colspan="4" class="empty">No recent errors.</td></tr>';
  return items.map(item => `<tr><td>${escapeHtml(formatTime(item.eventAt))}</td><td><code>${escapeHtml(item.tool)}</code></td><td>${escapeHtml(item.deviceId || '—')}</td><td><code>${escapeHtml(item.errorCode || 'TOOL_ERROR')}</code></td></tr>`).join('');
}

function renderSessionRows(items, csrf) {
  if (!items.length) return '<tr><td colspan="5" class="empty">No OAuth activity sessions.</td></tr>';
  return items.map(item => `<tr><td><code>${escapeHtml(item.activitySessionId)}</code></td><td>${escapeHtml(item.clientId || 'unknown')}</td><td>${escapeHtml(formatTime(item.startedAt))}</td><td>${escapeHtml(formatTime(item.lastSeenAt))}</td><td>${item.endedAt ? `ended ${escapeHtml(formatTime(item.endedAt))}` : `<form method="post" action="/dashboard/sessions/${encodeURIComponent(item.activitySessionId)}/end">${csrfField(csrf)}<button type="submit">End session</button></form>`}</td></tr>`).join('');
}

function dashboardHtml({ account, usage, devices, csrf }) {
  const online = devices.filter(device => device.online && !device.revoked).length;
  const schema = usage.schema || {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HCU Control</title>
<style>
:root{color-scheme:dark;--bg:#080a0d;--panel:#0d1117;--line:#252b34;--text:#e6edf3;--muted:#8b949e;--good:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px ui-monospace,SFMono-Regular,Consolas,monospace}main{width:min(1500px,96vw);margin:24px auto 48px}.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding:0 0 14px}.brand{font-size:18px;letter-spacing:.18em}.account{color:var(--muted);text-align:right}.strip{display:flex;gap:18px;flex-wrap:wrap;padding:12px 0;color:var(--muted)}.strip strong{color:var(--text)}.health{color:var(--good)}.metrics{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));border:1px solid var(--line);background:var(--panel)}.metric{padding:12px;border-right:1px solid var(--line);min-width:0}.metric:last-child{border-right:0}.metric span,.metric small{display:block;color:var(--muted);font-size:11px}.metric strong{display:block;font-size:20px;margin:5px 0 2px}section{margin-top:20px;border-top:1px solid var(--line)}h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:10px 0}table{width:100%;border-collapse:collapse;background:var(--panel)}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:11px}tr:last-child td{border-bottom:0}td small{display:block;color:var(--muted);margin-top:3px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px}.dot.online{background:var(--good)}.dot.offline{background:var(--warn)}.dot.revoked{background:var(--bad)}code{color:#c9d1d9}form{display:inline-flex;gap:5px;margin:0 5px 3px 0}input{max-width:180px;background:#080a0d;color:var(--text);border:1px solid var(--line);padding:5px 7px}button{background:#1f2937;color:var(--text);border:1px solid #374151;padding:5px 8px;font:inherit;cursor:pointer}button:hover{border-color:var(--accent)}button.danger{color:#ffb4ad;border-color:#5b2525}.empty{color:var(--muted)}.foot{margin-top:18px;color:var(--muted);font-size:11px}.foot form{float:right}@media(max-width:900px){.metrics{grid-template-columns:repeat(2,1fr)}.metric:nth-child(even){border-right:0}section{overflow-x:auto}table{min-width:760px}.top{align-items:flex-start;flex-direction:column}.account{text-align:left}}
</style></head><body><main>
<header class="top"><div><div class="brand">HCU CONTROL</div><div class="strip"><span class="health">● Gateway online</span><span><strong>${online}/${devices.length}</strong> devices online</span><span><strong>${formatNumber(schema.toolCount)} tools</strong></span><span><strong>${formatNumber(schema.schemaBytes)} B schema</strong></span></div></div><div class="account">${escapeHtml(account.email || account.accountId)}<br>${escapeHtml(account.accountId)}</div></header>
<div class="metrics">${metric('Tool calls', formatNumber(usage.totals.toolCalls), `${formatNumber(usage.totals.failed)} failed`)}${metric('Success', formatNumber(usage.totals.succeeded))}${metric('Input bytes', formatBytes(usage.totals.inputBytes))}${metric('Output bytes', formatBytes(usage.totals.outputBytes))}${metric('tools/list', formatNumber(usage.catalog.listCalls))}${metric('Estimated schema context', `~${formatNumber(schema.estimatedTokens)}`, 'estimate, not billing tokens')}</div>
<section><h2>Devices</h2><table><thead><tr><th>Device</th><th>Platform</th><th>Agent</th><th>Last seen</th><th>OK / Fail</th><th>Wire bytes</th><th>Controls</th></tr></thead><tbody>${renderDeviceRows(devices, csrf)}</tbody></table></section>
<section><h2>Top tools</h2><table><thead><tr><th>Tool</th><th>Calls</th><th>Failures</th><th>Input</th><th>Output</th></tr></thead><tbody>${renderToolRows(usage.topTools)}</tbody></table></section>
<section><h2>Skill loads</h2><table><thead><tr><th>Skill</th><th>Loads</th><th>Failures</th><th>Output</th><th>Estimated tokens</th></tr></thead><tbody>${renderSkillRows(usage.skillLoads)}</tbody></table></section>
<section><h2>Recent errors</h2><table><thead><tr><th>Time</th><th>Tool</th><th>Device</th><th>Error code</th></tr></thead><tbody>${renderErrorRows(usage.recentErrors)}</tbody></table></section>
<section><h2>Activity sessions</h2><table><thead><tr><th>Activity session</th><th>Client</th><th>Started</th><th>Last seen</th><th>State</th></tr></thead><tbody>${renderSessionRows(usage.activitySessions, csrf)}</tbody></table></section>
<div class="foot">Schema token values use <code>${escapeHtml(schema.estimationMethod || 'utf8_bytes_div_4_estimate')}</code>; they are estimated context size, not billing tokens.<form method="post" action="/logout"><button type="submit">Sign out</button></form></div>
</main></body></html>`;
}

export function installDashboardRoutes(app, { accountFromRequest, usageStore, deviceBroker } = {}) {
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

  app.get('/dashboard', (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const csrf = ensureCsrf(req, res);
    const usage = usageStore.getAccountUsage(account.accountId);
    const devices = deviceBroker.listDevices({ accountId: account.accountId });
    res.status(200).type('html').send(dashboardHtml({ account, usage, devices, csrf }));
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
