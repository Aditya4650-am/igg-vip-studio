import io
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")
base = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server")
css = base / "src" / "styles.css"

anchor = """.app-root .chip-emoji-glyph {
  font-family: "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif !important;
  font-size: 1.2rem !important;
  filter: saturate(1.05) !important;
}"""

extra = anchor + """

.app-root .stat-card {
  border: 1px solid rgba(38, 50, 74, 0.85) !important;
  border-radius: 0.8rem !important;
  background: linear-gradient(160deg, rgba(20, 28, 47, 0.98), rgba(10, 14, 26, 0.99)) !important;
  box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.1), 0 18px 44px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;
  transition: border-color 160ms ease, box-shadow 180ms ease, transform 140ms ease !important;
}
.app-root .stat-card:hover {
  border-color: rgba(167, 139, 250, 0.22) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 0 20px rgba(124, 58, 237, 0.24) !important;
  transform: translateY(-1px) !important;
}
.app-root .stat-title {
  font-family: "Syne", "Inter", ui-sans-serif, system-ui, sans-serif !important;
  font-weight: 700 !important;
  font-size: 0.78rem !important;
  letter-spacing: 0.05em !important;
  text-transform: uppercase !important;
  color: rgba(241, 245, 255, 0.96) !important;
}
.app-root .stat-asset {
  width: 2.1rem !important;
  height: 2.1rem !important;
  border-radius: 0.55rem !important;
  border: 1px solid rgba(167, 139, 250, 0.35) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 10px rgba(124, 58, 237, 0.2) !important;
}
.app-root .stat-emoji {
  display: inline-grid !important;
  place-items: center !important;
  width: 2.1rem !important;
  height: 2.1rem !important;
  font-family: "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif !important;
  font-size: 1.2rem !important;
  border-radius: 0.55rem !important;
  border: 1px solid rgba(167, 139, 250, 0.35) !important;
  background: linear-gradient(150deg, rgba(124, 58, 237, 0.2), rgba(10, 14, 26, 0.7)) !important;
}
.app-root .stat-icon { color: #a78bfa !important; }
.app-root .stat-card .field-stat,
.app-root .field-stat {
  font-family: "JetBrains Mono", ui-monospace, monospace !important;
  font-weight: 700 !important;
  font-size: 0.92rem !important;
  border-radius: 0.6rem !important;
  border: 1px solid rgba(56, 189, 248, 0.22) !important;
  background: rgba(7, 10, 19, 0.6) !important;
  color: #bae6fd !important;
}

.app-root .device-selector-card,
.app-root .sidebar-tools,
.app-root .sidebar-log {
  border: 1px solid rgba(38, 50, 74, 0.85) !important;
  border-radius: 0.9rem !important;
  background: linear-gradient(160deg, rgba(20, 28, 47, 0.98), rgba(10, 14, 26, 0.99)) !important;
  box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.1), 0 18px 44px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06) !important;
}
"""

data = css.read_bytes()
text = data.decode("utf-8-sig")
if anchor not in text:
    out.write("ANCHOR-MISSING\n")
else:
    text = text.replace(anchor, extra, 1)
    css.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
    out.write("part3-appended\n")
