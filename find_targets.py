import re
import zipfile

with zipfile.ZipFile(r"C:\Users\User\Downloads\township_all_decorations_icons.zip") as z:
    stems = sorted([n[:-5] for n in z.namelist() if n.endswith(".webp")])

src = open("src/lib/server/township/decor-stash.server.ts", encoding="utf-8").read()
items = re.findall(r'"id":\s*"([^"]+)"[^}]*?"label":\s*"([^"]+)"', src)

targets = [
    "flower house", "aquariumHouse fishing", "beauty flowerhouse",
    "beauty greengrocery", "beauty fireworkshop", "beauty seahouse decoration"
]

for did, label in items:
    if label in targets:
        print(f"FOUND: {did} || {label}")