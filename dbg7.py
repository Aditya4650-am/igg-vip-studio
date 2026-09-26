import re

src = open("src/lib/server/township/decor-stash.server.ts", encoding="utf-8").read()
items = re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)
for did, label in items:
    if "SmallWaterfall" in did or "Small Waterfall" in label or "Cafe_Waterfall" in did:
        print(repr(did), "||", repr(label))

m = open("src/lib/game-icon-map.ts", encoding="utf-8").read()
mm = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', m, re.S)
keys = set(re.findall(r'"([^"]+)":\s*"/game-icons/', mm.group(1)))
for k in ("Small Waterfall", "SmallWaterfall", "Cafe Waterfall", "beauty swing giraffe"):
    print(k, "mapped:", k in keys)
