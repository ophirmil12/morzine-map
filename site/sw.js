/*
 * Browser cache for the map, so the site works fast and offline after the first visit.
 * (GitHub Pages only lets browsers cache files for 10 minutes; this keeps them for weeks.)
 *
 *   Whole area, offline: after the first load the page asks for 'save-area', and this worker
 *     downloads every terrain tile and every base-map tile of the area (about 40 MB, done once,
 *     typically at home on Wi-Fi). Already-saved tiles are skipped, so an interrupted download
 *     simply continues on the next visit. Progress is posted to the page.
 *
 *   App files (page, code, data, icons, base-map style): stored on the first visit, then
 *     served from the cache at once and refreshed in the background. A new version of the
 *     site therefore shows on the visit after it is published.
 *   Terrain tiles (tiles/dem), base-map tiles, fonts, libraries: cache first, kept until the
 *     cache is full (MAX_TILES), never fetched twice. Their addresses never change content.
 *
 * Bump VERSION to throw away every cached app file (tiles are kept).
 */
const VERSION = 'v17';
const APP_CACHE = `app-${VERSION}`;
const TILE_CACHE = 'tiles-v1';
const LIB_CACHE = 'libs-v1';
const MAX_TILES = 8000;
// Area saved for offline use (same as the map's limits) and its zoom levels.
const AREA = { west: 6.56, south: 46.09, east: 6.89, north: 46.26 };
const BASEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
const BASEMAP_ZOOMS = [8, 14];   // OpenFreeMap vector tiles stop at 14; the map over-zooms them

// Stored on install. Icons are added from assets/icons/index.json.
const APP_FILES = [
  './', 'index.html', 'css/app.css', 'css/share.css', 'sw.js',
  'js/basemap.js', 'js/i18n.js', 'js/icons.js', 'js/live.js', 'js/share.js', 'js/weather.js', 'js/app.js',
  'style/base.json', 'i18n/languages.json', 'i18n/en.json',
  'data/trails.json', 'data/pois.json', 'data/categories.json', 'data/content/en.json',
  'assets/logo.svg', 'assets/icons/index.json', 'tiles/dem/metadata.json',
  'manifest.webmanifest', 'assets/app/icon-192.png', 'assets/app/icon-512.png', 'assets/app/icon-maskable-512.png',
  'assets/app/apple-touch-icon.png'
];
const TILE_HOSTS = ['tiles.openfreemap.org', 's3.amazonaws.com'];
const LIB_HOSTS = ['unpkg.com', 'fonts.gstatic.com', 'fonts.googleapis.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    let files = APP_FILES.slice();
    try {
      const icons = await (await fetch('assets/icons/index.json')).json();
      files = files.concat(Object.keys(icons).map((n) => `assets/icons/${n}.svg`));
    } catch (e) { /* icons are cached when first used instead */ }
    // One by one, so a single missing file does not cancel the rest.
    await Promise.all(files.map((f) => cache.add(new Request(f, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [APP_CACHE, TILE_CACHE, LIB_CACHE];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function cacheFirst(req, name, cap) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    cache.put(req, res.clone());
    if (cap) trim(cache, cap);
  }
  return res;
}

async function staleWhileRevalidate(req, name, event) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  const update = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
  if (hit) { event.waitUntil(update.catch(() => {})); return hit; }
  return update;
}

// ---------------------------------------------------------------- whole-area download
function tileRange(z) {
  const n = 2 ** z, rad = Math.PI / 180;
  const x = (lon) => Math.floor((lon + 180) / 360 * n);
  const y = (lat) => Math.floor((1 - Math.asinh(Math.tan(lat * rad)) / Math.PI) / 2 * n);
  return { x0: x(AREA.west), x1: x(AREA.east), y0: y(AREA.north), y1: y(AREA.south) };
}
function areaTiles(template, zmin, zmax) {
  const out = [];
  for (let z = zmin; z <= zmax; z++) {
    const r = tileRange(z);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) {
      out.push(template.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
  }
  return out;
}

let saving = null;
async function saveArea() {
  const urls = [];
  try {
    const meta = await (await fetch('tiles/dem/metadata.json')).json();
    // Plain string join: new URL() would percent-encode the {z}/{x}/{y} placeholders.
    // Terrain and hillshade use zoom <= 13 (js/app.js). Zoom 14 only feeds the desktop contour
    // lines, so it is cached when used and not saved ahead (192 tiles, about 21 MB less to download).
    urls.push(...areaTiles(self.registration.scope + 'tiles/dem/{z}/{x}/{y}.png', meta.minzoom, Math.min(meta.maxzoom, 13)));
  } catch (e) { /* no local terrain */ }
  try {
    const tj = await (await fetch(BASEMAP_TILEJSON)).json();
    (await caches.open(LIB_CACHE)).put(BASEMAP_TILEJSON, new Response(JSON.stringify(tj), { headers: { 'Content-Type': 'application/json' } }));
    urls.push(...areaTiles(tj.tiles[0], BASEMAP_ZOOMS[0], Math.min(BASEMAP_ZOOMS[1], tj.maxzoom || 14)));
  } catch (e) { /* base map tiles will be cached as they are viewed */ }

  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, next = 0, lastPost = 0;
  const post = async (final) => {
    const now = Date.now();
    if (!final && now - lastPost < 700) return;
    lastPost = now;
    for (const c of await self.clients.matchAll()) c.postMessage({ type: 'save-area', done, total: urls.length, failed, final });
  };
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res); else failed++;
        }
      } catch (e) { failed++; }
      done++;
      post(false);
    }
  }));
  await post(true);
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'save-area') {
    if (!saving) saving = saveArea().finally(() => { saving = null; });
    event.waitUntil(saving);
  }
});

let trimming = false;
async function trim(cache, cap) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - cap; i++) await cache.delete(keys[i]);  // oldest first
  } finally { trimming = false; }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The terms page (terms/) always comes from the network and is never stored.
  if (url.origin === self.location.origin && /\/terms(\/|\.html|$)/.test(url.pathname)) return;

  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/tiles/') && url.pathname.endsWith('.png')) {
      event.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES));
    } else {
      // The page itself is cached under "./" whatever the query string (?id=..., ?lang=...).
      const r = req.mode === 'navigate' ? new Request('./') : req;
      event.respondWith(staleWhileRevalidate(r, APP_CACHE, event));
    }
    return;
  }
  if (TILE_HOSTS.includes(url.hostname)) {
    // Tiles and glyphs never change at a given address; the tile index (TileJSON) does.
    if (/\.(pbf|png|mvt)$/.test(url.pathname)) event.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES));
    else event.respondWith(staleWhileRevalidate(req, LIB_CACHE, event));
    return;
  }
  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(url.hostname === 'fonts.googleapis.com'
      ? staleWhileRevalidate(req, LIB_CACHE, event)
      : cacheFirst(req, LIB_CACHE));
  }
});
