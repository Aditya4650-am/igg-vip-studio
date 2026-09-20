# IGG VIP Studio — agent notes

Server + web UI for editing Township saves. Game logic lives entirely on the
server; the Windows EXE (`client/`) only drives ADB and hosts a WebView2 shell.

## Commands

```bash
npm run dev        # Vite dev server on 0.0.0.0:8080 (strict port)
npm run build      # Vite build + DB migrate; emits .output/server/index.mjs
npm test           # scripts/**/*.test.mjs + src/**/*.test.ts with TS stripping
npm run typecheck  # tsc --noEmit
npm start          # node .output/server/index.mjs
```

`npm test` runs `.ts` tests through `scripts/register-ts-resolve.mjs`, an ESM
resolve hook that maps the `@/*` alias to `./src/*`. Without it, imports inside
`src/**` fail with `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`. Tests are
plain `node:test` + `node:assert`; there is no vitest/jest.

## Architecture

- `src/lib/server/studio.server.ts` — session store + all mutating operations.
  Sessions live in an in-memory `Map`, so the process must be long-lived.
- `src/lib/server/township/*.server.ts` — save manipulation, split by concern:
  `vars` (stat aliases), `inject` (season/regata/skins/profile/avatars),
  `desban` (unban, fetch city, decor), `xml-edit` (shared string helpers).
- `src/lib/server/catalogs.server.ts` — public catalogs + `revealSave()`, which
  maps UI public IDs (HMAC) back to real game IDs. Real IDs never reach the client.
- `src/lib/studio-api.ts` — TanStack Start server functions the UI calls.
- `src/components/studio-app.tsx` — single large component; one tab per feature.

## Save editing rules

The save is a flat XML document that is edited by **string replacement**; it is
never parsed and re-serialized (that reorders attributes and rewrites entities,
which the game's loader rejects).

- Keep documents tag-balanced. `findUnbalancedTag()` in `xml-edit.server.ts`
  guards the push path; a malformed save makes the game discard progress and
  looks to the user like the feature silently did nothing.
- Insert new elements with `insertInsideRoot()` so they land before the real
  document closer. Appending at EOF puts them outside the root.
- Never rewrite only the open tag of a paired element. `<SeasonTicket a/>` in
  front of a pre-existing `</SeasonTicket>` corrupts the document — match the
  self-closing form and its children separately.
- When creating a `<Var>`, choose `t="i"` only for integer values; a numeric
  type holding a non-numeric value makes the loader reject the whole save.
- Attribute quotes vary between builds. Use `attrValue()` / `putAttr()` rather
  than assuming double quotes.
- Save variants across builds expose the same counter under different Var
  names; `STAT_ALIASES` in `vars.server.ts` reads the first present alias and
  writes back to every alias already in the document.

## Fetch City / Unban

`fetchCityXml()` spawns `scripts/township/fetch_city.py`, which prints a single
JSON object on stdout: `{ok: true, xml_b64}` or `{ok: false, error}`. It needs a
real `bver`/`fver` pair from the device's `mLocalInfo.xml` — dummy versions get
HTTP 403 from `township.playrix.com` (verified from a clean network: the host
itself resolves fine, so 403 means rejected metadata, not a blocked host).

## Deployment

Render only, via `render.yaml` + `nixpacks.toml` (Nixpacks installs `python311`
and `nodejs_22`). Set `NITRO_PRESET=node-server`. This **must** be a persistent
server: FetchCity shells out to Python, which a serverless/edge target cannot
provide. Do not add a serverless preset.