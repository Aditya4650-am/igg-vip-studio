import re

src = open("src/lib/server/township/decor-stash.server.ts", encoding="utf-8").read()
items = re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)
print(len(items))
hits = [x for x in items if re.sub(r"[^a-z0-9]", "", x[0].lower()) == "christmastree"
        or re.sub(r"[^a-z0-9]", "", x[1].lower()) == "christmastree"]
print("christmastree hits:", hits)
hits2 = [x for x in items if "christmas" in x[0].lower()][:15]
print("christmas ids:", hits2)

m = open("src/lib/game-icon-map.ts", encoding="utf-8").read()
mm = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', m, re.S)
keys = set(re.findall(r'"([^"]+)":\s*"/game-icons/', mm.group(1)))
print("mapped:", len(keys))
print("christmas tree mapped:", "christmas tree" in keys, "| Christmas tree" in keys)
