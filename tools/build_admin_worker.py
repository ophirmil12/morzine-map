"""Build the single-file admin Worker to paste into the Cloudflare dashboard.

Puts server/live-location/admin/page.html into server/live-location/admin/worker-src.js
(in place of __PAGE__) and writes server/live-location/admin-worker.js.
    python -I tools/build_admin_worker.py
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "server", "live-location", "admin")

with open(os.path.join(SRC, "worker-src.js"), encoding="utf-8") as fh:
    worker = fh.read()
with open(os.path.join(SRC, "page.html"), encoding="utf-8") as fh:
    page = fh.read()
assert worker.count("__PAGE__") == 2, "expected the __PAGE__ marker (once in a comment, once in code)"
code = worker.replace("const PAGE = __PAGE__;", "const PAGE = " + json.dumps(page, ensure_ascii=False) + ";")
code = ("// BUILT FILE: edit admin/worker-src.js and admin/page.html, then run tools/build_admin_worker.py.\n" + code)
out = os.path.join(ROOT, "server", "live-location", "admin-worker.js")
with open(out, "w", encoding="utf-8") as fh:
    fh.write(code)
print("wrote", out, f"({len(code) // 1024} KB)")
