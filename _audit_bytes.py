import io
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")
base = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server")

for name in ("src\\styles.css", "src\\components\\studio-app.tsx"):
    path = base / name
    data = path.read_bytes()
    n = len(data)
    suspect = 0
    i = 0
    while i < n:
        b = data[i]
        if b < 0x80:
            i += 1
            continue
        if 0xC2 <= b <= 0xDF and i + 1 < n and 0x80 <= data[i + 1] <= 0xBF:
            i += 2
            continue
        if 0xE0 <= b <= 0xEF and i + 2 < n and 0x80 <= data[i + 1] <= 0xBF and 0x80 <= data[i + 2] <= 0xBF:
            i += 3
            continue
        if 0xF0 <= b <= 0xF4 and i + 3 < n and 0x80 <= data[i + 1] <= 0xBF and 0x80 <= data[i + 2] <= 0xBF and 0x80 <= data[i + 3] <= 0xBF:
            i += 4
            continue
        if b in (0xEF, 0xBB, 0xBF):
            i += 1
            continue
        suspect += 1
        line = data[:i].count(0x0A) + 1
        start = max(0, i - 40)
        out.write("%s line=%d offset=%d window=%r\n" % (name, line, i, data[start:i + 40]))
        if suspect > 60:
            break
        i += 1
    out.write("%s suspect-bytes=%d\n" % (name, suspect))
