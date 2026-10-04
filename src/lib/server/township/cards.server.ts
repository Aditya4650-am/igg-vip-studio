/**
 * The card half of the push gate (`DataStoreCollection > CardCollections`).
 *
 * There is no card *feature* here any more — the tab that granted cards and
 * queued sends to friends was removed, so nothing in this tool writes
 * `OwnedCards` or `lastSentCards` any more. What stays is the guard, because
 * it is not a feature: it runs on every push and refuses a save whose card
 * section a *different* edit broke.
 *
 * It is reachable without any card UI. Two paths still move card data:
 *
 * - the Stats tab writes the flat `FullCardCollections` counter (`crd`), and
 *   a raise with no `<DataElem name="cardId">` rows behind it is the shape of
 *   the 10-point tutorial-task ban on file;
 * - a restore copies the friend's card state through `INICIAL_VARS`.
 *
 * `cardProblems` returns invariant *keys* rather than messages so
 * `assertCardCollectionsSafe` can diff the save as it was loaded against the
 * save about to leave: a save that already looked odd on arrival keeps its
 * keys on both sides and stays pushable, which is what lets this be strict
 * about what the tool writes.
 */

export const CARD_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 151 }, (_, i) => {
    const n = i + 1;
    return n < 10 ? `card_0${n}` : `card_${n}`;
  }),
);

/**
 * The measured ceiling on `inStockCount`, from 629 `OwnedCards` entries
 * across 7 real saves (1 genuine player city, 6 genuine fetched cities):
 * stock is never 0 and never above 4 anywhere, and `maxInStockCount` tops
 * out at 4 too. It is kept only because the gate below has to recognise a
 * stock the server has never seen — asking for 12 used to write
 * `inStockCount="12"`, a value no city on record can hold.
 */
export const CARD_STOCK_MAX = 4;

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

function fieldValue(entry: string, name: string): string | null {
  return entry.match(new RegExp(`<DataElem\\b[^>]*\\bname="${name}"[^>]*\\bvalue="([^"]*)"`, "i"))?.[1] ?? null;
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
  // — all three, on every real save. Nothing here writes `isNew` any more;
  // the rule stays because a counter moved without its third term is exactly
  // what a broken edit looks like.
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
 * feature in this tool creates one, so a block that was not there a moment
 * ago means a splice went somewhere it should not have.
 */
export function assertCardCollectionsSafe(loaded: string, pushed: string) {
  // A headline counter with no rows behind it is the cards half of the file
  // the 10-point tutorial-task ban arrived in: `FullCardCollections` raised
  // while the save holds zero `<DataElem name="cardId">` rows anywhere. The
  // counter lives outside the `CardCollections` block, so this runs before
  // the span compare below — a Var-only change on a block-less save would
  // otherwise never be seen. Same loaded-vs-pushed rule: a split the save
  // arrived with stays pushable, and a raise against rows already held
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
