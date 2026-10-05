/**
 * Event token wallets: Bloom & Buzz (`TrainJourney`) and Frozen Fortune
 * (`DragonNest`).
 *
 * Every function below takes the wallet's event id as an optional last
 * argument defaulting to `TrainJourney`, so the Bloom & Buzz path is the same
 * bytes, the same messages and the same gate keys it has always had, and the
 * Frozen Fortune card is one argument away rather than a second copy of the
 * writer. Names stay `bloom*` for the same reason the regatta helpers keep
 * theirs: they are this module's public API and the tests are their guard rail.
 *
 * ## Bloom & Buzz
 *
 * The game never calls it "Bloom & Buzz" in data — its own id is
 * **`TrainJourney`**, proven four ways against the APK: `VariablesContext.bin`
 * pairs `TrainJourney → https://playrix.com/probabilities/ts_bloom_and_buzz`,
 * the analytics hooks are `TrainJourney.Internal.*` with
 * `procedural_type = bloom_buzz`, the cutscenes are `bloom_buzz` inside
 * `trainJourneyFinalReward`, and the token item is `TrainJourneyToken`
 * (`TJ_Token`). The event's own configs are `TJ_BalancesConfig_*`,
 * `TJ_MainPopup` and `TJ_Plinko`.
 *
 * Why this is a **local edit and never a copy**. Event state lives under
 * `<DataStoreCollection>`, the one proven instant-ban donor block — a real
 * FetchCity response carries 38 copies of the donor's `cityId`, 58
 * `mainPlayer`, 161 `saveId` and their `currentProfiles` list inside it — and
 * it is the block no restore mode copies (see `NOVO_BLOCKS` in
 * `desban.server.ts`). Measured on `mGameInfo.current-23.xml`:
 * `<DataStoreCollection>` spans bytes 270243..819858 and the TrainJourney
 * wallet sits at 746306, i.e. *inside* it. So the Events tab only ever rewrites
 * two integers inside this save's own wallet, and it cannot import anything
 * from another account even by accident.
 *
 * The wallet, exactly as the game wrote it (cityId `5dv7F9pDuO`):
 *
 *   <DataStoreCollection> … <DataElem name="GameFeatures" type="dataStore">
 *     <DataElem name="TrainJourney" type="dataStore">
 *       <DataElem name="CurrencyProvider" type="dataStore">
 *         <DataElem name="Amount" type="int" value="7"/>
 *         <DataElem name="InitialValueSet" type="bool" value="true"/>
 *         <DataElem name="LastTransferTransactionId" type="string" value=""/>
 *         <DataElem name="TokensEarned" type="int" value="7"/>
 *       </DataElem> …
 *
 * That field order is the same in every one of the 25 saves carrying the
 * block, and the wallet as a whole in 44 valued wallets across the corpus —
 * 25 Bloom, 16 Frozen Fortune, 3 Magic Cauldron.
 *
 * Why **both** numbers move by the same Δ:
 *
 * - `TokensEarned` is what `TJ_MainPopup` reads back for the event summary and
 *   `Amount` is the balance the currency component shows
 *   (`trainJourneyBalancesConfig → currencyProvider`), so raising only one
 *   leaves the popup and the HUD disagreeing about the same wallet.
 * - `Earned − Amount` is lifetime spent, and it is the one relation a server
 *   can reconcile for free: measured on the plinko-heavy saves it is exactly
 *   the spins already taken (8/1414, 0/475, 137/1475, 99/300). Raising
 *   `Amount` alone would claim tokens were spent that never were, so the pair
 *   moves together and the relation is preserved to the token.
 *   It is **not** `TotalTokensSpent`: that field stays 0 on 30 of 40 wallets
 *   until a plinko spin is actually recorded, which is why the relation is the
 *   reliable one and that field is not used as a ledger here.
 *
 * ## Frozen Fortune (`DragonNest`) — the same wallet, measured not guessed
 *
 * The APK has exactly **three** `currencyProvider` wallets in 170 MB of
 * decoded config (`trainJourney`, `dragonNest`, `magicCauldron`); City Cascade's
 * `cityCascadeBalancesConfig` has none, so it has no balance to write. Of those
 * three, DragonNest is the one whose evidence is in front of us:
 *
 * - its config is wired like Bloom's — the same `behaviourVarsContextProvider`
 *   ids `3456437961` / `3407070177`, the same `balanceId` + `TokensBalanceId`
 *   pair — and its saves declare `DN_BalancesConfig_4/5/6` exactly where
 *   Bloom's declare `TJ_BalancesConfig_7`;
 * - **16 real wallets** on disk carry `Amount` + `TokensEarned`, and all 16
 *   satisfy `Amount <= TokensEarned` with `InitialValueSet="true"`, the same
 *   two rules the 25 Bloom wallets satisfy (41/41 across both events);
 * - field order is not fixed: 41 valued wallets split `35` with
 *   `LastTransferTransactionId` and `6` without, which is why `fieldSpan`
 *   reads a field by name instead of by position;
 * - exactly **one** `<DataElem name="DragonNest" type="dataStore">` exists per
 *   save and it is inside `GameFeatures` on 58/58 files, so naming the owner
 *   is enough to scope the write — no fallback to "some other wallet" is ever
 *   taken (a save may hold all three at once).
 *
 * Its empty state is the reason this feature refuses instead of writing:
 * **42 of 58 saves hold `<DataElem name="CurrencyProvider" type="dataStore"/>`
 * with no numbers in it at all** — the event has been scheduled on that
 * account but not opened. The block the game writes is there, the wallet's
 * values are not, so the refusal tells the user to open the event in game once
 * rather than inventing the two integers the game has not created yet.
 *
 * Deliberately never touched: `InitialValueSet`, `LastTransferTransactionId`,
 * `balanceVersion` (21 per save, always in component `ptr` dataStores and
 * never inside a `CurrencyProvider`), `LayerLaunchCurrencyTransfer`, and every
 * wallet the caller did *not* name — a save may hold up to three
 * (`TrainJourney`, `DragonNest`, `MagicCauldron`) and only the one being
 * edited may move. A whole-document replace of `name="Amount"` would hit all
 * three, which is why every write here is scoped to the span of
 * `<event> > CurrencyProvider` first.
 *
 * Honest limit: `lib/` is empty in the shipped APK (the engine is a JNI `.so`
 * we do not have), so which of the two numbers the on-screen bead count reads
 * cannot be proven from this repository alone — the save is where the wallet
 * lives and both numbers agree after this edit, and the remaining check is
 * opening the game on a throwaway account. No tool can guarantee 100%
 * protection: a green gate means "nothing provably wrong", never
 * "cannot be banned".
 */
