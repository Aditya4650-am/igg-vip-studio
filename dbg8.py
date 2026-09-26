import re

src = open("src/lib/server/township/decor-stash.server.ts", encoding="utf-8").read()
items = re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)
by_label = {l: d for d, l in items}

m = open("src/lib/game-icon-map.ts", encoding="utf-8").read()
mm = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', m, re.S)
mapped = set(re.findall(r'"([^"]+)":\s*"/game-icons/', mm.group(1)))

for lab in ("flower house", "aquariumHouse fishing", "beauty flowerhouse",
            "beauty greengrocery", "beauty fireworkshop", "beauty seahouse decoration"):
    in_cat = lab in by_label
    in_map = lab in mapped
    print(repr(lab), "in-cat:", in_cat, "mapped:", in_map)