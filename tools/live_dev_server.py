"""Local stand-in for the live-location Worker (server/live-location/worker.js), for testing only.

Same API and rules, positions kept in memory (a dict shaped like the "pos" table).
    python tools/live_dev_server.py [--seed]   # http://127.0.0.1:8787/pos (--seed: 2 offline skiers)
Then open http://127.0.0.1:8000/?shareapi=http://127.0.0.1:8787/pos
Admin page for testing, WITHOUT the login: http://127.0.0.1:8787/admin
"""
import hashlib, json, re, sys, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEEP_MS, MIN_GAP_MS, MAX_OTHERS, SHOW_MS = 2 * 24 * 3600 * 1000, 20 * 1000, 300, 14 * 3600 * 1000
AREA = {"w": 6.45, "s": 46.03, "e": 6.98, "n": 46.32}
ORIGINS = ["https://ophirmil12.github.io", "http://127.0.0.1:8000", "http://localhost:8000"]
BAD_CHARS = re.compile(r"[\x00-\x1f\x7f<>]")
POS = {}   # id -> row, like the "pos" table in server/live-location/schema.sql
TRACK = []  # rows of the "track" table (emergency record), here without thinning
SETTINGS = {"sharing_off": False}
PLACES = {"house-1": {"id": "house-1", "name": "House", "emoji": "🏠", "color": "#B45309",
                      "description": "1130 Route de la Côte, 74110 La Côte-d'Arbroz, France",
                      "lat": 46.1901, "lon": 6.673783, "updated": 0}}
ROOT = __import__("os").path.dirname(__import__("os").path.dirname(__import__("os").path.abspath(__file__)))


def public_key(uid):
    return hashlib.sha256(("morzine-live:" + uid).encode()).hexdigest()[:12]


def handle(body):
    uid = str(body.get("id") or "")
    if not re.fullmatch(r"[0-9a-f-]{36}", uid):
        return 400, {"error": "bad id"}
    now = int(time.time() * 1000)
    for k in [k for k, r in POS.items() if r["t"] < now - KEEP_MS]:
        del POS[k]
    if body.get("stop"):
        POS.pop(uid, None)
        return 200, {"sharing": False, "others": []}
    if SETTINGS["sharing_off"]:
        POS.pop(uid, None)
        return 200, {"sharing": False, "disabled": True, "others": []}
    outside = False
    lat, lon = body.get("lat"), body.get("lon")
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
        if not (AREA["s"] <= lat <= AREA["n"] and AREA["w"] <= lon <= AREA["e"]):
            outside = True
            POS.pop(uid, None)
        elif uid not in POS or now - POS[uid]["t"] >= MIN_GAP_MS:
            name = BAD_CHARS.sub("", str(body.get("name") or "")).strip()[:24]
            acc = max(0, min(10000, round(float(body.get("acc") or 0))))
            POS[uid] = {"pub": public_key(uid), "name": name, "lat": round(lat, 5), "lon": round(lon, 5),
                        "acc": acc, "t": now}
            TRACK.append({"id": uid, "name": name, "lat": round(lat, 5), "lon": round(lon, 5), "acc": acc, "t": now})
    if uid not in POS:
        return 200, {"sharing": False, "others": [], "outside": outside}
    # (the real Worker shows everyone since 6:00 French time; here simply the last 14 hours)
    rows = sorted((r for k, r in POS.items() if k != uid and r["t"] > now - SHOW_MS), key=lambda r: -r["t"])[:MAX_OTHERS]
    others = [{"k": r["pub"], "name": r["name"], "lat": r["lat"], "lon": r["lon"], "acc": r["acc"],
               "age": round((now - r["t"]) / 1000)} for r in rows]
    return 200, {"sharing": True, "others": others, "outside": outside}


