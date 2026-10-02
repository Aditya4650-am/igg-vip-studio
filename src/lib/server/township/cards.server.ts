import { CARD_SEND_MAX_PER_RUN } from "@/lib/cards";

// One ceiling, both sides: the send button counts with it and the refusal
// below quotes it, so they cannot drift. See `cards.ts` for the rationale.
export { CARD_SEND_MAX_PER_RUN };

/**
 * Card-collections grants (`DataStoreCollection > CardCollections`).
 *
 * Real progress is the `OwnedCards` array of
 * `<DataElem type="dataStore">` entries
 * (`cardId`, `generatedCount`, `inStockCount`, `isNew`, `maxInStockCount`).
 * The flat `FullCardCollections` counter is display-only — the game does not
 * read it, so writing it reports success while changing nothing in game.
 *
 * Canonical ids are `card_01..card_09` then `card_10..card_151`: every real
 * city writes single digits zero-padded (no real city ever held unpadded
 * `card_1..card_9` — those rows are tool-created lookalikes the game keeps
 * but never counts toward a set). Inputs in either form are normalized to
 * canonical, and stale unpadded lookalikes are removed when their canonical
 * twin is granted.
 *
 * The catalog ends at 151 because a genuinely fetched city (`event_city`) holds
 * `card_01..card_151` contiguous with no gaps, and its `card_151` row is
 * field-for-field identical to its neighbours (`generatedCount="1"`
 * `inStockCount="1"` `isNew="false"` `maxInStockCount="1"`) — an ordinary
 * collection row the game itself wrote. Stopping at 150 left the last real card
 * unobtainable from *Unlock all*.
 *
 * Three things in here exist because a grant can otherwise look like a fraud
 * pattern to a server reading the save:
 *
 * 1. `grantCards` clamps stock to the measured ceiling and leaves `isNew`
 *    alone on cards the save already holds, so the save's own
 *    `sum(LastSeenSetProgress) == lastSeenCollectionProgress ==
 *    count(isNew=="false")` relation survives a grant untouched.
 * 2. `cardProblems` + `assertCardCollectionsSafe` are the push gate: they
 *    re-check every invariant measured across 7 real saves and refuse a file
 *    that broke one, comparing against the save as it was loaded so a city
 *    that already looked odd on arrival is never blocked for that reason.
 * 3. `sendCards` writes sends the way a real save holds them, and refuses
 *    (never silently skips) when the event window is closed, a recipient is
 *    not on this save's own `FriendsList`, or a card is not owned.
 */

export const CARD_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 151 }, (_, i) => {
    const n = i + 1;
    return n < 10 ? `card_0${n}` : `card_${n}`;
  }),
);

const KNOWN: ReadonlySet<string> = new Set(CARD_IDS);

/**
 * Measured ceilings, not guesses — both come from 629 `OwnedCards` entries
 * across 7 real saves (1 genuine player city, 6 genuine fetched cities):
 *
 * - `CARD_STOCK_MAX`: `inStockCount` is never 0 and never above 4 anywhere,
 *   and `maxInStockCount` tops out at 4 too. Asking for 12 used to write
 *   `inStockCount="12"` — a value no city the server has ever seen can hold.
 * - `CARD_SEND_HISTORY_MAX`: `lastSentCards` never held more than 3 entries
 *   in any save (1 / 0 / 0 / 0 / 0 / 3 / 1) while `totalSendCards` reached 13.
 *   It is a short rolling history, so a longer array would be unprecedented.
 *   The counters carry the real total, exactly as real saves do.
 * - `CARD_SEND_MAX_PER_RUN`: a round batch ceiling just under the catalog, so
 *   one push is effectively a whole collection without ever inventing a number.
 *   Defined in `@/lib/cards` and re-exported above, because the button that
 *   has to respect it runs in the browser.
 */
export const CARD_STOCK_MAX = 4;
export const CARD_SEND_HISTORY_MAX = 3;

