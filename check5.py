import re
m = open("src/lib/game-icon-map.ts", encoding="utf-8").read()
mm = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', m, re.S)
keys = set(re.findall(r'"([^"]+)":\s*"/game-icons/', mm.group(1)))
print('flower house' in keys)