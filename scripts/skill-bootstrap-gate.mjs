import { createHash } from 'node:crypto';

export const SKILL_CHECK_ADVISORY = 'Skill hint: for specialized workflows, load a matching skill with get_skill(name). Routine filesystem and shell operations do not require skill loading.';
export const SKILL_TOOL_BOOTSTRAP_NOTICE = 'For specialized workflows, load a matching skill with get_skill(name) when it materially changes the task approach.';

const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'shell_execute']);
const READ_TOOLS = new Set(['read_text_file', 'image_preview']);

export function decorateSkillBootstrapDescription(toolName, description = '') {
  const text = String(description || '').trim();
  return CHANGING_TOOLS.has(String(toolName || ''))
    ? [SKILL_TOOL_BOOTSTRAP_NOTICE, text].filter(Boolean).join('\n\n')
    : text;
}

export function buildSkillCallerKey({ accountId = '', oauthClientId = '', staticBearer = false, sessionId = '' } = {}) {
  const identity = accountId ? `account:${accountId}` : oauthClientId ? `oauth:${oauthClientId}` : staticBearer ? 'static-bearer' : 'anonymous';
  const digest = createHash('sha256')
    .update(sessionId ? `${identity}\nsession:${sessionId}` : identity)
    .digest('hex')
    .slice(0, 24);
  return `caller:${digest}`;
}

export function createSkillBootstrapGate({ ttlMs = 4 * 60 * 60 * 1_000, now = Date.now, maxEntries = 1_024 } = {}) {
  const states = new Map();

  function activeState(callerKey) {
    const key = String(callerKey || 'caller:anonymous');
    const currentTime = now();
    const existing = states.get(key);
    if (existing && existing.expiresAt > currentTime) return existing;
    if (existing) states.delete(key);
    const state = { advisoryShown: false, skillLoaded: false, expiresAt: currentTime + ttlMs };
    states.set(key, state);
    if (states.size > maxEntries) states.delete(states.keys().next().value);
    return state;
  }

  function refreshExpiry(state) {
    state.expiresAt = now() + ttlMs;
  }

  return {
    takeReadAdvisory(callerKey, toolName) {
      if (!READ_TOOLS.has(String(toolName || ''))) return null;
      const state = activeState(callerKey);
      if (state.skillLoaded || state.advisoryShown) return null;
      state.advisoryShown = true;
      refreshExpiry(state);
      return SKILL_CHECK_ADVISORY;
    },

    markSkillLoaded(callerKey) {
      const state = activeState(callerKey);
      state.skillLoaded = true;
      refreshExpiry(state);
    }
  };
}