/** Normalize `card_6`/`card_06` (any padding) to the canonical id, or null. */
function canonical(id: string): string | null {
  const m = /^card_0*(\d+)$/.exec(id.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 151) return null;
  return n < 10 ? `card_0${n}` : `card_${n}`;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Depth-walk from a `<DataElem` opener to its own `</DataElem>`. Returns the
 * inner span, or null for a self-closing tag (no content) and for an
 * unclosed one — never a guess about where the block ends, because a wrong
 * end index splices the document in the wrong place.
 */
function spanAt(doc: string, start: number): [number, number] | null {
  const gt = doc.indexOf(">", start);
  if (gt < 0) return null;
  if (doc[gt - 1] === "/") return null;
  let depth = 1;
  let pos = gt + 1;
  const openEnd = pos;
  while (depth > 0 && pos < doc.length) {
    const rest = doc.slice(pos);
    const o = rest.search(/<DataElem\b/i);
    const c = rest.search(/<\/DataElem\s*>/i);
    if (c < 0) return null;
    if (o >= 0 && o < c) {
      const abs = pos + o;
      const next = doc.indexOf(">", abs);
      if (next >= 0 && doc[next - 1] !== "/") depth++;
      pos = next >= 0 ? next + 1 : abs + 9;
    } else {
      const absC = pos + c;
      depth--;
      if (depth === 0) return [openEnd, absC];
      pos = absC + 11;
    }
  }
  return null;
}

/** The opening tag of the first `<DataElem name="…">` (optionally typed). */
function namedOpenTag(doc: string, name: string, type?: "array" | "dataStore"): RegExpMatchArray | null {
  const esc = escapeRe(name);
  if (!type) return doc.match(new RegExp(`<DataElem\\b[^>]*\\bname="${esc}"[^>]*>`, "i"));
  return (
    doc.match(new RegExp(`<DataElem\\b[^>]*\\bname="${esc}"[^>]*\\btype="${type}"[^>]*>`, "i")) ??
    doc.match(new RegExp(`<DataElem\\b[^>]*\\btype="${type}"[^>]*\\bname="${esc}"[^>]*>`, "i"))
  );
}

function namedSpan(doc: string, name: string, type?: "array" | "dataStore"): [number, number] | null {
  const open = namedOpenTag(doc, name, type);
  if (!open || open.index === undefined) return null;
  return spanAt(doc, open.index);
}

function ownedCardsSpan(doc: string): [number, number] | null {
  return namedSpan(doc, "OwnedCards", "array");
}

/** Inner text of the single `CardCollections` store, or null if absent. */
function cardBlock(xml: string): string | null {
  const span = namedSpan(xml, "CardCollections", "dataStore");
  return span ? xml.slice(span[0], span[1]) : null;
}

function fieldValue(entry: string, name: string): string | null {
  return entry.match(new RegExp(`<DataElem\\b[^>]*\\bname="${name}"[^>]*\\bvalue="([^"]*)"`, "i"))?.[1] ?? null;
}

function setField(entry: string, name: string, value: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return entry.replace(
    new RegExp(`(<DataElem\\b[^>]*\\bname="${esc}"[^>]*\\bvalue=")[^"]*(")`, "i"),
    `$1${value}$2`,
  );
}

function setDocInt(doc: string, name: string, value: number): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return doc.replace(
    new RegExp(`(<DataElem\\b[^>]*\\bname="${esc}"[^>]*\\bvalue=")\\d+(")`, "i"),
    `$1${value}$2`,
  );
}

function docInt(doc: string, name: string): number | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = doc.match(new RegExp(`<DataElem\\b[^>]*\\bname="${esc}"[^>]*\\bvalue="(\\d+)"`, "i"));
  return m ? Number(m[1]) : null;
}

/**
 * Flat `<Var name="…" v="…">` integer anywhere in the document (missing or
 * non-numeric reads 0). The block-scoped `docInt` above only sees
 * `<DataElem>` values; the lifetime counter is a `<Var>` outside the block,
 * so the gate reads it at document scope.
 */
function flatVarInt(xml: string, name: string): number {
  const m = new RegExp(`<Var\\b[^>]*\\bname="${name}"[^>]*\\bv="(\\d+)"`, "i").exec(xml);
  return m ? Number(m[1]) : 0;
}

/** Distinct owned card ids — a read-only progress number, never edited. */
export function countOwnedCards(xml: string): number {
  const span = ownedCardsSpan(xml);
  if (!span) return 0;
  return new Set(
    [...xml.slice(span[0], span[1]).matchAll(/<DataElem\b[^>]*\bname="cardId"[^>]*\bvalue="([^"]*)"/gi)].map(
      (x) => x[1],
    ),
  ).size;
}

/**
 * Ensure every selected card is owned with the requested stock.
 * `qtyMap` maps loose-or-canonical ids to wanted `inStockCount` copies;
 * stock and `maxInStockCount` are raised (never lowered) to the request and
 * `isNew` is set. Inputs in either padding form normalize to canonical, and
 * stale unpadded lookalikes (`card_6` next to `card_06`) are removed when
 * their canonical twin is granted. Unknown ids and non-positive quantities
 * are dropped. Returns `changed: 0` when nothing would move so the caller
 * reports a real no-op.
 */
