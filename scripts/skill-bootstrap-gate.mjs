import { createHash } from 'node:crypto';

export const SKILL_BOOTSTRAP_CODE = 'SKILL_BOOTSTRAP_REQUIRED';
export const SKILL_CHECK_ADVISORY = 'Skill check: before using local write_file, edit_file, or shell_execute, call get_skill() and load the workflow matching the context you inspected.';
export const SKILL_TOOL_BOOTSTRAP_NOTICE = 'Before first use of this local changing tool, call get_skill without arguments; inspect its routingPolicy and skillCatalog, then load the smallest relevant skill.';

const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'shell_execute']);
const READ_TOOLS = new Set(['read_text_file', 'image_preview']);

export function decorateSkillBootstrapDescription(toolName, description = '') {
  const text = String(description || '').trim();
  return CHANGING_TOOLS.has(String(toolName || ''))
    ? [SKILL_TOOL_BOOTSTRAP_NOTICE, text].filter(Boolean).join('\n\n')
    : text;
}

export function buildSkillCallerKey({ oauthClientId = '', staticBearer = false, sessionId = '' } = {}) {
  const identity = oauthClientId ? `oauth:${oauthClientId}` : staticBearer ? 'static-bearer' : 'anonymous';
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
    const state = { advisoryShown: false, blockedCount: 0, bootstrapped: false, expiresAt: currentTime + ttlMs };
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
      if (state.bootstrapped || state.advisoryShown) return null;
      state.advisoryShown = true;
      refreshExpiry(state);
      return SKILL_CHECK_ADVISORY;
    },

    checkTool(callerKey, toolName) {
      if (!CHANGING_TOOLS.has(String(toolName || ''))) return null;
      const state = activeState(callerKey);
      if (state.bootstrapped) return null;
      state.blockedCount += 1;
      refreshExpiry(state);
      return {
        code: SKILL_BOOTSTRAP_CODE,
        message: state.blockedCount === 1
          ? 'Call get_skill() before the first local write_file, edit_file, or shell_execute operation; load the workflow matching the context you inspected.'
          : 'Call get_skill().'
      };
    },

    markBootstrapped(callerKey) {
      const state = activeState(callerKey);
      state.bootstrapped = true;
      refreshExpiry(state);
    }
  };
}
