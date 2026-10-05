#!/usr/bin/env python3
"""Build the web versions of Cubefire Arena from game.html (the page body, as
published to claude.ai).

- index.html: standalone page for a static host, loading vendor/ files.
- cubefire-arena-single-file.html: everything inlined (three.js and the
  peer-to-peer networking code), so the one file runs on any host.
- server/public/index.html: the single file again, served by the Cloudflare
  Worker in server/ alongside the multiplayer relay.
"""
from pathlib import Path

here = Path(__file__).parent
body = (here / "game.html").read_text(encoding="utf-8")
head = (
    '<!doctype html>\n<html lang="en">\n<head>\n'
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">\n'
    '<meta name="apple-mobile-web-app-capable" content="yes">\n'
    '<meta name="mobile-web-app-capable" content="yes">\n'
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n'
    '<meta name="theme-color" content="#0b1016">\n'
    '<meta name="description" content="Free-for-all voxel shooter. Play online with friends on any device.">\n'
    '</head>\n<body>\n'
)
tail = "\n</body>\n</html>\n"

(here / "index.html").write_text(head + body + tail, encoding="utf-8")
print("wrote", here / "index.html")

THREE_TAG = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>'
assert body.count(THREE_TAG) == 1, "three.js script tag not found in game.html"
three = (here / "vendor" / "three-r128.min.js").read_text(encoding="utf-8")
p2p = (here / "vendor" / "trystero-nostr.min.js").read_text(encoding="utf-8")
EXPORTS = "export{Ss as joinRoom,G as selfId};"
assert p2p.count(EXPORTS) == 1, "networking bundle exports changed; update build.py"
for name, src in (("three.js", three), ("networking", p2p)):
    assert "</script" not in src.lower(), name + " contains a closing script tag"
p2p = p2p.replace(EXPORTS, 'window.__cfaP2P={joinRoom:Ss,selfId:G};dispatchEvent(new Event("cfa-p2p-ready"));')

inline = (
    '<script type="module" id="cfa-p2p">' + p2p + "</script>\n"
    "<script>" + three + "</script>"
)
single = head + body.replace(THREE_TAG, inline) + tail
(here / "cubefire-arena-single-file.html").write_text(single, encoding="utf-8")
print("wrote", here / "cubefire-arena-single-file.html", f"({len(single.encode()) // 1024} KB)")

public = here / "server" / "public"
public.mkdir(parents=True, exist_ok=True)
(public / "index.html").write_text(single, encoding="utf-8")
print("wrote", public / "index.html")
