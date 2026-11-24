"""Split the original site's SVG icon sprite into one file per icon.

    python tools/extract_site_icons.py

Reads cache/assets/sprite.svg and cache/assets/logo.svg (downloaded from explore.morzine.com),
writes site/assets/icons/<name>.svg, site/assets/icons/index.json and site/assets/logo.svg.
index.json records whether an icon is single-colour ("mono": true); mono icons can be
recoloured, which the map markers do.
"""
import json
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "cache", "assets")
OUT = os.path.join(ROOT, "site", "assets", "icons")


def main():
    os.makedirs(OUT, exist_ok=True)
    sprite = open(os.path.join(SRC, "sprite.svg"), encoding="utf-8").read()
    defs = re.search(r"<defs>(.*?)</defs>", sprite, re.S)
    defs = defs.group(1) if defs else ""
    index = {}
    for m in re.finditer(r'<symbol([^>]*)id="i-([^"]+)"([^>]*)>(.*?)</symbol>', sprite, re.S):
        attrs, name, attrs2, body = m.group(1), m.group(2), m.group(3), m.group(4)
        vb = re.search(r'viewBox="([^"]+)"', attrs + attrs2).group(1)
        # Clip paths in this sprite only crop to the icon box; some are empty and hide the icon.
        body = re.sub(r'\s*clip-path="url\(#[^)]*\)"', "", body)
        fills = set(re.findall(r'(?:fill|stroke)="(#[0-9a-fA-F]{3,8}|[a-z]+)"', body)) - {
            "none", "currentColor", "white", "#fff", "#FFF", "#ffffff", "#000", "#000000", "black"}
        mono = not fills
        if mono:
            body = re.sub(r'fill="(#000|#000000|black)"', 'fill="currentColor"', body)
        # Bring along any clipPath/gradient the symbol refers to.
        needed = "".join(d for d in re.findall(r"<(?:clipPath|linearGradient|radialGradient|mask)[^>]*>.*?</(?:clipPath|linearGradient|radialGradient|mask)>", defs, re.S)
                         if re.search(r'id="([^"]+)"', d) and f'#{re.search(r"id=\"([^\"]+)\"", d).group(1)})' in body)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"'
               + (' fill="currentColor"' if mono else '') + '>'
               + (f"<defs>{needed}</defs>" if needed else "") + body.strip() + "</svg>\n")
        with open(os.path.join(OUT, f"{name}.svg"), "w", encoding="utf-8") as fh:
            fh.write(svg)
        index[name] = {"mono": mono, "viewBox": vb}
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1, sort_keys=True)
    shutil.copy(os.path.join(SRC, "logo.svg"), os.path.join(ROOT, "site", "assets", "logo.svg"))
    print(f"{len(index)} icons, {sum(v['mono'] for v in index.values())} single-colour")


if __name__ == "__main__":
    main()
