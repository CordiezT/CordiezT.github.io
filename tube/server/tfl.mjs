// Data ingestion: thin, cached client for the TfL Unified API.
// The API key (optional) is read from the environment and never leaves the server.

const BASE = 'https://api.tfl.gov.uk';
const KEY = process.env.TFL_APP_KEY || '';

function withKey(path) {
  if (!KEY) return BASE + path;
  return BASE + path + (path.includes('?') ? '&' : '?') + 'app_key=' + encodeURIComponent(KEY);
}

// Cache entry: { value, fetchedAt, error, inflight }
const cache = new Map();

/**
 * Fetch `path` at most once per `ttl` ms. Concurrent callers share one request.
 * On failure the last good value is returned (marked stale) if one exists.
 */
export async function cached(path, ttl) {
  let e = cache.get(path);
  if (!e) cache.set(path, (e = { value: null, fetchedAt: 0, error: null, inflight: null }));
  const fresh = e.value && Date.now() - e.fetchedAt < ttl;
  if (fresh) return { value: e.value, fetchedAt: e.fetchedAt, stale: false };
  if (!e.inflight) {
    e.inflight = (async () => {
      try {
        const res = await fetch(withKey(path), { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`TfL ${res.status} ${res.statusText}`);
        e.value = await res.json();
        e.fetchedAt = Date.now();
        e.error = null;
      } catch (err) {
        e.error = String(err.message || err);
        console.warn(`[tfl] ${path}: ${e.error}`);
      } finally {
        e.inflight = null;
      }
    })();
  }
  await e.inflight;
  if (!e.value) throw new Error(e.error || 'no data');
  return { value: e.value, fetchedAt: e.fetchedAt, stale: Date.now() - e.fetchedAt >= ttl, error: e.error };
}

export const hasKey = () => Boolean(KEY);
