import express from 'express';
import { escapeHtml } from './enduser-ui.mjs';

const LOOPBACK_HOST = '127.0.0.1';
const AUTO_REFRESH_MS = 3500;

function number(value) { return Number(value || 0).toLocaleString('en-US'); }
function bytes(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n < 1024) return `${number(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n >= 10 * 1024 ? 0 : 1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MiB`;
}

function deviceRows(devices, usageStore, accountId) {
  if (!devices.length) return '<tr><td colspan="6" class="muted">No devices.</td></tr>';
  return devices.map(device => {
    const status = device.revoked ? 'revoked' : device.online ? 'online' : 'offline';
    const tools = usageStore.getDeviceToolUsage(accountId, device.deviceId);
    const totalCalls = tools.reduce((sum, item) => sum + Number(item.calls || 0), 0);
    const top = tools.slice(0, 4).map(item => `${escapeHtml(item.tool)} (${number(item.calls)})`).join(', ') || 'no attributed calls';
    return `<tr><td><span class="dot ${status}"></span><strong>${escapeHtml(device.deviceName)}</strong><small>${escapeHtml(device.deviceId)}</small></td><td>${status}</td><td>${number(totalCalls)}</td><td>${top}</td><td>${escapeHtml(device.platform || 'unknown')} / ${escapeHtml(device.arch || 'unknown')}</td><td>${escapeHtml(device.agentVersion || 'unknown')}</td></tr>`;
  }).join('');
}

function accountSection(account, usageStore, deviceBroker) {
  const usage = usageStore.getAccountUsage(account.accountId);
  const devices = deviceBroker.listDevices({ accountId: account.accountId });
  const input = Number(usage.totals.inputBytes || 0);
  const output = Number(usage.totals.outputBytes || 0);
  const estimatedTokens = Math.ceil((input + output) / 4);
  const topTools = usage.topTools.slice(0, 5).map(item => `${escapeHtml(item.tool)} (${number(item.calls)})`).join(', ') || 'none';
  return `<section class="account-card"><header><div><h2>${escapeHtml(account.email || account.accountId)}</h2><small>${escapeHtml(account.accountId)}</small></div><div class="state">${account.revokedAt ? 'revoked' : 'active'}</div></header><div class="summary"><span><b>${number(devices.length)}</b> devices</span><span><b>${number(usage.totals.toolCalls)}</b> calls</span><span><b>${number(usage.totals.succeeded)}</b> success</span><span><b>${number(usage.totals.failed)}</b> fail</span><span><b>${bytes(input)}</b> input</span><span><b>${bytes(output)}</b> output</span><span><b>~${number(estimatedTokens)}</b> I/O tokens <em>estimate, non-billing</em></span></div><p class="tools"><strong>Top tools:</strong> ${topTools}</p><table><thead><tr><th>Device</th><th>Status</th><th>Calls</th><th>Recent/top tools</th><th>Platform</th><th>Agent</th></tr></thead><tbody>${deviceRows(devices, usageStore, account.accountId)}</tbody></table></section>`;
}

function page(accountStore, usageStore, deviceBroker) {
  const accounts = accountStore.listAccounts().filter(account => account.role === 'user');
  const sections = accounts.map(account => accountSection(account, usageStore, deviceBroker)).join('') || '<p class="muted">No user accounts.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Operator account usage</title><style>:root{color-scheme:dark;--bg:#080a0d;--panel:#0d1117;--line:#252b34;--text:#e6edf3;--muted:#8b949e;--good:#3fb950;--warn:#d29922;--bad:#f85149}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px ui-monospace,SFMono-Regular,Consolas,monospace}main{width:min(1500px,96vw);margin:22px auto 50px}.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:12px}.top h1{font-size:18px;margin:0}.muted,small,em{color:var(--muted)}button{background:#161b22;color:var(--text);border:1px solid var(--line);padding:6px 9px;font:inherit;cursor:pointer}.account-card{margin-top:16px;border:1px solid var(--line);background:var(--panel);padding:14px}.account-card header{display:flex;justify-content:space-between;gap:12px}.account-card h2{font-size:15px;margin:0 0 4px}.state{color:var(--muted)}.summary{display:flex;flex-wrap:wrap;gap:12px 20px;margin:12px 0}.summary b{font-size:16px}.summary em{font-size:10px}.tools{margin:8px 0 12px;color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-top:1px solid var(--line);vertical-align:top}th{font-size:11px;color:var(--muted);font-weight:500}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px}.online{background:var(--good)}.offline{background:var(--warn)}.revoked{background:var(--bad)}td small{display:block;margin-top:3px}@media(max-width:850px){.account-card{overflow-x:auto}table{min-width:820px}}</style></head><body><main><header class="top"><div><h1>Operator account usage</h1><small>Loopback-only read-only overview · ${number(accounts.length)} user accounts</small></div><button id="auto" type="button">Auto refresh: on</button></header>${sections}</main><script>(()=>{const KEY='operatorAutoRefresh';const button=document.getElementById('auto');let enabled=localStorage.getItem(KEY)!=='off';let timer;const paint=()=>button.textContent='Auto refresh: '+(enabled?'on':'off');const schedule=()=>{clearTimeout(timer);if(!enabled||document.hidden)return;timer=setTimeout(()=>{const selection=String(window.getSelection?.()||'').trim();if(selection){schedule();return;}sessionStorage.setItem('operatorScrollY',String(window.scrollY));location.reload();},${AUTO_REFRESH_MS});};button.addEventListener('click',()=>{enabled=!enabled;localStorage.setItem(KEY,enabled?'on':'off');paint();schedule();});document.addEventListener('visibilitychange',schedule);window.addEventListener('load',()=>{const y=Number(sessionStorage.getItem('operatorScrollY')||0);if(y)scrollTo(0,y);paint();schedule();});})();</script></body></html>`;
}

export async function startOperatorDashboard({ accountStore, usageStore, deviceBroker, port } = {}) {
  if (!accountStore || !usageStore || !deviceBroker) throw new Error('accountStore, usageStore, and deviceBroker are required.');
  const app = express();
  app.get('/', (_req, res) => res.status(200).type('html').send(page(accountStore, usageStore, deviceBroker)));
  return new Promise((resolve, reject) => {
    const server = app.listen(Number(port), LOOPBACK_HOST, () => resolve(server));
    server.once('error', reject);
  });
}