import { elementRange, findUnbalancedTag } from "./xml-edit.server";
import { BLOOM_TOKENS_DEFAULT, BLOOM_TOKENS_MAX } from "../../events";

// Browser-safe bounds, defined once in `src/lib/events.ts` so the Events tab
// (which clamps as you type) and this writer can never drift apart.
export { BLOOM_TOKENS_DEFAULT, BLOOM_TOKENS_MAX };

/**
 * The wallets this module reads and writes, in the order the gate checks them.
 *
 * `TrainJourney` first is not cosmetic: `assertBloomSafe` reports the first
 * wallet it refuses, and every existing assertion in the Bloom tests expects
 * Bloom's own message when both wallets are present in one fixture.
 *
 * `MagicCauldron` is deliberately absent — it is the third `currencyProvider`
 * in the APK, but it appears in no save of this account's (3 of 58 files, all
 * A/B-test friend cities), so there is nothing here to measure it against.
 */
export const EVENT_WALLETS = ["TrainJourney", "DragonNest"] as const;
export type EventWalletId = (typeof EVENT_WALLETS)[number];

/** How a wallet is named in a refusal: the card's own name for every message,
 *  and its full form (name + the game's id) for the one refusal that has always
 *  carried it — `Save chưa có ví token Bloom & Buzz (TrainJourney)`. Splitting
 *  the two keeps Bloom's wording byte-identical to what shipped. */
const WALLET_NAME: Record<EventWalletId, string> = {
  TrainJourney: "Bloom & Buzz",
  DragonNest: "Frozen Fortune",
};

const WALLET_FULL: Record<EventWalletId, string> = {
  TrainJourney: "Bloom & Buzz (TrainJourney)",
  DragonNest: "Frozen Fortune (DragonNest)",
};

/**
 * Gate keys are namespaced per wallet. Two wallets are diffed side by side by
 * one loaded-vs-pushed comparison, so a key shared between them would let a
 * problem this tool created in one wallet be masked by the same problem the
 * save arrived with in the other.
 */
const KEY_PREFIX: Record<EventWalletId, string> = {
  TrainJourney: "bloom",
  DragonNest: "frozen",
};

