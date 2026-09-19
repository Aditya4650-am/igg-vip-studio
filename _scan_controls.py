import io
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")

for name in ("src\\styles.css", "src\\lib\\i18n.ts", "src\\components\\studio-app.tsx"):
    path = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server") / name
    text = path.read_text(encoding="utf-8-sig")
    hits = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for col, ch in enumerate(line):
            code = ord(ch)
            if 0x80 <= code <= 0x9F or ch in "ÃÅÄÆÇ":
                hits.append((lineno, col, ch, line.strip()[:100]))
    out.write("===== %s hits=%d\n" % (name, len(hits)))
    for lineno, col, ch, sample in hits[:120]:
        out.write("%d %d U+%04X %s\n" % (lineno, col, ord(ch), sample.encode("unicode_escape").decode("ascii")))
