"""Read-only research: diff a save's profile lists + skins against our catalogs.

Usage: python scripts/township/research_new_ids.py <save.xml>
Prints ids present in the save but missing from RAW_PROFILE / RAW_SKINS.
NEVER writes to the save or to the catalogs.
"""
import re
import sys

sys.path.insert(0, ".")


def csv_block(src, name):
    """value=... of <DataElem name="X" type="string" value="a,b,c"/>"""
    m = re.search(
        r'<DataElem name="%s" type="string" value="([^"]*)"' % re.escape(name),
        src,
    )
    return m.group(1) if m else None


def parse_ids(val):
    if not val:
        return []
    return [x for x in val.split(",") if x]


def main():
    path = sys.argv[1]
    c = open(path, encoding="utf-8", errors="replace").read()

    print("### Profile lists in save")
    save_lists = {}
    for name in (
        "UnlockedBadges",
        "UnlockedExpRanks",
        "UnlockedFrames",
        "UnlockedStyles",
        "UnlockedThemes",
    ):
        v = csv_block(c, name)
        ids = parse_ids(v)
        save_lists[name] = set(ids)
        print(f"{name}: {len(ids)} ids")

    # Skins: <item id="Group" current="a|b|"/> and <type id="Group" available="a|b|"/>
    save_skin_current = set()
    save_skin_available = set()
    for m in re.finditer(r'<item id="([^"]+)" current="([^"]*)"', c):
        for s in m.group(2).split("|"):
            if s:
                save_skin_current.add(s)
    for m in re.finditer(r'<type id="([^"]+)" available="([^"]*)"', c):
        for s in m.group(2).split("|"):
            if s:
                save_skin_available.add(s)
    print(f"skin current: {len(save_skin_current)}  skin available: {len(save_skin_available)}")

    # ---- load our catalogs by regex from the TS source (no TS import needed) ----
    src = open(
        "src/lib/server/catalogs.data.server.ts", encoding="utf-8"
    ).read()

    def raw_group(raw, gid):
        # groups look like { "id": "Badges", "items": [ { "id": "...", ... }, ... ] }
        m = re.search(r'"id":\s*"%s"' % re.escape(gid), raw)
        if not m:
            return set()
        j = raw.find('"items": [', m.end())
        if j < 0:
            return set()
        # find matching close of this items array
        depth = 0
        k = j + len('"items": [')
        start = k
        while k < len(raw):
            if raw[k] == "[":
                depth += 1
            elif raw[k] == "]":
                if depth == 0:
                    break
                depth -= 1
            k += 1
        seg = raw[start:k]
        return set(re.findall(r'"id":\s*"([^"]+)"', seg))

    prof = src[
        src.find("export const RAW_PROFILE"): src.find("export const RAW_SKINS")
    ]
    skins = src[src.find("export const RAW_SKINS") :]

    print("\n### Missing from our RAW_PROFILE")
    key_of = {
        "UnlockedBadges": "Badges",
        "UnlockedExpRanks": "ExpRanks",
        "UnlockedFrames": "Frames",
        "UnlockedStyles": "Styles",
        "UnlockedThemes": "Themes",
    }
    for sv, grp in key_of.items():
        ours = raw_group(prof, grp)
        missing = sorted(save_lists[sv] - ours)
        print(f"{grp}: ours={len(ours)} save={len(save_lists[sv])} MISSING={len(missing)}")
        for x in missing:
            print("   +", x)

    print("\n### Missing from our RAW_SKINS")
    ours_skins = set(re.findall(r'"id":\s*"([^"]+)"', skins))
    miss_cur = sorted(save_skin_current - ours_skins)
    miss_av = sorted(save_skin_available - ours_skins)
    print(f"ours={len(ours_skins)}  current-missing={len(miss_cur)}  available-missing={len(miss_av)}")
    for x in miss_cur:
        print("   C+", x)
    for x in miss_av:
        print("   A+", x)

    # skin groups from save: <type id="X" available=...> / <item id="X" current=...>
    groups = sorted(
        set(re.findall(r'<type id="([^"]+)" available=', c))
        | set(re.findall(r'<item id="([^"]+)" current=', c))
    )
    print("\nskin groups in save:", ", ".join(groups))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
