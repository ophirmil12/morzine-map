"""Keep the deployed site small. Rerun after changing icons.js, index.html or the data.

    python tools/slim_assets.py

1. Site icons: keeps in site/assets/icons/ only the SVGs that js/icons.js names
   (the full set stays in cache/assets/icons_all/, from tools/extract_site_icons.py).
2. Material Symbols font: rewrites the Google Fonts link in index.html so it asks only for
   the glyphs the site can use (icon_names=...), a few KB instead of about 3 MB.
"""
import json
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
ICONS = os.path.join(SITE, "assets", "icons")
ALL = os.path.join(ROOT, "cache", "assets", "icons_all")


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def main():
    icons_js = read(os.path.join(SITE, "js", "icons.js"))
    index_html = read(os.path.join(SITE, "index.html"))
    app_js = read(os.path.join(SITE, "js", "app.js"))

    # 1. site icons
    if not os.path.isdir(ALL):
        shutil.copytree(ICONS, ALL)
    index = json.loads(read(os.path.join(ALL, "index.json")))
    quoted = set(re.findall(r"'([a-z0-9-]+)'", icons_js))
    used = sorted(n for n in index if n in quoted)
    for f in os.listdir(ICONS):
        if f.endswith(".svg"):
            os.remove(os.path.join(ICONS, f))
    for n in used:
        shutil.copy(os.path.join(ALL, f"{n}.svg"), ICONS)
    with open(os.path.join(ICONS, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({n: index[n] for n in used}, fh, indent=1, sort_keys=True)
    print(f"site icons kept: {len(used)} of {len(index)}")

    # 2. Material Symbols glyph list
    names = set(re.findall(r'class="ms"[^>]*>([a-z0-9_]+)<', index_html + app_js))
    for block in ("MATERIAL_ALIAS", "FAMILY_MATERIAL"):
        m = re.search(block + r"\s*=\s*\{(.*?)\};", icons_js, re.S)
        body = m.group(1)
        names |= set(re.findall(r"'([a-z0-9_]+)'", body))               # values (and quoted keys)
        names |= set(re.findall(r"(?:^|[\s,{])([a-z0-9_]+):", body))    # bare keys
    # weather icons (js/weather.js, WEATHER_ICON table)
    m = re.search(r"WEATHER_ICON\s*=\s*\[(.*?)\];", read(os.path.join(SITE, "js", "weather.js")), re.S)
    if m:
        names |= set(re.findall(r"'([a-z0-9_]+)'", m.group(1)))
    cats = json.loads(read(os.path.join(SITE, "data", "categories.json")))
    for group in cats.values():
        for v in group.values():
            if isinstance(v.get("icon"), str) and re.fullmatch(r"[a-z0-9_]+", v["icon"]):
                names.add(v["icon"])
    names.discard("_default")
    glyphs = ",".join(sorted(names))
    new_link = ("https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,500,1,0"
                f"&icon_names={glyphs}&display=block")
    html2, n = re.subn(r'https://fonts\.googleapis\.com/css2\?family=Material\+Symbols\+Rounded[^"]*', new_link, index_html)
    assert n == 1, "Material Symbols link not found in index.html"
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html2)
    print(f"Material Symbols glyphs requested: {len(names)}")


if __name__ == "__main__":
    main()
