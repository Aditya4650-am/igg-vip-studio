/**
 * Live card sending over the game's own API — the Cards feature.
 *
 * Why this exists: the save-side card grant was removed on purpose (see
 * `cards.server.ts`), because a save can only describe cards a city already
 * has. Cards that actually *arrive* in a friend's inbox travel the same path
 * the game client uses — `POST /api/1/SendBox` with a framed body — so this
 * module is the one place that speaks it, and the UI drives it send-by-send.
 *
 * Four deliberate choices, all proven against the live server:
 *
 * - **One process per request** (`scripts/township/api_call.py`), exactly how
 *   `desban.server.ts` already runs `fetch_city.py`. The frame codec lives in
 *   one Python home, so request and response can never drift apart.
 * - **No ownership check.** The server accepts every `card_01..card_151` for
 *   any sender (probe: unowned `card_151` → 200 `{"result":{}}`), so there is
 *   no inventory parser here on purpose — the catalog in `cards.server.ts` is
 *   the complete sendable set.
 * - **403 is a retry, not a failure.** The client can
 *   get a transient
 *   `{"error":{"code":"Forbidden"}}` from the anti-abuse layer (~1 in 10 at
 *   0 ms spacing, none at 800 ms in a 10-shot run), and the very next request
 *   goes through. `sendCard` retries it with backoff; a genuine auth refusal
 *   (`Wrong parameter`, HTTP 401) is *not* retried — retrying cannot fix a
 *   token.
 * - **The event is read, not hardcoded.** `col_id` / `col_et` come from the
 *   save's own `CardCollections_*` window (`activeCardCollection`), so a
 *   Playrix rotation cannot silently kill every send — see `CardCollection`.
 *
 * `result` classifies the outcome: `{}` = the box was accepted and is in the
 * friend's inbox, `null` = the recipient id does not exist and the box was
 * dropped silently (the server's only negative answer — there is no error
 * body). Everything else is surfaced verbatim so the log never lies.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeLocalInfoBase64, fetchCityXml, parseGameFriends, parseLocalFriends, parseOwnMeta } from "./desban.server";
import { CARD_IDS } from "./cards.server";

export type CardFriend = { id: string; name: string; level: number };

export type CardAccount = {
  cityId: string;
  /** The account's game API token, as read from LocalInfo's `<AWS>` tag. */
  token: string;
  bver: string;
  fver: string;
  /** Own display name — CheckCity first, LocalInfo chat as the fallback. */
  name: string;
  level: number;
  /** Own avatar id, best effort from LocalInfo; "" is accepted by the server. */
  pic: string;
  friends: CardFriend[];
  /** Pending inbox boxes at the last CheckCity, for the inbox preview. */
  boxes: number;
  checkedAt: number;
  checkError: string | null;
  /** The collection event sends currently carry, read from a save (see resolve). */
  col: CardCollection | null;
  /** When `col` was last resolved — re-resolving is throttled inside a loop. */
  colAt: number;
};

/**
 * The event a SendBox box belongs to: `col_id` is the collection number and
 * `col_et` its end. Both are **read out of the save**, never guessed —
 * Playrix rotates the collection (CardCollections_7 → _8 on 2026-11-13, the
 * exact moment every client's card sends started failing), and a `col_id` the
 * server no longer knows makes it refuse SendBox outright. A value hardcoded
 * here is a time bomb; TWN shipped this same fix for this same failure.
 */
export type CardCollection = { colId: string; colEt: number };

/** Throttle for re-resolving inside a send loop — one FetchCity per 5 min max. */
const COL_RERESOLVE_MS = 5 * 60_000;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * The newest `CardCollections_*` event a save declares: its `collectionId`
 * (falling back to the number in `configId`) and its `endTime`. A document can
 * hold several archived windows — the largest `endTime` is the one open now
 * (measured: collection 7 ends exactly where collection 8 begins, 1794560400).
 * Null when the save declares none.
 */
export function activeCardCollection(xml: string): CardCollection | null {
  let best: CardCollection | null = null;
  const re = /value="CardCollections_(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const suffix = m[1];
    const win = xml.slice(m.index, m.index + 1200);
    const et =
      win.match(/name="endTime"[^>]*value="(\d+)"/)?.[1] ??
      win.match(/value="(\d+)"[^>]*name="endTime"/)?.[1];
    if (!suffix || !et) continue;
    const colId =
      win.match(/value="collectionId"[\s\S]{0,160}?name="second"[^>]*value="(\d+)"/)?.[1] ??
      suffix;
    const col = { colId, colEt: Number(et) };
    if (!best || col.colEt > best.colEt) best = col;
  }
  return best;
}

