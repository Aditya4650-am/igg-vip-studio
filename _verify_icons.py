import io
import re
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")
base = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server")
css = base / "src" / "styles.css"

data = css.read_bytes()
text = data.decode("utf-8-sig")

pattern = re.compile(r'\.feature-tab:nth-of-type\((\d+)\)::before \{ content: "((?:[^"\\]|\\.)*)"; \}')
matches = list(pattern.finditer(text))
out.write("matches=%d\n" % len(matches))
for m in matches:
    out.write("%s icon=%r\n" % (m.group(1), m.group(2)))
