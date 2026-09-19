# IGG VIP Studio — Deploy on Render (FetchCity + Unban working)

Render is the correct host for this app: it runs a **persistent Node server
with Python available**, which is exactly what `fetch_city.py` (FetchCity) and
therefore the Unban/Restore flow need.

## Step 1 — Push the code to GitHub

```bash
cd C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server
git init
git add .
git commit -m "IGG VIP Studio - Render deploy"
git remote add origin https://github.com/<you>/igg-vip-studio.git
git push -u origin main
```

`render.yaml` and `nixpacks.toml` (Node 22 + Python 3.11) must be committed.

## Step 2 — Create the Web Service

1. dashboard.render.com → **New → Web Service** → connect your repo.
2. Render reads `render.yaml`. Confirm:
   - **Build:** `NPM_CONFIG_PRODUCTION=false npm install && npm run build`
   - **Start:** `node .output/server/index.mjs`
3. **The service name IS your URL.** Render generates
   `https://<service-name>.onrender.com` from it.
   - Name it e.g. `igg-vip-studio` → URL becomes
     `https://igg-vip-studio.onrender.com`
   - If the name is taken, Render appends random characters. To control the
     URL exactly, pick an unused name, or add your own domain later
     (Settings → Custom Domains).
   - Changing the URL later = creating the service with a new name
     (or pointing a custom domain at it).

## Step 3 — Environment variables (Settings → Environment)

| Key | Value | Why |
|---|---|---|
| `NITRO_PRESET` | `node-server` | Persistent server preset (not serverless). |
| `NODE_VERSION` | `22` | Matches the engines field. |
| `NODE_ENV` | `production` | Production behavior. |
| `IGG_VIP_MASTER` | ≥ 16 random chars | AES/HMAC master key for license tokens. |
| `IGG_VIP_OWNER` | ≥ 12 chars | Owner key for the Control panel. |
| `DATABASE_URL` | Neon/Postgres string | Persistent DB (PGLite resets on redeploy). |
| `PYTHON_BIN` | `python3` | Lets fetch_city.py spawn deterministically. |
| `CLIENT_UPDATE_URL` | HTTPS URL of the client EXE | EXE auto-update. |
| `CLIENT_UPDATE_SHA256` | SHA-256 of that EXE | EXE auto-update integrity. |

## Step 4 — Deploy

Click **Create Web Service**. Nixpacks installs Node 22 + Python 3.11, runs the
build, then starts the server. Live URL: `https://<service-name>.onrender.com`.

## Step 5 — Point the Windows EXE at it

`%APPDATA%\IGG-VIP-Studio\server.txt` → paste your Render URL. Or set the
`IGG_VIP_URL` environment variable. No rebuild needed.

## Why FetchCity + Unban work here (and the 403 reality check)

The chain is: **LocalInfo (real bver/fver from your emulator) → fetch_city.py
→ clone friend city into your save → push back**.

- On Render, `spawn("python3", …)` works because Nixpacks installs Python.
- `bver` / `fver` come from YOUR device's `mLocalInfo.xml` — the app
  auto-pulls them (Refresh LocalInfo). Dummy versions get HTTP 403.
- Honest limitation: FetchCity calls `township.playrix.com`. If Playrix
  hardens/changes the API, the server may return 403/404 regardless of host.
  That is an upstream game-server risk, not a hosting problem.
