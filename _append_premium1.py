import io
import sys
from pathlib import Path

out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="backslashreplace")
base = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server")
css = base / "src" / "styles.css"

old_tail = """.app-root .inventory-group header button {
  font-size: 0.7rem !important;"""

block = old_tail + """
  font-weight: 700 !important;
  letter-spacing: 0.05em !important;
  text-transform: uppercase !important;
}

/* PREMIUM VISUAL SYSTEM UPGRADE: headings, feature cards, sidebar.
   R1. Every tab pill shows exactly one icon + one uppercase label.
   R2. Stat cards always render icon well + title + mono value field.
   R3. All headings use Syne/Inter with fixed weight scale. */

.app-root {
  --premium-card-fill: linear-gradient(160deg, rgba(20, 28, 47, 0.98), rgba(10, 14, 26, 0.99));
  --premium-card-edge: rgba(167, 139, 250, 0.22);
  --premium-card-glow: 0 0 0 1px rgba(167, 139, 250, 0.1), 0 18px 44px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  --premium-gold: #f8dea0;
  --premium-gold-soft: rgba(248, 222, 160, 0.72);
}

.app-root .feature-tabs {
  display: flex !important;
  align-items: stretch !important;
  gap: 0.4rem !important;
  overflow-x: auto !important;
  padding: 0.65rem 0.75rem 0 !important;
  scrollbar-width: none !important;
}
.app-root .feature-tabs::-webkit-scrollbar { display: none !important; }
.app-root button.feature-tab {
  flex: 1 0 6.4rem !important;
  min-height: 3.4rem !important;
  border: 1px solid rgba(38, 50, 74, 0.85) !important;
  border-bottom: 0 !important;
  border-radius: 0.8rem 0.8rem 0 0 !important;
  background: linear-gradient(180deg, rgba(21, 30, 50, 0.92), rgba(12, 17, 30, 0.96)) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
  white-space: normal !important;
}
.app-root button.feature-tab span:not([class]) {
  display: block !important;
  overflow: visible !important;
  text-overflow: clip !important;
  white-space: normal !important;
  line-height: 1.25 !important;
}
.app-root button.feature-tab--active {
  border-color: rgba(167, 139, 250, 0.55) !important;
  background: linear-gradient(180deg, rgba(124, 58, 237, 0.28), rgba(31, 24, 64, 0.96)) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 18px rgba(124, 58, 237, 0.28) !important;
}
.app-root .feature-tab-icon {
  width: 1.25rem !important;
  height: 1.25rem !important;
  flex-shrink: 0 !important;
  color: #a78bfa !important;
  filter: drop-shadow(0 0 6px rgba(167, 139, 250, 0.35)) !important;
}
.app-root button.feature-tab--active .feature-tab-icon { color: #f8dea0 !important; }
.app-root .feature-tab::before {
  color: #c4b5fd !important;
  filter: saturate(1) drop-shadow(0 1px 3px rgba(0, 0, 0, 0.5)) !important;
}
.app-root button.feature-tab--active::before {
  filter: saturate(1.15) drop-shadow(0 0 6px rgba(248, 222, 160, 0.5)) !important;
}
"""

data = css.read_bytes()
text = data.decode("utf-8-sig")
if old_tail not in text:
    out.write("ANCHOR-MISSING\n")
else:
    text = text.replace(old_tail, block, 1)
    css.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))
    out.write("part1-appended\n")