export function grantCards(xml: string, qtyMap: Record<string, number>) {
  let text = xml;
  const wanted = new Map<string, number>();
  for (const [raw, qty] of Object.entries(qtyMap)) {
    const id = canonical(raw);
    const n = Math.floor(Number(qty));
    if (!id || !Number.isFinite(n) || n <= 0) continue;
    // Clamped to the highest stock any real save has ever held (4). Anything
    // above that is a number the server has no way to reconcile.
    wanted.set(id, Math.min(Math.max(wanted.get(id) ?? 0, n), CARD_STOCK_MAX));
  }
  if (!wanted.size) return { xml: text, changed: 0 };
  // No CardCollections block means the event never opened on this save —
  // inventing the whole structure risks a corrupt session, so refuse with a
  // useful error instead of guessing.
  if (!/name="CardCollections"/i.test(text)) {
    throw new Error("Save chưa mở sự kiện Card Collections — mở bộ sưu tập trong game rồi Load lại");
  }
  const span = ownedCardsSpan(text);
  if (!span) {
    throw new Error("Không đọc được OwnedCards trong save — Load lại rồi thử lại");
  }
  // How many raw rows the save held before any of this ran. The cleanup step
  // below removes stale unpadded twins, which lowers the count, so the
  // "currently held" counter has to be able to follow it downwards too.
  const prevDistinct = new Set(
    [...text.slice(span[0], span[1]).matchAll(/<DataElem\b[^>]*\bname="cardId"[^>]*\bvalue="([^"]*)"/gi)].map((x) => x[1]),
  ).size;
  let changed = 0;
  for (const [id, want] of wanted) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const region = text.slice(span[0], span[1]);
    const m = region.match(new RegExp(`<DataElem\\b[^>]*\\bname="cardId"[^>]*\\bvalue="${esc}"[^>]*>`, "i"));
    if (!m || m.index === undefined) {
      const insert =
        `<DataElem type="dataStore">` +
        `<DataElem name="cardId" type="string" value="${id}"/>` +
        `<DataElem name="generatedCount" type="int" value="${want}"/>` +
        `<DataElem name="inStockCount" type="int" value="${want}"/>` +
        `<DataElem name="isNew" type="bool" value="true"/>` +
        `<DataElem name="maxInStockCount" type="int" value="${want}"/>` +
        `</DataElem>`;
      text = text.slice(0, span[1]) + insert + text.slice(span[1]);
      span[1] += insert.length;
      changed += 1;
    } else {
      // Entry bounds: up to the next card entry (or the array end), so field
      // edits cannot bleed into a neighbouring card.
      const rest = region.slice(m.index);
      const nextCard = rest.slice(m[0].length).search(/<DataElem\b[^>]*\bname="cardId"/i);
      const end = nextCard < 0 ? region.length : m.index + m[0].length + nextCard;
      let entry = region.slice(m.index, end);
      const stock = Number(fieldValue(entry, "inStockCount") ?? "0");
      const maxStock = Number(fieldValue(entry, "maxInStockCount") ?? "0");
      let moved = false;
      if (stock < want) {
        entry = setField(entry, "inStockCount", String(want));
        moved = true;
      }
      if (maxStock < want) {
        entry = setField(entry, "maxInStockCount", String(want));
        moved = true;
      }
      // `isNew` is deliberately NOT touched on a card the save already holds.
      // Every real save satisfies
      //   sum(LastSeenSetProgress) == lastSeenCollectionProgress == count(isNew=="false")
      // and flipping a known card to `true` used to move only the third term:
      // a genuine player city went from 137 == 137 to 0 while the counter stayed
      // 137. A newly *inserted* row does still start `true`, which leaves the
      // count untouched and keeps the relation exact.
      if (moved) {
        text = text.slice(0, span[0] + m.index) + entry + text.slice(span[0] + end);
        span[1] += entry.length - (end - m.index);
        changed += 1;
      }
    }
    // Drop the unpadded lookalike the old build wrote (`card_6` next to the
    // canonical `card_06`). The close quote keeps `card_06` itself safe. The
    // splice covers exactly one entry (one non-self-closing opener, one
    // closer); anything else aborts the cleanup rather than risking the doc.
    const num = Number(id.split("_")[1]);
    if (num < 10) {
      const twin = `card_${num}`;
      const tesc = twin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const region2 = text.slice(span[0], span[1]);
      const tm = region2.match(new RegExp(`<DataElem\\b[^>]*\\bname="cardId"[^>]*\\bvalue="${tesc}"[^>]*>`, "i"));
      if (tm && tm.index !== undefined) {
        const cardAbs = span[0] + tm.index;
        const entryStart = text.lastIndexOf("<DataElem", cardAbs - 1);
        const afterTag = cardAbs + tm[0].length;
        const closer = /<\/DataElem\s*>/.exec(text.slice(afterTag, span[1]));
        if (entryStart >= span[0] && closer && !/<\/DataElem/i.test(text.slice(entryStart, cardAbs))) {
          const entryEnd = afterTag + closer.index + closer[0].length;
          const cut = text.slice(entryStart, entryEnd);
          const opens = (cut.match(/<DataElem\b/g) ?? []).length;
          const selfClose = (cut.match(/<DataElem\b[^>]*\/>/g) ?? []).length;
          const closes = (cut.match(/<\/DataElem/g) ?? []).length;
          if (opens - selfClose === 1 && closes === 1) {
            text = text.slice(0, entryStart) + text.slice(entryEnd);
            span[1] -= entryEnd - entryStart;
            changed += 1;
          }
        }
      }
    }
  }
  if (changed) {
    // Keep the analytics counters consistent with what the save now holds.
    // `trackedUniqueCollectedCards` is *current state* — it counts the rows
    // the save holds right now — so it follows the array in both directions:
    // a grant raises it, removing a stale unpadded twin lowers it. Letting it
    // drift the wrong way is what made a real tool-edited city fail
    // `trackedUnique == distinct` on push. `trackedMaxCollectedCards` is the
    // lifetime high-water mark and is only ever raised.
    const after = ownedCardsSpan(text);
    if (after) {
      const distinct = new Set(
        [...text.slice(after[0], after[1]).matchAll(/<DataElem\b[^>]*\bname="cardId"[^>]*\bvalue="([^"]*)"/gi)].map((x) => x[1]),
      ).size;
      const unique = docInt(text, "trackedUniqueCollectedCards");
      if (unique !== null && (distinct > unique || distinct !== prevDistinct)) {
        text = setDocInt(text, "trackedUniqueCollectedCards", distinct);
      }
      const max = docInt(text, "trackedMaxCollectedCards");
      if (max !== null && distinct > max) {
        text = setDocInt(text, "trackedMaxCollectedCards", distinct);
      }
    }
  }
  return { xml: text, changed };
}

