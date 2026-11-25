"""Pretend skiers for testing live location sharing on localhost.

Each one moves along a real piste or lift from site/data/trails.json and posts its position to
the local stand-in server (tools/live_dev_server.py) every 20 seconds, like a phone that shares.
    python tools/live_demo_skiers.py [http://127.0.0.1:8787/pos]
Never point this at the real Worker.
"""
import json, math, os, sys, time, urllib.request, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787/pos"
EVERY_S = 20
SKIERS = [   # (name shown on the map, piste or lift name, metres moved per update)
    ("Noa", "Piste B", 120),
    ("Tom", "TC du Pleney", 160),
]


def load_lines():
    with open(os.path.join(ROOT, "site", "data", "trails.json"), encoding="utf-8") as fh:
        feats = json.load(fh)["features"]
    with open(os.path.join(ROOT, "site", "data", "content", "en.json"), encoding="utf-8") as fh:
        names = {k: v["name"] for k, v in json.load(fh)["items"].items()}
    return {names.get(f["properties"]["id"], ""): max(f["geometry"]["coordinates"], key=len) for f in feats}


def walker(line, step_m):
    """Yields points every step_m metres along the line, back and forth forever."""
    kx = 111320 * math.cos(math.radians(46.17))
    pts = line + line[::-1][1:]
    while True:
        carry = 0.0
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            seg = math.hypot((x2 - x1) * kx, (y2 - y1) * 111320)
            d = carry
            while d < seg:
                f = d / seg
                yield x1 + (x2 - x1) * f, y1 + (y2 - y1) * f
                d += step_m
            carry = d - seg


def post(body):
    req = urllib.request.Request(API, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


if __name__ == "__main__":
    lines = load_lines()
    skiers = [(str(uuid.uuid4()), name, walker(lines[where], step)) for name, where, step in SKIERS]
    print("demo skiers:", ", ".join(f"{n} on {w}" for n, w, _ in SKIERS), flush=True)
    try:
        while True:
            for uid, name, walk in skiers:
                lon, lat = next(walk)
                post({"id": uid, "name": name, "lat": round(lat, 5), "lon": round(lon, 5), "acc": 8})
            time.sleep(EVERY_S)
    finally:
        for uid, _, _ in skiers:
            try:
                post({"id": uid, "stop": True})
            except OSError:
                pass
