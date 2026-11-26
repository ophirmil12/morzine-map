/* Pinned places (the House and others): edited on the admin page, served by the location Worker.
 *
 * One small request (about 1 KB) when the map opens, and again when the page comes back to the
 * screen if the last one is older than 15 minutes. The last list is kept on the phone, so the
 * places also show offline. The map is redrawn only when the list really changed.
 *
 * Usage: PLACES.init(onChange) after the map has loaded. onChange(list) gets
 * [{ id, name, description, emoji, color, lat, lon }].
 */
const PLACES = (() => {
  const DEPLOYED = 'https://morzine-live.ophirmil1234.workers.dev/places';
  // Testing on localhost: ?shareapi=http://127.0.0.1:8787/pos also points this at the stand-in server.
  const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const devApi = local && new URLSearchParams(location.search).get('shareapi');
  const URL_PLACES = devApi ? devApi.replace(/\/pos$/, '/places') : DEPLOYED;
  const EVERY_MS = 15 * 60 * 1000;
  const STORE = 'morzine-places-v1';

  let saved = null, lastTry = 0, onChange = () => {};

  function init(cb) {
    onChange = cb;
    try { saved = JSON.parse(localStorage.getItem(STORE)); } catch (e) { saved = null; }
    if (saved && Array.isArray(saved.places)) onChange(saved.places);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    refresh(true);
  }

  async function refresh(force) {
    if (document.hidden || (!force && Date.now() - lastTry < EVERY_MS)) return;
    lastTry = Date.now();
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(URL_PLACES, { signal: ctl.signal });
      if (!r.ok) throw new Error(String(r.status));
      const places = (await r.json()).places;
      if (!Array.isArray(places)) return;
      const text = JSON.stringify(places);
      if (saved && JSON.stringify(saved.places) === text) return;   // nothing changed: no redraw
      saved = { places, at: Date.now() };
      try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch (e) { /* private mode */ }
      onChange(places);
    } catch (e) {
      /* offline or server down: keep the saved list */
    } finally { clearTimeout(timeout); }
  }

  return { init };
})();