const CURRENCY = "CurrencyProvider";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toInt = (v: string): number | null => (/^-?\d+$/.test(v) ? Number(v) : null);

/**
 * Opening index of the first `<DataElem … name="X" …>` (optionally typed)
 * inside `[from, to)`.
 *
 * Attribute order is matched in both directions because saves vary: the corpus
 * only ever shows `name` before `type`, but a rule written against one order
 * silently finds nothing — and "nothing found" here reads as "this save has no
 * event", which is a refusal rather than a crash.
 */
function namedOpenIndex(doc: string, name: string, type: string | null, from = 0, to = doc.length): number {
  const esc = escapeRe(name);
  const slice = doc.slice(from, to);
  const pats = type
    ? [
        new RegExp(`<DataElem\\b[^>]*\\bname="${esc}"[^>]*\\btype="${type}"[^>]*>`, "i"),
        new RegExp(`<DataElem\\b[^>]*\\btype="${type}"[^>]*\\bname="${esc}"[^>]*>`, "i"),
      ]
    : [new RegExp(`<DataElem\\b[^>]*\\bname="${esc}"[^>]*>`, "i")];
  let best = -1;
  for (const re of pats) {
    const m = re.exec(slice);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  return best < 0 ? -1 : from + best;
}

/**
 * Span of `<event> > CurrencyProvider`, or null when the save carries no
 * wallet at all (the 27 saves in the corpus with a `TrainJourneyDrop` analytics
 * block but no event store — the event has never been opened on that account;
 * for Frozen Fortune it is 42 of 58 saves holding an empty
 * `<DataElem name="CurrencyProvider" type="dataStore"/>`).
 *
 * It never falls back to *some other* `CurrencyProvider`: a save may hold three
 * and only the one named here may be edited.
 */
export function bloomWalletSpan(xml: string, event: EventWalletId = "TrainJourney"): { start: number; end: number } | null {
  const owner = namedOpenIndex(xml, event, "dataStore");
  if (owner < 0) return null;
  const block = elementRange(xml, owner);
  if (!block) return null;
  const rel = namedOpenIndex(xml, CURRENCY, null, block.start, block.end);
  if (rel < 0) return null;
  return elementRange(xml, rel);
}

/** `value="…"` of the one `DataElem` named `name` inside `w`, with offsets. */
function fieldSpan(w: string, name: string): { start: number; end: number; value: string } | null {
  const esc = escapeRe(name);
  const m = new RegExp(`<DataElem\\b[^>]*\\bname="${esc}"[^>]*>`, "i").exec(w);
  if (!m) return null;
  // The attribute is read out of the tag itself, so `type="int"` before or
  // after `name` makes no difference and a nested child can never be picked
  // up. The offsets are taken from the end of the match — the closing quote
  // of `value="…"` — rather than by searching the tag for the word "value",
  // which an attribute such as `valueCount` would locate first.
  const vm = /\bvalue\s*=\s*"([^"]*)"/i.exec(m[0]);
  if (!vm) return null;
  const end = m.index + vm.index + vm[0].length - 1;
  const start = end - vm[1]!.length;
  return { start, end, value: vm[1]! };
}

function fields(w: string) {
  const amount = fieldSpan(w, "Amount");
  const earned = fieldSpan(w, "TokensEarned");
  return {
    amount,
    earned,
    amountInt: amount ? toInt(amount.value) : null,
    earnedInt: earned ? toInt(earned.value) : null,
  };
}

/**
 * The wallet as the Events tab shows it.
 *
 * `present` is whether the save holds the block, `complete` whether both
 * numbers are readable — a save that has never opened the event reports
 * `no_wallet` so the tab can say so *before* anything is queued, instead of
 * failing at push. It is a readout, never a gate: nothing here blocks a push.
 *
 * `event` picks which wallet is reported; the Events tab asks for both.
 */
export type BloomReason = "ok" | "no_wallet" | "incomplete" | "invalid";

export type BloomInfo = { present: boolean; complete: boolean; amount: number; earned: number; reason: BloomReason };

export function bloomInfo(xml: string, event: EventWalletId = "TrainJourney"): BloomInfo {
  const span = bloomWalletSpan(xml, event);
  if (!span) return { present: false, complete: false, amount: 0, earned: 0, reason: "no_wallet" };
  const f = fields(xml.slice(span.start, span.end));
  const complete = f.amountInt !== null && f.earnedInt !== null;
  const reason: BloomReason = !complete ? "incomplete" : f.amountInt! < 0 || f.earnedInt! < 0 ? "invalid" : "ok";
  return { present: true, complete, amount: f.amountInt ?? 0, earned: f.earnedInt ?? 0, reason };
}

