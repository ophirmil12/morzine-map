"""Find the bottom station of every lift, so its line can be drawn from bottom to top
(the map draws direction arrows along the line).

Reads the lift lines in site/data/trails.json and the elevation tiles in site/tiles/dem (zoom 14),
and writes data_src/lift_bottoms.json: {id: [lon, lat] of the lower end}, plus "flat": lifts that
climb less than 15 m (carpets, rope tows), which get no arrows. tools/fetch_site_data.py
then turns each lift line so it starts at that point. Running this again gives the same answer
whichever way the lines currently point.

Needs Pillow:  C:/Users/Owner/tools/video-venv/Scripts/python.exe tools/lift_bottoms.py
"""
import json, math, os, sys, time
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
Z = 14
_tiles = {}


def elevation(lon, lat):
    n = 2 ** Z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    key = (int(x), int(y))
    if key not in _tiles:
        path = os.path.join(ROOT, "site", "tiles", "dem", str(Z), str(key[0]), f"{key[1]}.png")
        _tiles[key] = Image.open(path).convert("RGB") if os.path.exists(path) else None
    im = _tiles[key]
    if im is None:
        return None
    r, g, b = im.getpixel((min(255, int((x % 1) * 256)), min(255, int((y % 1) * 256))))
    return r * 256 + g + b / 256 - 32768


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    with open(os.path.join(ROOT, "site", "data", "trails.json"), encoding="utf-8") as fh:
        feats = json.load(fh)["features"]
    with open(os.path.join(ROOT, "site", "data", "content", "en.json"), encoding="utf-8") as fh:
        names = {k: v["name"] for k, v in json.load(fh)["items"].items()}
    out, flat, flat_ids = {}, [], []
    for f in feats:
        p = f["properties"]
        if p["family"] != "ski_lift":
            continue
        line = max(f["geometry"]["coordinates"], key=len)
        a, b = line[0], line[-1]
        ea, eb = elevation(*a), elevation(*b)
        if ea is None or eb is None:
            print("no elevation for", names.get(p["id"], p["id"]))
            continue
        out[p["id"]] = a if ea <= eb else b
        if abs(ea - eb) < 15:   # carpets and rope tows: no reliable direction, so no arrows
            flat_ids.append(p["id"])
            flat.append(f"{names.get(p['id'], p['id'])} ({abs(ea - eb):.0f} m)")
    with open(os.path.join(ROOT, "data_src", "lift_bottoms.json"), "w", encoding="utf-8") as fh:
        json.dump({"about": "Bottom station [lon, lat] of each lift, from the DEM (tools/lift_bottoms.py). "
                            "fetch_site_data.py draws each lift line from this end, so arrows point up.",
                   "made": time.strftime("%Y-%m-%d"), "bottoms": out, "flat": flat_ids}, fh, indent=1)
    print(f"lifts: {len(out)}")
    if flat:
        print("nearly flat (direction unsure):", ", ".join(flat))


if __name__ == "__main__":
    main()
