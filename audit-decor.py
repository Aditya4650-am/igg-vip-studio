import os
import re

m = open("src/lib/game-icon-map.ts", encoding="utf-8").read()
mm = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', m, re.S)
pairs = re.findall(r'"([^"]+)":\s*"(/game-icons/[^"]+)"', mm.group(1))
print("entries:", len(pairs))

missing = [(l, p) for l, p in pairs if not os.path.exists("public" + p)]
print("missing files:", len(missing))
for l, p in missing[:20]:
    print("  MISSING", l, "->", p)


def toks(s):
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    return set(t for t in re.split(r"[^a-z0-9]+", s.lower()) if t)


def eq(a, b):
    if a == b:
        return True
    if len(a) > 3 and len(b) > 3 and not a.endswith("ss") and not b.endswith("ss"):
        return a == b + "s" or b == a + "s"
    return False


weak = []
for label, path in pairs:
    stem = os.path.basename(path).rsplit(".", 1)[0]
    lt, st = toks(label), toks(stem)
    overlap = sum(1 for a in st if any(eq(a, b) for b in lt))
    if overlap == 0:
        weak.append((label, path))
print("zero-token-overlap entries:", len(weak))
for l, p in weak:
    print("  WEAK", l, "->", p)
