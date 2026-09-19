import io
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")
base = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server")
css = base / "src" / "styles.css"

old = '.feature-tab:nth-of-type(9)::before { content: "\\01F4E6"; }'
new = '.feature-tab:nth-of-type(9)::before { content: "\\01F4E6"; }'
data = css.read_bytes()
text = data.decode("utf-8-sig")
targets = [
    ('.feature-tab:nth-of-type(8)::before { content: "\\01F4E6"; }',
     '.feature-tab:nth-of-type(8)::before { content: "\\01F0CF"; }'),
    ('.feature-tab:nth-of-type(9)::before { content: "\\01F4E6"; }',
     '.feature-tab:nth-of-type(9)::before { content: "\\01F6D2"; }'),
]
for src, dst in targets:
    if src in text:
        text = text.replace(src, dst, 1)
        out.write("swapped icon for: %s\n" % src.split("nth-of-type(")[1][:2])
    else:
        out.write("MISSING: %s\n" % src[:70])
css.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
out.write("done\n")
