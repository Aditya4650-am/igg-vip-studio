"""Final decor matcher: safe tiers + visually-verified manual picks.

Auto (unique full-token containment, camelCase + plural tolerant):
  19 pairs, each a single-concept noun contained in exactly one item.
Manual (pixel-verified, see session notes):
  waterfall.webp  = plain rock waterfall, no cafe -> SmallWaterfall
  swings.webp     = giraffe-shaped swing seat   -> beauty_swing_giraffe
Skipped with reason:
  oasis.webp = tropical pool, neither arabic nor egyptian markers provable.
Everything else shares no safe token evidence -> emoji fallback stays.
"""

import io
import os
import re
import zipfile

REPO = os.path.dirname(os.path.abspath(__file__))
ZIP_PATH = r"C:\Users\User\Downloads\township_all_decorations_icons.zip"
GAME_ICONS = os.path.join(REPO, "public", "game-icons")

MANUAL = {
}


def load_catalog():
    src = open(os.path.join(REPO, "src", "lib", "server", "township", "decor-stash.server.ts"), encoding="utf-8").read()
    return re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)


def load_map_block():
    src = open(os.path.join(REPO, "src", "lib", "game-icon-map.ts"), encoding="utf-8").read()
    m = re.search(r'("decorByLabel":\s*\{)(.*?)(\n  \},)', src, re.S)
    assert m, "decorByLabel block not found"
    return src, m


def toks(s):
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    return [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t]


def eq(a, b):
    if a == b:
        return True
    if len(a) > 3 and len(b) > 3 and not a.endswith("ss") and not b.endswith("ss"):
        return a == b + "s" or b == a + "s"
    return False


def contained(st, it):
    return all(any(eq(a, b) for b in it) for a in st)


def main():
    from PIL import Image

    catalog = load_catalog()
    src, m = load_map_block()
    mapped = set(re.findall(r'"([^"]+)":\s*"/game-icons/', m.group(2)))
    open_items = [(d, l) for d, l in catalog if l not in mapped]
    print("catalog:", len(catalog), "mapped:", len(mapped), "open:", len(open_items))

    with zipfile.ZipFile(ZIP_PATH) as zf:
        stems = sorted(n[:-5] for n in zf.namelist() if n.endswith(".webp"))
        disk = set(os.listdir(GAME_ICONS))
        fresh = [s for s in stems if s + ".webp" not in disk]
        print("fresh stems:", len(fresh))

        pairs = {}  # stem -> label

        # auto tier - aggressive multi-tier matching
        for s in fresh:
            st = set(toks(s))
            if not st:
                continue
            # Tier 1: exact token containment (strictest)
            cands = [(d, l) for d, l in open_items
                     if contained(st, set(toks(d)) | set(toks(l)))]
            if len(cands) == 1 and cands[0][1] not in pairs.values():
                pairs[s] = cands[0][1]
                continue
            # Tier 2: Jaccard >= 0.4 (related enough)
            cands = []
            for d, l in open_items:
                it = set(toks(d)) | set(toks(l))
                if not it:
                    continue
                inter = len(st & it)
                union = len(st | it)
                if union > 0:
                    j = inter / union
                    if j >= 0.4:
                        cands.append((d, l, j))
            if len(cands) == 1 and cands[0][1] not in pairs.values():
                pairs[s] = cands[0][1]
                continue
            # Tier 3: at least 2 token overlap
            cands = []
            for d, l in open_items:
                it = set(toks(d)) | set(toks(l))
                if not it:
                    continue
                overlap = len(st & it)
                if overlap >= 2:
                    cands.append((d, l, len(st & it)))
            if len(cands) == 1 and cands[0][1] not in pairs.values():
                pairs[s] = cands[0][1]
                continue
            # Tier 4: best Jaccard single match (>= 0.25)
            cands = []
            for d, l in open_items:
                it = set(toks(d)) | set(toks(l))
                if not it:
                    continue
                inter = len(st & it)
                union = len(st | it)
                if union > 0:
                    cands.append((d, l, inter / union))
            if cands:
                cands.sort(key=lambda x: x[2], reverse=True)
                if cands[0][2] >= 0.25 and cands[0][1] not in pairs.values():
                    pairs[s] = cands[0][1]
        by_label = {l: l for _, l in open_items}
        for stem, label in MANUAL.items():
            assert label in by_label, "manual target already mapped: " + label
            assert stem in fresh, "manual stem already extracted: " + stem
            pairs[stem] = label

        print("pairs:", len(pairs))

        # extract + validate + write files
        for stem in sorted(pairs):
            data = zf.read(stem + ".webp")
            Image.open(io.BytesIO(data)).verify()
            with open(os.path.join(GAME_ICONS, stem + ".webp"), "wb") as fh:
                fh.write(data)

        # splice map entries (appended, sorted)
        entries = "".join(
            '    "%s": "/game-icons/%s.webp",\n' % (label, stem)
            for stem, label in sorted(pairs.items(), key=lambda kv: kv[1])
        )
        new_block = m.group(1) + m.group(2).rstrip("\n") + "\n" + entries.rstrip("\n") + m.group(3)
        out = src[: m.start()] + new_block + src[m.end():]
        open(os.path.join(REPO, "src", "lib", "game-icon-map.ts"), "w", encoding="utf-8").write(out)

    # report
    for stem in sorted(pairs):
        print("  %s -> %s" % (stem, pairs[stem]))
    remaining = [l for _, l in open_items if l not in set(pairs.values())]
    print("mapped total:", len(mapped) + len(pairs), "of", len(catalog))
    print("still unmatched:", len(remaining))


if __name__ == "__main__":
    main()
