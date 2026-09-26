import re

src = open("src/lib/server/township/decor-stash.server.ts", encoding="utf-8").read()
items = re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)
for did, label in items:
    if "mallWaterfall" in label or "wing_giraffe" in did or "wing giraffe" in label:
        print(repr(did), "||", repr(label))
