# IGG VIP TOOL

Server (GitHub → Render) + Windows client EXE. A Township save editor: the server owns all game logic and the save algorithms; the desktop client only drives ADB and hosts the UI. The UI ships in 20 languages.

## Features (tabs)

| Tab | What it does |
|---|---|
| Data Center | Edit core values (T-Cash, coins, level, energy, residents…). One Save writes the session on the server. |
| Profile Studio | Unlock badges, titles, frames, styles. |
| Avatar Studio | Unlock avatars 1–398, single picks or ranges. |
| Skin Gallery | Unlock building/vehicle/animal skins per group. |
| Unban Center | Fetch a friend's clean city and restore it into a banned account (`inicial` / `completo` / `novo`). |
| Decor Studio | Grant decorations from the stash catalog, searchable by theme. |
| Sticker Hub | Unlock chat stickers/emoji. |
| Item Manager | Grant materials, tools, boosts and coupons with a bulk quantity. |
| Barn Inventory | Set barn capacity tier and per-product quantities (325 products). |
| Museum | Complete all 354 museum artifacts (requires the Museum built in-game). |
| Cards | Grant card-collection cards with per-card duplicate counts (150 ids, 15 groups of 10). |

Quick actions (sidebar): Regatta 105×135, Season Pass, Export current XML. Every change is staged in the UI and committed together on Save & push; unban on a clean selection uses its dedicated path.

## Commands

```bash
npm run dev        # Vite dev server on 0.0.0.0:8080 (strict port)
npm run build      # Vite build + DB migrate; emits .output/server/index.mjs
npm test           # scripts + src tests (node:test, no vitest/jest)
npm run typecheck  # tsc --noEmit
npm start          # node .output/server/index.mjs
```

## Security model

| Layer | How |
|---|---|
| License | AES-256-GCM + HMAC, bound Device ID `VIP-XXXX-…`, 12-hour token |
| Owner | `IGG_VIP_OWNER` (12+ chars) on Render — never hard-code a preview key |
| Master | `IGG_VIP_MASTER` (16+ chars) — sealing key |
| Catalog | Client sees HMAC public ids; real game ids stay on the server |
| Save | Decrypt / edit / Unban / FetchCity run server-side only |
| EXE | ADB bridge + WebView2 window. Holds no algorithms, no secrets |

Required Render env: `IGG_VIP_MASTER`, `IGG_VIP_OWNER`, `NITRO_PRESET=node-server`, `NODE_VERSION=22`. Deploy details: [DEPLOY.md](./DEPLOY.md).

### Save format behavior (v1.15)

The server decodes a loaded save for editing, then returns **plain XML**. The desktop client writes that plain XML directly to `mGameInfo.xml` and `mGameInfo.bak` in the Township save directory. It never re-encrypts the edited XML before push.

Saves are edited by **string replacement only** — never parsed and re-serialized (the game's loader rejects reordered attributes/entities). Every write path guards with a tag-balance check.

## Windows client

Built by `.github/workflows/build-client.yml` on `windows-latest` (Nuitka compiles to machine code and `client/protect/` encrypts the result; neither can run on the Linux builder). Push a `v*` tag to build and attach the EXE to a GitHub release, or run the workflow manually from Actions. The client loads its UI from the deployed Render server, so UI/icon changes need only a Render deploy + EXE restart — rebuild the EXE only when `client/` changes.

The shipped EXE is **protected**: compiled with Nuitka (no extractable Python bytecode — the old PyInstaller build could be unpacked and decompiled back to source in about a minute), then AES-256-GCM encrypted at rest behind a small C loader that authenticates the payload, refuses to run under a debugger, decrypts into `%TEMP%`, runs it and deletes it. `client/README.md` states plainly what that does and does not buy.

Point the client at another server without rebuilding via `%APPDATA%\IGG-VIP-Studio\server.txt` or the `IGG_VIP_URL` environment variable.

### "Failed to extract … decompression resulted in return code -1" (and other instant launch failures)

**This is a full disk, not a broken download.** The message came from the old PyInstaller bootloader; the protected build fails the same way for the same reason. Every launch unpacks the client into `%TEMP%` — Nuitka's onefile uses `%TEMP%\onefile_*`, and the protector's loader writes its decrypted copy to `%TEMP%\ingg_*` first — and a machine with nowhere to put it fails before any of the app's own code can explain anything.

1. Check free space on **C:** — near 0 GB triggers it.
2. Delete stale `%TEMP%\onefile_*`, `%TEMP%\ingg_*` and old `%TEMP%\_MEI*` folders (one machine had 17 of the last kind = 372 MB).
3. Relaunch. **No reinstall or re-download** — a brand-new EXE fails identically on a full disk.

Free space is the only fix: the unpacking happens before the app's own code runs, so it cannot be made friendlier from our side.
