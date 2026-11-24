"""Download AWS Terrarium DEM tiles covering a bbox into a local {z}/{x}/{y}.png tree.

Stdlib only. Example:
    python tools/download_dem.py --bbox 6.56,46.09,6.89,46.26 --minzoom 8 --maxzoom 14
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SOURCE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ATTRIBUTION = "https://github.com/tilezen/joerd/blob/master/docs/attribution.md"
USER_AGENT = "morzine-map-dem-download/1.0"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    lat = max(min(lat, 85.05112878), -85.05112878)
    x = int((lon + 180.0) / 360.0 * n)
    lr = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lr)) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tiles_for_bbox(bbox, z):
    west, south, east, north = bbox
    x0, y0 = lonlat_to_tile(west, north, z)
    x1, y1 = lonlat_to_tile(east, south, z)
    return [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def fetch(z, x, y, out, retries=5, timeout=30):
    dest = out / str(z) / str(x) / f"{y}.png"
    if dest.exists() and dest.stat().st_size > 0:
        return "skipped", dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = SOURCE.format(z=z, x=x, y=y)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    delay = 1.0
    last = None
    for _ in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            if not data.startswith(b"\x89PNG"):
                raise ValueError("response is not a PNG")
            tmp = dest.with_suffix(".png.part")
            tmp.write_bytes(data)
            os.replace(tmp, dest)
            return "downloaded", dest
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 404:
                break
        except Exception as e:  # network errors, timeouts, bad data
            last = e
        time.sleep(delay)
        delay *= 2
    return f"failed: {last}", dest


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bbox", default="6.56,46.09,6.89,46.26",
                   help="west,south,east,north in degrees")
    p.add_argument("--minzoom", type=int, default=8)
    p.add_argument("--maxzoom", type=int, default=14)
    p.add_argument("--out", default=str(PROJECT_ROOT / "site" / "tiles" / "dem"),
                   help="output folder (relative paths resolve against the project root)")
    p.add_argument("--threads", type=int, default=4)
    a = p.parse_args()

    bbox = [float(v) for v in a.bbox.split(",")]
    if len(bbox) != 4:
        p.error("--bbox needs west,south,east,north")
    out = Path(a.out)
    if not out.is_absolute():
        out = PROJECT_ROOT / out

    jobs = []
    for z in range(a.minzoom, a.maxzoom + 1):
        t = tiles_for_bbox(bbox, z)
        print(f"z{z}: {len(t)} tiles")
        jobs.extend(t)

    counts = {"downloaded": 0, "skipped": 0}
    failures = []
    with ThreadPoolExecutor(max_workers=a.threads) as ex:
        futs = {ex.submit(fetch, z, x, y, out): (z, x, y) for z, x, y in jobs}
        for i, f in enumerate(as_completed(futs), 1):
            status, _ = f.result()
            if status in counts:
                counts[status] += 1
            else:
                failures.append((futs[f], status))
            if i % 100 == 0 or i == len(jobs):
                print(f"  {i}/{len(jobs)} done", flush=True)

    meta = {
        "encoding": "terrarium",
        "tileSize": 256,
        "minzoom": a.minzoom,
        "maxzoom": a.maxzoom,
        "bbox": bbox,
        "source": SOURCE,
        "attribution": ATTRIBUTION,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    total = sum(f.stat().st_size for f in out.rglob("*.png"))
    print(f"downloaded {counts['downloaded']}, skipped {counts['skipped']}, "
          f"failed {len(failures)}; {total / 1e6:.2f} MB of PNGs in {out}")
    for t, s in failures:
        print(f"  FAILED {t}: {s}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
