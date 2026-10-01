#!/usr/bin/env python3
"""Wrap game.html (the page body, as published to claude.ai) into a standalone
index.html for the public web link (GitHub Pages)."""
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
(here / "index.html").write_text(head + body + "\n</body>\n</html>\n", encoding="utf-8")
print("wrote", here / "index.html")
