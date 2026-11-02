"""Read-only research helper: extract event datastores from a Township save.

Usage: python scripts/township/research_extract.py <save.xml> <DataElem name> [...]
Dumps each balanced <DataElem> block to stdout. NEVER writes to the save.
"""
import sys


def extract(src, start_tag):
    """Balanced <DataElem> ... </DataElem> extract, read-only."""
    i = src.find(start_tag)
    if i < 0:
        return None, -1
    depth = 0
    j = i
    tag = "<DataElem"
    close = "</DataElem>"
    n = len(src)
    while j < n:
        if src.startswith(tag, j) and src[j + len(tag):j + len(tag) + 1] in (" ", ">"):
            # self-closing <DataElem .../> opens and closes in one
            gt = src.find(">", j)
            if gt > 0 and src[gt - 1] == "/":
                j = gt + 1
                continue
            depth += 1
            j += len(tag)
            continue
        if src.startswith(close, j):
            depth -= 1
            j += len(close)
            if depth == 0:
                return src[i:j], i
            continue
        j += 1
    return None, i


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    src_path = sys.argv[1]
    c = open(src_path, encoding="utf-8", errors="replace").read()
    for name in sys.argv[2:]:
        start = '<DataElem name="%s" type="dataStore">' % name
        blk, i = extract(c, start)
        print("=" * 20, name, "at", i, "len", len(blk) if blk else None)
        if blk:
            print(blk)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