/* ------------------------------------------------------------------ *
 * Structural guard
 * ------------------------------------------------------------------ */

/**
 * Structural problems inside a `CardCollections` block, returned as *keys*
 * rather than messages so the push gate can diff the save as it was loaded
 * against the save about to leave: a save that already violated a rule is
 * never refused for that same rule, only for one this tool broke.
 *
 * Each key is one of the invariants measured across 7 real saves — 629
 * `OwnedCards` entries, every one passing. A tool edit that fails any of
 * them produces a city the server has never seen a real player produce,
 * which is exactly the shape a fraud check looks for.
 */
export function cardProblems(block: string): string[] {
  const out = new Set<string>();

  const span = namedSpan(block, "OwnedCards", "array");
  const region = span ? block.slice(span[0], span[1]) : "";
  const FIELDS = ["cardId", "generatedCount", "inStockCount", "isNew", "maxInStockCount"];

  const starts = [...region.matchAll(/<DataElem\b[^>]*\bname="cardId"/g)].map((m) => m.index!);
  const ids: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]!;
    const e = i + 1 < starts.length ? starts[i + 1]! : region.length;
    const entry = region.slice(s, e);
    const names = [...entry.matchAll(/<DataElem\b[^>]*\bname="([A-Za-z0-9_]+)"/g)].map((m) => m[1]!);
    if (names.join(",") !== FIELDS.join(",")) out.add("entry-fields");
    const num = (f: string) =>
      Number(entry.match(new RegExp(`<DataElem\\b[^>]*\\bname="${f}"[^>]*\\bvalue="(-?\\d+)"`, "i"))?.[1] ?? "NaN");
    const stock = num("inStockCount");
    const max = num("maxInStockCount");
    // Never 0, never above the measured ceiling, never above its own cap.
    if (!Number.isFinite(stock) || stock < 1 || stock > CARD_STOCK_MAX) out.add("stock-range");
    if (!Number.isFinite(max) || max < stock || max > CARD_STOCK_MAX) out.add("stock-range");
    const id = fieldValue(entry, "cardId");
    if (id !== null) ids.push(id);
  }

  // Ids are canonical and unique: no `card_1` beside `card_01`, none repeated.
  for (const id of ids) {
    const m = /^card_(\d{1,3})$/.exec(id);
    const n = m ? Number(m[1]) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > CARD_IDS.length || (n < 10 && !/^card_0\d$/.test(id))) {
      out.add("card-id-grammar");
      break;
    }
  }
  if (new Set(ids).size !== ids.length) out.add("duplicate-card");

  const distinct = new Set(ids).size;
  const uniq = docInt(block, "trackedUniqueCollectedCards");
  const tmax = docInt(block, "trackedMaxCollectedCards");
  const lastSeen = docInt(block, "lastSeenCollectionProgress");
  if (uniq !== null && uniq !== distinct) out.add("unique-count");
  if (uniq !== null && tmax !== null && tmax < uniq) out.add("max-count");
  if (uniq !== null && lastSeen !== null && lastSeen > uniq) out.add("last-seen-count");

  // sum(LastSeenSetProgress) == lastSeenCollectionProgress == count(isNew=="false")
  // — all three, on every real save. `grantCards` deliberately leaves isNew
  // alone so a grant cannot move only the third term.
  const fresh = (region.match(/<DataElem\b[^>]*\bname="isNew"[^>]*\bvalue="false"/gi) ?? []).length;
  if (lastSeen !== null && fresh !== lastSeen) out.add("progress-count");
  const lsp = namedSpan(block, "LastSeenSetProgress");
  if (lsp && lastSeen !== null) {
    const sum = [...block.slice(lsp[0], lsp[1]).matchAll(/\bvalue="(-?\d+)"/g)].reduce((a, m) => a + Number(m[1]), 0);
    if (sum !== lastSeen) out.add("progress-count");
  }

  // Completed sets are ten cards each (set_01 = card_01..card_10) and every
  // completed one is already in the reward list the game will pay out from.
  const cs = namedSpan(block, "CompletedSets", "dataStore");
  if (cs) {
    const inner = block.slice(cs[0], cs[1]);
    if (/\bname="set_\d+"[^>]*\bvalue="false"/i.test(inner)) out.add("completed-sets");
    const done = [...inner.matchAll(/\bname="(set_\d+)"[^>]*\bvalue="true"/gi)].map((m) => m[1]!);
    if (done.length) {
      const bySet = new Map<number, Set<number>>();
      for (const id of ids) {
        const m = /^card_0*(\d+)$/.exec(id);
        if (!m) continue;
        const n = Number(m[1]);
        if (n < 1 || n > CARD_IDS.length) continue;
        const s = Math.ceil(n / 10);
        if (!bySet.has(s)) bySet.set(s, new Set());
        bySet.get(s)!.add(n);
      }
      for (const s of done) {
        if ((bySet.get(Number(s.slice(4)))?.size ?? 0) !== 10) {
          out.add("completed-set-size");
          break;
        }
      }
      const gr = namedSpan(block, "givenBasicRewards", "array");
      if (gr) {
        const rewarded = new Set([...block.slice(gr[0], gr[1]).matchAll(/\bvalue="(set_\d+)"/gi)].map((m) => m[1]!));
        for (const s of done) {
          if (!rewarded.has(s)) {
            out.add("reward-missing");
            break;
          }
        }
      }
    }
  }

  const tsc = docInt(block, "totalSendCards");
  const tstage = docInt(block, "totalSendCardsCurrentStage");
  if (tsc !== null && tstage !== null && tsc < tstage) out.add("send-counters");

  const cur = docInt(block, "currentTokens");
  const track = docInt(block, "trackedTokensCount");
  const add = docInt(block, "additionalTokens");
  const lastTok = docInt(block, "lastSeenTokens");
  if (cur !== null && track !== null && cur !== track) out.add("token-count");
  if (cur !== null && add !== null && add > cur) out.add("token-count");
  if (cur !== null && lastTok !== null && lastTok > cur) out.add("token-count");

  return [...out];
}