/** Retry budget for the transient 403; each attempt waits `RETRY_BACKOFF_MS`. */
const RETRY_403_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1500;
const API_TIMEOUT_MS = 40_000;

/**
 * Accounts keyed by session id — the game token never leaves the server, and
 * the UI only ever sees the public view. Module state on purpose: sessions are
 * already in-memory in `studio.server.ts`, and this file must not grow a field
 * on their type to keep the Cards tab purely additive.
 */
const accounts = new Map<string, CardAccount>();

function publicView(a: CardAccount) {
  const { token: _token, ...rest } = a;
  return rest;
}

/**
 * The three fields the delivery check needs from the loaded account: the game
 * versions for the FetchCity frame and the sender's own cityId, which is what
 * attributes boxes in a friend's save to *our* sends. The token itself stays
 * private in this module — FetchCity is read by cityId without one, the same
 * way the clone features fetch other cities.
 */
export function cardSessionMeta(
  sessionId: string,
): { bver: string; fver: string; cityId: string } | null {
  const a = accounts.get(sessionId);
  return a ? { bver: a.bver, fver: a.fver, cityId: a.cityId } : null;
}

export type CardAccountView = ReturnType<typeof publicView>;
export type CardLoadResult = CardAccountView & { cardIds: readonly string[] };

function apiScriptPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "scripts/township/api_call.py"),
    join(here, "../../../../scripts/township/api_call.py"),
    join(here, "../../../scripts/township/api_call.py"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

type ApiReply = {
  ok: boolean;
  status?: number;
  resp?: Record<string, unknown>;
  error?: string;
  body?: string;
};

/**
 * Spawn `api_call.py` once and hand it the request on stdin. Resolves the
 * Python binary the same way `desban.server.ts` does — environment override
 * first, then `python3`, then `python` — because a fresh instance may ship
 * with only one of them on PATH.
 */
function apiCall(
  acc: Pick<CardAccount, "bver" | "fver" | "token">,
  endpoint: string,
  body: unknown,
  query: string,
): Promise<ApiReply> {
  const script = apiScriptPath();
  const candidates = [process.env.PYTHON_BIN, "python3", "python"].filter(Boolean) as string[];

  return new Promise((resolve, reject) => {
    let index = 0;
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message.slice(0, 300)));
    };

    const runNext = () => {
      if (settled) return;
      const bin = candidates[index++];
      if (!bin) {
        fail("Cards: Python không chạy được trên server (thiếu python3/python)");
        return;
      }

      let out = "";
      let timedOut = false;
      const py = spawn(bin, [script], {
        cwd: dirname(script),
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      const killTimer = setTimeout(() => {
        timedOut = true;
        py.kill();
      }, API_TIMEOUT_MS);

      py.stdout.setEncoding("utf8");
      py.stdout.on("data", (d) => {
        out += d;
      });
      py.stderr.on("data", () => {
        /* diagnostics only — the JSON on stdout is the contract */
      });

      py.on("error", () => {
        clearTimeout(killTimer);
        runNext();
      });

      py.on("close", (code) => {
        clearTimeout(killTimer);
        if (settled) return;
        if (timedOut) {
          fail("Cards: API quá hạn — máy chủ không trả lời");
          return;
        }
        // The reply is the last JSON line on stdout; anything before it is
        // interpreter noise and is ignored rather than made into an error.
        const lines = out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i]!.startsWith("{")) continue;
          try {
            const parsed = JSON.parse(lines[i]!) as ApiReply;
            settled = true;
            if (typeof parsed.ok !== "boolean") {
              reject(new Error("Cards: phản hồi không hợp lệ"));
            } else {
              resolve(parsed);
            }
            return;
          } catch {
            /* keep looking for an earlier JSON line */
          }
        }
        fail(
          `Cards: Python lỗi ${code ?? "?"} — ${lines.join(" ").slice(0, 200) || "không có đầu ra"}`,
        );
      });

      const req = JSON.stringify({
        endpoint,
        bver: acc.bver,
        fver: acc.fver,
        token: acc.token,
        query,
        body,
      });
      py.stdin.write(req);
      py.stdin.end();
    };

    runNext();
  });
}

function reEscape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `"set_06"` for `card_60` — cards ship in fixed sets of ten. */
function setOf(cardId: string) {
  const n = Number(cardId.split("_")[1]);
  return `set_${String(Math.floor((n - 1) / 10) + 1).padStart(2, "0")}`;
}

