/* Morzine interactive map. Plain JS, MapLibre GL. */
(async function () {
  'use strict';

  // ------------------------------------------------------------------ settings
  // The map covers Les Gets, Morzine and Avoriaz and opens on Morzine village.
  const START = { center: [6.7105, 46.1795], zoom: 13.4, pitch: 50, bearing: 0 };
  const BOUNDS = [[6.56, 46.09], [6.89, 46.26]];
  // Base map: our own style (style/base.json + js/basemap.js) on OpenFreeMap vector tiles.
  const BASE_STYLE = BASEMAP.styleUrl;
  // Terrain: AWS Terrarium elevation tiles stored in the site (tools/download_dem.py, zoom 8-13).
  // Absolute URL because MapLibre loads tiles in a web worker. sw.js keeps them cached for weeks.
  const DEM_TILES = new URL('tiles/dem/', location.href).href + '{z}/{x}/{y}.png';
  // Zoom 13 for both the 3D terrain and the hillshade: same tile files (downloaded once), and 30-40%
  // fewer elevation tiles than zoom 14 with no visible change. Zoom 14 also made hillshade stripes.
  const DEM_MAXZOOM = 13;
  const SHADE_MAXZOOM = 13;
  // The elevation tiles exist only for this box: never ask for tiles outside it (towards the horizon).
  const DEM_BOUNDS = [6.56, 46.09, 6.89, 46.26];
  const DEM_ATTR = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank">Terrain: Mapzen, AWS</a>';
  const DATA_ATTR = 'Data: Office de Tourisme de Morzine';
  const EXAGGERATION = 1.35;
  const LIST_LIMIT = 150;

  // Layer groups shown as chips. Line groups first, then point families.
  const LINE_GROUPS = {
    pistes:  { families: ['ski_trail'], icon: 'downhill_skiing', color: '#1b65d4' },
    lifts:   { families: ['ski_lift', 'mtb_lift'], icon: '@lift', color: '#3b444d' },
    nordic:  { families: ['nordic_ski_trail'], icon: 'nordic_walking', color: '#1b65d4' },
    routes:  { families: ['activity_routes'], icon: 'hiking', color: '#8a56b6' },
    mtb:     { families: ['mtb_trail'], icon: 'directions_bike', color: '#c2410c' },
    running: { families: ['trail_running'], icon: 'directions_run', color: '#0f766e' }
  };
  const POI_ORDER = ['mountain_restaurants', 'activities', 'restaurants', 'bars', 'accommodations', 'rental_accommodation',
    'shops_and_services', 'producers', 'stops'];
  // Piste colours as on the original site.
  const DIFF_COLOR = { novice: '#66BE58', easy: '#1B65D4', intermediate: '#E11C1C', advanced: '#111111' };
  const LIFT_COLOR = '#60666C';
  const CLOSED_COLOR = '#a3acb5';   // lifts and pistes closed right now (live status)

  // Layers shown when the map opens, per season; the others start switched off.
  const DEFAULT_ON = { winter: ['pistes', 'lifts', 'mountain_restaurants'], summer: ['lifts', 'mtb'] };

  // ------------------------------------------------------------------ state
  const qs = new URLSearchParams(location.search);
  const state = {
    season: qs.get('season') || defaultSeason(),
    on: null,                  // layers switched on (set from DEFAULT_ON below)
    query: '',
    selected: null,
    terrain: true,
    look: 'winter'             // map style: 'winter' (snowy) or 'regular' (natural colours)
  };
  const LOOK_KEY = 'morzine-map-look';
  try { if (localStorage.getItem(LOOK_KEY) === 'regular') state.look = 'regular'; } catch (e) { /* private mode */ }

  function defaultSeason() {
    const d = new Date(), m = d.getMonth() + 1, day = d.getDate();
    // Winter season on the site runs from late November to April.
    return (m === 11 && day >= 20) || m === 12 || m <= 4 ? 'winter' : 'summer';
  }
  // Winter only for now: summer data is not fetched and the season switch is hidden.
  const SEASONS_ON = ['winter'];
  if (!SEASONS_ON.includes(state.season)) state.season = SEASONS_ON[0];
  state.on = new Set(DEFAULT_ON[state.season]);

  // ------------------------------------------------------------------ load
  await I18N.init(qs.get('lang'));
  const [meta, trailsFC, poisFC] = await Promise.all([
    fetch('data/categories.json').then((r) => r.json()),
    fetch('data/trails.json').then((r) => r.json()),
    fetch('data/pois.json').then((r) => r.json())
  ]);
  await ICONS.init(meta);
  const t = I18N.t;

  // ------------------------------------------------------------------ features
  function difficulty(fam, cat) {
    cat = cat || '';
    if (fam === 'activity_routes') return 'route';
    if (fam === 'mtb_trail') {
      const m = cat.match(/novice|easy|intermediate|advanced/);
      return m ? m[0] : 'mtb';
    }
    if (fam === 'trail_running') return 'running';
    if (cat === 'snowshoeing') return 'route';
    const m = cat.match(/novice|easy|intermediate|advanced|expert/);
    if (m) return m[0] === 'expert' ? 'advanced' : m[0];
    return 'other';
  }

  function lineLength(geom) {
    const R = 6371000, rad = Math.PI / 180;
    const parts = geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
    let sum = 0;
    for (const line of parts) {
      for (let i = 1; i < line.length; i++) {
        const [x1, y1] = line[i - 1], [x2, y2] = line[i];
        const dy = (y2 - y1) * rad, dx = (x2 - x1) * rad * Math.cos((y1 + y2) / 2 * rad);
        sum += R * Math.hypot(dx, dy);
      }
    }
    return sum;
  }

  function bboxOf(geom) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
        b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
      } else c.forEach(walk);
    };
    walk(geom.coordinates);
    return b;
  }

  const groupOfFamily = {};
  for (const [g, def] of Object.entries(LINE_GROUPS)) def.families.forEach((f) => { groupOfFamily[f] = g; });

  const all = [];   // every feature, lines and points
  const byId = {};
  for (const f of trailsFC.features.concat(poisFC.features)) {
    const p = f.properties;
    const isLine = f.geometry.type !== 'Point';
    const look = ICONS.look(p.family, p.category);
    p.name = I18N.item(p.id).name;
    p.group = groupOfFamily[p.family] || p.family;
    p.iconKey = ICONS.key(look);
    p.color = look.color;
    if (isLine) {
      p.diff = difficulty(p.family, p.category);
      p.isLift = LINE_GROUPS.lifts.families.includes(p.family) || ICONS.LIFT_CATS.has(p.category);
      if (p.isLift) { p.group = 'lifts'; p.color = LIFT_COLOR; }
      else if (DIFF_COLOR[p.diff]) p.color = DIFF_COLOR[p.diff];
      p.length = Math.round(lineLength(f.geometry));
      p.bbox = bboxOf(f.geometry);
    }
    p.point = isLine ? (p.marker || f.geometry.coordinates.flat(2).slice(0, 2)) : f.geometry.coordinates;
    p.search = (p.name + ' ' + I18N.category(p.category) + ' ' + I18N.family(p.family)).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    const rec = { f, p, isLine };
    all.push(rec); byId[p.id] = rec;
  }

  // ------------------------------------------------------------------ map
  // Phones are the main target: lighter rendering there (no antialiasing, pixel ratio capped at 2).
  const isPhone = window.matchMedia('(max-width: 760px)').matches;
  const map = new maplibregl.Map({
    container: 'map', style: BASE_STYLE, ...START, minZoom: 11,
    maxPitch: 75, maxZoom: 17.5, maxBounds: BOUNDS, hash: 'view', attributionControl: false,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    canvasContextAttributes: { antialias: !isPhone }
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: DATA_ATTR }), isPhone ? 'top-right' : 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
  // Vertical distance scale under the map buttons. It uses the ground scale at the map centre
  // (from zoom and latitude only), so it stays steady while the camera tilts or crosses terrain.
  (function verticalScale() {
    const box = document.getElementById('vscale');
    const lbl = box.querySelector('.lbl'), bar = box.querySelector('.bar');
    const STEPS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    const MAX_PX = isPhone ? 96 : 120;
    let queued = false;
    const draw = () => {
      queued = false;
      const lat = map.getCenter().lat * Math.PI / 180;
      const mpp = 40075016.686 * Math.cos(lat) / (512 * Math.pow(2, map.getZoom()));
      let d = STEPS[0];
      for (const s of STEPS) if (s / mpp <= MAX_PX) d = s;
      bar.style.height = `${Math.round(d / mpp)}px`;
      lbl.textContent = d >= 1000 ? t('units.km', { n: d / 1000 }) : t('units.m', { n: d });
    };
    map.on('move', () => { if (!queued) { queued = true; requestAnimationFrame(draw); } });
    map.once('load', draw);
    draw();
  })();
  document.getElementById('map').setAttribute('aria-label', t('map.label'));
  if (qs.has('debug')) window.map = map;   // for testing in the browser console

  // Draw marker images when a layer first needs them.
  map.on('styleimagemissing', (e) => {
    if (!e.id.includes('|') || map.hasImage(e.id)) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    map.addImage(e.id, ICONS.makeImage(e.id, ratio), { pixelRatio: ratio });
  });



  map.on('load', () => {
    // Credits start folded (the "i" button opens them) so they never cover the map buttons.
    document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show')
      .forEach((el) => el.classList.remove('maplibregl-compact-show'));
    // --- terrain, hillshade, sky
    map.addSource('dem', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, minzoom: 8, maxzoom: DEM_MAXZOOM, bounds: DEM_BOUNDS, attribution: DEM_ATTR });
    map.addSource('dem-shade', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, minzoom: 8, maxzoom: SHADE_MAXZOOM, bounds: DEM_BOUNDS });
    map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-shade', paint: { 'hillshade-method': 'igor' } },
      map.getLayer('hillshade-slot') ? 'hillshade-slot' : undefined);  // colours set by BASEMAP.applySeason
    setTerrain(true);
    // Contour lines: desktop only (they are computed in the browser; phones skip the work).
    if (!isPhone) {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/maplibre-contour@0.2.0/dist/index.min.js';
      s.onload = () => BASEMAP.addContours(map, DEM_TILES);
      document.head.appendChild(s);
    }
    map.setSky({
      'sky-color': '#7fb2e5', 'horizon-color': '#dfeaf5', 'fog-color': '#f3f6f9',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.25
    });

    BASEMAP.localise(map, I18N.lang);
    // Ski layers go under village and peak names ('overlays-slot'); points go on top.
    const OVER = map.getLayer('overlays-slot') ? 'overlays-slot' : undefined;
    const addSki = (layer) => map.addLayer(layer, OVER);

    // --- trails and lifts
    map.addSource('trails', { type: 'geojson', data: emptyFC(), promoteId: 'id' });
    map.addSource('lift-ends', { type: 'geojson', data: emptyFC() });
    const width = (base) => ['interpolate', ['exponential', 1.5], ['zoom'], 11, base * 0.55, 14, base, 17, base * 2.4];
    // Width that grows on hover: zoom interpolation outside, hover case inside each stop.
    const hoverWidth = (base, hov) => {
      const c = (k) => ['case', ['boolean', ['feature-state', 'hover'], false], hov * k, base * k];
      return ['interpolate', ['exponential', 1.5], ['zoom'], 11, c(0.55), 14, c(1), 17, c(2.4)];
    };
    const diffColor = ['get', 'color'];
    // Live status: lines closed right now are drawn by one grey dashed layer ('closed-lines').
    const open = ['!', ['boolean', ['get', 'closed'], false]];
    const notLift = ['all', ['!', ['get', 'isLift']], open];

    addSki({ id: 'trail-casing', type: 'line', source: 'trails', filter: ['!', ['get', 'isLift']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.85, 'line-width': width(4) } });
    addSki({ id: 'trail-selected', type: 'line', source: 'trails', filter: ['==', ['get', 'id'], ''],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffd400', 'line-width': width(11), 'line-blur': 1 } });
    addSki({ id: 'pistes', type: 'line', source: 'trails',
      filter: ['all', notLift, ['==', ['get', 'family'], 'ski_trail']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': diffColor,
        'line-width': hoverWidth(2.3, 3.6) } });
    addSki({ id: 'nordic', type: 'line', source: 'trails',
      filter: ['all', notLift, ['==', ['get', 'family'], 'nordic_ski_trail'], ['!=', ['get', 'diff'], 'route']],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': diffColor, 'line-width': width(2.6), 'line-dasharray': [2.2, 1.4] } });
    addSki({ id: 'routes', type: 'line', source: 'trails',
      filter: ['all', notLift, ['any',
        ['==', ['get', 'diff'], 'route'],
        ['in', ['get', 'family'], ['literal', ['activity_routes', 'trail_running']]]]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': diffColor, 'line-width': width(2.4), 'line-dasharray': [0.2, 1.8] } });
    // Mountain-bike trails: solid, so they don't look like base-map footpaths.
    addSki({ id: 'mtb', type: 'line', source: 'trails',
      filter: ['all', notLift, ['==', ['get', 'family'], 'mtb_trail']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': diffColor, 'line-width': hoverWidth(2.2, 3.4) } });
    addSki({ id: 'lifts-casing', type: 'line', source: 'trails', filter: ['get', 'isLift'],
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.8, 'line-width': width(4) } });
    addSki({ id: 'lifts', type: 'line', source: 'trails', filter: ['all', ['get', 'isLift'], open],
      paint: { 'line-color': LIFT_COLOR,
        'line-width': hoverWidth(2, 3.4) } });
    addSki({ id: 'closed-lines', type: 'line', source: 'trails', filter: ['boolean', ['get', 'closed'], false],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': CLOSED_COLOR, 'line-width': hoverWidth(2, 3.2), 'line-dasharray': [1.6, 1.3] } });
    addSki({ id: 'lift-ends', type: 'circle', source: 'lift-ends', minzoom: 13,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 16, 5], 'circle-color': LIFT_COLOR,
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } });
    addSki({ id: 'trail-labels', type: 'symbol', source: 'trails', minzoom: 13.2,
      layout: {
        'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 16, 13], 'text-max-angle': 35,
        'symbol-spacing': 280, 'text-padding': 2
      },
      paint: { 'text-color': ['case', ['boolean', ['get', 'closed'], false], '#7c8894', diffColor],
        'text-halo-color': '#ffffff', 'text-halo-width': 1.6 } });

    // --- points of interest: coloured dots when zoomed out (as on the original), icons when zoomed in
    const ICON_ZOOM = 14.3;
    map.addSource('pois', { type: 'geojson', data: emptyFC(), promoteId: 'id' });
    map.addLayer({ id: 'poi-dots', type: 'circle', source: 'pois', maxzoom: ICON_ZOOM,
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 12.5, 5.5, 14.3, 7],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 1.5]
      } });
    map.addLayer({ id: 'poi-icons', type: 'symbol', source: 'pois', minzoom: ICON_ZOOM,
      layout: {
        'icon-image': ['get', 'iconKey'], 'icon-size': 1, 'icon-allow-overlap': true,
        'text-field': ['step', ['zoom'], '', 15.5, ['get', 'name']], 'text-font': ['Noto Sans Regular'],
        'text-size': 11.5, 'text-offset': [0, 1.35], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9
      },
      paint: { 'text-color': '#15202b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4,
        'icon-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0.97] } });
    map.addSource('selected-point', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'selected-point', type: 'circle', source: 'selected-point',
      paint: { 'circle-radius': 21, 'circle-color': 'rgba(255,212,0,.35)', 'circle-stroke-color': '#ffd400', 'circle-stroke-width': 3 } },
    'poi-icons');

    bindMapEvents();
    keepCameraAboveGround();
    refresh();
    map.once('idle', () => { if (!state.query && !state.selected) renderList(); });
    if (qs.get('id') && byId[qs.get('id')]) openDetail(qs.get('id'), true);
    LIVE.start(applyLive);
    SHARE.init(map, { t, toast });   // live location sharing (hidden until the Worker is deployed)
  });

  /** The camera must never go into the mountain. MapLibre calls transformCameraUpdate on every
   *  camera change (finger, mouse, animation, jump) before drawing it. Look at the ground under the
   *  camera and on the first stretch of its line of sight; if the camera is not at least MARGIN
   *  above all of it, step back (zoom out) and check again. Done here and not with a jumpTo in a
   *  'move' handler, because a jumpTo stops any running flight or finger gesture half way. */
  function keepCameraAboveGround() {
    if (!map.transform || !map.transform.getCameraLngLat || !map.transform.getCameraAltitude) return;
    const MARGIN = 80;   // metres (exaggerated terrain)
    const highestGround = (tr) => {
      const cam = tr.getCameraLngLat(), c = tr.center;
      let top = -Infinity;
      for (const k of [0, 0.15, 0.3]) {   // under the camera, then towards the centre of the view
        const h = map.queryTerrainElevation([cam.lng + (c.lng - cam.lng) * k, cam.lat + (c.lat - cam.lat) * k]);
        if (h !== null && h !== undefined) top = Math.max(top, h);
      }
      return top;
    };
    // MapLibre 5.6 works out the height of the view centre during a flight, then loses it: the flight
    // keeps its start height, ends too close to (or too far from) a peak, and MapLibre's own
    // below-ground check tilts the camera up on the way. Hand the height over before that check.
    const ownCheck = map._elevateCameraIfInsideTerrain;
    if (typeof ownCheck === 'function') {
      map._elevateCameraIfInsideTerrain = function (tr) {
        if (map.getTerrain() && map.isEasing()) tr.setElevation(map.transform.elevation);
        return ownCheck.call(this, tr);
      };
    }
    map.transformCameraUpdate = (tr) => {
      if (!map.getTerrain()) return {};
      const out = {};
      for (let i = 0; i < 6; i++) {
        const ground = highestGround(tr);
        if (!isFinite(ground)) break;
        const cam = tr.getCameraAltitude(), above = cam - tr.elevation;
        if (cam >= ground + MARGIN || above <= 0) break;
        // The camera's height above the centre doubles for each zoom level out.
        tr.setZoom(tr.zoom - Math.log2(Math.max(ground + MARGIN - tr.elevation, above * 1.1) / above) - 0.05);
        out.zoom = tr.zoom;
      }
      return out;
    };
    // MapLibre 5.6 also leaves the centre height frozen after a flight (only a finger drag frees it).
    // Free it, so the centre stays on the ground as finer terrain tiles arrive.
    map.on('moveend', () => { if (!map.isMoving()) map._elevationFreeze = false; });
  }

  // ------------------------------------------------------------------ live lift/piste status
  const CLOSED_KINDS = new Set(['closed', 'offseason', 'stopped']);
  const livePill = document.getElementById('livePill');
  const legendLive = document.getElementById('legendLive');
  const hhmm = (ms) => {
    const d = new Date(ms), now = new Date();
    const time = d.toLocaleTimeString(I18N.lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return d.toDateString() === now.toDateString() ? time
      : `${d.toLocaleDateString(I18N.lang, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
  };

  // Hidden settings: 5 taps in a row on the Morzine logo open a small box with two switches,
  // "ignore live lift status" (normal colours, no status pill or badge) and "location sharing
  // after hours" (js/share.js). Both stay on until midnight, French time, then switch off.
  const K_IGNORE = 'morzine-ignore-live-until';
  const stillOn = (k) => { try { return Number(localStorage.getItem(k)) > Date.now(); } catch (e) { return false; } };
  let ignoreLive = stillOn(K_IGNORE);
  (function hiddenSettings() {
    const box = document.getElementById('secretBox');
    const optLive = document.getElementById('optIgnoreLive');
    const optAfter = document.getElementById('optAfterHours');
    const sync = () => { ignoreLive = stillOn(K_IGNORE); optLive.checked = ignoreLive; optAfter.checked = SHARE.afterHours(); };
    optLive.addEventListener('change', () => {
      try {
        if (optLive.checked) localStorage.setItem(K_IGNORE, String(SHARE.nextMidnight()));
        else localStorage.removeItem(K_IGNORE);
      } catch (e) { /* private mode: works until reload */ }
      ignoreLive = optLive.checked;
      applyLive();
      toast(t(ignoreLive ? 'live.ignored' : 'live.restored'));
    });
    optAfter.addEventListener('change', () => SHARE.setAfterHours(optAfter.checked));
    // Midnight passed while the page was open: the switches turn themselves off.
    setInterval(() => { const was = ignoreLive; sync(); if (was !== ignoreLive) applyLive(); }, 60 * 1000);

    const TAPS = 5, GAP_MS = 1500;
    let count = 0, last = 0;
    document.querySelectorAll('.map-logo, .brand-logo').forEach((logo) => {
      logo.style.touchAction = 'manipulation';   // no double-tap zoom eating taps
      logo.addEventListener('click', () => {
        const now = Date.now();
        count = now - last < GAP_MS ? count + 1 : 1;
        last = now;
        if (count < TAPS) return;
        count = 0;
        sync();
        box.hidden = !box.hidden;
      });
    });
    // Touching anything else closes the box.
    document.addEventListener('pointerdown', (e) => {
      if (!box.hidden && !box.contains(e.target) && !e.target.closest('.map-logo, .brand-logo')) box.hidden = true;
    }, true);
  })();

  /** New status arrived (or the saved one at start): recolour lines, update pill, legend, card. */
  function applyLive() {
    let changed = false;
    for (const r of all) {
      if (!r.isLine) continue;
      const k = LIVE.kind(r.p.id);
      const closed = !ignoreLive && CLOSED_KINDS.has(k);
      if (r.p.live !== k || r.p.closed !== closed) { r.p.live = k; r.p.closed = closed; changed = true; }
    }
    if (changed && map.getSource('trails')) refresh();
    renderLiveTime();
    if (state.selected) renderLiveRow(byId[state.selected]);
  }

  /** Time of the last update, coloured green (under 10 min), yellow (under 1 h) or red. */
  function renderLiveTime() {
    const f = LIVE.freshness();
    if (ignoreLive) { livePill.hidden = true; legendLive.hidden = true; return; }
    if (!f) return;
    const time = hhmm(LIVE.fetchedAt);
    livePill.hidden = false;
    livePill.className = `live-pill ${f}`;
    livePill.querySelector('span').textContent = t('live.pill', { time });
    legendLive.hidden = false;
    legendLive.className = `legend-live ${f}`;
    legendLive.innerHTML = `<i class="dot"></i><span>${esc(t('live.legend', { time }))}</span>`;
  }
  setInterval(() => { renderLiveTime(); if (state.selected) renderLiveRow(byId[state.selected]); }, 60 * 1000);
  livePill.addEventListener('click', () => document.getElementById('btnLegend').click());

  function renderLiveRow(r) {
    const row = document.getElementById('dLive');
    const k = r && r.isLine ? LIVE.kind(r.p.id) : null;
    if (ignoreLive || !k || k === 'none' || !LIVE.fetchedAt) { row.hidden = true; return; }
    const f = LIVE.freshness();
    const st = row.querySelector('.st');
    st.className = `st ${k}`; st.textContent = t(`live.${k}`);
    const upd = row.querySelector('.upd');
    upd.className = `upd ${f}`;
    upd.querySelector('span').textContent = t('live.updated', { time: hhmm(LIVE.fetchedAt) });
    row.hidden = false;
  }

  const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

  function setTerrain(on) {
    map.setTerrain(on ? { source: 'dem', exaggeration: EXAGGERATION } : null);
    showTerrainState(on);
  }
  function showTerrainState(on) {
    state.terrain = on;
    const b = document.getElementById('btn3d');
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('span').textContent = on ? t('map.3d') : t('map.2d');
  }

  /** Call back once the terrain tiles in view have loaded (1.5 s at most). */
  function whenTerrainLoaded(cb) {
    if (map.queryTerrainElevation(map.getCenter())) return cb();   // ground under the centre known
    let done = false, timer = null;
    const onData = (e) => { if (e.sourceId === 'dem' && e.tile && map.isSourceLoaded('dem')) finish(); };
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer); map.off('sourcedata', onData); cb();
    };
    timer = setTimeout(finish, 1500);
    map.on('sourcedata', onData);
  }

  // ------------------------------------------------------------------ filtering
  const inSeason = (r) => (r.p.seasons || []).includes(state.season);
  const visibleRecords = () => all.filter((r) => inSeason(r) && state.on.has(r.p.group));
  function matches(r, q) { return !q || q.split(/\s+/).every((w) => r.p.search.includes(w)); }

  function refresh() {
    // Same tiles either way (so both styles work offline): only the colours change.
    BASEMAP.applySeason(map, state.look === 'regular' ? 'summer' : 'winter');
    const vis = visibleRecords();
    const lines = vis.filter((r) => r.isLine), pts = vis.filter((r) => !r.isLine);
    if (map.getSource('trails')) {
      map.getSource('trails').setData({ type: 'FeatureCollection', features: lines.map((r) => r.f) });
      const ends = [];
      for (const r of lines) {
        if (!r.p.isLift) continue;
        const parts = r.f.geometry.type === 'MultiLineString' ? r.f.geometry.coordinates : [r.f.geometry.coordinates];
        const first = parts[0][0], lastPart = parts[parts.length - 1], last = lastPart[lastPart.length - 1];
        ends.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: first } },
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: last } });
      }
      map.getSource('lift-ends').setData({ type: 'FeatureCollection', features: ends });
      map.getSource('pois').setData({ type: 'FeatureCollection', features: pts.map((r) => r.f) });
    }
    renderChips();
    renderList();
  }

  // ------------------------------------------------------------------ panel: chips
  const chipsEl = document.getElementById('chips');
  function groupsInSeason() {
    const count = {};
    for (const r of all) if (inSeason(r)) count[r.p.group] = (count[r.p.group] || 0) + 1;
    const lineGroups = Object.keys(LINE_GROUPS).filter((g) => count[g]);
    const poiGroups = POI_ORDER.filter((g) => count[g]).concat(Object.keys(count).filter((g) => !LINE_GROUPS[g] && !POI_ORDER.includes(g)));
    // Layers that start switched on come first, so on phones they are in view in the chip row.
    const groups = lineGroups.concat(poiGroups), first = DEFAULT_ON[state.season] || [];
    return { count, groups: groups.filter((g) => first.includes(g)).concat(groups.filter((g) => !first.includes(g))) };
  }
  function renderChips() {
    const { count, groups } = groupsInSeason();
    chipsEl.setAttribute('aria-label', t('layers.pistes'));
    chipsEl.innerHTML = groups.map((g) => {
      const def = LINE_GROUPS[g];
      const label = def ? t(`layers.${g}`) : I18N.family(g) || g;
      return `<button type="button" class="chip" data-group="${g}" aria-pressed="${state.on.has(g)}">
        ${ICONS.chipHTML(g, def ? def.families[0] : g)}${esc(label)} <span class="n">${count[g]}</span></button>`;
    }).join('');
  }
  chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    const g = b.dataset.group;
    state.on.has(g) ? state.on.delete(g) : state.on.add(g);
    refresh();
  });

  // ------------------------------------------------------------------ panel: list
  const listEl = document.getElementById('results'), countEl = document.getElementById('count');
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderList() {
    const q = norm(state.query);
    // A search looks through every item of the season, including layers that are off.
    let rows = (q ? all.filter(inSeason) : visibleRecords()).filter((r) => matches(r, q));
    // Without a search, list what is in view.
    if (!q && map.loaded()) {
      const b = map.getBounds();
      rows = rows.filter((r) => r.isLine
        ? !(r.p.bbox[2] < b.getWest() || r.p.bbox[0] > b.getEast() || r.p.bbox[3] < b.getSouth() || r.p.bbox[1] > b.getNorth())
        : b.contains(r.p.point));
    }
    const order = Object.keys(LINE_GROUPS).concat(POI_ORDER);
    rows.sort((a, b) => (order.indexOf(a.p.group) - order.indexOf(b.p.group)) || a.p.name.localeCompare(b.p.name, I18N.lang));
    countEl.textContent = I18N.tn('results.count', rows.length);
    if (!rows.length) { listEl.innerHTML = `<li class="more">${esc(t('results.none'))}</li>`; return; }
    listEl.innerHTML = rows.slice(0, LIST_LIMIT).map((r) => `<li><button type="button" data-id="${esc(r.p.id)}">
      ${ICONS.badgeHTML(r.p.family, r.p.category, r.isLine ? 'line' : '')}
      <span class="txt"><span class="nm">${esc(r.p.name)}</span><span class="ct">${esc(kindLabel(r.p))}</span></span>
      </button></li>`).join('') +
      (rows.length > LIST_LIMIT ? `<li class="more">${esc(t('results.more', { n: rows.length - LIST_LIMIT }))}</li>` : '');
  }
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]'); if (b) openDetail(b.dataset.id, true);
  });
  listEl.addEventListener('mouseover', (e) => {
    const b = e.target.closest('button[data-id]'); if (b) highlight(b.dataset.id);
  });
  listEl.addEventListener('mouseleave', () => highlight(state.selected));

  function kindLabel(p) {
    const cat = I18N.category(p.category), fam = I18N.family(p.family);
    return cat && fam && cat !== fam ? `${cat} · ${fam}` : cat || fam;
  }

  let searchTimer;
  document.getElementById('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value; renderList(); }, 120);
  });

  // ------------------------------------------------------------------ detail view
  const listView = document.getElementById('listView'), detailView = document.getElementById('detailView');

  function openDetail(id, fly) {
    const r = byId[id]; if (!r) return;
    if (!state.on.has(r.p.group)) { state.on.add(r.p.group); refresh(); }  // show its layer
    state.selected = id;
    const p = r.p, it = I18N.item(id);
    document.getElementById('dIcon').outerHTML = ICONS.badgeHTML(p.family, p.category, r.isLine ? 'line' : '').replace('class="badge', 'id="dIcon" class="badge');
    document.getElementById('dName').textContent = it.name;
    document.getElementById('dKind').textContent = kindLabel(p);
    const d = document.getElementById('dDesc');
    d.textContent = it.description || t('detail.noDescription');
    d.classList.toggle('empty', !it.description);
    renderLiveRow(r);
    const facts = [];
    if (p.area) facts.push([t('detail.area'), p.area]);
    if (r.isLine && p.length) {
      facts.push([t('detail.length'), p.length >= 1000
        ? t('units.km', { n: (p.length / 1000).toLocaleString(I18N.lang, { maximumFractionDigits: 1 }) })
        : t('units.m', { n: Math.round(p.length / 10) * 10 })]);
    }
    if (p.seasons && p.seasons.length) facts.push([t('detail.season'), p.seasons.map((s) => t(`season.${s}`)).join(', ')]);
    document.getElementById('dFacts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    listView.hidden = true; detailView.hidden = false; detailView.scrollTop = 0;
    highlight(id);
    setSheet('half');          // phones: open part way; slide up for the rest
    if (fly) zoomTo(r);
    const u = new URL(location.href); u.searchParams.set('id', id); history.replaceState(null, '', u);
  }

  function closeDetail() {
    state.selected = null; highlight(null);
    detailView.hidden = true; listView.hidden = false;
    const u = new URL(location.href); u.searchParams.delete('id'); history.replaceState(null, '', u);
    renderList();
  }
  document.getElementById('back').addEventListener('click', closeDetail);
  document.getElementById('dZoom').addEventListener('click', () => state.selected && zoomTo(byId[state.selected]));

  // The map's own padding (phones: the sheet). A flight's padding option replaces it, so flights
  // pass this one and the place lands in the middle of the map left above the sheet.
  let mapPad = { top: 0, bottom: 0, left: 0, right: 0 };
  function zoomTo(r) {
    const padding = panelPadding();
    if (r.isLine) {
      // fitBounds frames tilted 3D views badly, so take a flat camera for the line's box,
      // then fly to its centre keeping the tilt (and step back a little for the tilt).
      const cam = map.cameraForBounds([[r.p.bbox[0], r.p.bbox[1]], [r.p.bbox[2], r.p.bbox[3]]],
        { padding, bearing: map.getBearing() }) || {};
      const c = [(r.p.bbox[0] + r.p.bbox[2]) / 2, (r.p.bbox[1] + r.p.bbox[3]) / 2];
      map.flyTo({ center: c, zoom: Math.min(15.5, (cam.zoom || 14) - (map.getPitch() > 20 ? 0.4 : 0)), padding: mapPad, duration: 1200 });
    }
    else map.flyTo({ center: r.p.point, zoom: Math.max(map.getZoom(), 16), padding: mapPad, duration: 1200 });
  }
  // The camera already keeps clear of the sheet (map padding), so this is only a margin.
  function panelPadding() {
    return isPhone ? { top: 70, bottom: 30, left: 30, right: 30 } : { top: 80, bottom: 80, left: 90, right: 80 };
  }

  function highlight(id) {
    if (!map.getLayer('trail-selected')) return;
    const r = id && byId[id];
    map.setFilter('trail-selected', ['==', ['get', 'id'], r && r.isLine ? id : '']);
    map.getSource('selected-point').setData(r && !r.isLine
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: r.p.point } }] }
      : emptyFC());
  }

  // ------------------------------------------------------------------ map events
  function bindMapEvents() {
    const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, maxWidth: '260px' });
    const interactive = ['poi-icons', 'poi-dots', 'pistes', 'nordic', 'routes', 'mtb', 'lifts', 'closed-lines', 'trail-labels'];
    let hovered = null;

    map.on('mousemove', (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: interactive.filter((l) => map.getLayer(l)) })[0];
      if (hovered !== null && (!f || f.properties.id !== hovered)) {
        map.setFeatureState({ source: 'trails', id: hovered }, { hover: false });
        hovered = null;
      }
      if (!f) { hoverPopup.remove(); map.getCanvas().style.cursor = ''; return; }
      map.getCanvas().style.cursor = 'pointer';
      const p = f.properties;
      if (f.source === 'trails') { hovered = p.id; map.setFeatureState({ source: 'trails', id: p.id }, { hover: true }); }
      const r = byId[p.id];
      if (r) hoverPopup.setLngLat(e.lngLat).setHTML(`<b>${esc(r.p.name)}</b><span>${esc(kindLabel(r.p))}</span>`).addTo(map);
    });
    map.getCanvas().addEventListener('mouseleave', () => hoverPopup.remove());

    map.on('click', (e) => {
      const pad = isPhone ? 14 : 6;   // fingers are less precise than a mouse
      const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
      const f = map.queryRenderedFeatures(box, { layers: interactive.filter((l) => map.getLayer(l)) })[0];
      if (f) { hoverPopup.remove(); openDetail(f.properties.id, false); }
      else if (isPhone && sheetMode !== 'peek') setSheet('peek');   // tap on empty map: back to the map
    });

    let moveTimer;
    map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => { if (!state.query && !state.selected) renderList(); }, 150); });
    map.on('rotate', () => { document.getElementById('northIcon').style.transform = `rotate(${-map.getBearing()}deg)`; });
    document.getElementById('northIcon').style.transform = `rotate(${-map.getBearing()}deg)`;
  }

  // ------------------------------------------------------------------ header controls
  const seasonSeg = document.getElementById('seasonSeg');
  function renderSeason() {
    seasonSeg.setAttribute('aria-label', t('season.label'));
    seasonSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.season === state.season)));
  }
  seasonSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-season]'); if (!b || b.dataset.season === state.season) return;
    state.season = b.dataset.season;
    const u = new URL(location.href); u.searchParams.set('season', state.season); history.replaceState(null, '', u);
    if (state.selected && !inSeason(byId[state.selected])) closeDetail();
    state.on = new Set(DEFAULT_ON[state.season]);
    renderSeason(); refresh();
  });

  const langSel = document.getElementById('langSelect');
  langSel.innerHTML = I18N.languages.map((l) => `<option value="${l.code}">${esc(l.label)}</option>`).join('');
  langSel.value = I18N.lang;
  langSel.closest('.lang').classList.toggle('single', I18N.languages.length < 2);
  langSel.addEventListener('change', () => {
    const u = new URL(location.href); u.searchParams.set('lang', langSel.value); location.href = u.toString();
  });

  // 2D/3D. To 2D: tilt down with the terrain still on, then flatten it (from straight above this
  // hardly shows). To 3D: bring the terrain back while still looking straight down, wait for its
  // tiles, then tilt back to the last 3D tilt, so the camera rises with the ground and does not pop.
  let toggleId = 0, pitch3d = 60;
  document.getElementById('btn3d').addEventListener('click', () => {
    const on = !state.terrain, id = ++toggleId;
    showTerrainState(on);
    if (!on) {
      if (map.getPitch() >= 20) pitch3d = map.getPitch();
      const flatten = () => { if (id === toggleId) map.setTerrain(null); };
      map.easeTo({ pitch: 0, duration: 700 });
      if (map.isEasing()) map.once('moveend', flatten); else flatten();
      return;
    }
    map._elevationFreeze = false;   // the centre height follows the terrain tiles as they arrive
    if (!map.getTerrain()) setTerrain(true);
    whenTerrainLoaded(() => { if (id === toggleId) map.easeTo({ pitch: pitch3d, duration: 700 }); });
  });
  document.getElementById('btnNorth').addEventListener('click', () => map.easeTo({ bearing: 0, duration: 600 }));
  const legend = document.getElementById('legend');
  const btnLegend = document.getElementById('btnLegend');
  const showLegend = (on) => { legend.hidden = !on; btnLegend.setAttribute('aria-pressed', String(on)); };
  btnLegend.addEventListener('click', () => showLegend(legend.hidden));
  // Touching anything outside the legend (map, sheet, other buttons) closes it.
  document.addEventListener('pointerdown', (e) => {
    if (!legend.hidden && !legend.contains(e.target) && !btnLegend.contains(e.target)) showLegend(false);
  }, true);

  // Map style switch inside the legend: snowy winter look or regular natural colours.
  const lookSeg = document.getElementById('lookSeg');
  const renderLook = () => lookSeg.querySelectorAll('button')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.look === state.look)));
  lookSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-look]'); if (!b || b.dataset.look === state.look) return;
    state.look = b.dataset.look;
    try { localStorage.setItem(LOOK_KEY, state.look); } catch (err) { /* fine */ }
    renderLook();
    BASEMAP.applySeason(map, state.look === 'regular' ? 'summer' : 'winter');
  });
  renderLook();

  const toastEl = document.getElementById('toast');
  function toast(msg) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { toastEl.hidden = true; }, 3500);
  }
  // "Where am I": first tap finds you and keeps the map on you as you move;
  // moving the map by hand stops following; tapping again stops the location.
  const locBtn = document.getElementById('btnLocate');
  let meMarker = null, watchId = null, following = false, firstFix = false;
  const inBounds = (ll) => ll[0] >= BOUNDS[0][0] && ll[0] <= BOUNDS[1][0] && ll[1] >= BOUNDS[0][1] && ll[1] <= BOUNDS[1][1];
  function stopLocating() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null; following = false;
    if (meMarker) { meMarker.remove(); meMarker = null; }
    locBtn.classList.remove('following'); locBtn.setAttribute('aria-pressed', 'false');
  }
  locBtn.addEventListener('click', () => {
    if (!navigator.geolocation) return toast(t('map.locateFailed'));
    if (watchId !== null && following) return stopLocating();
    if (watchId !== null) {                    // located but not following: re-centre and follow
      following = true; locBtn.classList.add('following');
      if (meMarker) map.easeTo({ center: meMarker.getLngLat(), duration: 600 });
      return;
    }
    following = true; firstFix = true;
    locBtn.classList.add('following'); locBtn.setAttribute('aria-pressed', 'true');
    watchId = navigator.geolocation.watchPosition((pos) => {
      const ll = [pos.coords.longitude, pos.coords.latitude];
      if (!inBounds(ll)) { toast(t('map.outside')); return stopLocating(); }
      if (!meMarker) {
        const el = document.createElement('div'); el.className = 'me';
        meMarker = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map);
      } else meMarker.setLngLat(ll);
      if (firstFix) { firstFix = false; map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 15), duration: 1200 }); }
      else if (following) map.easeTo({ center: ll, duration: 800 });
    }, () => { toast(t('map.locateFailed')); stopLocating(); },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  });
  map.on('dragstart', () => { if (following && watchId !== null) { following = false; locBtn.classList.remove('following'); } });

  // ------------------------------------------------------------------ phone bottom sheet
  // Three heights: 'peek' (handle + search, the map almost full screen), 'half' (opened by a
  // tap on something), 'full' (slid up). The sheet follows the finger and snaps to the nearest.
  const panel = document.getElementById('panel');
  const grab = document.getElementById('grab');
  let sheetMode = 'peek', searchH = 46;
  function sheetHeights() {
    const vh = window.innerHeight;
    searchH = document.querySelector('.search').offsetHeight || searchH;   // measured while visible
    const peek = grab.offsetHeight + searchH + 10;
    return { peek, half: Math.round(vh * 0.45), full: Math.round(vh * 0.9) };
  }
  function applySheetHeight(h) {
    panel.style.setProperty('--sheet-h', `${h}px`);
    document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  }
  /** Keep the map's centre (and fitBounds) above the sheet. The map glides with the sheet (0.25 s,
   *  as its CSS) instead of jumping. While the map moves (a flight, a finger) it waits for the end:
   *  changing the padding would stop the move half way. */
  let padWaiting = false;
  function padMap(h, glide) {
    mapPad = { top: 0, left: 0, right: 0, bottom: Math.min(h, sheetHeights().half) };
    const apply = () => {
      const p = map.getPadding();
      if (p.top === 0 && p.left === 0 && p.right === 0 && p.bottom === mapPad.bottom) return;
      if (map.isMoving()) {
        if (!padWaiting) { padWaiting = true; map.once('moveend', () => { padWaiting = false; apply(); }); }
        return;
      }
      if (glide) map.easeTo({ padding: mapPad, duration: 250 });
      else map.setPadding(mapPad);
    };
    apply();
  }
  function setSheet(mode, glide = true) {
    if (!isPhone) return;
    sheetMode = mode;
    const h = sheetHeights()[mode];
    panel.classList.remove('peek', 'half', 'full'); panel.classList.add(mode);
    applySheetHeight(h);
    padMap(h, glide);
    const active = document.activeElement;
    if (mode !== 'full' && active && active.id === 'search') active.blur();   // close the keyboard
  }
  if (isPhone) {
    // Phones: the legend button sits at the bottom, in the search row.
    document.getElementById('searchRow').appendChild(document.getElementById('btnLegend'));
    setSheet('peek', false);
    window.addEventListener('resize', () => setSheet(sheetMode, false));
    document.getElementById('search').addEventListener('focus', () => setSheet('full'));
    (function sheetDrag() {
      let y0 = null, h0 = 0, t0 = 0, moved = false;
      grab.addEventListener('pointerdown', (e) => {
        y0 = e.clientY; h0 = panel.getBoundingClientRect().height; t0 = performance.now(); moved = false;
        grab.setPointerCapture(e.pointerId); panel.classList.add('dragging');
      });
      grab.addEventListener('pointermove', (e) => {
        if (y0 === null) return;
        const dy = e.clientY - y0;
        if (Math.abs(dy) > 4) moved = true;
        const hs = sheetHeights();
        applySheetHeight(Math.max(hs.peek, Math.min(hs.full, h0 - dy)));
      });
      const end = (e) => {
        if (y0 === null) return;
        panel.classList.remove('dragging');
        const dy = e.clientY - y0, dt = Math.max(1, performance.now() - t0);
        y0 = null;
        const hs = sheetHeights(), order = ['peek', 'half', 'full'];
        if (!moved) {           // a tap on the handle: open one step, or close from full
          return setSheet(sheetMode === 'full' ? 'peek' : order[order.indexOf(sheetMode) + 1]);
        }
        const v = dy / dt;      // px per ms; a quick flick moves one step in its direction
        if (Math.abs(v) > 0.5) {
          const i = order.indexOf(sheetMode) + (v < 0 ? 1 : -1);
          return setSheet(order[Math.max(0, Math.min(2, i))]);
        }
        const h = h0 - dy;      // otherwise snap to the nearest height
        setSheet(order.reduce((a, b) => (Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a)));
      };
      grab.addEventListener('pointerup', end);
      grab.addEventListener('pointercancel', end);
    })();
  }

  // ------------------------------------------------------------------ start
  I18N.apply();
  renderSeason();
  renderChips();

  // Browser cache (sw.js). Off on localhost so edits show at once; add ?sw=1 to test it locally.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if ('serviceWorker' in navigator && (!local || qs.has('sw'))) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // Ask the browser not to clear the cached tiles when space runs low (it may say no).
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    saveAreaForOffline();
  }

  /** Once the map has loaded, ask sw.js to download the whole area (terrain + base map) so the
   *  map works without signal on the slopes. Done once; resumes on the next visit if cut. */
  function saveAreaForOffline() {
    const FLAG = 'morzine-area-saved-v1';
    let saved = false;
    try { saved = localStorage.getItem(FLAG) === '1'; } catch (e) { /* private mode */ }
    if (saved) return;
    const pill = document.getElementById('offline');
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type !== 'save-area' || !m.total) return;
      if (!m.final) {
        pill.textContent = t('offline.saving', { pct: Math.floor(100 * m.done / m.total) });
        pill.hidden = false;
        return;
      }
      pill.hidden = true;
      if (!m.failed) {
        try { localStorage.setItem(FLAG, '1'); } catch (err) { /* fine */ }
        toast(t('offline.done'));
      }
    });
    const ask = () => navigator.serviceWorker.ready.then((reg) => reg.active && reg.active.postMessage({ type: 'save-area' }));
    if (map.loaded()) map.once('idle', ask); else map.once('idle', ask);
  }
})();
