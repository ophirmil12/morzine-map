/* Live location sharing: skiers see each other on the map (server/live-location/worker.js).
 *
 * - On by default: a one-time notice asks first (OK / Not now). It can be switched off any time
 *   (map button, or the switch in the legend).
 * - Works from 6:00 to 20:00, French time. A hidden switch (5 taps on the logo) allows it after
 *   hours until midnight.
 * - While the page is open and on screen: one request every 3 minutes sends my position and
 *   brings back the others. Nothing runs while the phone is locked or the page is hidden.
 *   People whose last position is older than OFFLINE_MIN show in light purple with
 *   "10 min" / "1 hour" style ages.
 * - The server keeps an emergency record for 2 days (see server/live-location/EMERGENCY.md).
 *
 * Usage: SHARE.init(map, { toast }) after the map has loaded.
 */
const SHARE = (() => {
  const API_DEPLOYED = 'https://morzine-live.ophirmil1234.workers.dev/pos';
  const OPEN_HOUR = 6, CLOSE_HOUR = 20;   // French time
  const OFFLINE_MIN = 7;                  // no news for 7 min (two missed updates): shown as offline
  const K_ID = 'morzine-share-id', K_NAME = 'morzine-share-name', K_CHOICE = 'morzine-share-choice';
  const K_AFTER = 'morzine-share-after-hours-until';

  // Testing on localhost only: ?shareapi=<url> uses another server (tools/live_dev_server.py),
  // ?demoloc=<lat>,<lon> pretends the phone is there and makes updates fast.
  const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const qs = new URLSearchParams(location.search);
  const API = (local && qs.get('shareapi')) || API_DEPLOYED;
  const DEMO = local && qs.get('demoloc') ? qs.get('demoloc').split(',').map(Number) : null;
  // One request every 3 minutes both sends my position and brings back the others: light on
  // battery (one short GPS fix, one radio wake-up) and data (about 1 KB per request).
  const EVERY_MS = DEMO ? 20 * 1000 : 3 * 60 * 1000;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };
  const deviceId = () => {
    let id = store.get(K_ID);
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) { id = crypto.randomUUID(); store.set(K_ID, id); }
    return id;
  };

  // ------------------------------------------------------------------ French time
  function parisSeconds(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: 'numeric',
      minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return (Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second);
  }
  /** Time (ms) of the next midnight in France: hidden switches turn themselves off then. */
  const nextMidnight = () => Date.now() + (24 * 3600 - parisSeconds(Date.now())) * 1000;
  const inHours = () => { const h = parisSeconds(Date.now()) / 3600; return h >= OPEN_HOUR && h < CLOSE_HOUR; };
  const afterHours = () => Number(store.get(K_AFTER)) > Date.now();

  // ------------------------------------------------------------------ state
  let map, toast;
  let active = false, lastSend = 0, others = [], warnedOutside = false, busy = false, drawnKey = '';
  const $ = (id) => document.getElementById(id);
  const choice = () => store.get(K_CHOICE);              // 'on', 'off', or null (never asked)
  const allowed = () => inHours() || afterHours();

  function init(m, helpers) {
    map = m; toast = helpers.toast;
    if (!API) return;
    $('btnShare').hidden = false;
    $('legendShare').hidden = false;
    addLayers();

    $('btnShare').addEventListener('click', () => {
      if (!allowed()) { toast(I18N.t('share.offHours')); return; }
      setChoice(choice() === 'on' ? 'off' : 'on', true);
    });
    $('shareSwitch').addEventListener('change', (e) => setChoice(e.target.checked ? 'on' : 'off', true));
    const name = $('shareName');
    name.value = store.get(K_NAME) || '';
    name.addEventListener('change', () => { store.set(K_NAME, name.value.trim().slice(0, 24)); lastSend = 0; tick(); });
    $('shareOk').addEventListener('click', () => { $('shareDlg').close(); setChoice('on', false); });
    $('shareNo').addEventListener('click', () => { $('shareDlg').close(); setChoice('off', false); });

    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    window.addEventListener('online', () => tick());
    setInterval(tick, DEMO ? 5 * 1000 : 20 * 1000);

    // First visit: ask once (inside sharing hours, so the question makes sense).
    if (choice() === null && allowed()) $('shareDlg').showModal();
    tick();
  }

  function setChoice(c, tell) {
    store.set(K_CHOICE, c);
    if (c === 'off' && active) post({ id: deviceId(), stop: true }).catch(() => {});
    if (tell) toast(I18N.t(c === 'on' ? 'share.started' : 'share.stopped'));
    lastSend = 0;
    tick();
  }

  /** Hidden switch (app.js, 5 taps on the logo): share after 20:00, until midnight. */
  function setAfterHours(on) {
    store.set(K_AFTER, on ? String(nextMidnight()) : null);
    lastSend = 0;
    tick();
  }

  /** Every 20 s (cheap, no network): is sharing active now, and is the next update due? */
  function tick() {
    const should = choice() === 'on' && allowed();
    if (should !== active) {
      active = should;
      if (!active) { others = []; }
      lastSend = 0; warnedOutside = false;
    }
    render();
    if (!active || document.hidden || busy) return;
    if (Date.now() - lastSend >= EVERY_MS) { lastSend = Date.now(); sendPosition(); }
  }

  function sendPosition() {
    const send = (lat, lon, acc) => call({ id: deviceId(), name: store.get(K_NAME) || '', lat, lon, acc });
    if (DEMO) { send(DEMO[0], DEMO[1], 10); return; }
    if (!navigator.geolocation) { call({ id: deviceId() }); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => send(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) { toast(I18N.t('share.denied')); store.set(K_CHOICE, 'off'); tick(); }
        else call({ id: deviceId() });   // no GPS fix right now: still show the others
      },
      // GPS for a useful fix on the mountain; a fix up to 2 min old (e.g. from "my position") is reused.
      { enableHighAccuracy: true, maximumAge: 2 * 60 * 1000, timeout: 15 * 1000 });
  }

  function call(body) {
    busy = true;
    post({ ...body, afterHours: afterHours() }).then(apply).catch(() => {}).finally(() => { busy = false; });
  }

  async function post(body) {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } finally { clearTimeout(timeout); }
  }

  function apply(res) {
    if (!active || !res) return;
    if (res.outside && !warnedOutside) { warnedOutside = true; toast(I18N.t('share.outside')); }
    const got = Date.now();
    others = (res.others || []).map((o) => ({ ...o, seenAt: got - o.age * 1000 }));
    render();
  }

  // ------------------------------------------------------------------ drawing
  const ON = '#7c3aed', OFF = '#c4b5fd', LABEL_ON = '#4c1d95', LABEL_OFF = '#7c6aa8';

  function addLayers() {
    map.addSource('friends', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'friends-dot', type: 'circle', source: 'friends',
      paint: { 'circle-radius': 8, 'circle-color': ['case', ['get', 'offline'], OFF, ON],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'friends-label', type: 'symbol', source: 'friends',
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12,
        'text-offset': [0, 1.25], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': ['case', ['get', 'offline'], LABEL_OFF, LABEL_ON],
        'text-halo-color': '#ffffff', 'text-halo-width': 1.6 } });
  }

  /** "10 min", "1 hour", "3 hours". */
  function ago(min) {
    return min < 60 ? I18N.t('share.agoMin', { n: Math.max(1, min) }) : I18N.tn('share.agoHours', Math.floor(min / 60));
  }

  function render() {
    const b = $('btnShare'); if (!b) return;
    const on = choice() === 'on';
    b.setAttribute('aria-pressed', String(active));
    b.classList.toggle('waiting', on && !active);   // switched on, but outside sharing hours
    const n = b.querySelector('.n');
    n.hidden = !(active && others.length);
    n.textContent = n.hidden ? '' : String(others.length);
    $('shareSwitch').checked = on;
    $('shareHours').classList.toggle('warn', on && !active);

    const src = map && map.getSource('friends'); if (!src) return;
    const now = Date.now();
    // Redraw only when something visible changed (new data, or a label's minute ticked over).
    const key = active + '|' + Math.floor(now / 60000) + '|' + others.map((o) => o.k + o.seenAt).join();
    if (key === drawnKey) return;
    drawnKey = key;
    src.setData({ type: 'FeatureCollection', features: active ? others.map((o) => {
      const min = Math.floor((now - o.seenAt) / 60000);
      const offline = min >= OFFLINE_MIN;
      const name = o.name || I18N.t('share.anonymous');
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [o.lon, o.lat] },
        properties: { offline, label: offline ? `${name} · ${ago(min)}` : name } };
    }) : [] });
  }

  return { init, setAfterHours, afterHours, nextMidnight, get active() { return active; } };
})();
