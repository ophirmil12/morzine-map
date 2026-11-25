"""Research and write short English descriptions for every ski piste and ski lift.

    python tools/research_ski_descriptions.py base      # geometry + DEM facts, raw site fields
    python tools/research_ski_descriptions.py osm       # OpenStreetMap aerialways and pistes, matched to ours
    python tools/research_ski_descriptions.py rmnet     # lift sheets from remontees-mecaniques.net
    python tools/research_ski_descriptions.py write     # build data_src/ski_descriptions_en.json
    python tools/research_ski_descriptions.py all       # all four in order

Inputs
  site/data/trails.json, site/data/content/en.json  our pistes and lifts
  site/tiles/dem/14/                                 Terrarium elevation tiles
  cache/find/                                        the raw records fetch_site_data.py saved
                                                     (resort, lift type and seat count)
  tools/ski_research_notes.json                      facts gathered by hand from the web
                                                     (ride times, styles, parks), with sources
  data_src/lift_hours_2027.json                      lift opening hours for winter 2026-27, read by
                                                     hand from the operators' timetables
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
HOURS = os.path.join(ROOT, "data_src", "lift_hours_2027.json")
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


def plain(s):
    """Lower case, no accents, no spaces or hyphens: compares spellings of one name."""
    import unicodedata
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return "".join(ch for ch in s if ch.isalnum())


def unaccent(s):
    """Lower case without accents, spaces kept: 'Pléney' == 'PLENEY', 'Belle Mouille' != 'Bellemouille'."""
    import unicodedata
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()


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


# ---------------------------------------------------------------- stage: rmnet

RMNET = "https://www.remontees-mecaniques.net"
RMNET_STATIONS = ["station-les-gets-58", "station-morzine-le-pleney-25", "station-morzine-super-morzine-923",
                  "station-avoriaz-24", "station-montriond-84"]
def page_text(blob):
    import html as htmlmod
    import re
    b = blob.decode("utf-8") if b"charset=utf-8" in blob[:3000].lower() else blob.decode("latin-1")
    b = re.sub(r"(?s)<script.*?</script>", "", b)
    t = re.sub(r"<[^>]+>", "|", b)
    t = htmlmod.unescape(re.sub(r"\s+", " ", t))
    return re.sub(r"(\|\s*)+", "| ", t)


def stage_rmnet():
    """Technical sheets of every lift listed for our resorts on remontees-mecaniques.net."""
    import re
    links = {}
    for st in RMNET_STATIONS:
        blob = fetch(f"{RMNET}/bdd/{st}.html", kind="rmnet")
        b = blob.decode("latin-1")
        for m in re.finditer(r'href="(/bdd/reportage-[^"#]+)"[^>]*>(.*?)</a>', b, re.S):
            label = re.sub(r"<[^>]+>|\s+", " ", m.group(2)).strip()
            if label:
                links[m.group(1)] = {"station": st, "label": label}
    print("rmnet reportages:", len(links))
    out = {}
    for path, info in links.items():
        url = RMNET + path
        key = hashlib.sha1((url + "|").encode()).hexdigest()
        cached = os.path.exists(os.path.join(CACHE, "rmnet", key))
        t = page_text(fetch(url, kind="rmnet"))
        if not cached:
            time.sleep(1.0)
        rec = dict(info, url=url)
        start = t.find("Caractéristiques")
        sheet = t[start:start + 2500] if start >= 0 else ""
        # Two layouts: "Label| : value|" and "Label : value|"
        rec["sheet"] = {k.strip(): v.strip() for k, v in
                        re.findall(r"\|\s*([^|:]{3,60}?)\s*\|?\s*:\s*([^|]{1,80})(?=\|)", sheet)}
        rec["closed_hint"] = any(w in t for w in ("Démonté", "démonté en", "Fermé définitivement",
                                                  "Année de démantèlement"))
        out[path] = rec
    save_json(out, os.path.join(CACHE, "rmnet_lifts.json"))
    print("saved", len(out))


# ---------------------------------------------------------------- stage: write

COLOUR = {"ski_novice": "green", "ski_easy": "blue", "ski_intermediate": "red", "ski_advanced": "black"}
# Typical line speeds (m/s) and extra station time (s), used only when no real ride time exists.
TYPICAL = {"detachable_chairlift": (5.0, 30), "chairlift": (2.3, 0), "gondola_lift": (5.0, 30),
           "cable_car": (8.0, 30), "surface_lift": (3.0, 0), "cord_lift": (1.5, 0),
           "carpet_ski_lift": (0.7, 0)}
SMALL = {"de", "du", "des", "la", "le", "les", "au", "aux", "à", "a", "et", "en", "sous"}
OSM_URL = "https://www.openstreetmap.org/"


def round10(x):
    return int(round(x / 10.0) * 10)


def fmt_alt(x):
    return f"{round10(x):,} m"


def fmt_len(m):
    if m < 1000:
        return f"{round10(m)} m"
    return f"{m / 1000:.1f} km"


def length_fact(m):
    return round10(m) if m < 1000 else int(round(m / 100.0) * 100)


def title_fr(s):
    """'GRAINS D'OR EXPRESS' -> "Grains d'Or Express"; mixed-case names are kept."""
    if s != s.upper():
        return s
    words = []
    for i, w in enumerate(s.lower().split()):
        if "'" in w:
            a, b = w.split("'", 1)
            w = (a + "'" + b.capitalize()) if a in ("d", "l") and i > 0 else (a.capitalize() + "'" + b.capitalize())
        elif "-" in w:
            w = "-".join(p.capitalize() for p in w.split("-"))
        elif not (i > 0 and w in SMALL):
            w = w.capitalize()
        words.append(w)
    return " ".join(words)