/**
 * The card half of the push gate. Runs on every push but returns on a
 * straight string compare of the `CardCollections` block, so features that
 * never touch cards cost nothing.
 *
 * A block that disappears or appears from nowhere is refused outright: no
 * feature in this tool creates one (`grantCards` and `sendCards` both throw
 * first), so a block that was not there a moment ago means a splice went
 * somewhere it should not have.
 */
export function assertCardCollectionsSafe(loaded: string, pushed: string) {
  // A headline counter with no rows behind it is the cards half of the file
  // the 10-point tutorial-task ban arrived in: `FullCardCollections` raised
  // while the save holds zero `<DataElem name="cardId">` rows anywhere. The
  // counter lives outside the `CardCollections` block, so this runs before
  // the span compare below — a Var-only change on a block-less save would
  // otherwise never be seen. Same loaded-vs-pushed rule: a split the save
  // arrived with stays pushable, and any grant against rows already held
  // never trips this. A Stats-tab raise on a row-less save is refused with
  // its reason instead of failing silently in game.
  if (!/<DataElem\b[^>]*\bname="cardId"/i.test(pushed)) {
    if (flatVarInt(pushed, "FullCardCollections") > flatVarInt(loaded, "FullCardCollections")) {
      throw new Error(
        "Không đẩy file lên máy: số bộ sưu tập (card) tăng mà save không có lá bài nào — " +
          "mở tính năng thẻ trong game và nhận vài lá trước, rồi hãy sửa số này.",
      );
    }
  }
  const a = namedSpan(loaded, "CardCollections", "dataStore");
  const b = namedSpan(pushed, "CardCollections", "dataStore");
  if (!a && !b) return;
  if (a && !b) throw new Error("Không đẩy file: Card Collections bị mất sau khi sửa");
  if (!a && b) throw new Error("Không đẩy file: Card Collections tự sinh ra dù save gốc không có");

  const beforeXml = loaded.slice(a![0], a![1]);
  const afterXml = pushed.slice(b![0], b![1]);
  if (beforeXml === afterXml) return; // cards untouched — every other feature is unaffected

  const before = cardProblems(beforeXml);
  const after = cardProblems(afterXml);
  const broken = after.filter((p) => !before.includes(p));
  if (broken.length) {
    throw new Error(
      `Không đẩy file lên máy: Card Collections hỏng sau khi sửa (${broken.join(", ")}). ` +
        "Thẻ thật chưa từng cho kết quả này, nên server Playrix có thể coi save của bạn là gian lận.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * Sending cards
 * ------------------------------------------------------------------ */

/**
 * The save's own `Friends > FriendsList` — the authoritative roster and the
 * only thing that makes a `toUserId` ours to write. Pointing a send at a
 * stranger is the one part of this feature a server can check for free, so
 * the rule is enforced rather than trusted: the caller's recipient must be
 * on this list. Names come from `<friend … city_name>` records elsewhere in
 * the save when they are there, and fall back to the id.
 */
export function friendsList(xml: string): { id: string; name: string }[] {
  const span = namedSpan(xml, "FriendsList", "array");
  if (!span) return [];
  const ids = [...xml.slice(span[0], span[1]).matchAll(/<DataElem\b[^>]*\bvalue="([A-Za-z0-9]+)"/gi)].map(
    (m) => m[1]!,
  );
  const names = new Map<string, string>();
  for (const m of xml.matchAll(/<[A-Za-z][A-Za-z0-9]*\b[^>]*>/g)) {
    const tag = m[0];
    const id = /\b(?:city_id|cityId|id)="([A-Za-z0-9]+)"/i.exec(tag)?.[1];
    const name = /\b(?:city_name|cityName|displayName)="([^"]+)"/.exec(tag)?.[1];
    if (id && name && !names.has(id)) names.set(id, name);
  }
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: names.get(id) ?? id });
  }
  return out;
}

