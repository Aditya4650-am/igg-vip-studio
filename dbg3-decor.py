import os
import re
import zipfile
from collections import Counter

REPO = os.path.dirname(os.path.abspath(__file__))
with zipfile.ZipFile(r"C:\Users\User\Downloads\township_all_decorations_icons.zip") as z:
    stems = sorted(n[:-5] for n in z.namelist() if n.endswith(".webp"))

disk = set(os.listdir(os.path.join(REPO, "public", "game-icons")))
fresh = [s for s in stems if s + ".webp" not in disk]
print("fresh stems:", len(fresh))

src = open(os.path.join(REPO, "src", "lib", "server", "township", "decor-stash.server.ts"), encoding="utf-8").read()
items = re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)
m = open(os.path.join(REPO, "src", "lib", "game-icon-map.ts"), encoding="utf-8").read()
mm = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', m, re.S)
mapped = set(re.findall(r'"([^"]+)":\s*"/game-icons/', mm.group(1)))
open_items = [(d, l) for d, l in items if l not in mapped]


def toks(s):
    return [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t]


def compact(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


# exact compact hits among open items?
exact = 0
for s in fresh:
    c = compact(s)
    if any(compact(d) == c or compact(l) == c for d, l in open_items):
        exact += 1
print("fresh stems with exact compact hit on open items:", exact)

# tier-3 candidate distribution
dist = Counter()
examples = {}
for s in fresh:
    st = set(toks(s))
    if not st:
        continue
    n = 0
    ex = None
    for d, l in open_items:
        it = set(toks(d)) | set(toks(l))
        if st <= it:
            n += 1
            ex = (d, l)
            if n > 1:
                break
    dist[n] += 1
    if n == 1:
        examples[s] = ex
print("candidate-count distribution (capped at 2):", dict(dist))
print("unique-candidate pairs:", len(examples))
for s, pair in sorted(examples.items())[:40]:
    print("  %s  ->  %s (%s)" % (s, pair[0], pair[1]))

# jaccard >= 0.5 pairs (excluding exact/unique already counted)
print("=== jaccard>=0.5 not covered above ===")
jac = []
covered = set(examples)
for d, l in open_items:
    it = set(toks(d)) | set(toks(l))
    for s in fresh:
        st = set(toks(s))
        if not st or s in covered:
            continue
        j = len(st & it) / len(st | it)
        if j >= 0.5:
            jac.append((j, s, d, l))
jac.sort(reverse=True)
print("count:", len(jac))
for j, s, d, l in jac[:60]:
    print("  %.2f %s -> %s (%s)" % (j, s, d, l))
