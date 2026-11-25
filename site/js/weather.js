/* Mountain weather: a small chip in the top-right corner with an icon, the temperature and ⛰️.
 *
 * Forecast from Météo-France (AROME/ARPEGE models) through Open-Meteo: free, no key, about
 * 0.5 KB per request. One request on load, then every 30 minutes while the page is visible.
 * The last answer is kept on the phone and shown for up to 3 hours when there is no signal.
 *
 * Usage: WEATHER.init({ toast }) once the page texts are loaded.
 */
const WEATHER = (() => {
  // The top of the slopes: Avoriaz, 1,800 m (the elevation fixes the temperature for that height).
  const SPOT = { lat: 46.191, lon: 6.774, elevation: 1800 };
  const URL_NOW = 'https://api.open-meteo.com/v1/meteofrance?latitude=' + SPOT.lat + '&longitude=' + SPOT.lon +
    '&elevation=' + SPOT.elevation + '&current=temperature_2m,weather_code,is_day&timezone=Europe%2FParis';
  const EVERY_MS = 30 * 60 * 1000;
  const SHOW_MAX_MS = 3 * 3600 * 1000;   // older than this: hide rather than show stale weather
  const STORE = 'morzine-weather-v1';

  // WMO weather code -> [day icon, night icon] (Material Symbols names; tools/slim_assets.py reads this).
  const WEATHER_ICON = [
    [[0], 'sunny', 'bedtime'],
    [[1, 2], 'partly_cloudy_day', 'partly_cloudy_night'],
    [[3], 'cloud', 'cloud'],
    [[45, 48], 'foggy', 'foggy'],
    [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], 'rainy', 'rainy'],
    [[71, 73, 75, 77, 85, 86], 'weather_snowy', 'weather_snowy'],
    [[95, 96, 99], 'thunderstorm', 'thunderstorm']
  ];

  let last = null, lastTry = 0, toast = () => {};
  const el = () => document.getElementById('weather');

  function init(helpers) {
    toast = helpers.toast || toast;
    try { last = JSON.parse(localStorage.getItem(STORE)); } catch (e) { last = null; }
    render();
    el().addEventListener('click', () => {
      if (!last) return;
      toast(I18N.t('weather.about', { time: hhmm(last.at) }));
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('online', () => refresh(true));
    setInterval(refresh, 5 * 60 * 1000);   // cheap check; the request itself only every 30 minutes
    refresh(true);
  }

  async function refresh(force) {
    if (document.hidden) return;
    const now = Date.now();
    if (!force && now - lastTry < EVERY_MS) return;
    if (!force && last && now - last.at < EVERY_MS) return;
    lastTry = now;
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(URL_NOW, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const c = (await r.json()).current;
      if (!c || typeof c.temperature_2m !== 'number') throw new Error('no data');
      last = { t: c.temperature_2m, code: c.weather_code, day: c.is_day === 1, at: now };
      try { localStorage.setItem(STORE, JSON.stringify(last)); } catch (e) { /* private mode */ }
    } catch (e) {
      /* no signal or service down: keep showing the last answer while it is recent */
    } finally { clearTimeout(timeout); }
    render();
  }

  function iconFor(code, day) {
    const row = WEATHER_ICON.find(([codes]) => codes.includes(code));
    return row ? (day ? row[1] : row[2]) : 'cloud';
  }

  const hhmm = (ms) => new Date(ms).toLocaleTimeString(I18N.lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  function render() {
    const box = el(); if (!box) return;
    if (!last || Date.now() - last.at > SHOW_MAX_MS) { box.hidden = true; return; }
    box.hidden = false;
    box.querySelector('.ms').textContent = iconFor(last.code, last.day);
    box.querySelector('.t').textContent = `${Math.round(last.t)}°`;
    const label = I18N.t('weather.label', { temp: Math.round(last.t), time: hhmm(last.at) });
    box.title = label;
    box.setAttribute('aria-label', label);
  }

  return { init };
})();
