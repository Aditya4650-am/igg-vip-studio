/**
 * Bloom & Buzz event tokens.
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
 * block (40 valued wallets across all events in the corpus).
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
 * Deliberately never touched: `InitialValueSet`, `LastTransferTransactionId`,
 * `balanceVersion` (21 per save, always in component `ptr` dataStores and
 * never inside a `CurrencyProvider`), `LayerLaunchCurrencyTransfer`, and every
 * *other* event's wallet — a save may hold up to three (`TrainJourney`,
 * `DragonNest`, `MagicCauldron`) and only ours may move. A whole-document
 * replace of `name="Amount"` would hit all three, which is why every write here
 * is scoped to the span of `TrainJourney > CurrencyProvider` first.
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

const OWNER = "TrainJourney";
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
 * Span of `TrainJourney > CurrencyProvider`, or null when the save carries no
 * wallet at all (the 27 saves in the corpus with a `TrainJourneyDrop` analytics
 * block but no event store — the event has never been opened on that account).
 *
 * It never falls back to *some other* `CurrencyProvider`: a save may hold three
 * and only ours may be edited.
 */
export function bloomWalletSpan(xml: string): { start: number; end: number } | null {
  const owner = namedOpenIndex(xml, OWNER, "dataStore");
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
 */
export type BloomReason = "ok" | "no_wallet" | "incomplete" | "invalid";

export type BloomInfo = { present: boolean; complete: boolean; amount: number; earned: number; reason: BloomReason };

export function bloomInfo(xml: string): BloomInfo {
  const span = bloomWalletSpan(xml);
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
 * Only the two `value="…"` runs inside `TrainJourney > CurrencyProvider` are
 * rewritten; every other byte of the document — including the other event
 * wallets, `InitialValueSet`, `LastTransferTransactionId` and the whole
 * `DataStoreCollection` around them — is left exactly as it was. The rewrite
 * runs from the later field backwards so the earlier field's offsets stay
 * valid without recomputing them.
 */
export function addBloomTokens(xml: string, want: number): string {
  const n = Math.floor(Number(want));
  if (!Number.isFinite(n) || n < 1) throw new Error("Số token không hợp lệ");

  const span = bloomWalletSpan(xml);
  if (!span) {
    throw new Error(
      "Save chưa có ví token Bloom & Buzz (TrainJourney) — hãy mở sự kiện trong game một lần rồi thử lại. " +
        "Công cụ không tự sinh ví mới vì sẽ thiếu cả StateMachine của sự kiện.",
    );
  }
  const before = xml.slice(span.start, span.end);
  if (fieldCount(before, CURRENCY) !== 1) {
    throw new Error("Ví token Bloom & Buzz bị lồng sai — không sửa để tránh hỏng save");
  }
  const f = fields(before);
  if (!f.amount || !f.earned) {
    throw new Error("Ví token Bloom & Buzz thiếu Amount hoặc TokensEarned — không thể sửa an toàn");
  }
  if (f.amountInt === null || f.earnedInt === null || f.amountInt < 0 || f.earnedInt < 0) {
    throw new Error("Ví token Bloom & Buzz chứa số không hợp lệ — không sửa để tránh hỏng save");
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
export function bloomProblems(doc: string): string[] {
  const keys: string[] = [];
  const span = bloomWalletSpan(doc);
  if (!span) return keys; // no event store — nothing to check, nothing to break
  const w = doc.slice(span.start, span.end);
  if (fieldCount(w, CURRENCY) !== 1) {
    keys.push("bloom-wallet-nested");
    return keys;
  }
  const f = fields(w);
  if (!f.amount || !f.earned) {
    keys.push("bloom-wallet-incomplete");
    return keys;
  }
  if (f.amountInt === null || f.earnedInt === null) {
    keys.push("bloom-wallet-value-invalid");
    return keys;
  }
  if (f.amountInt < 0 || f.earnedInt < 0) keys.push("bloom-wallet-value-negative");
  // Measured 40/40 valued wallets in the corpus: the balance never exceeds
  // what the account has ever earned. A write that breaks it is the shape a
  // server reads for free — but a save that arrived this way keeps the key on
  // both sides and stays pushable.
  if (f.amountInt > f.earnedInt) keys.push("bloom-balance-over-earned");
  return keys;
}

/**
 * The wallet with its two token values masked, for "nothing else moved", plus
 * the pair as read. `complete` is false when either number is unreadable —
 * the numeric comparisons below only run on a wallet both sides could read.
 */
function walletText(doc: string): { text: string; amount: number; earned: number; complete: boolean } | null {
  const span = bloomWalletSpan(doc);
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
 * Same loaded-vs-pushed rule as the others: a save that arrived with an odd
 * wallet keeps its key on both sides and stays pushable; only a split this
 * tool created is refused. Because no restore copies `<DataStoreCollection>`,
 * and nothing else in the tool writes these fields, a wallet that moves at all
 * is something this session did.
 */
export function assertBloomSafe(loaded: string, pushed: string) {
  const before = walletText(loaded);
  const after = walletText(pushed);
  if (!before && !after) return;
  if (before && !after) throw new Error("Không đẩy file lên máy: ví token Bloom & Buzz biến mất sau khi sửa");
  if (!before && after) {
    throw new Error(
      "Không đẩy file lên máy: ví token Bloom & Buzz tự sinh ra dù save gốc không có — " +
        "sự kiện phải được mở trong game trước.",
    );
  }

  const wasKeys = bloomProblems(loaded);
  const nowKeys = bloomProblems(pushed);
  const broken = nowKeys.filter((k) => !wasKeys.includes(k));
  if (broken.length) {
    throw new Error(
      `Không đẩy file lên máy: ví token Bloom & Buzz hỏng sau khi sửa (${broken.join(", ")}). ` +
        "Bất kỳ số liệu nào lệch trong ví này cũng là điều mọi save thật đều không có, " +
        "nên server Playrix có thể coi save của bạn là gian lận.",
    );
  }

  if (before!.text !== after!.text) {
    throw new Error(
      "Không đẩy file lên máy: ví token Bloom & Buzz thay đổi ngoài hai số lượng token " +
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
