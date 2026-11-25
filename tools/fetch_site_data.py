"""Fetch the Morzine map data from explore.morzine.com into site/data/.

Used with the tourist office's permission. Standard library only.
Every HTTP response is cached in cache/, so a rerun only asks for what is missing.
Delete cache/ to force a full refresh.

    python tools/fetch_site_data.py

Writes
  site/data/trails.json            ski pistes, lifts, nordic and other routes (lines)
  site/data/pois.json              points of interest
  site/data/content/en.json        English names and descriptions per item id,
                                   plus family and category labels
  site/data/categories.json        colour and icon per category and family
  cold_storage/site_texts/         the site's French texts and the it/de/nl labels
Events are skipped: they go out of date quickly.
Hand-made overlays from data_src/: mountain_food.json (restaurant group),
ski_fixes_2027.json (lifts and pistes changed since the office data, lines from OSM)
and ski_descriptions_en.json (piste and lift texts).
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(__file__))
import nuxt_parse  # noqa: E402

BASE = "https://explore.morzine.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")
OUT = os.path.join(ROOT, "site", "data")
UA = "Mozilla/5.0 (morzine-map rebuild for the Office de Tourisme de Morzine)"
WORKERS = 4
PAUSE = 0.15

LANGS = {"fr": {"locale": "fr-FR", "index": "15_morzine_fr_FR"},
         "en": {"locale": "en-US", "index": "15_morzine_en_US"}}
# The site also has category labels in these languages (no listing texts).
EXTRA_LABEL_LANGS = {"it": "it-IT", "de": "de-DE", "nl": "nl-NL"}
# Winter only for now (2026-11-24). Add "summer": "Été" to bring summer back.
SEASONS = {"winter": "Hiver"}
LINE_FAMILIES = {"ski_trail", "ski_lift", "nordic_ski_trail", "activity_routes",
                 "mtb_trail", "trail_running", "mtb_lift"}
SKIP_FAMILIES = {"events"}
# The map covers Les Gets, Morzine and Avoriaz only (west, south, east, north).
AREA = (6.60, 46.11, 6.85, 46.235)


def in_area(coords):
    """True if any vertex of a (nested) coordinate list lies inside AREA."""
    if isinstance(coords[0], (int, float)):
        return AREA[0] <= coords[0] <= AREA[2] and AREA[1] <= coords[1] <= AREA[3]
    return any(in_area(c) for c in coords)


def http(url, body=None, kind="raw", ua=UA):
    """GET (or POST JSON) with a disk cache. Returns bytes, or None on 404."""
    key = hashlib.sha1((url + "|" + json.dumps(body, sort_keys=True)).encode()).hexdigest()
    path = os.path.join(CACHE, kind, key[:2], key)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            data = fh.read()
        return None if data == b"__404__" else data
    headers = {"User-Agent": ua, "Accept": "application/json, text/html, */*"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                blob = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                blob = b"__404__"
                break
            if attempt == 3:
                raise
        except Exception:
            if attempt == 3:
                raise
        time.sleep(2 ** attempt)
    time.sleep(PAUSE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(blob)
    return None if blob == b"__404__" else blob


def pmap(fn, items, label):
    out = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for i, r in enumerate(pool.map(fn, items), 1):
            out.append(r)
            if i % 100 == 0 or i == len(items):
                print(f"  {label}: {i}/{len(items)}", flush=True)
    return out


def markers(lang, season):
    L = LANGS[lang]
    body = {"mutations": {
        "AlgoliaSeasonFilter": {"options": {"seasonLabel": SEASONS[season], "seasonCode": season}},
        "AlgoliaTabFilter": {"options": {"indexName": L["index"], "query": "", "view": "standard",
                                         "agenda": {"timezone": "Europe/Paris"}}}}}
    return json.loads(http(f"{BASE}/markers?locale={L['locale']}", body, "markers"))


def find_one(object_id):
    raw = http(f"{BASE}/find/cache", {"prop": "objectID", "values": object_id, "locale": "fr-FR",
                                      "options": {"withEventDates": False}}, "find")
    res = json.loads(raw) if raw else []
    return res[0] if res else None


def find_uuids(uuids, locale):
    raw = http(f"{BASE}/find/cache", {"prop": "uuid", "values": uuids, "locale": locale,
                                      "options": {"withEventDates": False}}, "find")
    return json.loads(raw) if raw else []


def geo(object_id):
    raw = http(f"{BASE}/fr/{object_id}/geo", None, "geo")
    if not raw:
        return None
    try:
        g = json.loads(raw)
    except ValueError:
        return None
    return g if g.get("geometry") else None


def round_coords(c, nd=5):
    """5 decimals is about 1 m. The always-zero altitude is dropped."""
    if isinstance(c[0], (int, float)):
        return [round(c[0], nd), round(c[1], nd)]
    return [round_coords(x, nd) for x in c]


def simplify(line, tol_m=1.5):
    """Douglas-Peucker on a lon/lat line, tolerance in metres. Keeps the shape, drops redundant points."""
    if len(line) < 3:
        return line
    kx, ky = 111320 * 0.6926, 111320  # metres per degree at 46.2 N (cos 46.2 = 0.6926)
    pts = [(x * kx, y * ky) for x, y in line]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        seg = (dx * dx + dy * dy) ** 0.5 or 1e-9
        best, idx = 0.0, None
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / seg
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol_m:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(line, keep) if k]


def clean_lines(geometry):
    parts = geometry["coordinates"] if geometry["type"] == "MultiLineString" else [geometry["coordinates"]]
    parts = [simplify(round_coords(p)) for p in parts]
    parts = [p for p in parts if len(p) >= 2]
    return {"type": "MultiLineString", "coordinates": parts}


def clean_text(s):
    if not s:
        return ""
    return " ".join(str(s).split())


OSM_API = "https://api.openstreetmap.org/api/0.6"
# The OSM servers refuse browser-like user agents.
OSM_UA = "morzine-map/1.0 (static ski map rebuild)"


def osm_ways(way_ids):
    """{way id: [[lon, lat], ...]} from the OpenStreetMap API, in the way's own node order (cached)."""
    out = {}
    for w in sorted(way_ids):
        els = json.loads(http(f"{OSM_API}/way/{w}/full.json", None, "osm", ua=OSM_UA))["elements"]
        nodes = {e["id"]: [e["lon"], e["lat"]] for e in els if e["type"] == "node"}
        way = next(e for e in els if e["type"] == "way")
        out[w] = [nodes[n] for n in way["nodes"]]
    return out