/**
 * The live card-collection window, read out of the save's own
 * `<DataElem name="first" value="RememberTime"/>` pair rather than assumed.
 * A `sendTime` outside that window is the single cheapest thing a server can
 * check, so a save that cannot produce one is refused instead of guessed at.
 *
 * A real city keeps one pair per remembered event — 15 in the sample save —
 * and the first of them is an empty leftover (`configId=""`, both times 0).
 * Only the pair naming the card event carries our window, so every pair is
 * scanned and the empty ones are skipped rather than read as "closed".
 */
export function cardWindow(xml: string): { start: number; end: number } | null {
  let at = 0;
  for (;;) {
    const anchor = xml.indexOf('value="RememberTime"', at);
    if (anchor < 0) return null;
    at = anchor + 1;
    const second = xml.indexOf('name="second"', anchor);
    if (second < 0) continue;
    const tagStart = xml.lastIndexOf("<DataElem", second);
    if (tagStart < 0 || second - tagStart > 500) continue;
    const span = spanAt(xml, tagStart);
    if (!span) continue;
    const inner = xml.slice(span[0], span[1]);
    const cfg = inner.match(/<DataElem\b[^>]*\bname="configId"[^>]*\bvalue="([^"]*)"/i)?.[1] ?? "";
    const ev = inner.match(/<DataElem\b[^>]*\bname="eventId"[^>]*\bvalue="([^"]*)"/i)?.[1] ?? "";
    if (!/^CardCollections/i.test(cfg) && !/^CardCollections/i.test(ev)) continue;
    const start = docInt(inner, "startTime");
    const end = docInt(inner, "endTime");
    if (start === null || end === null || end <= start) return null; // named but not running
    return { start, end };
  }
}

