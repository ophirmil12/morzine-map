"""Research and write short English descriptions for every ski piste and ski lift.

    python tools/research_ski_descriptions.py base      # geometry + DEM facts, raw site fields
    python tools/research_ski_descriptions.py osm       # OpenStreetMap aerialways and pistes, matched to ours
    python tools/research_ski_descriptions.py write     # build data_src/ski_descriptions_en.json
    python tools/research_ski_descriptions.py all       # the three in order

Inputs
  site/data/trails.json, site/data/content/en.json  our pistes and lifts
  site/tiles/dem/14/                                 Terrarium elevation tiles
  cache/find/                                        the raw records fetch_site_data.py saved
                                                     (resort, lift type and seat count)
  tools/ski_research_notes.json                      facts gathered by hand from the web
                                                     (ride times, styles, parks), with sources
Every download is cached in cache/ski_research/, so a rerun needs no network.
Standard library plus Pillow and numpy.
"""
import glob
import hashlib
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache", "ski_research")
DEM = os.path.join(ROOT, "site", "tiles", "dem", "14")
NOTES = os.path.join(ROOT, "tools", "ski_research_notes.json")
OUT = os.path.join(ROOT, "data_src", "ski_descriptions_en.json")
BASE_JSON = os.path.join(CACHE, "base.json")
OSM_JSON = os.path.join(CACHE, "osm_match.json")
UA = "morzine-map-research/1.0 (static ski map rebuild)"
Z = 14
FAMILIES = ("ski_trail", "ski_lift")


# ---------------------------------------------------------------- helpers

def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_json(obj, path, indent=1):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=indent)
        fh.write("\n")


def fetch(url, data=None, kind="web"):
    """GET (or POST form data) with a disk cache under cache/ski_research/<kind>/."""
    key = hashlib.sha1((url + "|" + (data or "")).encode()).hexdigest()
    path = os.path.join(CACHE, kind, key)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            return fh.read()
    body = data.encode() if data else None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                blob = r.read()
            break
        except Exception as e:  # noqa: BLE001
            print("  retry", attempt, e, flush=True)
            time.sleep(10 * (attempt + 1))
    else:
        raise RuntimeError("failed: " + url)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(blob)
    return blob


def metres(lon1, lat1, lon2, lat2):
    """Haversine distance in metres."""
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ---------------------------------------------------------------- DEM

_tiles = {}


def _tile(x, y):
    if (x, y) not in _tiles:
        path = os.path.join(DEM, str(x), f"{y}.png")
        if not os.path.exists(path):
            _tiles[(x, y)] = None
        else:
            a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
            _tiles[(x, y)] = a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256 - 32768
    return _tiles[(x, y)]