LIFT_PREFIX = ("TSD", "TS3", "TS6", "TS", "TD4", "TD6", "TK", "TC", "TLC", "TPH", "TAPIS", "Tapis",
               "TELECORDE", "Telecorde", "FIL-NEIGE", "Fil neige")


def lift_core(name):
    n = name
    for p in LIFT_PREFIX:
        if n.startswith(p + " "):
            n = n[len(p) + 1:]
            break
    n = n.replace(" 3S", "")
    for art in ("de la ", "du ", "des ", "de l'", "de ", "la ", "le ", "les "):
        if n.lower().startswith(art):
            n = n[len(art):]
    return title_fr(n)


def ride_text(minutes, real):
    if not real:
        return f"about {max(1, int(round(minutes)))} min"
    secs = int(round(minutes * 60 / 5.0) * 5)
    if minutes < 3 and secs % 60:
        return f"{secs // 60} min {secs % 60} s"
    return f"{int(round(minutes))} min"


def parse_minutes(s):
    """'3:20', '4.5', '5 min 30 sec', "4'34''", '2 minutes 15', '8 min 37 sec' -> minutes."""
    import re
    s = s.replace("’", "'").replace("′", "'").lower()
    m = re.match(r"^\s*(\d+):(\d+)\s*$", s)
    if m:
        return int(m.group(1)) + int(m.group(2)) / 60
    m = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*(?:min\w*)?\s*$", s)
    if m:
        return float(m.group(1).replace(",", "."))
    m = re.search(r"(\d+)\s*(?:'|min)[^\d]*(\d+)?", s)
    if m:
        return int(m.group(1)) + (int(m.group(2)) / 60 if m.group(2) else 0)
    return None


def grade_stats(line):
    pts = resample(line, 20.0)
    z = [elevation(*p) for p in pts]
    if z[0] < z[-1]:
        pts, z = pts[::-1], z[::-1]
    d = [0.0]
    for p, q in zip(pts[:-1], pts[1:]):
        d.append(d[-1] + metres(*p, *q))
    steep = 0.0
    j = 0
    for i in range(len(pts)):
        while j < len(pts) and d[j] - d[i] < 100:
            j += 1
        if j < len(pts):
            steep = max(steep, (z[i] - z[j]) / (d[j] - d[i]))
    drop = max(z) - min(z)
    return {"mean": drop / max(d[-1], 1), "steep": steep, "top_pt": pts[0], "bottom_pt": pts[-1],
            "loop": metres(*line[0], *line[-1]) < 60}


MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September",
          "October", "November", "December")
MAX_LIFT_WORDS = 38  # whole lift description with its hours sentence
MAX_WORDS = 30       # target for the automatic second sentence when there are no hours


def hm(t):
    """'08:45' -> '8:45', '00:00' -> '0:00'."""
    h, m = t.split(":")
    return f"{int(h)}:{m}"


def day_month(iso):
    """'2027-02-06' -> '6 February'."""
    _, m, d = iso.split("-")
    return f"{int(d)} {MONTHS[int(m) - 1]}"


def period_clause(periods, key):
    """Changes after the first period, e.g. ', or 17:15 from 6 February to 5 March'."""
    runs = []
    for p in periods:
        if runs and runs[-1]["v"] == p[key]:
            runs[-1]["to"] = p["to"]
        else:
            runs.append({"v": p[key], "from": p["from"], "to": p["to"]})
    if len(runs) == 1:
        return ""
    if len(runs) == 2:
        return f", or {hm(runs[1]['v'])} from {day_month(runs[1]['from'])}"
    if len(runs) == 3 and runs[2]["v"] == runs[0]["v"]:
        r = runs[1]
        return f", or {hm(r['v'])} from {day_month(r['from'])} to {day_month(r['to'])}"
    return ", " + " and ".join(f"{hm(r['v'])} from {day_month(r['from'])}" for r in runs[1:])


def hours_text(h):
    """A short sentence with a lift's opening hours, or '' when they are unknown.
    Last rides down (gondolas, cable car) stay in the hours file unless a hand 'text' gives them."""
    if not h:
        return ""
    if h.get("text"):
        return h["text"]
    if not h.get("open"):
        return ""
    o = hm(h["open"])
    if h.get("open_school_holidays"):
        o += f" ({hm(h['open_school_holidays'])} in school holidays)"
    if "close" in h:
        per = h.get("periods") or [{"from": "", "to": "", "close": h["close"]}]
        return f"Open daily from {o} to {hm(per[0]['close'])}{period_clause(per, 'close')}."
    per = h.get("periods") or [{"from": "", "to": "", "last_up": h["last_up"]}]
    return f"Open daily from {o}, last ride up at {hm(per[0]['last_up'])}{period_clause(per, 'last_up')}."