export type CardsInfo = {
  owned: number;
  ownedIds: string[];
  friends: number;
  sent: number;
  history: number;
  window: { start: number; end: number } | null;
  live: boolean;
  reason: "ok" | "no_event" | "window_closed" | "no_friends";
};

/** Read-only state the Cards tab shows *before* anything is pressed. */
export function inspectCards(xml: string): CardsInfo {
  const block = cardBlock(xml);
  const win = block ? cardWindow(xml) : null;
  const now = Math.floor(Date.now() / 1000);
  const live = Boolean(win && now >= win.start && now <= win.end);
  const friends = friendsList(xml);

  const ownedSpan = block ? namedSpan(block, "OwnedCards", "array") : null;
  const owned = new Set<string>();
  if (ownedSpan && block) {
    for (const m of block.slice(ownedSpan[0], ownedSpan[1]).matchAll(/<DataElem\b[^>]*\bname="cardId"[^>]*\bvalue="([^"]*)"/gi)) {
      const c = canonical(m[1]!);
      if (c) owned.add(c);
    }
  }

  const hist = block ? namedSpan(block, "lastSentCards", "array") : null;
  const history = hist
    ? (block!.slice(hist[0], hist[1]).match(/<DataElem\b[^>]*type="dataStore"[^>]*>/gi) ?? []).length
    : 0;

  const reason: CardsInfo["reason"] = !block
    ? "no_event"
    : !live
      ? "window_closed"
      : !friends.length
        ? "no_friends"
        : "ok";

  return {
    owned: owned.size,
    ownedIds: [...owned].sort(),
    friends: friends.length,
    sent: block ? docInt(block, "totalSendCards") ?? 0 : 0,
    history,
    window: win,
    live,
    reason,
  };
}

export type CardSend = { cardId: string; toUserId: string };

/**
 * Record card sends into the save, exactly the way a real save holds them.
 *
 * What is written, and nothing else: one `lastSentCards` entry per distinct
 * (card, friend) pair with the observed three fields in the observed order,
 * the array capped at `CARD_SEND_HISTORY_MAX` (never longer in any real
 * save), and `totalSendCards` / `totalSendCardsCurrentStage` raised together
 * by the number of sends recorded — never lowered, never invented.
 *
 * Deliberately untouched: `inStockCount` (every sent card in every real save
 * still sits in `OwnedCards` with stock >= 1, so a decrement would be the
 * one number we cannot justify), `CardsSent` and `totalGivenCards` (neither
 * reconciles with `totalSendCards` in any save, so there is no relation to
 * preserve), and every gift / token / set field.
 *
 * Refuses — with a reason, never a silent skip — when the block or the event
 * window is missing or closed, when a recipient is not on this save's own
 * roster, or when a card is not in `OwnedCards`.
 */