/**
 * Own display name and avatar out of LocalInfo alone, used until CheckCity
 * (the authoritative source) answers. Name comes from a chat message the city
 * itself sent (`fromId` = own cityId); the avatar from the ranking JSON that
 * pairs `"avatar":{"id":…}` with `"cityname":<name>`. Both are cosmetic — the
 * server accepts an empty `from` — but a real sender line is what the friend
 * sees in their inbox.
 */
function ownIdentity(xml: string, cityId: string, fallbackName: string) {
  let name = "";
  try {
    const tag = xml.match(new RegExp(`<msg\\b[^>]*fromId="${reEscape(cityId)}"[^>]*>`))?.[0];
    name = tag?.match(/\bfromName="([^"]*)"/)?.[1] ?? "";
  } catch {
    name = "";
  }
  name = name || fallbackName;

  let pic = "";
  if (name) {
    try {
      pic =
        xml.match(
          new RegExp(`\\{"avatar":\\{"id":"([^"]+)"\\}[^{}]{0,60}"cityname":"${reEscape(name)}"`),
        )?.[1] ?? "";
    } catch {
      pic = "";
    }
  }
  return { name, pic };
}

/**
 * Resolve the collection a box must carry: the save this session holds first
 * (no spawn — exactly what the device has), then Playrix's own copy of our
 * city, which covers a session with no save loaded and a save pulled before
 * the rotation. Returns the freshest pair found and `null` only when both
 * sources fail. Called at Refresh and, throttled, when a send loop meets an
 * ended window.
 */
async function resolveCardCollection(
  token: string,
  sessionId: string,
  acc: Pick<CardAccount, "cityId" | "bver" | "fver">,
): Promise<CardCollection | null> {
  const now = nowSec();
  let stale: CardCollection | null = null;
  try {
    // Dynamic import: `studio.server.ts` must not become a static dependency
    // of this module (its session map is its own; this only reads).
    const { sessionSaveXml } = await import("../studio.server");
    const xml = sessionSaveXml(token, sessionId);
    const col = xml ? activeCardCollection(xml) : null;
    if (col) {
      if (col.colEt > now) return col;
      stale = col;
    }
  } catch {
    /* no session save on this session — FetchCity below is the fallback */
  }
  try {
    const xml = await fetchCityXml(acc.cityId, acc.bver, acc.fver);
    const col = activeCardCollection(xml);
    if (col) {
      if (col.colEt > now) return col;
      stale = stale ?? col;
    }
  } catch {
    /* keep whatever the save gave us */
  }
  return stale;
}

/**
 * Load the account for the Cards tab: decode the LocalInfo the client just
 * pulled, take the API token and roster from it, then confirm the token with
 * a real CheckCity so the tab shows *before* the first send whether the
 * credentials work, what the city is called, and how many boxes are waiting.
 * The active card collection is resolved here too, so the first send never
 * pays for it.
 */
