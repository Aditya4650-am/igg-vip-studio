"""Rebuild client/icon.ico from the app header brand image (public/logo.jpeg).

Same logo the header shows next to "IGG VIP TOOL". Full Windows size
ladder so taskbar, Alt-Tab, window chrome and Explorer all render sharp.
Run: python3 make-exe-icon.py
"""

from PIL import Image

SRC = "public/logo.jpeg"
DST = "client/icon.ico"
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

img = Image.open(SRC).convert("RGBA")
assert img.width == img.height, "logo must stay square, got %s" % (img.size,)
img.save(DST, sizes=SIZES)

check = Image.open(DST)
print("wrote", DST, "sizes:", sorted(check.info.get("sizes", [])))
assert set(check.info.get("sizes", [])) == set(SIZES), "size ladder incomplete"
print("ok")
