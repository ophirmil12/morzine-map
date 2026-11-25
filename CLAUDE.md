# Morzine ski map: rules for developers

This file is for everyone who changes this repository, people and coding agents alike.
README.md explains how to run, update and publish the map. This file explains what must stay true.
Read it before you change anything in `site/`.

## What the map is for

- A 3D map of the ski runs and lifts of Morzine, Les Gets and Avoriaz, for the Morzine tourist office.
- Mainly for skiers on phones, on the mountain with weak signal and a cold battery.
- The map and the lifts come first. Every other feature must stay small and must not slow it down.

## Performance rules

The page must stay light on CPU, GPU, RAM, battery and mobile data. Before adding anything, ask
whether it costs work on every frame, every move or every minute. If it does, find a cheaper way.

**Network and data**
- First visit, usually on Wi-Fi: it may download a lot, because everything is then cached.
- Later visits must come from the cache: app files, tiles, fonts and libraries.
- No polling faster than what exists today:
  - live lift status: once on load, then every 5 minutes, only while the page is visible
  - location sharing: one request every 3 minutes, which both sends and receives, only while visible
  - mountain weather (`site/js/weather.js`): one request every 30 minutes, only while visible
- Never send requests for areas outside the map. Tile sources with limited coverage need `bounds`
  (see `DEM_BOUNDS` in `site/js/app.js` and the contours source in `site/js/basemap.js`).
- No analytics, trackers, ads or third-party widgets.
- Load no new libraries without a strong reason. Pin exact versions.

**Rendering, CPU and RAM**
- **Terrain:** one set of zoom 13 elevation tiles feeds both the 3D terrain and the hillshade.
  Do not raise it to zoom 14: that loads 30-40% more tiles, and zoom 14 hillshade shows stripes.
  Zoom 14 is only for desktop contour lines.
- **Phones:**
  - pixel ratio capped at 2 and no antialiasing
  - no contour lines
  - no hover effects
- **Work per frame or move:**
  - no heavy code in `move`/`render` handlers, which run on every frame
  - throttle with `requestAnimationFrame`
  - do not rebuild DOM lists on every move
- **GeoJSON:** do not call `setData` unless something visible changed (see `render()` in `site/js/share.js`).
- **Tilt and tiles:** keep the maximum tilt and the number of tiles in view in mind. High tilt loads
  about 3 times more tiles. MapLibre's "fewer far tiles" setting (`setSourceTileLodParams`) was tested and made nearby slopes blurry,
  so it is not used.
- **Timers:** use as few as possible. Nothing should run while the page is hidden.

**Battery**
- GPS only when needed: one position every 3 minutes for sharing, or the "my position" button.
- No continuous `watchPosition` unless the user turns on following.

**How to check a change**
- Test at 390x844 (phone) and 1440x900, with no console errors.
- Compare the number of tiles loaded at tilt 50 and 75 before and after the change.
- The tools in the README (Playwright with headless Edge) work for this.

## Caching and the service worker (`site/sw.js`)

- **Bump `VERSION`** in `site/sw.js` whenever any app file changes, or phones keep the old one.
- **New app files** go into the precache list there.
- **Every page visit is answered with the cached map.** A new standalone page must be excluded,
  like `terms/`, or it will show the map instead.
- **The terms page (`site/terms/`) is never cached.** It is not linked from the map and not indexed.
- **The service worker only runs off localhost**, or locally with `?sw=1`.

## Camera

- **The camera must never go inside the terrain.** `keepCameraAboveGround()` in `site/js/app.js`
  guards this through `map.transformCameraUpdate`.
- **Never call `jumpTo`/`easeTo` inside a `move` handler.** It stops running animations and gestures.
- **MapLibre is pinned to 5.6.0.** The camera guard uses two private MapLibre fields. Re-test the
  camera (2D/3D switch, flights, pinch at high tilt) before any upgrade.

