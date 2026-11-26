/*
 * Icons and colours.
 *
 * Colours come from the original site's category data (data/categories.json).
 * Glyphs, in order of preference:
 *   1. the original site's own icons (assets/icons/*.svg, from its sprite)
 *   2. the Material Symbols name the site's data gives for the category
 *   3. a Material Symbols fallback per family
 * Map marker images are drawn on a canvas the first time the map asks for them.
 */
const ICONS = (() => {
  const FONT = 'Material Symbols Rounded';
  const FALLBACK_COLOR = '#60666C';

  // Single-colour icons from the site's sprite, by category, then by family.
  const SITE_BY_CATEGORY = {
    ski_novice: 'alpine-skiing', ski_easy: 'alpine-skiing', ski_intermediate: 'alpine-skiing',
    ski_advanced: 'alpine-skiing', ski: 'alpine-skiing', alpin_skiing: 'alpine-skiing',
    chairlift: 'chairlift', surface_lift: 'chairlift', cord_lift: 'chairlift', carpet_ski_lift: 'chairlift',
    gondola_lift: 'gondola-lift', cable_car: 'cable-lift',
    nordic_ski_novice: 'nordic-skiing', nordic_ski_easy: 'nordic-skiing', nordic_ski_intermediate: 'nordic-skiing',
    nordic_ski_advanced: 'nordic-skiing', cross_country_skiing: 'nordic-skiing',
    snowshoeing: 'snowshoeing', Hiking: 'hiking', Walk: 'hiking',
    downhill_mtb: 'mountain-bike', mountain_bike: 'mountain-bike',
    toilets: 'toilet', Hotel: 'accommodation', holiday_resort: 'accommodation', tourism_residence: 'accommodation',
    collective_accommodation: 'accommodation', Accommodation: 'accommodation'
  };
  const SITE_BY_FAMILY = {
    ski_trail: 'alpine-skiing', ski_lift: 'chairlift', mtb_lift: 'chairlift', nordic_ski_trail: 'nordic-skiing',
    activity_routes: 'hiking', mtb_trail: 'mountain-bike', accommodations: 'accommodation', stops: 'directions-bus'
  };
  // Material Symbols where the site's data names something that is not a Material glyph.
  const MATERIAL_ALIAS = {
    bar: 'local_bar', store: 'storefront', parking: 'local_parking', taxi: 'local_taxi', publictransport: 'directions_bus',
    hook: 'phishing', lake: 'water', climbing: 'landscape', legacy: 'account_balance', craft: 'handyman', hammer: 'handyman',
    honey: 'emoji_nature', farm: 'agriculture', tooth: 'dentistry', doctor: 'stethoscope', health: 'medical_services',
    hospital: 'local_hospital', pharmacy: 'local_pharmacy', police: 'local_police', post_office: 'local_post_office',
    lease: 'real_estate_agent', protect: 'shield', classroom: 'school', city_hall: 'account_balance', people: 'groups',
    tourism_office: 'info', usefull: 'info', bank: 'account_balance', food: 'restaurant', cabin: 'cabin',
    'bed-bunk': 'bed', theaters: 'theaters', scissors: 'content_cut', bright_mind: 'lock', bocce_filled: 'sports',
    paintball: 'sports_esports', aircraft: 'flight', helicopter: 'helicopter', horse_riding: 'bedroom_baby',
    snowmobile: 'snowmobile', snowboarding: 'snowboarding', recreational_activities: 'attractions',
    natural_reserve: 'forest', baby: 'child_care', biathlon: 'sports', stadium: 'stadium', sailing: 'sailing',
    rafting: 'kayaking', directions_run: 'directions_run', directions_walk: 'directions_walk'
  };
  const FAMILY_MATERIAL = {
    activities: 'local_activity', shops_and_services: 'storefront', restaurants: 'restaurant', bars: 'local_bar',
    mountain_restaurants: 'restaurant', pinned: 'push_pin', rental_accommodation: 'cottage', producers: 'agriculture', trail_running: 'directions_run', _default: 'location_on'
  };
  const FAMILY_COLOR = { nordic_ski_trail: '#1B65D4', trail_running: '#FAB333', stops: '#006FD6', pinned: '#B45309' };

  // Colour icons from the site's sprite, used on the layer chips (as on the original tabs).
  const CHIP_ICON = {
    pistes: 'ski-colored', nordic: 'nordic-skiing-colored', routes: 'figmoji-walking', mtb: 'figmoji-cycling',
    running: 'figmoji-running', activities: 'activity', restaurants: 'restaurant', mountain_restaurants: 'restaurant', bars: 'bar',
    accommodations: 'accommodation-colored', rental_accommodation: 'accommodation-colored',
    shops_and_services: 'shops-and-services', producers: 'terroir', stops: 'bus-colored', lifts: 'gondola-lift'
  };

  const LIFT_CATS = new Set(['chairlift', 'gondola_lift', 'cable_car', 'surface_lift', 'carpet_ski_lift',
    'cord_lift', 'funicular', 'drag_lift']);

  let meta = { categories: {}, families: {} };
  let siteIndex = {};
  const siteImg = {};       // name -> HTMLImageElement (white version)
  const okCache = {};

  /** True when Material Symbols has a ligature for this name (drawn as a single 1em glyph). */
  function materialExists(name) {
    if (!name || /[^a-z0-9_]/.test(name)) return false;
    if (okCache[name] !== undefined) return okCache[name];
    const c = document.createElement('canvas').getContext('2d');
    c.font = `40px "${FONT}"`;
    return (okCache[name] = c.measureText(name).width < 56);
  }

  function siteIconFor(family, category) {
    const n = SITE_BY_CATEGORY[category] || (category ? null : null) || SITE_BY_FAMILY[family];
    return n && siteIndex[n] && siteIndex[n].mono ? n : null;
  }

  // Pinned places: their own emoji and colour, set by app.js (setPinned).
  const custom = {};
  const setCustom = (id, v) => { custom[id] = v; };

  /** {glyph, kind: 'site'|'material'|'emoji', color} for a family/category. */
  function look(family, category) {
    if (custom[category]) return { glyph: custom[category].emoji, kind: 'emoji', color: custom[category].color };
    const cat = meta.categories[category] || {};
    const fam = meta.families[family] || {};
    const color = cat.color && cat.color !== '#000000' && !/^ski_|^nordic_ski_/.test(category || '')
      ? cat.color
      : (/^(ski|nordic_ski)_(novice|easy|intermediate|advanced)$/.test(category || '') ? (cat.color || FALLBACK_COLOR)
        : fam.color || FAMILY_COLOR[family] || cat.color || FALLBACK_COLOR);
    const byCat = SITE_BY_CATEGORY[category];
    if (byCat && siteIndex[byCat] && siteIndex[byCat].mono) return { glyph: byCat, kind: 'site', color };
    for (const n of [cat.icon, MATERIAL_ALIAS[cat.icon]]) {
      if (typeof n === 'string' && materialExists(n)) return { glyph: n, kind: 'material', color };
      const a = MATERIAL_ALIAS[n];
      if (a && materialExists(a)) return { glyph: a, kind: 'material', color };
    }
    const byFam = siteIconFor(family, null);
    if (byFam) return { glyph: byFam, kind: 'site', color };
    const fm = FAMILY_MATERIAL[family] || FAMILY_MATERIAL._default;
    return { glyph: fm, kind: 'material', color };
  }

  /** Key used as the map image id. */
  const key = (l) => `${l.kind}:${l.glyph}|${l.color}`;

  /** HTML badge (disc + white glyph) for lists and the detail view. */
  function badgeHTML(family, category, extraClass = '') {
    const l = look(family, category);
    const glyph = l.kind === 'site'
      ? `<img src="assets/icons/${l.glyph}.svg" alt="" class="si">`
      : l.kind === 'emoji' ? `<span class="em">${l.glyph}</span>` : `<span class="ms">${l.glyph}</span>`;
    return `<span class="badge ${extraClass}" style="--c:${l.color}">${glyph}</span>`;
  }

  /** Icon for a layer chip: the site's colour icon when it has one. */
  function chipHTML(group, family) {
    const n = CHIP_ICON[group];
    if (n && siteIndex[n]) {
      return siteIndex[n].mono
        ? `<span class="dot" style="--c:#60666C"><img src="assets/icons/${n}.svg" alt="" class="si"></span>`
        : `<span class="dot plain"><img src="assets/icons/${n}.svg" alt=""></span>`;
    }
    const l = look(family || group, null);
    return `<span class="dot" style="--c:${l.color}">${l.kind === 'site' ? `<img src="assets/icons/${l.glyph}.svg" alt="" class="si">` : `<span class="ms">${l.glyph}</span>`}</span>`;
  }

  /** Marker image: white ring, coloured disc, white glyph. */
  function makeImage(id, ratio) {
    const [kg, color] = id.split('|');
    const [kind, glyph] = kg.split(':');
    const size = 30, px = Math.round(size * ratio);
    const cv = document.createElement('canvas'); cv.width = cv.height = px;
    const ctx = cv.getContext('2d'); ctx.scale(ratio, ratio);
    const c = size / 2;
    ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(c, c, c - 2, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(c, c, c - 4, 0, Math.PI * 2); ctx.fill();
    if (kind === 'site' && siteImg[glyph]) {
      const s = 16; ctx.drawImage(siteImg[glyph], c - s / 2, c - s / 2, s, s);
    } else if (kind === 'emoji') {
      ctx.font = '15px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(glyph, c, c + 1);
    } else {
      ctx.fillStyle = '#fff'; ctx.font = `17px "${FONT}"`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(glyph, c, c + 0.5);
    }
    return { width: px, height: px, data: ctx.getImageData(0, 0, px, px).data };
  }

  /** Load the icon index, white copies of the site icons the map uses, and the icon font. */
  async function init(m) {
    meta = m || meta;
    siteIndex = await fetch('assets/icons/index.json').then((r) => r.json());
    const names = new Set(Object.values(SITE_BY_CATEGORY).concat(Object.values(SITE_BY_FAMILY)));
    await Promise.all([...names].filter((n) => siteIndex[n] && siteIndex[n].mono).map(async (n) => {
      const svg = (await fetch(`assets/icons/${n}.svg`).then((r) => r.text())).replace(/currentColor/g, '#ffffff');
      const img = new Image(64, 64);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', '<svg width="64" height="64" '));
      await img.decode().catch(() => {});
      siteImg[n] = img;
    }));
    await document.fonts.load(`24px "${FONT}"`, 'downhill_skiing').catch(() => {});
  }

  return { init, look, key, badgeHTML, chipHTML, makeImage, setCustom, LIFT_CATS };
})();
