from pathlib import Path

for name in ("src\\styles.css", "src\\lib\\i18n.ts", "src\\components\\studio-app.tsx", "src\\lib\\game-icon-map.ts"):
    path = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server") / name
    data = path.read_bytes()
    text = data.decode("utf-8-sig").replace("ð", "")
    bad = sum(text.count(c) for c in "ÝÞßÞàÞ")
    print(name, "bytes=", len(data), "leftover-markers=", bad, "has-replacement=", "�" in text)
    try:
        raw = text.encode("cp1252")
        fixed = raw.decode("utf-8")
        changed = sum(1 for a, b in zip(text, fixed) if a != b) + abs(len(text) - len(fixed))
        print("  unmojibake-diffs=", changed, "fixedlen=", len(fixed))
    except Exception as exc:
        print("  unmojibake-error=", type(exc).__name__, str(exc)[:160])
