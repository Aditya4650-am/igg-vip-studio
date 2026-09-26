import os
import re
import zipfile
from collections import Counter

REPO = os.path.dirname(os.path.abspath(__file__))
with zipfile.ZipFile(r"C:\Users\User\Downloads\township_all_decorations_icons.zip") as z:
    stems = sorted(n[:-5] for n in z.namelist() if n.endswith(".webp"))

disk = set(os.listdir(os.path.join(REPO, "public", "game-icons")))
fresh = [s for s in stems if s + ".webp" not in disk]

src = open(os.path.join(REPO, "src", "lib", "server", "township", "decor-stash.server.ts"), encoding="utf-8").read()
items = re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)
m = open(os.path.join(REPO, "src", "lib", "game-icon-map.ts"), encoding="utf-8").read()
mm = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', m, re.S)
mapped = set(re.findall(r'"([^"]+)":\s*"/game-icons/', mm.group(1)))
open_items = [(d, l) for d, l in items if l not in mapped]
print("fresh:", len(fresh), "open items:", len(open_items))


def toks(s):
    # split separators AND camelCase boundaries
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    return [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t]


def eq(a, b):
    if a == b:
        return True
    # tolerant trailing-s plural
    if len(a) > 3 and len(b) > 3 and not a.endswith("ss") and not b.endswith("ss"):
        if a == b + "s" or b == a + "s":
            return True
    return False


def contained(st, it):
    return all(any(eq(a, b) for b in it) for a in st)


dist = Counter()
pairs = {}
for s in fresh:
    st = set(toks(s))
    if not st:
        continue
    cands = []
    for d, l in open_items:
        it = set(toks(d)) | set(toks(l))
        if contained(st, it):
            cands.append((d, l))
            if len(cands) > 1:
                break
    dist[len(cands) if len(cands) <= 1 else 2] += 1
    if len(cands) == 1:
        pairs[s] = cands[0]

print("dist (0/1/2+):", dict(dist), "unique:", len(pairs))

# show new ones beyond the 18 (spot check quality)
for s in sorted(pairs)[:80]:
    print("  %s -> %s (%s)" % (s, pairs[s][0], pairs[s][1]))
print("...")
# multi-candidate examples (rejected)
shown = 0
for s in fresh:
    st = set(toks(s))
    if not st:
        continue
    cands = [(d, l) for d, l in open_items if contained(st, set(toks(d)) | set(toks(l)))]
    if len(cands) > 1 and shown < 15:
        print("MULTI %s -> %s" % (s, [(d) for d, l in cands[:6]]))
        shown += 1