def apply_ski_fixes(fix, trails, content):
    """Apply data_src/ski_fixes_2027.json: remove, re-draw, rename, re-categorise and add items."""
    lines = osm_ways({e["osm_way"] for sec in ("geometry", "add") for e in fix.get(sec, [])})

    def osm_line(e):
        line = lines[e["osm_way"]][::-1] if e.get("reverse") else lines[e["osm_way"]]
        return clean_lines({"type": "LineString", "coordinates": line})

    by_id = {f["properties"]["id"]: f for f in trails}
    missing = {e["id"] for sec in ("remove", "geometry", "category", "rename") for e in fix.get(sec, [])} - set(by_id)
    if missing:  # the office dropped or re-keyed them: the fix is no longer needed, or must be redone
        print("  ski fixes: ids no longer in the office data:", sorted(missing))
    gone = {e["id"] for e in fix.get("remove", [])}
    for e in fix.get("geometry", []):
        if e["id"] in by_id:
            f = by_id[e["id"]]
            f["geometry"] = osm_line(e)
            f["properties"]["marker"] = f["geometry"]["coordinates"][0][0]
    for e in fix.get("category", []):
        if e["id"] in by_id:
            by_id[e["id"]]["properties"]["category"] = e["category"]
    for e in fix.get("rename", []):
        for lang in ("fr", "en"):
            if e["id"] in content[lang]["items"]:
                content[lang]["items"][e["id"]]["name"] = e["name"]
    for e in fix.get("add", []):
        geom = osm_line(e)
        props = {"id": e["id"], "family": e["family"], "category": e["category"], "seasons": ["winter"],
                 "area": e["area"], "marker": geom["coordinates"][0][0]}
        trails.append({"type": "Feature", "properties": props, "geometry": geom})
        for lang in ("fr", "en"):
            content[lang]["items"][e["id"]] = {"name": e["name"], "description": ""}
    trails[:] =[f for f in trails if f["properties"]["id"] not in gone]
    for lang in ("fr", "en"):
        for uid in gone:
            content[lang]["items"].pop(uid, None)
    print(f"ski fixes {fix.get('checked')}: removed {len(gone)}, re-drawn {len(fix.get('geometry', []))},"
          f" renamed {len(fix.get('rename', []))}, re-categorised {len(fix.get('category', []))},"
          f" added {len(fix.get('add', []))}")


