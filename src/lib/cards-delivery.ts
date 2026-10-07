/**
 * Delivery physics for the Cards tab — pure helpers shared by the send loop
 * and the tests. No I/O, no React.
 *
 * Proven against the live server (the `cards_*` experiments): a receiver's
 * inbox holds **100 gift boxes** of any type; the 101st insert permanently
 * evicts the oldest down to 50. There is no TTL, nothing ever comes back, and
 * a sender cannot see that inbox (`CheckCity` on another city is Forbidden) —
 * so a run must never push the estimated box footprint past the cap, and it
 * has to confirm delivery from the friend's *save* instead (FetchCity is
 * readable by cityId, and the save carries both the album and the boxes).
 *
 * Two rules fall out of that and live here:
 *
 * - **Numeric send order.** `card_100` must never sort before `card_11`: the
 *   old lexicographic order shipped cards 100–151 *first*, and the prune then
 *   destroyed exactly those on a real receiver — the loss pattern this module
 *   exists to prevent.
 * - **Cap-aware waves.** Estimate = visible unclaimed boxes + our own
 *   not-yet-collected sends (+ a reserve when the save is too stale to see
 *   behind), keep it ≤ INBOX_SAFE, and wait for the receiver to collect
 *   between waves.
 */

/** Measured cap: 100 boxes are kept, the 101st evicts the oldest down to 50. */
export const INBOX_BOX_CAP = 100;
/** Wave ceiling — 10 boxes of headroom below the proven cap. */
export const INBOX_SAFE = 90;
/** Snapshot older than STALE_AFTER_MS → assume up to this many unseen live boxes. */
export const STALE_BACKLOG_RESERVE = 40;
export const STALE_AFTER_MS = 60 * 60 * 1000;

const CARD_RE = /^card_0*(\d+)$/;

/** `card_11` → 11, `card_05` → 5; 0 for anything that is not a card id. */
export function cardNumber(cardId: string): number {
  const m = CARD_RE.exec(cardId);
  return m ? Number(m[1]) : 0;
}

/** Canonical id for a card number — must stay byte-equal to `CARD_IDS`. */
export function cardIdOf(n: number): string {
  return n < 10 ? `card_0${n}` : `card_${n}`;
}

/**
 * Delivery order: by card number, not by string. `sortCardsNumerically`
 * sends card_02 before card_11 before card_100, so an unexpected prune can
 * never take out the high cards first.
 */
export function sortCardsNumerically(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => cardNumber(a) - cardNumber(b) || a.localeCompare(b));
}

export type SaveBox = {
  /** Card number 1..151 for `collections_send_card`, null for other types. */
  card: number | null;
  type: string;
  /** Sending city id from the box payload, "" when absent. */
  from: string;
  /** True once the receiver has applied the box into their album. */
  applied: boolean;
  /** Server timestamp (sec) — set when a receiver session absorbs the box. */
  time: number;
};

export type CardSnapshot = {
  /** The receiver's last save write, Unix sec (0 when the server omitted it). */
  updAt: number;
  boxes: SaveBox[];
  /** Unclaimed boxes of any type — this is what the 100-box cap counts. */
  pendingTotal: number;
  /** Boxes *we* delivered that are in their save, applied or still pending. */
  fromUs: Record<number, number>;
  /** Newest box timestamp (sec) — the moment a receiver session absorbed boxes. */
  maxBoxTime: number;
  /** Unique cards in the album / total copies, for reporting. */
  albumUnique: number;
  albumCopies: number;
  /** Every card number the receiver owns, ascending — the collect-for-self
   *  plan reads it to know exactly which cards are still missing. */
  ownedIds: number[];
};

/**
 * Parse the pieces of a fetched save the delivery check needs. The shape is
 * the real one: `<DataElem type="dataStore">` blocks hold the album
 * (`cardId` + `inStockCount`), `<box data='…' applied="…" time="…"/>`
 * elements hold the gift boxes, and the box's `from.city_id` says which city
 * sent it — that attribution is what lets "already delivered" be exact.
 */