export function sendCards(xml: string, sends: CardSend[]) {
  let text = xml;

  const wanted: CardSend[] = [];
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const s of sends) {
    const id = typeof s?.cardId === "string" ? canonical(s.cardId) : null;
    const to = typeof s?.toUserId === "string" ? s.toUserId.trim() : "";
    if (!id) {
      bad.push(String(s?.cardId));
      continue;
    }
    if (!/^[A-Za-z0-9]{1,20}$/.test(to)) {
      bad.push(`${id} → ${to || "?"}`);
      continue;
    }
    const key = `${id}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({ cardId: id, toUserId: to });
  }
  if (bad.length) throw new Error(`Thẻ hoặc người nhận không hợp lệ: ${bad.slice(0, 5).join(", ")}`);
  if (!wanted.length) return { xml: text, changed: 0 };
  if (wanted.length > CARD_SEND_MAX_PER_RUN) {
    throw new Error(`Mỗi lần gửi tối đa ${CARD_SEND_MAX_PER_RUN} thẻ — bạn đang chọn ${wanted.length}`);
  }

  const cs = namedSpan(text, "CardCollections", "dataStore");
  if (!cs) {
    throw new Error("Save chưa mở sự kiện Card Collections — mở bộ sưu tập trong game rồi Load lại");
  }
  let block = text.slice(cs[0], cs[1]);

  const win = cardWindow(text);
  const now = Math.floor(Date.now() / 1000);
  if (!win) {
    throw new Error("Không đọc được khung sự kiện Card Collections — sự kiện chưa mở, chưa thể gửi thẻ");
  }
  if (now < win.start || now > win.end) {
    throw new Error(
      `Sự kiện Card Collections đã đóng (${new Date(win.end * 1000).toLocaleString()}) — chưa thể gửi thẻ`,
    );
  }

  const friends = new Set(friendsList(text).map((f) => f.id));
  const outsiders = [...new Set(wanted.filter((w) => !friends.has(w.toUserId)).map((w) => w.toUserId))];
  if (outsiders.length) {
    throw new Error(`Người nhận không có trong danh sách bạn bè của bạn: ${outsiders.join(", ")}`);
  }

  const owned = new Set(
    [...block.matchAll(/<DataElem\b[^>]*\bname="cardId"[^>]*\bvalue="([^"]*)"/gi)]
      .map((m) => canonical(m[1]!))
      .filter((x): x is string => Boolean(x)),
  );
  const missing = [...new Set(wanted.map((w) => w.cardId).filter((id) => !owned.has(id)))];
  if (missing.length) {
    throw new Error(`Bạn chưa có thẻ này để gửi: ${missing.join(", ")} — thêm vào bộ sưu tập trước`);
  }

  const tsc = docInt(block, "totalSendCards");
  const tstage = docInt(block, "totalSendCardsCurrentStage");
  if (tsc === null || tstage === null) {
    throw new Error("Save không có dữ liệu gửi thẻ (totalSendCards) — không thể ghi nhận lần gửi này");
  }

  // One entry per distinct pair, in the observed field order. The batch's
  // times ascend, stay inside the window, and never exceed "now".
  const n = wanted.length;
  const entries = wanted.map((w, i) => {
    const t = Math.max(win.start, Math.min(now, now - (n - 1 - i)));
    return (
      `<DataElem type="dataStore">` +
      `<DataElem name="cardId" type="string" value="${w.cardId}"/>` +
      `<DataElem name="sendTime" type="int64" value="${t}"/>` +
      `<DataElem name="toUserId" type="string" value="${w.toUserId}"/>` +
      `</DataElem>`
    );
  });
  const retained = entries.slice(-CARD_SEND_HISTORY_MAX);

  const hspan = namedSpan(block, "lastSentCards", "array");
  if (!hspan) {
    const open = namedOpenTag(block, "lastSentCards", "array");
    if (!open || open.index === undefined || !/\/>\s*$/.test(open[0])) {
      throw new Error("Không đọc được lastSentCards trong save — hủy để tránh hỏng file");
    }
    const replacement = open[0].replace(/\/>$/, ">") + retained.join("") + "</DataElem>";
    block = block.slice(0, open.index) + replacement + block.slice(open.index + open[0].length);
  } else {
    const inner = block.slice(hspan[0], hspan[1]);
    const found = [...inner.matchAll(/<DataElem\b[^>]*type="dataStore"[^>]*>[\s\S]*?<\/DataElem>/g)];
    let cursor = 0;
    let clean = true;
    for (const f of found) {
      if (inner.slice(cursor, f.index!).trim() !== "") {
        clean = false;
        break;
      }
      cursor = f.index! + f[0].length;
    }
    if (clean && inner.slice(cursor).trim() !== "") clean = false;
    if (!clean) throw new Error("lastSentCards có cấu trúc lạ — hủy để tránh hỏng file");
    const merged = [...found.map((f) => f[0]), ...entries].slice(-CARD_SEND_HISTORY_MAX);
    block = block.slice(0, hspan[0]) + merged.join("") + block.slice(hspan[1]);
  }

  // Both counters move together by exactly what was recorded, so
  // `totalSendCards >= totalSendCardsCurrentStage` always survives.
  block = setDocInt(block, "totalSendCards", tsc + n);
  block = setDocInt(block, "totalSendCardsCurrentStage", tstage + n);

  text = text.slice(0, cs[0]) + block + text.slice(cs[1]);
  return { xml: text, changed: n };
}
