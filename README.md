# Morzine interactive map

A light, phone-first 3D map of the Les Gets, Morzine and Avoriaz ski area: ski runs, lifts and
useful places. It's a rebuild of the map on explore.morzine.com for the Morzine Tourist Office,
using the office's data. It is a static site with no build step and no server code, published
on GitHub Pages.

## Run it locally

    cd site
    python -m http.server 8000 --bind 127.0.0.1

Open http://127.0.0.1:8000/ . Use the browser's phone view (F12, then the device toolbar):
phones are the main target.

## Folders

| Path | What it is |
|---|---|
| `site/` | The website. Only this folder is published. |
| `site/data/trails.json` | Ski runs, lifts and routes (lines) |
| `site/data/pois.json` | Places (points) |
| `site/data/content/en.json` | English names, descriptions and category labels |
| `site/data/categories.json` | Colour and icon per category (from the original site) |
| `site/i18n/` | Interface text per language, and the language list |
| `site/assets/` | The office logo and the original site's icons |
| `site/sw.js` | Browser cache, so repeat visits load almost nothing |
| `tools/` | Python scripts (standard library only) that rebuild `site/data` and `site/assets` |
| `cold_storage/site_texts/` | The original French texts, and labels in Italian, German and Dutch. Not published. |
| `cache/` | Downloaded raw responses. Not in git; can be rebuilt. |

## Publishing

In Settings → Pages, set Source to **GitHub Actions**. Every push to `main` then publishes
`site/` at https://ophirmil12.github.io/morzine-map/ through `.github/workflows/pages.yml`.
If Source is left on "Deploy from a branch", the root `index.html` forwards visitors to `site/`.

## Live lift and piste status

`site/js/live.js` reads ResaLocal's real-time API, which the tourist office agreed to. It makes
one request of about 5 KB (`/api/v1/groups/uuids/by-status?groups=morzine,avoriaz,lesgets`):

- **When:** when the page opens, then every 5 minutes while the page is on screen.
- **Without signal:** the last answer is kept on the phone and shown with its time. The time is
  green when under 10 minutes old, yellow under an hour, and red when older.
- **On the map:** closed lifts and pistes are drawn grey and dashed.

## Update the data

    python tools/fetch_site_data.py      # runs, lifts, places and texts from explore.morzine.com
    python tools/extract_site_icons.py   # the original site's icons and logo
    python tools/slim_assets.py          # keep only the icons and font glyphs in use

`fetch_site_data.py` caches every answer in `cache/`. To get fresh data, delete `cache/`
first. Events are left out because they go out of date.

## Add a language

1. Add `{"code": "de", "label": "Deutsch", "dir": "ltr"}` to `site/i18n/languages.json`.
2. Copy `site/i18n/en.json` to `de.json` and translate the values.
3. Copy `site/data/content/en.json` to `de.json` and translate it.

Anything missing falls back to English. The language menu appears once there are two
languages, and right-to-left languages are supported (`"dir": "rtl"`).

## Size and caching

- **What we publish:** about 34 MB. 32 MB of that is terrain tiles (`site/tiles/dem`, zoom 8-14,
  from `tools/download_dem.py`), and a visitor only downloads the tiles for the area they look at.
- **First visit on a phone:** about 1 MB over the network.
- **Later visits:** 0 KB until something changes.
- **Why `sw.js` is needed:** GitHub Pages only lets browsers cache files for 10 minutes. `sw.js`
  stores the app on the first visit and keeps terrain tiles, base-map tiles (OpenFreeMap), fonts
  and libraries for weeks. The site's own files are refreshed in the background, so a new
  version shows on the visit after it is published.
- **Throwing away cached app files:** bump `VERSION` in `sw.js`.
- **Testing it locally:** the cache is off on localhost; add `?sw=1` to the address.

Winter only for now: `tools/fetch_site_data.py` only fetches the winter season, and the season
switch is hidden.

## Credits

Map data © OpenStreetMap contributors, tiles by OpenFreeMap / OpenMapTiles. Terrain: Mapzen
Terrain Tiles on AWS. Runs, lifts, places, icons and logo: Office de Tourisme de Morzine
(explore.morzine.com). Map library: MapLibre GL JS.
