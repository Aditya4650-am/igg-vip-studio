import re

m = open("src/lib/game-icon-map.ts", encoding="utf-8").read()
mm = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', m, re.S)
keys = set(re.findall(r'"([^"]+)":\s*"/game-icons/', mm.group(1)))

for k in ("Small Waterfall", "beauty fireworkshop", "flower house", "aquariumHouse fishing"):
    print(k, k in keys)