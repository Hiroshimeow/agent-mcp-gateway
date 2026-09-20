const DEFAULT_PACKAGE = '@hcu-lab.me/mcp-device';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export function normalizeStableVersion(value) {
  const version = String(value || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected an exact stable semantic version.');
  return version;
}

export function compareStableVersions(left, right) {
  const a = normalizeStableVersion(left).split('.').map(Number);
  const b = normalizeStableVersion(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function isNewerStableVersion(current, latest) {
  try { return compareStableVersions(current, latest) < 0; }
  catch { return false; }
}

export function createDeviceReleaseProvider(options = {}) {
  const packageName = String(options.packageName || DEFAULT_PACKAGE).trim();
  const registryUrl = String(options.registryUrl || DEFAULT_REGISTRY).replace(/\/+$/, '');
  const fetchFn = options.fetchFn || globalThis.fetch;
  const ttlMs = Math.max(1_000, Number(options.ttlMs || 60_000));
  const timeoutMs = Math.max(500, Number(options.timeoutMs || 4_000));
  let fallbackVersion = null;
  try { fallbackVersion = options.fallbackVersion ? normalizeStableVersion(options.fallbackVersion) : null; } catch {}
  let cachedVersion = fallbackVersion;
  let cachedAt = fallbackVersion ? Date.now() : 0;
  let inFlight = null;

  async function fetchLatest() {
    if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchFn(`${registryUrl}/${encodeURIComponent(packageName)}/latest`, {
        headers: { accept: 'application/json' },
        signal: controller.signal
      });
      if (!response?.ok) throw new Error(`npm registry returned HTTP ${response?.status || 'unknown'}`);
      const body = await response.json();
      return normalizeStableVersion(body?.version);
    } finally {
      clearTimeout(timer);
    }
  }

  async function latestVersion() {
    const now = Date.now();
    if (cachedVersion && now - cachedAt < ttlMs) return cachedVersion;
    if (inFlight) return await inFlight;
    inFlight = (async () => {
      try {
        const latest = await fetchLatest();
        cachedVersion = latest;
        cachedAt = Date.now();
        return latest;
      } catch {
        return cachedVersion || fallbackVersion || null;
      } finally {
        inFlight = null;
      }
    })();
    return await inFlight;
  }

  return {
    latestVersion,
    peek: () => cachedVersion,
    packageName
  };
}