/** How many `Amount` / `TokensEarned` elements the wallet itself holds. */
function fieldCount(w: string, name: string) {
  return (w.match(new RegExp(`<DataElem\\b[^>]*\\bname="${escapeRe(name)}"`, "gi")) ?? []).length;
}

/**
 * Raise both wallet numbers by `want`.
 *
 * Only the two `value="…"` runs inside `<event> > CurrencyProvider` are
 * rewritten; every other byte of the document — including the other event
 * wallets, `InitialValueSet`, `LastTransferTransactionId` and the whole
 * `DataStoreCollection` around them — is left exactly as it was. The rewrite
 * runs from the later field backwards so the earlier field's offsets stay
 * valid without recomputing them.
 */
export function addBloomTokens(xml: string, want: number, event: EventWalletId = "TrainJourney"): string {
  const n = Math.floor(Number(want));
  if (!Number.isFinite(n) || n < 1) throw new Error("Số token không hợp lệ");

  const name = WALLET_NAME[event];
  const span = bloomWalletSpan(xml, event);
  if (!span) {
    throw new Error(
      `Save chưa có ví token ${WALLET_FULL[event]} — hãy mở sự kiện trong game một lần rồi thử lại. ` +
        "Công cụ không tự sinh ví mới vì sẽ thiếu cả StateMachine của sự kiện.",
    );
  }
  const before = xml.slice(span.start, span.end);
  if (fieldCount(before, CURRENCY) !== 1) {
    throw new Error(`Ví token ${name} bị lồng sai — không sửa để tránh hỏng save`);
  }
  const f = fields(before);
  if (!f.amount || !f.earned) {
    // Bloom's refusal text ships verbatim — what to do about an unopened event
    // is said once, in the Frozen Fortune card's own hint, rather than being
    // bolted onto a message another feature already reads.
    throw new Error(`Ví token ${name} thiếu Amount hoặc TokensEarned — không thể sửa an toàn`);
  }
  if (f.amountInt === null || f.earnedInt === null || f.amountInt < 0 || f.earnedInt < 0) {
    throw new Error(`Ví token ${name} chứa số không hợp lệ — không sửa để tránh hỏng save`);
  }

  const nextAmount = f.amountInt + n;
  const nextEarned = f.earnedInt + n;
  // A typo guard on the *input*, nothing more: no readable config states a
  // ceiling for this wallet, so this only stops one absurd request.
  if (n > BLOOM_TOKENS_MAX) throw new Error(`Số token tối đa mỗi lần là ${BLOOM_TOKENS_MAX}`);

  // Rewritten from the later field backwards: replacing it cannot move the
  // earlier field's offsets, so each pass works on coordinates already
  // validated against the string it is slicing.
  const edits = [
    { at: f.amount, value: nextAmount },
    { at: f.earned, value: nextEarned },
  ].sort((a, b) => b.at.start - a.at.start);
  let after = before;
  for (const e of edits) {
    after = `${after.slice(0, e.at.start)}${e.value}${after.slice(e.at.end)}`;
  }

  const out = `${xml.slice(0, span.start)}${after}${xml.slice(span.end)}`;

  const malformed = findUnbalancedTag(out);
  if (malformed) throw new Error(`Save XML không hợp lệ (${malformed}) — hủy để tránh hỏng file`);

  // Self-check: nothing inside the wallet may differ except the two numbers.
  if (stripWalletValues(after) !== stripWalletValues(before)) {
    throw new Error("Ví token thay đổi ngoài hai số lượng token — hủy");
  }
  return out;
}

/** The wallet with its two token values masked, for "nothing else moved". */
function stripWalletValues(w: string): string {
  let out = w;
  for (const name of ["Amount", "TokensEarned"]) {
    const f = fieldSpan(out, name);
    if (f) out = `${out.slice(0, f.start)}#${out.slice(f.end)}`;
  }
  return out;
}

/**
 * What the Events tab reports about a save, as *keys* so the push gate can
 * diff the save as it arrived against the save about to leave.
 */
