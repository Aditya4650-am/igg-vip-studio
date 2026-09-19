import io
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")
base = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server")
css = base / "src" / "styles.css"

anchor = ".app-root button.feature-tab--active::before {\n  filter: saturate(1.15) drop-shadow(0 0 6px rgba(248, 222, 160, 0.5)) !important;\n}"

extra = anchor + """

.app-root .kicker,
.app-root .inventory-group h3,
.app-root .sidebar-tools .kicker,
.app-root .sidebar-log .kicker,
.app-root .cards-hero-title,
.app-root .cards-friend-title,
.app-root .cards-slots-title {
  font-family: "Syne", "Inter", ui-sans-serif, system-ui, sans-serif !important;
  font-weight: 700 !important;
  letter-spacing: 0.09em !important;
  text-transform: uppercase !important;
  color: rgba(248, 222, 160, 0.72) !important;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.45) !important;
}
.app-root .inventory-group h3 { font-size: 0.74rem !important; }
.app-root .kicker { font-size: 0.68rem !important; }

.app-root .group-emoji {
  display: inline-grid !important;
  place-items: center !important;
  width: 1.7rem !important;
  height: 1.7rem !important;
  font-family: "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif !important;
  font-size: 1.05rem !important;
  line-height: 1 !important;
  border-radius: 0.5rem !important;
  border: 1px solid rgba(167, 139, 250, 0.35) !important;
  background: linear-gradient(150deg, rgba(124, 58, 237, 0.22), rgba(10, 14, 26, 0.7)) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 10px rgba(124, 58, 237, 0.2) !important;
}
.app-root .group-asset {
  width: 2rem !important;
  height: 2rem !important;
  border-radius: 0.5rem !important;
  border: 1px solid rgba(167, 139, 250, 0.35) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 10px rgba(124, 58, 237, 0.18) !important;
}

.app-root .inventory-chip {
  border: 1px solid rgba(38, 50, 74, 0.85) !important;
  border-radius: 0.7rem !important;
  background: linear-gradient(160deg, rgba(20, 28, 47, 0.98), rgba(10, 14, 26, 0.99)) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
  transition: border-color 160ms ease, box-shadow 180ms ease, transform 140ms ease !important;
}
.app-root .inventory-chip:hover {
  border-color: rgba(167, 139, 250, 0.5) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 16px rgba(124, 58, 237, 0.22) !important;
  transform: translateY(-1px) !important;
}
.app-root .inventory-chip[aria-pressed="true"] {
  border-color: rgba(251, 191, 36, 0.55) !important;
  background: linear-gradient(150deg, rgba(180, 83, 9, 0.2), rgba(14, 12, 8, 0.85)) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 18px rgba(245, 158, 11, 0.2) !important;
}
.app-root .chip-label {
  font-family: "Inter", "Segoe UI", ui-sans-serif, system-ui, sans-serif !important;
  font-weight: 600 !important;
  font-size: 0.8rem !important;
  letter-spacing: 0.01em !important;
  color: rgba(241, 245, 255, 0.95) !important;
}
.app-root .chip-asset {
  border: 1px solid rgba(167, 139, 250, 0.32) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 10px rgba(124, 58, 237, 0.18) !important;
}
.app-root .chip-emoji {
  border: 1px solid rgba(167, 139, 250, 0.32) !important;
  background: linear-gradient(150deg, rgba(124, 58, 237, 0.2), rgba(10, 14, 26, 0.7)) !important;
}
.app-root .chip-emoji-glyph {
  font-family: "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif !important;
  font-size: 1.2rem !important;
  filter: saturate(1.05) !important;
}
"""

data = css.read_bytes()
text = data.decode("utf-8-sig")
if anchor not in text:
    out.write("ANCHOR-MISSING\n")
else:
    text = text.replace(anchor, extra, 1)
    css.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
    out.write("part2-appended\n")
