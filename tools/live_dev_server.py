"""Local stand-in for the live-location Worker (server/live-location/worker.js), for testing only.

Same API and rules, positions kept in memory (a dict shaped like the "pos" table).
    python tools/live_dev_server.py [--seed]   # http://127.0.0.1:8787/pos (--seed: 2 offline skiers)
Then open http://127.0.0.1:8000/?shareapi=http://127.0.0.1:8787/pos
"""
import hashlib, json, re, sys, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEEP_MS, MIN_GAP_MS, MAX_OTHERS, SHOW_MS = 2 * 24 * 3600 * 1000, 20 * 1000, 300, 14 * 3600 * 1000
AREA = {"w": 6.45, "s": 46.03, "e": 6.98, "n": 46.32}
ORIGINS = ["https://ophirmil12.github.io", "http://127.0.0.1:8000", "http://localhost:8000"]
BAD_CHARS = re.compile(r"[\x00-\x1f\x7f<>]")
POS = {}   # id -> row, like the "pos" table in server/live-location/schema.sql


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
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_POST(self):
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