export function bloomProblems(doc: string, event: EventWalletId = "TrainJourney"): string[] {
  const keys: string[] = [];
  const p = KEY_PREFIX[event];
  const span = bloomWalletSpan(doc, event);
  if (!span) return keys; // no event store — nothing to check, nothing to break
  const w = doc.slice(span.start, span.end);
  if (fieldCount(w, CURRENCY) !== 1) {
    keys.push(`${p}-wallet-nested`);
    return keys;
  }
  const f = fields(w);
  if (!f.amount || !f.earned) {
    keys.push(`${p}-wallet-incomplete`);
    return keys;
  }
  if (f.amountInt === null || f.earnedInt === null) {
    keys.push(`${p}-wallet-value-invalid`);
    return keys;
  }
  if (f.amountInt < 0 || f.earnedInt < 0) keys.push(`${p}-wallet-value-negative`);
  // Measured 41/41 valued wallets across both events in the corpus: the
  // balance never exceeds what the account has ever earned. A write that
  // breaks it is the shape a server reads for free — but a save that arrived
  // this way keeps the key on both sides and stays pushable.
  if (f.amountInt > f.earnedInt) keys.push(`${p}-balance-over-earned`);
  return keys;
}

/**
 * The wallet with its two token values masked, for "nothing else moved", plus
 * the pair as read. `complete` is false when either number is unreadable —
 * the numeric comparisons below only run on a wallet both sides could read.
 */
function walletText(doc: string, event: EventWalletId = "TrainJourney"): { text: string; amount: number; earned: number; complete: boolean } | null {
  const span = bloomWalletSpan(doc, event);
  if (!span) return null;
  const w = doc.slice(span.start, span.end);
  const f = fields(w);
  const complete = f.amountInt !== null && f.earnedInt !== null;
  return { text: stripWalletValues(w), amount: f.amountInt ?? 0, earned: f.earnedInt ?? 0, complete };
}

/**
 * The push gate for this feature, wired into `encodeSave` beside the card,
 * shape, progression and regatta gates so every path that ends in a push is
 * covered without the Events tab having to remember.
 *
 * It runs once per wallet in `EVENT_WALLETS`, because one batch may queue both
 * cards and each wallet must be diffed against its own loaded-vs-pushed pair —
 * keys are namespaced per wallet (`bloom-*` / `frozen-*`) so the two diffs can
 * never mask one another. Same loaded-vs-pushed rule as the others: a save that
 * arrived with an odd wallet keeps its key on both sides and stays pushable;
 * only a split this tool created is refused. Because no restore copies
 * `<DataStoreCollection>`, and nothing else in the tool writes these fields, a
 * wallet that moves at all is something this session did.
 */
export function assertBloomSafe(loaded: string, pushed: string) {
  for (const event of EVENT_WALLETS) assertWalletSafe(loaded, pushed, event);
}

/** `assertBloomSafe` for one wallet. `TrainJourney` is checked first. */
function assertWalletSafe(loaded: string, pushed: string, event: EventWalletId) {
  const name = WALLET_NAME[event];
  const before = walletText(loaded, event);
  const after = walletText(pushed, event);
  if (!before && !after) return;
  if (before && !after) throw new Error(`Không đẩy file lên máy: ví token ${name} biến mất sau khi sửa`);
  if (!before && after) {
    throw new Error(
      `Không đẩy file lên máy: ví token ${name} tự sinh ra dù save gốc không có — ` +
        "sự kiện phải được mở trong game trước.",
    );
  }

  const wasKeys = bloomProblems(loaded, event);
  const nowKeys = bloomProblems(pushed, event);
  const broken = nowKeys.filter((k) => !wasKeys.includes(k));
  if (broken.length) {
    throw new Error(
      `Không đẩy file lên máy: ví token ${name} hỏng sau khi sửa (${broken.join(", ")}). ` +
        "Bất kỳ số liệu nào lệch trong ví này cũng là điều mọi save thật đều không có, " +
        "nên server Playrix có thể coi save của bạn là gian lận.",
    );
  }

  if (before!.text !== after!.text) {
    throw new Error(
      `Không đẩy file lên máy: ví token ${name} thay đổi ngoài hai số lượng token ` +
        "(InitialValueSet / LastTransferTransactionId / thứ tự trường).",
    );
  }
  if (before!.complete && after!.complete && before!.earned - before!.amount !== after!.earned - after!.amount) {
    throw new Error(
      "Không đẩy file lên máy: Amount và TokensEarned phải cùng tăng một lượng — " +
        "chênh lệch Earned − Amount là số token đã tiêu mà server có thể đối chiếu.",
    );
  }
}