def main():
    os.makedirs(os.path.join(OUT, "content"), exist_ok=True)

    # 1. markers, French, per season
    items = {}  # objectId -> feature dict
    for season in SEASONS:
        feats = markers("fr", season)
        print(f"markers fr/{season}: {len(feats)}")
        for f in feats:
            p = f["properties"]
            if p["family"] in SKIP_FAMILIES:
                continue
            it = items.setdefault(p["objectId"], {
                "objectId": p["objectId"], "family": p["family"], "category": p.get("category"),
                "point": round_coords(f["geometry"]["coordinates"]), "seasons": []})
            it["seasons"].append(season)
    print(f"unique items (no events): {len(items)}")

    # 2. French record of every item (name, summary, uuid, sku)
    ids = sorted(items)
    recs = pmap(find_one, ids, "fr records")
    for oid, rec in zip(ids, recs):
        items[oid]["rec"] = rec

    # 3. exact lines
    line_ids = [oid for oid in ids if items[oid]["family"] in LINE_FAMILIES]
    geos = pmap(geo, line_ids, "lines")
    for oid, g in zip(line_ids, geos):
        items[oid]["geo"] = g

    # 4. English texts, by uuid in batches
    uuids = [it["rec"]["uuid"] for it in items.values() if it.get("rec") and it["rec"].get("uuid")]
    en = {}
    batches = [uuids[i:i + 40] for i in range(0, len(uuids), 40)]
    for res in pmap(lambda b: find_uuids(b, "en-US"), batches, "en records"):
        for r in res:
            en[r["uuid"]] = r

    # 5. category and family labels from the map page's data (5 languages)
    html = http(f"{BASE}/fr/carte", None, "page").decode("utf-8")
    i = html.index("window.__NUXT__=")
    state = nuxt_parse.parse(html[i:html.index("</script>", i)])["pinia"]
    cats = {c["code"]: c for c in state["categories"]["data"]}
    fams = {f["code"]: f for f in state["families"]["data"]}

    # 6. write outputs
    trails, pois = [], []
    content = {"fr": {"items": {}}, "en": {"items": {}}}
    missing = 0
    outside = 0
    for oid in ids:
        it = items[oid]
        g = it.get("geo")
        if not in_area(g["geometry"]["coordinates"] if g else it["point"]):
            outside += 1
            continue
        rec = it.get("rec") or {}
        uid = rec.get("uuid") or oid
        if not rec:
            missing += 1
        props = {"id": uid, "family": it["family"], "category": it["category"] or rec.get("category"),
                 "seasons": it["seasons"]}
        name_fr = clean_text(rec.get("name")) or oid.split("/")[-1].replace("-", " ").capitalize()
        content["fr"]["items"][uid] = {"name": name_fr, "description": clean_text(rec.get("summary"))}
        e = en.get(uid)
        if e:
            content["en"]["items"][uid] = {"name": clean_text(e.get("name")),
                                           "description": clean_text(e.get("summary"))}
        ski = rec.get("ski") or {}
        if ski.get("area"):
            props["area"] = ski["area"]
        if g:
            props["marker"] = it["point"]
            trails.append({"type": "Feature", "properties": props, "geometry": clean_lines(g["geometry"])})
        else:
            pois.append({"type": "Feature", "properties": props,
                         "geometry": {"type": "Point", "coordinates": it["point"]}})

    # Restaurants (and food shops) up on the ski area get their own group, shown by default.
    # The list is hand-checked: data_src/mountain_food.json says how it was chosen.
    mf_path = os.path.join(ROOT, "data_src", "mountain_food.json")
    if os.path.exists(mf_path):
        with open(mf_path, encoding="utf-8") as fh:
            mf = json.load(fh)
        ids = {x["id"] for x in mf["places"]}
        for f in pois:
            if f["properties"]["id"] in ids:
                f["properties"]["family"] = mf["family"]
        base = fams.get("restaurants", {})
        fams[mf["family"]] = {"code": mf["family"], "color": base.get("color"), "icon": base.get("icon"),
                              "label": mf["label"]}
        print("mountain food places:", sum(f["properties"]["family"] == mf["family"] for f in pois))

    # The office data lags behind the ski area. Hand-checked fixes for this winter (lifts gone,
    # wrong or moved lines, missing runs) live in data_src/ski_fixes_2027.json, with sources.
    fix_path = os.path.join(ROOT, "data_src", "ski_fixes_2027.json")
    if os.path.exists(fix_path):
        with open(fix_path, encoding="utf-8") as fh:
            fix = json.load(fh)
        apply_ski_fixes(fix, trails, content)

    used_cats = {f["properties"]["category"] for f in trails + pois}
    used_fams = {f["properties"]["family"] for f in trails + pois}
    meta = {"categories": {}, "families": {}}
    for code in sorted(c for c in used_cats if c):
        c = cats.get(code, {})
        icon = c.get("icon")
        if isinstance(icon, dict):
            icon = icon.get("big") or icon.get("selected")
        meta["categories"][code] = {"color": c.get("color"), "icon": icon, "group": c.get("group")}
    for code in sorted(used_fams):
        f = fams.get(code, {})
        meta["families"][code] = {"color": f.get("color"), "icon": f.get("icon")}

    all_langs = {"fr": "fr-FR", "en": "en-US", **EXTRA_LABEL_LANGS}
    for lang, loc in all_langs.items():
        block = content.setdefault(lang, {"items": {}})
        block["categories"] = {k: (cats.get(k, {}).get("label") or {}).get(loc, "") for k in meta["categories"]}
        block["families"] = {k: (fams.get(k, {}).get("label") or {}).get(loc, "") for k in meta["families"]}

    def dump(obj, name, compact=True):
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
            if compact:
                json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
            else:
                json.dump(obj, fh, ensure_ascii=False, indent=1)

    src = {"source": "explore.morzine.com (Office de Tourisme de Morzine)",
           "fetched": time.strftime("%Y-%m-%d")}
    dump({"type": "FeatureCollection", **src, "features": trails}, "trails.json")
    dump({"type": "FeatureCollection", **src, "features": pois}, "pois.json")
    dump(meta, "categories.json", compact=False)

    # The site ships English only. Items with no English text keep their French name
    # (mostly proper nouns) and are listed in cold_storage/untranslated_en.json.
    en_block = content["en"]
    untranslated = {}
    for uid, fr in content["fr"]["items"].items():
        cur = en_block["items"].get(uid)
        if not cur or not cur.get("name"):
            en_block["items"][uid] = {"name": fr["name"], "description": ""}
            untranslated[uid] = fr
        elif not cur.get("description") and fr.get("description"):
            untranslated[uid] = fr

    # Pistes and lifts have no text on the site. Short descriptions researched for the map
    # (length, altitudes, ride time...) live in data_src/ski_descriptions_en.json.
    extra_path = os.path.join(ROOT, "data_src", "ski_descriptions_en.json")
    if os.path.exists(extra_path):
        with open(extra_path, encoding="utf-8") as fh:
            extra = json.load(fh)
        added = 0
        for uid, rec in extra.items():
            cur = en_block["items"].get(uid)
            if cur is not None and not cur.get("description") and rec.get("description"):
                cur["description"] = rec["description"]
                untranslated.pop(uid, None)
                added += 1
        print("piste/lift descriptions added:", added)
    dump(en_block, "content/en.json", compact=False)

    # French texts and the other category labels: kept outside the site for reference.
    cold = os.path.join(ROOT, "cold_storage", "site_texts")
    os.makedirs(cold, exist_ok=True)
    for lang, block in content.items():
        if lang == "en":
            continue
        with open(os.path.join(cold, f"{lang}.json"), "w", encoding="utf-8") as fh:
            json.dump(block, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(cold, "untranslated_en.json"), "w", encoding="utf-8") as fh:
        json.dump(untranslated, fh, ensure_ascii=False, indent=1)
    print("items with missing English name or description:", len(untranslated))

    from collections import Counter
    print("trails:", len(trails), Counter(f["properties"]["family"] for f in trails))
    print("pois:", len(pois), Counter(f["properties"]["family"] for f in pois))
    print("fr records missing:", missing, "| en texts:", len(content["en"]["items"]),
          "| left out (outside the area):", outside)


if __name__ == "__main__":
    main()
