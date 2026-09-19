import io
import re
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")
base = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server")
css = base / "src" / "styles.css"

data = css.read_bytes()
text = data.decode("utf-8-sig")

fixes = [
    ('.feature-tab:nth-of-type(7)::before { content: "\\01F35F"; }',
     '.feature-tab:nth-of-type(7)::before { content: "\\01F3DF"; }'),
    ('.feature-tab:nth-of-type(9)::before { content: "\\01F3EC"; }',
     '.feature-tab:nth-of-type(9)::before { content: "\\01F4E6"; }'),
    ('content: "\\U0001f5a5\\ufe0f";',
     'content: "\\01F5A5";'),
    ('content: "\\U0001f4cb";',
     'content: "\\01F4CB";'),
]
applied = 0
for old, new in fixes:
    if old in text:
        text = text.replace(old, new)
        applied += 1
        out.write("swapped %r -> %r\n" % (old, new))
out.write("swapped-count=%d\n" % applied)
css.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
out.write("wrote-bytes=%d\n" % len(css.read_bytes()))
