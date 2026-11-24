/* Base map helper for the Morzine map. Plain script, defines window.BASEMAP.
 *
 *   BASEMAP.styleUrl                        'style/base.json' (relative to index.html)
 *   BASEMAP.applySeason(map, 'winter'|'summer')   recolour the base map
 *   BASEMAP.addContours(map, demUrl, opts)  contour lines + "1500 m" labels (needs maplibre-contour)
 *   BASEMAP.localise(map, 'fr'|'en'|...)    label language for the base map
 *
 * Layer ids you can insert your own layers before (they are invisible placeholders):
 *   'hillshade-slot'       hillshade (above ground cover, below water and roads)
 *   'contours-slot'        contour lines (used by addContours)
 *   'contour-labels-slot'  contour labels (used by addContours)
 *   'overlays-slot'        piste/lift lines and trail labels (place names and peaks stay on top)
 */
(function () {
  'use strict';

  // ======================================================================
  // COLOURS. Edit freely. Each entry is  layer id -> { paint property: value }.
  // Colours are CSS colours: '#rrggbb' or 'rgba(r,g,b,alpha)'.
  // Layers that are not on the map yet are skipped, so 'hillshade' and the
  // contour layers are recoloured only once they exist.
  // ======================================================================
  const PALETTES = {
    winter: {
      // ground: snow with a faint blue tint
      'background':          { 'background-color': '#f3f6f9' },
      'landcover-grass':     { 'fill-color': '#f5f8fa' },        // meadows / pistes: snow
      'landcover-wood':      { 'fill-color': '#d6e0e1' },        // forest: cool grey-green white
      'landcover-rock':      { 'fill-color': '#eaeef2' },
      'landcover-ice':       { 'fill-color': '#f8fbfd' },
      'landcover-wetland':   { 'fill-color': '#e6eef1' },
      'landuse-residential': { 'fill-color': '#e9edf2' },
      'landuse-other':       { 'fill-color': '#e6eaef' },
      'landuse-pitch':       { 'fill-color': '#eaf0f3' },
      // water
      'water':               { 'fill-color': '#bcd7ea' },
      'waterway-river':      { 'line-color': '#a9cbe3' },
      'waterway-stream':     { 'line-color': '#a9cbe3' },
      // built
      'building':            { 'fill-color': '#dde3ea', 'fill-outline-color': '#c9d1da' },
      'road-path':           { 'line-color': '#b4bfca' },
      'road-minor-casing':   { 'line-color': '#c6cfd9' },
      'road-major-casing':   { 'line-color': '#b9c3ce' },
      'road-minor':          { 'line-color': '#ffffff' },
      'road-major':          { 'line-color': '#ffffff' },
      'boundary-country':    { 'line-color': '#a5adc0' },
      // labels
      'road-label':          { 'text-color': '#7f8994', 'text-halo-color': '#ffffff' },
      'waterway-label':      { 'text-color': '#5a8db5', 'text-halo-color': '#ffffff' },
      'water-label':         { 'text-color': '#4f84ae', 'text-halo-color': '#ffffff' },
      'place-hamlet':        { 'text-color': '#4b5563', 'text-halo-color': 'rgba(255,255,255,0.9)' },
      'peak':                { 'text-color': '#6b7480', 'text-halo-color': 'rgba(255,255,255,0.9)' },
      'place-village':       { 'text-color': '#1d2b4f', 'text-halo-color': 'rgba(255,255,255,0.95)' },
      'place-town':          { 'text-color': '#1d2b4f', 'text-halo-color': 'rgba(255,255,255,0.95)' },
      // relief (layers added by the app / by addContours)
      'hillshade': {
        'hillshade-shadow-color': '#4f6684',      // blue-grey shadows
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#8193ab',
        'hillshade-exaggeration': 0.55
      },
      'contour-lines':  { 'line-color': '#8296ae' },
      'contour-labels': { 'text-color': '#7a8ba1', 'text-halo-color': 'rgba(243,246,249,0.9)' }
    },

    summer: {
      // ground: light green-beige, natural greens
      'background':          { 'background-color': '#eef0e1' },
      'landcover-grass':     { 'fill-color': '#e2ebc9' },        // meadows
      'landcover-wood':      { 'fill-color': '#bcd5a2' },        // forest
      'landcover-rock':      { 'fill-color': '#e4e2da' },
      'landcover-ice':       { 'fill-color': '#f3f7fa' },
      'landcover-wetland':   { 'fill-color': '#d6e5d2' },
      'landuse-residential': { 'fill-color': '#e8e5dc' },
      'landuse-other':       { 'fill-color': '#e3e0d8' },
      'landuse-pitch':       { 'fill-color': '#d6e8c4' },
      'water':               { 'fill-color': '#a9d0ea' },
      'waterway-river':      { 'line-color': '#94c2e2' },
      'waterway-stream':     { 'line-color': '#94c2e2' },
      'building':            { 'fill-color': '#ddd7cd', 'fill-outline-color': '#c9c1b5' },
      'road-path':           { 'line-color': '#a69f8f' },
      'road-minor-casing':   { 'line-color': '#cfc9bd' },
      'road-major-casing':   { 'line-color': '#c2bbad' },
      'road-minor':          { 'line-color': '#ffffff' },
      'road-major':          { 'line-color': '#ffffff' },
      'boundary-country':    { 'line-color': '#a59cb4' },
      'road-label':          { 'text-color': '#7d7a72', 'text-halo-color': '#ffffff' },
      'waterway-label':      { 'text-color': '#4f86b2', 'text-halo-color': '#ffffff' },
      'water-label':         { 'text-color': '#3f7aa8', 'text-halo-color': '#ffffff' },
      'place-hamlet':        { 'text-color': '#4a4f45', 'text-halo-color': 'rgba(255,255,255,0.85)' },
      'peak':                { 'text-color': '#6a675e', 'text-halo-color': 'rgba(255,255,255,0.85)' },
      'place-village':       { 'text-color': '#1d2b4f', 'text-halo-color': 'rgba(255,255,255,0.95)' },
      'place-town':          { 'text-color': '#1d2b4f', 'text-halo-color': 'rgba(255,255,255,0.95)' },
      'hillshade': {
        'hillshade-shadow-color': '#4a5340',      // olive-brown shadows
        'hillshade-highlight-color': '#fffdf2',
        'hillshade-accent-color': '#6f7760',
        'hillshade-exaggeration': 0.5
      },
      'contour-lines':  { 'line-color': '#a08f72' },
      'contour-labels': { 'text-color': '#8c7c60', 'text-halo-color': 'rgba(238,240,225,0.9)' }
    }
  };

  // Contour settings (BASEMAP.addContours).
  const CONTOURS = {
    minor: 100,          // metres between faint lines
    major: 500,          // metres between darker, labelled lines
    majorMinZoom: 12,    // major lines from this zoom (no contours below it)
    minorMinZoom: 13,    // minor lines from this zoom
    labelMinZoom: 13,    // "1500 m" labels from this zoom
    demMaxZoom: 14       // contour tiles are computed from DEM z<=14 only, then overzoomed
  };
  // Cost: maplibre-contour 0.2.0 index.min.js is 32 KB (11 KB gzipped). Contours are computed
  // in a web worker from the same Terrarium PNGs as the terrain (fetched again, cached by the browser).
  // maplibre-contour script, pinned. Add this tag to index.html before basemap.js:
  // <script src="https://unpkg.com/maplibre-contour@0.2.0/dist/index.min.js"></script>

  // ======================================================================

  // The peak layer shows "▲ name (ele)" with the triangle in its own colour,
  // which lives inside the text-field. Keep it in step with the palette.
  const PEAK_TRIANGLE = { winter: '#7b8591', summer: '#8f8a7c' };

  let currentSeason = 'winter';

  function set(map, id, props) {
    if (!map.getLayer(id)) return;
    for (const [k, v] of Object.entries(props)) {
      try { map.setPaintProperty(id, k, v); } catch (e) { console.warn('BASEMAP', id, k, e.message); }
    }
  }

  function applySeason(map, season) {
    currentSeason = season === 'summer' ? 'summer' : 'winter';
    const pal = PALETTES[currentSeason];
    for (const [id, props] of Object.entries(pal)) set(map, id, props);
    recolourPeakTriangle(map);
  }

  function recolourPeakTriangle(map) {
    if (!map.getLayer('peak')) return;
    const tf = map.getLayoutProperty('peak', 'text-field');
    if (!Array.isArray(tf)) return;
    const copy = JSON.parse(JSON.stringify(tf));
    (function walk(e) {
      if (!Array.isArray(e)) return;
      if (e[0] === 'format') {
        for (let i = 1; i < e.length - 1; i++) {
          if (e[i] === '▲' && e[i + 1] && typeof e[i + 1] === 'object') e[i + 1]['text-color'] = PEAK_TRIANGLE[currentSeason];
        }
      }
      e.forEach(walk);
    })(copy);
    map.setLayoutProperty('peak', 'text-field', copy);
  }

  // Replace every ["coalesce",["get","name:xx"],["get","name"]] inside an expression.
  function swapLang(expr, lang) {
    if (!Array.isArray(expr)) return expr;
    if (expr[0] === 'coalesce' && Array.isArray(expr[1]) && expr[1][0] === 'get' &&
        typeof expr[1][1] === 'string' && expr[1][1].startsWith('name:')) {
      const out = expr.slice();
      out[1] = ['get', 'name:' + lang];
      return out;
    }
    return expr.map((e) => swapLang(e, lang));
  }

  function localise(map, lang) {
    if (!lang) return;
    for (const l of map.getStyle().layers) {
      if (l.type !== 'symbol' || !l.source || l.source !== 'openmaptiles') continue;
      const tf = map.getLayoutProperty(l.id, 'text-field');
      if (!tf) continue;
      const next = swapLang(tf, lang);
      if (JSON.stringify(next) !== JSON.stringify(tf)) map.setLayoutProperty(l.id, 'text-field', next);
    }
  }

  let demSource = null;
  function addContours(map, demTilesUrlTemplate, opts) {
    opts = opts || {};
    if (typeof mlcontour === 'undefined') {
      console.warn('BASEMAP.addContours: maplibre-contour is not loaded; skipping contours.');
      return false;
    }
    if (map.getSource('contours')) return true;
    const c = Object.assign({}, CONTOURS, opts);
    if (!demSource) {
      demSource = new mlcontour.DemSource({
        url: demTilesUrlTemplate,
        encoding: opts.encoding || 'terrarium',
        maxzoom: c.demMaxZoom,
        minzoom: c.majorMinZoom,
        worker: true,
        cacheSize: 60
      });
      demSource.setupMaplibre(maplibregl);
    }
    const th = [c.minor, c.major];
    const thresholds = {};
    for (let zz = c.majorMinZoom; zz <= c.demMaxZoom; zz++) {
      // [major, major] = only major lines (they get level 1); [minor, major] = both
      thresholds[zz] = zz >= c.minorMinZoom ? th : [c.major, c.major];
    }
    map.addSource('contours', {
      type: 'vector',
      tiles: [demSource.contourProtocolUrl({
        thresholds,
        contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level'
      })],
      minzoom: c.majorMinZoom,
      maxzoom: c.demMaxZoom
    });
    const pal = PALETTES[currentSeason];
    const before = (id) => (map.getLayer(id) ? id : undefined);
    map.addLayer({
      id: 'contour-lines', type: 'line', source: 'contours', 'source-layer': 'contours',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': pal['contour-lines']['line-color'],
        // level 1 = major (every c.major m), level 0 = minor
        'line-width': ['match', ['get', 'level'], 1, 0.9, 0.5],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, ['match', ['get', 'level'], 1, 0.35, 0.15],
          14, ['match', ['get', 'level'], 1, 0.55, 0.28]]
      }
    }, before('contours-slot'));
    map.addLayer({
      id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours',
      minzoom: c.labelMinZoom,
      filter: ['>', ['get', 'level'], 0],
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': 420, 'text-max-angle': 25,
        'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'],
        'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-padding': 8
      },
      paint: {
        'text-color': pal['contour-labels']['text-color'],
        'text-halo-color': pal['contour-labels']['text-halo-color'],
        'text-halo-width': 1.2
      }
    }, before('contour-labels-slot'));
    return true;
  }

  window.BASEMAP = {
    styleUrl: 'style/base.json',
    palettes: PALETTES,
    contours: CONTOURS,
    applySeason,
    addContours,
    localise,
    get season() { return currentSeason; }
  };
})();
