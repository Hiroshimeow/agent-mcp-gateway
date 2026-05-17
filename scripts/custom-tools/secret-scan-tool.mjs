import fs from 'node:fs';
import { defaultExcludePatterns, resolveInsideTrustedRoots, toRelativeFromRoot, walkFiles } from './path-utils.mjs';
import { fail, ok, redactSecret } from './response-utils.mjs';

const RULES = [
  { name: 'github_pat', severity: 'high', regex: /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, message: 'Possible GitHub personal access token' },
  { name: 'openai_api_key', severity: 'high', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g, message: 'Possible OpenAI API key' },
  { name: 'npm_token', severity: 'high', regex: /\bnpm_[A-Za-z0-9]{20,}\b/g, message: 'Possible npm token' },
  { name: 'private_key', severity: 'high', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, message: 'Private key block detected' },
  { name: 'ngrok_token', severity: 'high', regex: /\bNGROK_AUTHTOKEN\s*=\s*([^\s#]+)/gi, group: 1, message: 'Possible ngrok auth token' },
  { name: 'mcp_bearer_token', severity: 'high', regex: /\bMCP_BEARER_TOKEN\s*=\s*([^\s#]+)/gi, group: 1, message: 'Possible MCP bearer token' },
  { name: 'mcp_auth_password', severity: 'high', regex: /\bMCP_AUTH_PASSWORD\s*=\s*([^\s#]+)/gi, group: 1, message: 'Possible MCP auth password' },
  { name: 'password_or_secret', severity: 'medium', regex: /\b(?:PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*([^\s#]+)/gi, group: 1, message: 'Possible secret assignment' },
  { name: 'jwt_like_token', severity: 'medium', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, message: 'Possible JWT-like token' },
  { name: 'tailscale_auth_key', severity: 'high', regex: /\btskey-[A-Za-z0-9_-]{20,}\b/g, message: 'Possible Tailscale auth key' }
];

const ORDER = { low: 1, medium: 2, high: 3, none: 99 };

function isPlaceholder(value) {
  return /^(|changeme|change-me|replace-me|dummy|placeholder|example|example[-_]?.*|your[-_]?.*|.*[-_]here|xxx+|<.*>)$/i.test(String(value || '').trim());
}

export async function secretScanTool(args = {}, context = {}) {
  try {
    const target = resolveInsideTrustedRoots(args.path, context, { mustExist: true });
    const include = args.include?.length ? args.include : ['**/*'];
    const exclude = defaultExcludePatterns(args.exclude || []);
    const maxFindings = Math.max(1, Number(args.maxFindings || 100));
    const files = await walkFiles(target.path, target.root, { include, exclude });
    const findings = [];
    for (const file of files) {
      if (findings.length >= maxFindings) break;
      const buffer = await fs.promises.readFile(file);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && findings.length < maxFindings; i += 1) {
        const line = lines[i];
        for (const rule of RULES) {
          rule.regex.lastIndex = 0;
          let match;
          while ((match = rule.regex.exec(line)) && findings.length < maxFindings) {
            const value = match[rule.group || 0];
            if (isPlaceholder(value)) continue;
            findings.push({ severity: rule.severity, path: toRelativeFromRoot(file, target.root), line: i + 1, rule: rule.name, redacted: redactSecret(value), message: rule.message });
          }
        }
      }
    }
    const counts = { high: 0, medium: 0, low: 0 };
    for (const finding of findings) counts[finding.severity] += 1;
    const failOn = args.failOn || 'high';
    const passed = failOn === 'none' || !findings.some(f => ORDER[f.severity] >= ORDER[failOn]);
    return ok('secret_scan', passed ? 'Secret scan passed' : 'Secret scan found possible secrets', { passed, counts, findings, truncated: findings.length >= maxFindings });
  } catch (error) {
    return fail('secret_scan', error.code || 'SCAN_ERROR', error.message, error.details || {});
  }
}