export function parseCardSnapshot(
  xml: string,
  opts: { ourCityId: string; updAt: number },
): CardSnapshot {
  const boxes: SaveBox[] = [];
  for (const m of xml.matchAll(/<box data='(\{.*?\})'([^>]*)>/g)) {
    const data = m[1] ?? "";
    const attrs = m[2] ?? "";
    let type = "";
    let card: number | null = null;
    let from = "";
    try {
      const d = JSON.parse(data) as Record<string, unknown>;
      type = String(d.box_type ?? "");
      const rawId =
        typeof d.card_id === "string" ? d.card_id : typeof d.cardId === "string" ? d.cardId : "";
      const num = CARD_RE.exec(rawId)?.[1];
      card = num ? Number(num) : null;
      const f = d.from;
      if (f && typeof f === "object") from = String((f as Record<string, unknown>).city_id ?? "");
    } catch {
      /* an unparseable box still counts toward the cap below */
    }
    const time = Number(/(?:^|\s)time="(\d+)"/.exec(attrs)?.[1] ?? 0) || 0;
    const applied = /(?:^|\s)applied="1"/.test(attrs);
    boxes.push({ card, type, from, applied, time });
  }

  const fromUs: Record<number, number> = {};
  let pendingTotal = 0;
  let maxBoxTime = 0;
  for (const b of boxes) {
    if (!b.applied) pendingTotal++;
    if (b.time > maxBoxTime) maxBoxTime = b.time;
    if (b.card !== null && b.from === opts.ourCityId) {
      fromUs[b.card] = (fromUs[b.card] ?? 0) + 1;
    }
  }

  let albumUnique = 0;
  let albumCopies = 0;
  const seen = new Set<number>();
  for (const m of xml.matchAll(/<DataElem type="dataStore">([\s\S]*?)<\/DataElem>/g)) {
    const block = m[1] ?? "";
    const idMatch = /name="cardId" type="string" value="card_0*(\d+)"/.exec(block);
    if (!idMatch) continue;
    const n = Number(idMatch[1]);
    if (seen.has(n)) continue;
    seen.add(n);
    albumUnique++;
    const stock = Number(/name="inStockCount" type="\w+" value="(\d+)"/.exec(block)?.[1] ?? 1);
    albumCopies += Number.isFinite(stock) && stock > 0 ? stock : 1;
  }

  return {
    updAt: opts.updAt,
    boxes,
    pendingTotal,
    fromUs,
    maxBoxTime,
    albumUnique,
    albumCopies,
    ownedIds: [...seen].sort((a, b) => a - b),
  };
}

/**
 * What "collect for myself" still has to send: every catalogued card that is
 * neither in the album (`owned`) nor already on its way (`waiting` — boxes
 * pending in the save or sitting live in our own inbox). Ascending numeric
 * order, so the run always starts at card_01 and an unexpected prune can
 * never take the high cards out first. Zero/negative junk is dropped.
 */
export function missingCardNumbers(
  all: readonly number[],
  owned: readonly number[],
  waiting: readonly number[],
): number[] {
  const have = new Set<number>(owned);
  for (const n of waiting) if (n > 0) have.add(n);
  return [...new Set(all)].filter((n) => n > 0 && !have.has(n)).sort((a, b) => a - b);
}

/**
 * The receiver's estimated box footprint — what the send loop compares
 * against INBOX_SAFE before each wave.
 *
 * - `snap.pendingTotal`: boxes their save shows unclaimed (they count toward
 *   the cap under either reading of the server's model — visible-unclaimed or
 *   save+live — so they are always included).
 * - `ourUnmerged`: our successful sends that are not in their save yet —
 *   they are sitting in the live inbox.
 * - a stale or missing snapshot adds STALE_BACKLOG_RESERVE: a save that has
 *   not been written for hours tells us nothing about boxes other senders
 *   left there, so keep that much extra headroom.
 */
export function estimateBoxes(snap: CardSnapshot | null, ourUnmerged: number, now: number): number {
  const unmerged = Math.max(0, ourUnmerged);
  if (!snap) return STALE_BACKLOG_RESERVE + unmerged;
  const stale =
    snap.updAt > 0 && now - snap.updAt * 1000 > STALE_AFTER_MS ? STALE_BACKLOG_RESERVE : 0;
  return snap.pendingTotal + unmerged + stale;
}

export type DeliveryCheck = {
  /**
   * True when the snapshot was taken after a receiver session absorbed boxes
   * from *after* `sinceMs` — only then does "not in the save" mean "lost"
   * rather than "still in transit".
   */
  evidence: boolean;
  /** How many of each card the receiver now holds from us (in their save). */
  have: Record<number, number>;
  /** Cards that are provably short and should be resent (evidence only). */
  missing: Record<number, number>;
};

/**
 * Absolute delivery check: the receiver should end up holding `expected[n]`
 * copies of card n *from us*. A send made after the last absorbed batch is
 * still in transit, so it never counts as missing — that distinction is what
 * keeps the resend path from ever double-sending.
 */
export function deliveryCheck(
  expected: Record<number, number>,
  snap: CardSnapshot,
  sentTimes: Record<number, readonly number[]>,
  sinceMs: number,
): DeliveryCheck {
  const mergeMs = snap.maxBoxTime * 1000;
  const evidence = snap.maxBoxTime > 0 && mergeMs >= sinceMs;
  const have: Record<number, number> = {};
  const missing: Record<number, number> = {};
  for (const key of Object.keys(expected)) {
    const n = Number(key);
    const qty = expected[n] ?? 0;
    have[n] = snap.fromUs[n] ?? 0;
    if (!evidence) continue;
    const inFlight = (sentTimes[n] ?? []).filter((t) => t > mergeMs).length;
    const short = qty - have[n] - inFlight;
    if (short > 0) missing[n] = short;
  }
  return { evidence, have, missing };
}

/** How many of `expected` the receiver provably holds right now. */
export function confirmedCount(
  expected: Record<number, number>,
  have: Record<number, number>,
): number {
  let total = 0;
  for (const key of Object.keys(expected)) {
    const n = Number(key);
    total += Math.min(expected[n] ?? 0, have[n] ?? 0);
  }
  return total;
}