class Handler(BaseHTTPRequestHandler):
    def cors(self):
        origin = self.headers.get("Origin", "")
        self.send_header("Access-Control-Allow-Origin", origin if origin in ORIGINS else ORIGINS[0])
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")

    def send_json(self, status, out, cors=True):
        data = json.dumps(out, ensure_ascii=False).encode()
        self.send_response(status)
        if cors:
            self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/places":
            return self.send_json(200, {"places": sorted(PLACES.values(), key=lambda p: p["name"])})
        if path == "/admin":   # the admin page, WITHOUT the Cloudflare Access login (local testing only)
            page = open(__import__("os").path.join(ROOT, "server", "live-location", "admin", "page.html"), encoding="utf-8").read()
            page = page.replace("fetch(path", "fetch('/admin' + path")   # API lives under /admin/api here
            data = page.encode()
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            return
        if path == "/admin/api/state":
            now = int(time.time() * 1000)
            people = {}
            for r in TRACK:
                p = people.setdefault(r["id"], {"id": r["id"], "name": r["name"], "first": r["t"], "last": r["t"], "n": 0})
                p["first"] = min(p["first"], r["t"]); p["last"] = max(p["last"], r["t"]); p["n"] += 1
                p["name"] = max(p["name"], r["name"])
            live = [{"id": k, "name": r["name"], "lat": r["lat"], "lon": r["lon"], "acc": r["acc"], "t": r["t"]}
                    for k, r in sorted(POS.items(), key=lambda kv: -kv[1]["t"])]
            return self.send_json(200, {"sharingOff": SETTINGS["sharing_off"], "now": now, "live": live,
                                        "people": sorted(people.values(), key=lambda p: -p["last"]),
                                        "places": sorted(PLACES.values(), key=lambda p: p["name"]), "user": "local test", "loginOn": False})
        if path == "/admin/api/track":
            uid = dict(x.split("=", 1) for x in query.split("&") if "=" in x).get("id", "")
            return self.send_json(200, {"points": [r for r in TRACK if r["id"] == uid]})
        self.send_json(404, {"error": "not found"})

    def admin_post(self, path, body):
        if self.headers.get("X-Admin") != "1":
            return 403, {"error": "refused"}
        if path == "/admin/api/settings":
            SETTINGS["sharing_off"] = bool(body.get("sharingOff")); return 200, {"ok": True}
        if path == "/admin/api/places":
            pid = body.get("id") or "place-" + uuid.uuid4().hex[:8]
            if not body.get("name"):
                return 400, {"error": "Name, position and colour are needed."}
            PLACES[pid] = {"id": pid, "name": body["name"], "description": body.get("description", ""),
                           "emoji": body.get("emoji") or "📍", "color": body.get("color", "#b45309"),
                           "lat": float(body["lat"]), "lon": float(body["lon"]), "updated": int(time.time() * 1000)}
            return 200, {"ok": True, "id": pid}
        if path == "/admin/api/places/delete":
            PLACES.pop(body.get("id"), None); return 200, {"ok": True}
        if path == "/admin/api/clear":
            if body.get("confirm") != "DELETE ALL":
                return 400, {"error": "not confirmed"}
            POS.clear(); TRACK.clear(); return 200, {"ok": True}
        return 404, {"error": "not found"}

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_POST(self):
        if self.path.startswith("/admin/api/"):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            status, out = self.admin_post(self.path, body)
            return self.send_json(status, out, cors=False)
        if self.path != "/pos":
            status, out = 404, {"error": "not found"}
        else:
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                status, out = handle(body if isinstance(body, dict) else {})
            except ValueError:
                status, out = 400, {"error": "bad request"}
        data = json.dumps(out).encode()
        self.send_response(status); self.cors()
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data)))
        self.end_headers(); self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8787
    if "--seed" in sys.argv:   # two people who stopped sending a while ago, to see "offline" dots
        t0 = int(time.time() * 1000)
        for name, lat, lon, mins in (("Lea", 46.1735, 6.6990, 25), ("Max", 46.1622, 6.6950, 130)):
            uid = str(uuid.uuid4())
            POS[uid] = {"pub": public_key(uid), "name": name, "lat": lat, "lon": lon, "acc": 10, "t": t0 - mins * 60000}
    print(f"live-location dev server on http://127.0.0.1:{port}/pos", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