export async function loadCardInfo(
  token: string,
  sessionId: string,
  b64: string,
  saveXml?: string | null,
): Promise<CardLoadResult> {
  const xml = decodeLocalInfoBase64(b64);
  const meta = parseOwnMeta(xml);
  const awsToken = xml.match(/<AWS\b[^>]*\btoken="([^"]+)"/i)?.[1] ?? "";
  if (!awsToken) {
    throw new Error(
      "LocalInfo không chứa API token — hãy mở Township ít nhất một lần rồi Refresh.",
    );
  }
  if (!meta.cityId) {
    throw new Error("LocalInfo không chứa cityId — kiểm tra lại bản save đang mở.");
  }

  // The game's own friend list lives in the save (`<FollowedFriendIds>`), and
  // LocalInfo carries the platform roster. Either one alone is incomplete —
  // reading only LocalInfo is why the tab showed a friend list that did not
  // match the game. Merge both, save first so the in-game names win.
  const fromSave = (saveXml ? parseGameFriends(saveXml) : []).map((f) => ({
    id: f.id,
    name: f.name,
    level: f.level,
  }));
  const fromLocal = parseLocalFriends(xml).map((f) => ({ id: f.id, name: f.name, level: f.level }));
  const merged = new Map<string, CardFriend>();
  for (const f of [...fromSave, ...fromLocal]) {
    if (!f.id || f.id === meta.cityId) continue;
    const prev = merged.get(f.id);
    if (!prev) {
      merged.set(f.id, f);
      continue;
    }
    merged.set(f.id, {
      id: f.id,
      name: prev.name && prev.name !== prev.id ? prev.name : f.name,
      level: prev.level || f.level,
    });
  }
  const friends: CardFriend[] = [...merged.values()];

  const prev = accounts.get(sessionId);
  const ident = ownIdentity(xml, meta.cityId, prev?.name ?? "");
  const acc: CardAccount = {
    cityId: meta.cityId,
    token: awsToken,
    bver: meta.bver || prev?.bver || "",
    fver: meta.fver || prev?.fver || "",
    name: ident.name || prev?.name || "",
    level: prev?.level ?? 0,
    pic: ident.pic || prev?.pic || "",
    friends,
    boxes: prev?.boxes ?? 0,
    checkedAt: 0,
    checkError: null,
    col: prev?.col ?? null,
    colAt: 0,
  };
  if (!acc.bver || !acc.fver) {
    throw new Error("LocalInfo không chứa version game (bver/FVer) — mở Township rồi Refresh.");
  }

  try {
    const r = await apiCall(
      acc,
      "CheckCity",
      { cityId: acc.cityId, tz: 28800 },
      `?cityId=${acc.cityId}`,
    );
    if (r.ok && r.resp && typeof r.resp.result === "object" && r.resp.result !== null) {
      const result = r.resp.result as Record<string, unknown>;
      acc.name = typeof result.name === "string" && result.name ? result.name : acc.name;
      acc.level = Number(result.lvl) || acc.level;
      acc.boxes = Array.isArray(result.boxes) ? result.boxes.length : 0;
      acc.checkedAt = Date.now();
    } else {
      acc.checkError =
        r.status === 401
          ? "Token bị từ chối (401) — làm mới LocalInfo"
          : `CheckCity: ${r.error ?? `HTTP ${r.status ?? "?"}`}`;
    }
  } catch (e) {
    acc.checkError = e instanceof Error ? e.message : String(e);
  }

  // Resolve the event window before the account goes live: a fresh save gives
  // it for free, a stale or missing one costs one FetchCity here rather than
  // a failed first send.
  acc.col = (await resolveCardCollection(token, sessionId, acc)) ?? acc.col;
  acc.colAt = acc.col && acc.col.colEt > nowSec() ? Date.now() : 0;

  accounts.set(sessionId, acc);
  return { ...publicView(acc), cardIds: CARD_IDS };
}

export type SendOutcome = {
  /** "sent" = in the friend's inbox, "rejected" = id does not exist, "error" = transport/auth. */
  status: "sent" | "rejected" | "error";
  http?: number;
  detail?: string;
  /** How many transient 403s were retried before this outcome. */
  retried: number;
};

/**
 * Send exactly one card to exactly one friend — one API round trip, classified
 * honestly. The UI owns the loop (quantity, delay, progress) so every single
 * send is visible in the log and a stop button means stop.
 */
