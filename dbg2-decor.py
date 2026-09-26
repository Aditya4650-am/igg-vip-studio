import os
import re
import zipfile

REPO = os.path.dirname(os.path.abspath(__file__))
with zipfile.ZipFile(r"C:\Users\User\Downloads\township_all_decorations_icons.zip") as z:
    stems = sorted(n[:-5] for n in z.namelist() if n.endswith(".webp"))

disk = set(os.listdir(os.path.join(REPO, "public", "game-icons")))
on_disk = [s for s in stems if s + ".webp" in disk]
print("stems already extracted:", len(on_disk), "of", len(stems))

src = open(os.path.join(REPO, "src", "lib", "server", "township", "decor-stash.server.ts"), encoding="utf-8").read()
items = re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)

m = open(os.path.join(REPO, "src", "lib", "game-icon-map.ts"), encoding="utf-8").read()
mm = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', m, re.S)
mapped = set(re.findall(r'"([^"]+)":\s*"/game-icons/', mm.group(1)))


def toks(s):
    return [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t]


# tier-3 simulation on a few known-unmatched items
for did, label in items:
    if label in mapped:
        continue
    if did not in ("1400_Christmas_Decoration", "Apple_Garden", "aquariumHouse_fishing",
                    "beauty_atlantis_statue", "BobsleighRace", "CafeTube"):
        continue
    it = set(toks(did)) | set(toks(label))
    scored = []
    for s in stems:
        st = set(toks(s))
        if not st:
            continue
        inter = st & it
        if inter:
            scored.append((len(inter) / len(st | it), len(inter) == len(st), s))
    scored.sort(reverse=True)
    print("=" * 20, did, "|", label)
    for sc, full, s in scored[:6]:
        print("   %.2f full=%s %s" % (sc, full, s))