def stage_write():
    base = load_json(BASE_JSON)
    osm = load_json(OSM_JSON)
    rm = load_json(os.path.join(CACHE, "rmnet_lifts.json"))
    notes = load_json(NOTES)
    hours = load_json(HOURS)["lifts"] if os.path.exists(HOURS) else {}
    trails = {f["properties"]["id"]: f["geometry"]["coordinates"][0]
              for f in load_json(os.path.join(ROOT, "site", "data", "trails.json"))["features"]}
    osm_geom = {}
    for el in load_json(os.path.join(CACHE, "osm_aerialways.json"))["elements"]:
        osm_geom[f"way/{el['id']}"] = way_line(el)

    def note_for(row):
        for key in (f"{row['family']}:{row['name']}@{(row['resort'] or [''])[0]}", f"{row['family']}:{row['name']}"):
            if key in notes:
                return notes[key]
        return {}

    # Display names: OSM spelling (accents) when it is the same name.
    def display(row):
        if note_for(row).get("display"):
            return note_for(row)["display"]
        m = osm.get(row["id"])
        core = lift_core(row["name"]) if row["family"] == "ski_lift" else title_fr(row["name"])
        if (m and m["ok"] and m.get("osm_name") and unaccent(m["osm_name"]) == unaccent(core)
                and m["osm_name"].lower() != core.lower()):
            return m["osm_name"]
        return core

    # Lift stations and piste ends, for "served by" and "ends at".
    lifts = {}
    for i, r in base.items():
        if r["family"] != "ski_lift":
            continue
        n = note_for(r)
        line = trails[i]
        if n.get("osm_geometry"):
            line = osm_geom[n["osm_geometry"]]
        za, zb = elevation(*line[0]), elevation(*line[-1])
        bottom, top = (line[0], line[-1]) if za <= zb else (line[-1], line[0])
        lifts[i] = {"row": r, "line": line, "bottom": bottom, "top": top, "note": n}
    pistes = {}
    for i, r in base.items():
        if r["family"] == "ski_trail":
            pistes[i] = dict(grade_stats(trails[i]), row=r, note=note_for(r))

    def kind(lf, short=False):
        r, n = lf["row"], lf["note"]
        if n.get("kind"):
            return n["short_kind"] if short and n.get("short_kind") else n["kind"]
        code = (r["lift"] or {}).get("type_code") or r["category"]
        seats = n.get("seats") or (r["lift"] or {}).get("capacity")
        if code in ("detachable_chairlift", "chairlift"):
            if short:
                return "chairlift"
            det = "detachable " if code == "detachable_chairlift" or n.get("detachable") else ""
            return f"{seats}-seat {det}chairlift" if seats and seats > 1 else f"{det}chairlift"
        if code == "gondola_lift":
            return "gondola" if short or not seats else f"gondola with {seats}-person cabins"
        if code == "cable_car":
            return "cable car"
        if code == "surface_lift":
            return "drag lift"
        if code == "cord_lift":
            return "rope tow"
        if code == "carpet_ski_lift":
            return "moving carpet"
        return "lift"

    def lift_ref(j):
        lf = lifts[j]
        return f"the {display(lf['row'])} {kind(lf, short=True)}"

    def near(p, q, tol):
        return metres(*p, *q) <= tol

    out = {}
    stats = {"osm": 0, "web": 0, "estimate": 0, "none": 0}
    hours_stats = {}
    for i, r in sorted(base.items(), key=lambda kv: (kv[1]["family"], kv[1]["name"])):
        sources = []
        facts = {}
        if r["family"] == "ski_lift":
            lf = lifts[i]
            n = lf["note"]
            line = lf["line"]
            lfacts = line_facts(line, "ski_lift")
            facts["length_m"] = length_fact(lfacts["slope_m"])
            facts["bottom_m"] = round10(lfacts["bottom_m"])
            facts["top_m"] = round10(lfacts["top_m"])
            facts["lift_type"] = kind(lf)
            m = osm.get(i) if osm.get(i, {}).get("ok") else None
            if m:
                sources.append(OSM_URL + m["osm_id"])
            rmrec = None
            if n.get("rmnet"):
                num = n["rmnet"].rsplit("-", 1)[-1]
                rmrec = next((v for k, v in rm.items() if k.endswith("-" + num)), None)
                if rmrec is None:
                    print("  rmnet sheet missing:", r["name"], n["rmnet"])
            if rmrec:
                sources.append(rmrec["url"])
            ride, src = None, None
            if n.get("ride"):
                ride, src = n["ride"]["min"], n["ride"]["source"]
            elif rmrec and any(k.startswith(("Temps de trajet", "Durée")) for k in rmrec["sheet"]):
                k = next(k for k in rmrec["sheet"] if k.startswith(("Temps de trajet", "Durée")))
                ride, src = parse_minutes(rmrec["sheet"][k]), "web"
            elif m and m["tags"].get("aerialway:duration"):
                ride, src = parse_minutes(m["tags"]["aerialway:duration"]), "osm"
            if ride is None and not n.get("no_ride"):
                code = (r["lift"] or {}).get("type_code") or r["category"]
                if n.get("detachable"):
                    code = "detachable_chairlift"
                speed, extra = TYPICAL.get(code, (3.0, 0))
                if rmrec:
                    for k, v in rmrec["sheet"].items():
                        if k.startswith("Vitesse"):
                            try:
                                speed = float(v.split()[0].replace(",", "."))
                            except (ValueError, IndexError):
                                pass
                ride, src = (lfacts["slope_m"] / speed + extra) / 60, "estimate"
            if ride is not None:
                facts["ride_min"] = round(ride, 1)
                facts["ride_min_source"] = src
            stats[src or "none"] += 1
            for s in n.get("sources", []):
                if s not in sources:
                    sources.append(s)
            # Last sentence: opening hours for the season, from data_src/lift_hours_2027.json.
            h = hours.get(i, {})
            s3 = hours_text(h)
            if s3:
                facts["hours"] = {k: h[k] for k in ("open", "open_school_holidays", "close", "last_up") if k in h}
                facts["hours_basis"] = h["basis"]
                for s in h.get("sources", []):
                    if s not in sources:
                        sources.append(s)
                hours_stats[h["basis"]] = hours_stats.get(h["basis"], 0) + 1
            else:
                hours_stats["none"] = hours_stats.get("none", 0) + 1
            limit = MAX_LIFT_WORDS - len(s3.split()) if s3 else MAX_WORDS
            # Sentence 1: what it is, how long, from where to where, how long it takes.
            k = facts["lift_type"]
            rt = ride_text(ride, src != "estimate") if ride is not None else None
            if round10(lfacts["top_m"]) - round10(lfacts["bottom_m"]) < 20:
                s1 = f"This {k} is {fmt_len(lfacts['slope_m'])} long, at about {fmt_alt(lfacts['bottom_m'])}"
                s1 += f", and the ride takes {rt}." if rt else "."
            else:
                s1 = (f"This {k} climbs {fmt_len(lfacts['slope_m'])} from {fmt_alt(lfacts['bottom_m'])}"
                      f" to {fmt_alt(lfacts['top_m'])}")
                s1 += f" in {rt}." if rt else "."
            if n.get("lead"):
                s1 = n["lead"]
            # Sentence 2: hand note, or the runs that start at the top.
            if n.get("note") is not None:
                s2 = n["note"]
            else:
                runs = []
                for j, p in pistes.items():
                    if p["row"]["category"] == "snowshoeing":
                        continue
                    if near(p["top_pt"], lf["top"], 150):
                        runs.append((metres(*p["top_pt"], *lf["top"]), display(p["row"]), p["row"]["category"]))
                runs.sort()
                names = []
                for _, nm, _ in runs:
                    if nm not in names:
                        names.append(nm)
                names = names[:2]
                s2 = ""
                for cut in (2, 1):
                    if len(names) >= cut:
                        cand = (f"From the top you can ski down {names[0]}." if cut == 1 else
                                f"From the top you can ski down {names[0]} or {names[1]}.")
                        if len((s1 + " " + cand).split()) <= limit:
                            s2 = cand
                            break
            desc = " ".join(x for x in (s1, s2, s3) if x)
        else:
            p = pistes[i]
            n = p["note"]
            line = trails[i]
            lfacts = line_facts(line, "ski_trail")
            facts["length_m"] = length_fact(lfacts["slope_m"])
            facts["top_m"] = round10(lfacts["top_m"])
            facts["bottom_m"] = round10(lfacts["bottom_m"])
            if n.get("park"):
                facts["park"] = True
            cat = r["category"]
            m = osm.get(i) if osm.get(i, {}).get("ok") else None
            if m and plain(m.get("osm_name")) == plain(r["name"]):
                sources.append(OSM_URL + m["osm_id"])
            for s in n.get("sources", []):
                if s not in sources:
                    sources.append(s)
            L, T, B = fmt_len(lfacts["slope_m"]), fmt_alt(lfacts["top_m"]), fmt_alt(lfacts["bottom_m"])
            if cat == "snowshoeing":
                if p["loop"]:
                    s1 = f"This snowshoe trail is a {L} loop between {B} and {T}."
                else:
                    s1 = f"This snowshoe trail runs {L} between {B} and {T}."
            elif cat in COLOUR:
                c = COLOUR[cat]
                if round10(lfacts["top_m"]) - round10(lfacts["bottom_m"]) < 30:
                    s1 = f"This {c} run is {L} long and almost flat, at about {T}."
                else:
                    s1 = f"This {c} run drops from {T} to {B} over {L}."
            else:
                noun = n.get("noun", "run")
                s1 = f"This {noun} drops from {T} to {B} over {L}."
            if n.get("lead"):
                s1 = n["lead"].format(L=L, T=T, B=B)
            if n.get("note") is not None:
                s2 = n["note"]
            elif cat == "snowshoeing":
                s2 = ""
            else:
                # Short predicates ("is steep in places") join into one second sentence.
                import re
                import unicodedata
                ascii_name = unicodedata.normalize("NFKD", r["name"]).encode("ascii", "ignore").decode().lower()
                preds = list(n.get("preds", []))
                if re.match(r"(acces|jonction|lonction|aller|retour|route retour)", ascii_name):
                    preds.append("is a link run")
                m_osm = osm.get(i)
                if (m_osm and m_osm["ok"] and plain(m_osm.get("osm_name")) == plain(r["name"])
                        and m_osm["tags"].get("piste:grooming") == "backcountry" and cat in COLOUR):
                    preds.append("is usually left ungroomed")
                style = n.get("style")
                if style is None and cat in COLOUR and lfacts["top_m"] - lfacts["bottom_m"] >= 30:
                    st, mn = p["steep"], p["mean"]
                    if mn < 0.07:
                        style = "is mostly flat"
                    elif st < 0.22:
                        style = "is gentle all the way"
                    elif st >= 0.6:
                        style = "is very steep in places"
                    elif st >= 0.45:
                        style = "is steep in places"
                    elif st >= 0.35:
                        style = "has a few steeper pitches"
                # where it starts and ends
                top_lifts = [j for j, lf in lifts.items() if near(p["top_pt"], lf["top"], 150)]
                bot_lifts = [j for j, lf in lifts.items()
                             if near(p["bottom_pt"], lf["bottom"], 250 if lf["note"].get("place") else 150)]
                top_lifts.sort(key=lambda j: metres(*p["top_pt"], *lifts[j]["top"]))
                bot_lifts.sort(key=lambda j: metres(*p["bottom_pt"], *lifts[j]["bottom"]))
                a = None if n.get("no_from") or not top_lifts else lift_ref(top_lifts[0])
                b = None if n.get("no_to") or not bot_lifts else lift_ref(bot_lifts[0])
                place = lifts[bot_lifts[0]]["note"].get("place") if bot_lifts and not n.get("no_to") else None
                if place and lfacts["top_m"] - lfacts["bottom_m"] >= 100:
                    b = place
                else:
                    place = None
                if a and b and a == b:
                    b = None
                if n.get("where") is not None:
                    where = n["where"]
                elif a and b:
                    where = f"runs from the top of {a} down to {b}"
                elif a:
                    where = f"starts at the top of {a}"
                elif b:
                    where = f"runs down to {b}" if place else f"ends at {b}"
                else:
                    where = ""
                if n.get("extra"):
                    s2 = n["extra"]
                else:
                    chosen = []
                    for pr in preds + [where, style]:
                        if pr and len(chosen) < 2 and len((s1 + " It " + " and ".join(chosen + [pr])).split()) <= 30:
                            chosen.append(pr)
                    if len(chosen) == 2 and chosen[0].startswith("is ") and chosen[1].startswith("is "):
                        chosen[1] = chosen[1][3:]
                    s2 = ("It " + " and ".join(chosen) + ".") if chosen else ""
            desc = " ".join(x for x in (s1, s2) if x)
            if cat in COLOUR:
                facts["level"] = COLOUR[cat]
        out[i] = {"name": r["name"], "description": desc, "facts": facts, "sources": sources}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    save_json(out, OUT, indent=1)
    print("wrote", len(out), "entries ->", OUT)
    print("lift ride time sources:", stats)
    print("lift hours basis:", hours_stats)
    check_style(out)


def check_style(out):
    """Flag text that breaks the house rules."""
    import re
    bad = 0
    for i, e in out.items():
        d = e["description"]
        problems = []
        if re.search("[–—;]", d):
            problems.append("dash/semicolon")
        cap = MAX_LIFT_WORDS if "hours" in e["facts"] else 32
        if len(d.split()) > cap:
            problems.append(f"{len(d.split())} words")
        if re.search(r"\bnot\b.*\bit's\b", d, re.I):
            problems.append("not X it's Y")
        if problems:
            bad += 1
            print("  STYLE", e["name"], problems, "|", d)
    print("style problems:", bad)


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    if stage in ("base", "all"):
        stage_base()
    if stage in ("osm", "all"):
        stage_osm()
    if stage in ("rmnet", "all"):
        stage_rmnet()
    if stage in ("write", "all"):
        stage_write()
