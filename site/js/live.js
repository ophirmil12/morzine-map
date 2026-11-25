/*
 * Live open/closed status of lifts and pistes.
 *
 * Source: ResaLocal's real-time API (the platform behind explore.morzine.com; use agreed with the
 * Morzine Tourist Office). One small request returns every status of the three ski areas,
 * about 5 KB compressed:
 *   GET https://realtime.resalocal.com/api/v1/groups/uuids/by-status?groups=morzine,avoriaz,lesgets
 *   -> { "<code>": [uuid, ...], ... }     uuids are the `id` of our lines (data/trails.json)
 *
 * Fetched when the page opens, then every 5 minutes while the page is on screen (never in the
 * background). The last answer is kept on the phone, so without signal the map shows the last
 * known status with its time. If anything fails, nothing is shown and the map works as before.
 */
const LIVE = (() => {
  const URL_ALL = 'https://realtime.resalocal.com/api/v1/groups/uuids/by-status?groups=morzine,avoriaz,lesgets';
  const EVERY_MS = 5 * 60 * 1000;
  const TIMEOUT_MS = 8000;
  const STORE = 'morzine-live-status-v1';

  // Status codes of the API, grouped the way the map shows them.
  const KIND = {
    100: 'closed', 101: 'closed', 102: 'offseason', 103: 'closed',
    200: 'open', 201: 'open',
    300: 'soon', 301: 'delayed', 302: 'stopped',
    500: 'none', 501: 'none'
  };

  let byId = {}, fetchedAt = 0, lastTry = 0, listener = () => {};

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (saved && saved.t && saved.s) { byId = invert(saved.s); fetchedAt = saved.t; }
    } catch (e) { /* nothing saved */ }
  }
  function invert(groups) {
    const out = {};
    for (const [code, ids] of Object.entries(groups || {})) for (const id of ids || []) out[id] = Number(code);
    return out;
  }

  async function refresh() {
    lastTry = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(URL_ALL, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) return;
      const groups = await r.json();
      if (!groups || typeof groups !== 'object') return;
      byId = invert(groups); fetchedAt = Date.now();
      try { localStorage.setItem(STORE, JSON.stringify({ t: fetchedAt, s: groups })); } catch (e) { /* full */ }
      listener();
    } catch (e) { /* offline or blocked: keep the last known status */ }
    finally { clearTimeout(timer); }
  }

  function due() { return document.visibilityState === 'visible' && Date.now() - lastTry >= EVERY_MS; }

  /** Start: show the saved status at once, then fetch now and every 5 minutes while visible. */
  function start(onChange) {
    listener = onChange || listener;
    load();
    if (fetchedAt) listener();
    refresh();
    setInterval(() => { if (due()) refresh(); }, 30 * 1000);
    document.addEventListener('visibilitychange', () => { if (due()) refresh(); });
    window.addEventListener('online', () => { if (Date.now() - lastTry > 30 * 1000) refresh(); });
  }

  /** 'open' | 'closed' | 'offseason' | 'soon' | 'delayed' | 'stopped' | 'none' | null (unknown id). */
  function kind(id) { const c = byId[id]; return c === undefined ? null : (KIND[c] || 'none'); }

  /** 'fresh' (under 10 min), 'stale' (under 30 min), 'old', or null when never loaded. */
  function freshness() {
    if (!fetchedAt) return null;
    const min = (Date.now() - fetchedAt) / 60000;
    return min < 10 ? 'fresh' : min < 30 ? 'stale' : 'old';
  }

  return { start, kind, freshness, get fetchedAt() { return fetchedAt; }, get ids() { return byId; } };
})();
