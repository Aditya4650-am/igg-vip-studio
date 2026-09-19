# IGG VIP Studio — Deploy to Vercel

This repo is already wired for Vercel: `vite.config.ts` builds with the Nitro
`vercel` preset and emits a Vercel Build Output API bundle at `.vercel/output`.
The added `vercel.json` just pins the build/install commands.

## 1. Push to GitHub

```bash
git init
git add .
git commit -m "IGG VIP Studio"
git remote add origin https://github.com/<you>/igg-vip-studio.git
git push -u origin main
```

> The included `.gitignore` keeps `node_modules`, build output and secrets out
> of the repo. Commit `vercel.json` — Vercel reads it.

## 2. Import into Vercel

1. Vercel dashboard → **Add New → Project** → import your repo.
2. Vercel auto-detects the settings from `vercel.json`:
   - **Install Command:** `npm install`
   - **Build Command:** `npm run build`
   - **Output Directory:** `.vercel/output`
3. Don't deploy yet — add the environment variables first.

## 3. Environment variables (Project → Settings → Environment Variables)

| Key | Required | Notes |
|---|---|---|
| `IGG_VIP_MASTER` | **Yes** | ≥ 16 random chars — AES/HMAC master key. |
| `IGG_VIP_OWNER` | **Yes** | ≥ 12 chars — owner key for the Control panel. |
| `NODE_ENV` | Recommended | `production` |
| `DATABASE_URL` | Recommended | A **Neon**/Postgres connection string. If you omit it the app falls back to embedded PGLite, which is **ephemeral on Vercel** (data resets). Set `DATABASE_URL` for a real deployment. |

`IGG_VIP_MASTER` / `IGG_VIP_OWNER` must match what your license keys were minted
with. If the owner env isn't set, the preview default is `IGG-OWNER-PREVIEW`
(change it in production).

## 4. Deploy

Click **Deploy**. The build runs `npm run build` (Vite build + DB migrate) and
Nitro emits `.vercel/output`, which Vercel serves as:
- Static assets → CDN
- The app + API → a Node.js 22 serverless function (`functions/__server.func`)

Your app URL will be `https://<project>.vercel.app`.

## 5. Point the Windows client at it

The desktop client loads this URL. Set it once:
- create `%APPDATA%\IGG-VIP-Studio\server.txt` containing `https://<project>.vercel.app`, **or**
- set env var `IGG_VIP_URL=https://<project>.vercel.app`, **or**
- edit `DEFAULT_SERVER_URL` in `client/igg_client.py` before building the EXE.

## Notes
- **Python for FetchCity:** the server's `fetch_city.py` needs Python. On Vercel
  (serverless) there is no persistent Python runtime — that feature works in the
  Node/local/Render deployment. The rest of the app is unaffected.
- **Database:** use Neon (`DATABASE_URL`) on Vercel. PGLite (the default) is
  in-memory and resets between cold starts.
