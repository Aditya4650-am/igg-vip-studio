import pathlib, re

path = pathlib.Path(r"C:\Users\User\Downloads\IGG-VIP-Server-Stickers-UPDATED\Server\scripts\with-app-env.mjs")
text = path.read_text(encoding="utf-8")
orig = text

# Fix 1: add statSync to the fs import (line 23)
text = text.replace("import { readFileSync, realpathSync } from \"node:fs\";",
                    "import { readFileSync, realpathSync, statSync } from \"node:fs\";")

# Fix 2: replace join(bindir, ...) with an inline join root + bin path
text = text.replace("join(bindir, command + \".exe\")",
                    "join(root, \"node_modules\", \".bin\", command + \".exe\")")

changed = text != orig
path.write_text(text, encoding="utf-8")
print("CHANGED" if changed else "NOOP")