def _pixel(px, py):
    t = _tile(px // 256, py // 256)
    return None if t is None else t[py % 256, px % 256]


def elevation(lon, lat):
    """Bilinear height in metres from the zoom 14 Terrarium tiles."""
    n = 2 ** Z * 256
    fx = (lon + 180) / 360 * n - 0.5
    lr = math.radians(lat)
    fy = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n - 0.5
    x0, y0 = int(math.floor(fx)), int(math.floor(fy))
    dx, dy = fx - x0, fy - y0
    v = [_pixel(x0, y0), _pixel(x0 + 1, y0), _pixel(x0, y0 + 1), _pixel(x0 + 1, y0 + 1)]
    if any(a is None for a in v):
        return None
    return (v[0] * (1 - dx) * (1 - dy) + v[1] * dx * (1 - dy)
            + v[2] * (1 - dx) * dy + v[3] * dx * dy)


def resample(line, step):
    """Points every `step` metres along a lon/lat line (ends kept)."""
    pts = [tuple(line[0])]
    carry = 0.0
    for (a, b), (c, d) in zip(line[:-1], line[1:]):
        seg = metres(a, b, c, d)
        pos = step - carry
        while pos < seg:
            t = pos / seg
            pts.append((a + (c - a) * t, b + (d - b) * t))
            pos += step
        carry = (carry + seg) % step
    if pts[-1] != tuple(line[-1]):
        pts.append(tuple(line[-1]))
    return pts


def line_facts(line, family):
    horiz = sum(metres(*p, *q) for p, q in zip(line[:-1], line[1:]))
    if family == "ski_lift":
        za, zb = elevation(*line[0]), elevation(*line[-1])
        slope = math.hypot(horiz, zb - za)
        return {"horiz_m": horiz, "slope_m": slope, "bottom_m": min(za, zb), "top_m": max(za, zb),
                "start_m": za, "end_m": zb}
    pts = resample(line, 20.0)
    z = [elevation(*p) for p in pts]
    slope = sum(math.hypot(metres(*p, *q), zb - za)
                for p, q, za, zb in zip(pts[:-1], pts[1:], z[:-1], z[1:]))
    return {"horiz_m": horiz, "slope_m": slope, "bottom_m": min(z), "top_m": max(z),
            "start_m": z[0], "end_m": z[-1]}


# ---------------------------------------------------------------- stage: base

def raw_records():
    """uuid -> English raw record (French one if no English) from fetch_site_data's cache."""
    recs = {}
    for fn in glob.glob(os.path.join(ROOT, "cache", "find", "*", "*")):
        try:
            d = load_json(fn)
        except (ValueError, UnicodeDecodeError):
            continue
        for r in d if isinstance(d, list) else [d]:
            if not isinstance(r, dict) or "uuid" not in r:
                continue
            english = r.get("objectID", "").startswith(("ski-", "en/"))
            if english or r["uuid"] not in recs:
                recs[r["uuid"]] = r
    return recs


def stage_base():
    trails = load_json(os.path.join(ROOT, "site", "data", "trails.json"))
    names = load_json(os.path.join(ROOT, "site", "data", "content", "en.json"))["items"]
    recs = raw_records()
    out = {}
    for f in trails["features"]:
        p = f["properties"]
        if p["family"] not in FAMILIES:
            continue
        line = f["geometry"]["coordinates"][0]
        r = recs.get(p["id"], {})
        ski = r.get("ski", {})
        row = {"id": p["id"], "family": p["family"], "category": p["category"],
               "name": names[p["id"]]["name"], "area": p.get("area"),
               "resort": ski.get("resort"), "lift": ski.get("lift"),
               "difficulty": r.get("itinerary", {}).get("difficulty_level"),
               "associations": r.get("associations", []),
               "start": line[0], "end": line[-1]}
        row.update(line_facts(line, p["family"]))
        out[p["id"]] = row
    save_json(out, BASE_JSON)
    print("base:", len(out), "items ->", BASE_JSON)


# ---------------------------------------------------------------- stage: osm

OVERPASS = "https://overpass-api.de/api/interpreter"
BBOX = "46.10,6.58,46.25,6.87"


def overpass(query, name):
    blob = fetch(OVERPASS, "data=" + urllib.parse.quote(query), kind="osm")
    d = json.loads(blob)
    save_json(d, os.path.join(CACHE, name), indent=None)
    return d


def norm(s):
    import unicodedata
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    for w in ("telesiege", "teleski", "telecabine", "telepherique", "tsd", "ts6", "ts3", "ts4", "ts",
              "td6", "td4", "tk", "tc", "tlc", "tph", "3s", "express", "du", "de", "des", "la", "le",
              "les", "l'", "d'", "fil-neige", "fil neige", "tapis", "telecorde", "piste", "the"):
        s = (" " + s + " ").replace(" " + w + " ", " ").strip()
    return "".join(ch for ch in s if ch.isalnum())


def way_line(el):
    return [(g["lon"], g["lat"]) for g in el.get("geometry", [])]


def end_distance(ours, theirs):
    """Mean distance between matching ends (either direction), metres."""
    a, b = ours[0], ours[-1]
    c, d = theirs[0], theirs[-1]
    same = (metres(*a, *c) + metres(*b, *d)) / 2
    flip = (metres(*a, *d) + metres(*b, *c)) / 2
    return min(same, flip)


def stage_osm():
    base = load_json(BASE_JSON)
    lifts_q = f'[out:json][timeout:120];way["aerialway"]({BBOX});out tags geom;'
    pistes_q = f'[out:json][timeout:120];(way["piste:type"]({BBOX});relation["piste:type"]({BBOX}););out tags geom;'
    la = overpass(lifts_q, "osm_aerialways.json")["elements"]
    time.sleep(5)
    pi = overpass(pistes_q, "osm_pistes.json")["elements"]
    print("osm aerialways:", len(la), "piste ways/relations:", len(pi))
    match = {}
    for i, row in base.items():
        ours = [tuple(row["start"]), tuple(row["end"])]
        pool = la if row["family"] == "ski_lift" else [e for e in pi if e["type"] == "way" and e.get("geometry")]
        best = None
        for e in pool:
            g = way_line(e)
            if len(g) < 2:
                continue
            dist = end_distance(ours, [g[0], g[-1]])
            same_name = norm(e.get("tags", {}).get("name")) == norm(row["name"]) and norm(row["name"])
            score = dist - (400 if same_name else 0)
            if best is None or score < best[0]:
                best = (score, dist, bool(same_name), e)
        if best is None:
            continue
        score, dist, same_name, e = best
        ok = (same_name and dist < 400) or dist < 60
        match[i] = {"name": row["name"], "osm_id": f"{e['type']}/{e['id']}", "osm_name": e.get("tags", {}).get("name"),
                    "end_dist_m": round(dist), "same_name": same_name, "ok": ok, "tags": e.get("tags", {})}
    save_json(match, OSM_JSON)
    lifts = [m for i, m in match.items() if base[i]["family"] == "ski_lift"]
    print("lifts matched ok:", sum(m["ok"] for m in lifts), "/", sum(1 for r in base.values() if r["family"] == "ski_lift"))
    print("with duration:", sum(1 for m in lifts if m["ok"] and "aerialway:duration" in m["tags"]))


# ---------------------------------------------------------------- stage: write

if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    if stage in ("base", "all"):
        stage_base()
    if stage in ("osm", "all"):
        stage_osm()
    if stage in ("write", "all"):
        from ski_writer import stage_write  # noqa: E402
        stage_write()
