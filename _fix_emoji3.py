import io
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")
base = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server")
css = base / "src" / "styles.css"

lines = css.read_text(encoding="utf-8-sig").splitlines(keepends=True)
start = next(i for i, line in enumerate(lines) if "Emoji taxonomy stays presentation-only" in line)
end = next(i for i, line in enumerate(lines) if ".feature-tab--active::before" in line)
out.write("block=%d..%d\n" % (start + 1, end + 1))

tabs = [
    ("1", "01F4CA", "Data Center"),
    ("2", "01F464", "Profile Studio"),
    ("3", "01F9D1", "Avatar Studio"),
    ("4", "01F3A8", "Skin Gallery"),
    ("5", "01F6E1", "Unban Center"),
    ("6", "02728", "Decor Studio"),
    ("7", "01F3DF", "Sticker Hub"),
    ("8", "01F4E6", "Cards"),
    ("9", "01F4E6", "Item Manager"),
    ("10", "01F33E", "Barn Inventory"),
]
order = {t[0]: i for i, t in enumerate(tabs)}
kept = {num: line for num, line in ((m.group(1), m.group(0)) for m in [])}
import re
found = {}
for line in lines[start:end]:
    m = re.search(r"\.feature-tab:nth-of-type\((\d+)\)::before", line)
    if m:
        found[m.group(1)] = line

block = []
block.append("/* Emoji taxonomy stays presentation-only; the existing Lucide-style glyphs\n")
block.append("   remain in place and continue to carry the accessible tab labels. */\n")
block.append(".feature-tab {\n")
block.append("  font-family: \"Inter\", \"Segoe UI\", ui-sans-serif, system-ui, sans-serif;\n")
block.append("  font-weight: 800;\n")
block.append("  font-size: 0.7rem;\n")
block.append("  line-height: 1.2;\n")
block.append("  letter-spacing: 0.035em;\n")
block.append("  text-transform: uppercase;\n")
block.append("  text-rendering: optimizeLegibility;\n")
block.append("  -webkit-font-smoothing: antialiased;\n")
block.append("}\n")
block.append(".feature-tab::before {\n")
block.append("  display: inline-block;\n")
block.append("  margin-right: 0.3rem;\n")
block.append("  font-size: 1.05rem;\n")
block.append("  line-height: 1;\n")
block.append('  font-family: "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif;\n')
block.append("  filter: saturate(1);\n")
block.append("  transform: translateY(-0.02rem);\n")
block.append("}\n")
block.append("\n")
for num, code, _label in tabs:
    src = found.get(num)
    m = re.search(r'\{ content: "((?:[^"\\]|\\.)*)"; \}', src) if src else None
    glyph = m.group(1) if m else ("\\" + code)
    block.append('.feature-tab:nth-of-type(%s)::before { content: "%s"; }\n' % (num, glyph))
block.append("\n")
lines[start:end] = block
css.write_bytes(b"\xef\xbb\xbf" + "".join(lines).encode("utf-8"))
out.write("wrote-lines=%d\n" % len(lines))
for line in lines[start:start + 26]:
    out.write(line)