## Layout and behaviour the office asked for

- The map opens on Morzine village. Default layers: Ski runs, Lifts, Mountain restaurants, House.
- The House layer is one hand-added place (`data_src/custom_places.json`), drawn as an icon at every zoom.
- Phones:
  - The bottom panel can shrink to almost nothing.
  - The search box, share button and legend button sit in one row at the bottom.
- The legend closes when the user touches anything else. It has no nordic or snowshoe rows.
- There is no "i" credits button on the map and no credits line in the legend (the owner's choice,
  to save space). The full credits are on the terms page (`site/terms/`). Note: the OpenStreetMap
  licence asks for its credit to be reachable from the map. This was raised and the owner decided.
- **Hidden settings:** 5 taps on the Morzine logo open a box with two switches. Both turn off at
  midnight, French time:
  - "ignore live lift status"
  - "location sharing after hours"
- **Mountain weather:** a small chip in the top-right corner with an icon, the temperature and ⛰️.
  It shows the top of the slopes (Avoriaz, 1,800 m): Météo-France forecasts through Open-Meteo.
- **Lifts:** grey direction arrows and grey name labels along the lines.
- **Home screen:** `site/manifest.webmanifest` (Android) and the apple-* tags in `index.html`
  (iPhone), named "Morzine Map", skier icon on the logo navy. `tools/make_app_icons.py` redraws the icons.
- **Live status colours:** closed lines are grey and dashed. The update time is green under 10
  minutes, yellow under 30, red when older. If the status cannot be loaded, the map works as before.

## Location sharing (`site/js/share.js`, `server/live-location/`)

- **On by default after a one-time notice.** It can be switched off in the legend or with the button.
- **Hours:** it works from 6:00 to 20:00, French time. After hours it works only with the hidden switch.
- **Offline people:** someone whose last position is older than 7 minutes is drawn in light purple,
  labelled like "10 min" or "1 hour".
- **Emergency record:** every position for 2 hours, one per 20 minutes for 2 days, then deleted.
  Nobody sees it in the app. `server/live-location/EMERGENCY.md` explains how to look someone up.
- **Server:** a Cloudflare Worker with a D1 database, on the free plan. Keep the request rate low
  enough to stay inside it.
- **Updating the Worker:** paste `worker.js` in the Cloudflare dashboard. The D1 console needs
  one-line SQL without comments.

## Data

- **Source:** the tourist office's site, used with their permission. Prefer their colours, icons
  and texts over our own.
- **Updates:** `tools/fetch_site_data.py` rebuilds `site/data/` from cached responses.
- **Never execute the original site's JavaScript.** `tools/nuxt_parse.py` reads it as text.
- **Our own corrections live in `data_src/`** and are applied by the fetch script. Do not hand-edit `site/data/`.
  - `mountain_food.json`: the Mountain restaurants group
  - `ski_descriptions_en.json`: piste and lift texts
  - `ski_fixes_2027.json`: lift and piste changes for winter 2026-27
  - `custom_places.json`: places not in the office data (the House), each family its own layer
  - `lift_bottoms.json`: bottom station of each lift (made by `tools/lift_bottoms.py` from the
    elevation data). Lift lines are turned to run bottom to top, so the direction arrows point up.
    Nearly flat carpets and rope tows are marked `flat` and get no arrows.
- **Winter only for now.** English only for now. French texts are kept in `cold_storage/`.

## Text

- **Every visible text goes through i18n:** `site/i18n/en.json`, and `data/content/en.json` for
  names and descriptions. The map will be translated later.
- **Style:** short, plain sentences, written for skiers.
  - no em or en dashes
  - no semicolons
  - no sentence fragments

## Publishing

- **A push to `main` publishes `site/`** through GitHub Actions: two jobs, build then deploy.
- **After every push, check the deploy:**
  - the run in the Actions tab succeeded
  - the live site serves the new `sw.js` `VERSION`
