import io
import re
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")
base = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server")
css = base / "src" / "styles.css"

data = css.read_bytes()
text = data.decode("utf-8-sig")

fixes = {
    'content: "\\U0001f4ca";': 'content: "\\01F4CA";',
    'content: "\\U0001f464";': 'content: "\\01F464";',
    'content: "\\U0001f9d1";': 'content: "\\01F9D1";',
    'content: "\\U0001f3a8";': 'content: "\\01F3A8";',
    'content: "\\U0001f6e1";': 'content: "\\01F6E1";',
    'content: "\\u2728";': 'content: "\\02728";',
    'content: "\\U0001f35f";': 'content: "\\01F35F";',
    'content: "\\U0001f4e6";': 'content: "\\01F4E6";',
    'content: "\\U0001f3ec";': 'content: "\\01F3EC";',
    'content: "\\U0001f33e";': 'content: "\\01F33E";',
}
applied = 0
for old, new in fixes.items():
    if old in text:
        text = text.replace(old, new)
        applied += 1
        out.write("swapped %r -> %r\n" % (old, new))
out.write("swapped-count=%d\n" % applied)

pattern = re.compile(r'\.feature-tab:nth-of-type\((\d+)\)::before \{ content: "((?:[^"\\]|\\.)*)"; \}')
icons = ["01F4CA", "01F464", "01F9D1", "01F3A8", "01F6E1", "02728", "01F35F", "01F4E6", "01F3EC", "01F33E"]

def rebuild(match):
    idx = int(match.group(1)) - 1
    if 0 <= idx < len(icons):
        return '.feature-tab:nth-of-type(%d)::before { content: "\\%s"; }' % (idx + 1, icons[idx])
    return match.group(0)

text, n = pattern.subn(rebuild, text)
out.write("normalized=%d\n" % n)
css.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
out.write("wrote-bytes=%d\n" % len(css.read_bytes()))
