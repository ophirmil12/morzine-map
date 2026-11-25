"""Home-screen icons (web-app manifest and iPhone) from the site's skier icon.

White skier on the Morzine logo navy. Renders with headless Edge (Playwright), so run it with
the video-venv Python:  C:/Users/Owner/tools/video-venv/Scripts/python.exe tools/make_app_icons.py
Writes site/assets/app/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png.
"""
import os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "site", "assets", "app")
NAVY = "#252f46"   # the Morzine logo colour
svg = open(os.path.join(ROOT, "site", "assets", "icons", "alpine-skiing.svg"), encoding="utf-8").read()

# (file, size, share of the square the skier fills, rounded corners)
ICONS = [
    ("icon-192.png", 192, 0.62, False),
    ("icon-512.png", 512, 0.62, False),
    ("icon-maskable-512.png", 512, 0.50, False),   # maskable: keep inside the 80% safe zone
    ("apple-touch-icon.png", 180, 0.60, False),     # iPhone rounds the corners itself
]

with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge", headless=True)
    for name, size, share, _ in ICONS:
        pg = b.new_page(viewport={"width": size, "height": size}, device_scale_factor=1)
        g = round(size * share)
        pg.set_content(f"""<html><body style="margin:0;width:{size}px;height:{size}px;background:{NAVY};
            display:grid;place-items:center;color:#fff">
            <div style="width:{g}px;height:{g}px">{svg.replace('<svg ', '<svg width="100%" height="100%" ', 1)}</div>
            </body></html>""")
        pg.screenshot(path=os.path.join(OUT, name), omit_background=False)
        pg.close()
        print("wrote", name)
    b.close()