export async function sendCard(
  token: string,
  sessionId: string,
  toCityId: string,
  cardId: string,
): Promise<SendOutcome> {
  const acc = accounts.get(sessionId);
  if (!acc) throw new Error("Cards: chưa nạp LocalInfo — bấm Refresh trước khi gửi.");
  if (!CARD_IDS.includes(cardId)) throw new Error(`Cards: ${cardId} không có trong danh mục.`);
  if (!/^[A-Za-z0-9]{4,24}$/.test(toCityId)) {
    throw new Error(`Cards: id bạn gửi không hợp lệ (${toCityId}).`);
  }

  // The box must name the collection that is open *now*: Playrix rotates it
  // (CardCollections_7 → _8 on 2026-11-13) and SendBox is refused outright
  // for a col_id the server no longer knows — that refusal is what stopped
  // every client's sends. Re-resolve when the window has ended or nothing was
  // found, throttled so a long loop cannot spawn FetchCity per card.
  if (!acc.col || acc.col.colEt <= nowSec()) {
    if (Date.now() - acc.colAt >= COL_RERESOLVE_MS) {
      acc.colAt = Date.now();
      const fresh = await resolveCardCollection(token, sessionId, acc).catch(() => null);
      if (fresh) acc.col = fresh;
    }
  }
  if (!acc.col) {
    throw new Error("Chưa đọc được bộ sưu tập đang mở — Load save của bạn rồi bấm Refresh.");
  }
  const col = acc.col;
  const staleHint =
    col.colEt <= nowSec() ? " — bộ sưu tập trong save đã hết hạn, mở Township rồi bấm Refresh" : "";

  const box = {
    afg: 3,
    box_type: "collections_send_card",
    card_id: cardId,
    col_et: col.colEt,
    col_id: col.colId,
    friend_type: "send_friend",
    from: { city_id: acc.cityId, friend_city_name: acc.name, pic: acc.pic },
    seed: String(10000 + Math.floor(Math.random() * 90000)),
    sendCounter: 1,
    set_id: setOf(cardId),
    to: toCityId,
    type: "box",
  };
  const body = { cityId: acc.cityId, to_cityId: toCityId, box: JSON.stringify(box) };

  let retried = 0;
  for (let attempt = 0; ; attempt++) {
    const r = await apiCall(acc, "SendBox", body, `?cityId=${acc.cityId}`);
    if (r.ok && r.resp) {
      const result = r.resp.result;
      if (result !== null && typeof result === "object") {
        return { status: "sent", http: 200, retried };
      }
      if (result === null) {
        return { status: "rejected", http: 200, retried, detail: staleHint || undefined };
      }
      // 200 with an unexpected shape — report it rather than call it a send.
      return { status: "error", http: 200, detail: JSON.stringify(r.resp).slice(0, 160), retried };
    }

    const http = r.status ?? 0;
    const err = r.error ?? "";
    if (http === 403 && attempt < RETRY_403_ATTEMPTS) {
      // The anti-abuse layer trips on cadence, not on content: back off and
      // the same box is accepted. (401 "Wrong parameter" never lands here.)
      retried++;
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    if (http === 401) {
      return {
        status: "error",
        http,
        detail: "Token bị từ chối (401) — làm mới LocalInfo",
        retried,
      };
    }
    if (http === 403) {
      return {
        status: "error",
        http,
        detail: "Bị chặn tạm (403) sau khi thử lại — tăng delay" + staleHint,
        retried,
      };
    }
    return { status: "error", http, detail: err || `HTTP ${http}`, retried };
  }
}

export type InboxBox = {
  type: string;
  card?: string;
  from?: string;
  time?: string;
};

/**
 * Fresh CheckCity for the inbox preview: validates the token again, refreshes
 * the own-name/level, and lists what is waiting to be collected — the same
 * `boxes` array the receiver's game will show, which is how a delivery is
 * verified end to end. `total` is the uncapped inbox size: `boxes` itself
 * lists at most 60 entries, while the 100-box cap math needs the real count.
 */
export async function checkInbox(
  _token: string,
  sessionId: string,
): Promise<{
  name: string;
  level: number;
  boxes: InboxBox[];
  total: number;
  error: string | null;
}> {
  const acc = accounts.get(sessionId);
  if (!acc) throw new Error("Cards: chưa nạp LocalInfo — bấm Refresh trước.");

  try {
    const r = await apiCall(
      acc,
      "CheckCity",
      { cityId: acc.cityId, tz: 28800 },
      `?cityId=${acc.cityId}`,
    );
    if (r.ok && r.resp && typeof r.resp.result === "object" && r.resp.result !== null) {
      const result = r.resp.result as Record<string, unknown>;
      acc.name = typeof result.name === "string" && result.name ? result.name : acc.name;
      acc.level = Number(result.lvl) || acc.level;
      const raws = Array.isArray(result.boxes) ? (result.boxes as unknown[]) : [];
      acc.boxes = raws.length;
      acc.checkedAt = Date.now();
      acc.checkError = null;
      const boxes: InboxBox[] = [];
      for (const raw of raws.slice(-60).reverse()) {
        try {
          const b = JSON.parse(String(raw)) as Record<string, unknown>;
          boxes.push({
            type: String(b.box_type ?? "?"),
            card: typeof b.card_id === "string" ? b.card_id : undefined,
            from:
              typeof b.from === "object" && b.from
                ? String((b.from as Record<string, unknown>).friend_city_name ?? "")
                : undefined,
            time: b.time ? String(b.time) : undefined,
          });
        } catch {
          /* a box we cannot parse is still counted above */
        }
      }
      return { name: acc.name, level: acc.level, boxes, total: raws.length, error: null };
    }
    const error =
      r.status === 401
        ? "Token bị từ chối (401) — làm mới LocalInfo"
        : `CheckCity: ${r.error ?? `HTTP ${r.status ?? "?"}`}`;
    acc.checkError = error;
    return { name: acc.name, level: acc.level, boxes: [], total: 0, error };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    acc.checkError = error;
    return { name: acc.name, level: acc.level, boxes: [], total: 0, error };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
