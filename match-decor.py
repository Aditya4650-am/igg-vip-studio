"""Match township_all_decorations_icons.zip art to DECOR_STASH catalog items.

Tier 1: normalized stem == normalized id
Tier 2: normalized stem == normalized label
Tier 3: stem tokens fully contained in exactly ONE catalog item's id/label
        tokens (unique-candidate rule kills generic stems like "tree").

Writes: extracted files -> public/game-icons/<stem>.webp
        new map entries -> decor-map-new.txt (label -> /game-icons/<stem>.webp)
Prints coverage stats + remainder list.
"""

import json
import os
import re
import zipfile

REPO = os.path.dirname(os.path.abspath(__file__))
ZIP_PATH = r"C:\Users\User\Downloads\township_all_decorations_icons.zip"
GAME_ICONS = os.path.join(REPO, "public", "game-icons")


def norm_compact(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def norm_tokens(s):
    return [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t]


def load_catalog():
    src = open(os.path.join(REPO, "src", "lib", "server", "township", "decor-stash.server.ts"), encoding="utf-8").read()
    items = re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)
    assert items, "no catalog items parsed"
    return items


def load_mapped_labels():
    src = open(os.path.join(REPO, "src", "lib", "game-icon-map.ts"), encoding="utf-8").read()
    m = re.search(r'"decorByLabel":\s*\{(.*?)\n  \},', src, re.S)
    assert m, "decorByLabel block not found"
    return set(re.findall(r'"([^"]+)":\s*"/game-icons/', m.group(1)))


def main():
    catalog = load_catalog()
    mapped = load_mapped_labels()
    print("catalog items:", len(catalog), "| already mapped labels:", len(mapped))

    with zipfile.ZipFile(ZIP_PATH) as z:
        stems = sorted(n[:-5] for n in z.namelist() if n.endswith(".webp"))
    print("zip art:", len(stems))
    zf = zipfile.ZipFile(ZIP_PATH)

    # index catalog by compact id / label
    by_id = {}
    by_label = {}
    for did, label in catalog:
        by_id.setdefault(norm_compact(did), []).append((did, label))
        by_label.setdefault(norm_compact(label), []).append((did, label))

    used_labels = set()
    tier = {1: 0, 2: 0, 3: 0}
    new_entries = []  # (label, stem)
    stem_use = {}

    def claim(label, stem, t):
        if label in mapped or label in used_labels:
            return False
        used_labels.add(label)
        tier[t] += 1
        new_entries.append((label, stem))
        stem_use[stem] = label
        return True

    # tiers 1 + 2
    for stem in stems:
        c = norm_compact(stem)
        hit = None
        t = 0
        if c in by_id and len(by_id[c]) == 1:
            hit, t = by_id[c][0], 1
        elif c in by_label and len(by_label[c]) == 1:
            hit, t = by_label[c][0], 2
        if hit:
            claim(hit[1], stem, t)

    # tier 3: unique token containment
    token_index = []
    for did, label in catalog:
        if label in mapped or label in used_labels:
            token_index.append((did, label, set(norm_tokens(did)) | set(norm_tokens(label))))
    for stem in stems:
        if stem in stem_use:
            continue
        st = set(norm_tokens(stem))
        if not st:
            continue
        cands = [(did, label) for did, label, toks in token_index if st <= toks]
        if len(cands) == 1:
            claim(cands[0][1], stem, 3)

    print("tier1:", tier[1], "tier2:", tier[2], "tier3:", tier[3], "new:", len(new_entries))

    # extract + validate
    from PIL import Image
    import io

    os.makedirs(GAME_ICONS, exist_ok=True)
    bad = []
    for label, stem in new_entries:
        data = zf.read(stem + ".webp")
        try:
            im = Image.open(io.BytesIO(data))
            im.verify()
        except Exception as e:  # noqa: BLE001
            bad.append((stem, str(e)))
            continue
        with open(os.path.join(GAME_ICONS, stem + ".webp"), "wb") as fh:
            fh.write(data)
    print("extracted ok:", len(new_entries) - len(bad), "bad:", bad[:10])

    with open(os.path.join(REPO, "decor-map-new.txt"), "w", encoding="utf-8") as fh:
        for label, stem in sorted(new_entries):
            fh.write('    "%s": "/game-icons/%s.webp",\n' % (label, stem))

    # remainder
    remaining = [(did, label) for did, label in catalog if label not in mapped and label not in used_labels]
    print("still unmatched:", len(remaining))
    with open(os.path.join(REPO, "decor-still-needed.txt"), "w", encoding="utf-8") as fh:
        for did, label in remaining:
            fh.write("%s  (%s)\n" % (did, label))


if __name__ == "__main__":
    main()
