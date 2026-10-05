import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  addBloomTokens,
  assertBloomSafe,
  bloomInfo,
  bloomProblems,
  bloomWalletSpan,
  BLOOM_TOKENS_DEFAULT,
  BLOOM_TOKENS_MAX,
} from "./events.server.ts";
import { BLOOM_TOKENS_DEFAULT as UI_DEFAULT, BLOOM_TOKENS_MAX as UI_MAX } from "../../events.ts";
import { findUnbalancedTag } from "./xml-edit.server.ts";

/**
 * The wallet exactly as the game writes it — same field order as every one of
 * the 25 saves in the corpus that carry the block (cityId `5dv7F9pDuO` read
 * byte for byte), so a test that passes here passes on a real save.
 */
const wallet = (amount: number, earned: number) =>
  `<DataElem name="CurrencyProvider" type="dataStore">` +
  `<DataElem name="Amount" type="int" value="${amount}"/>` +
  `<DataElem name="InitialValueSet" type="bool" value="true"/>` +
  `<DataElem name="LastTransferTransactionId" type="string" value=""/>` +
  `<DataElem name="TokensEarned" type="int" value="${earned}"/>` +
  `</DataElem>`;

/**
 * A save shaped like the real one: the wallet lives inside
 * `DataStoreCollection > GameFeatures > TrainJourney`, and a *second* event
 * (`DragonNest`) holds a valued wallet of its own in the same block — which is
 * why every write here has to be scoped rather than replaced document-wide.
 */
const save = (trainJourneyInner: string) =>
  `<root><Global>` +
  `<Var name="cityId" v="TESTCITY01"/>` +
  `<DataStoreCollection>` +
  `<DataElem name="DragonNest" type="dataStore">${wallet(252, 252)}</DataElem>` +
  `<DataElem name="GameFeatures" type="dataStore">` +
  `<DataElem name="TrainJourney" type="dataStore">${trainJourneyInner}` +
  `<DataElem name="FinalReward" type="dataStore"><DataElem name="Rewards" type="array"/></DataElem>` +
  `</DataElem></DataElem>` +
  `</DataStoreCollection>` +
  `</Global><GameInfoPatcher/></root>`;

const base = save(wallet(7000, 7000));
const wellFormed = (xml: string) => assert.equal(findUnbalancedTag(xml), null, "expected balanced XML");

/** Everything of `xml` outside the TrainJourney wallet, for byte comparison. */
function outsideWallet(xml: string) {
  const span = bloomWalletSpan(xml);
  assert.ok(span, "expected a wallet to locate");
  return { head: xml.slice(0, span.start), tail: xml.slice(span.end) };
}

test("bloom: raises Amount and TokensEarned together, and only those two numbers", () => {
  const out = addBloomTokens(base, 50);
  wellFormed(out);

  assert.deepEqual(bloomInfo(out), {
    present: true,
    complete: true,
    amount: 7050,
    earned: 7050,
    reason: "ok",
  });

  // Byte-for-byte proof that nothing else moved: undoing the two values must
  // reproduce the input exactly, including every other byte of the document.
  assert.equal(out.split("7050").join("7000"), base, "only the two token values may differ");

  const a = outsideWallet(base);
  const b = outsideWallet(out);
  assert.equal(b.head, a.head, "everything before the wallet is untouched");
  assert.equal(b.tail, a.tail, "everything after the wallet is untouched");

  // The other event's wallet is in the same DataStoreCollection and must not
  // have been touched by a whole-document `name="Amount"` replace.
  assert.match(out, /<DataElem name="DragonNest"[\s\S]*?value="252"/);

  // The two fields nobody asked for stay exactly as they were.
  assert.match(out, /name="InitialValueSet" type="bool" value="true"/);
  assert.match(out, /name="LastTransferTransactionId" type="string" value=""/);
});

test("bloom: the spent difference (Earned − Amount) is preserved to the token", () => {
  // A save that has already spent: 8 held of 1414 earned — the shape of every
  // plinko-heavy wallet in the corpus. Raising only Amount would claim 100
  // tokens were spent that never were.
  const spentSave = save(wallet(8, 1414));
  const out = addBloomTokens(spentSave, 100);
  assert.deepEqual(bloomInfo(out), { present: true, complete: true, amount: 108, earned: 1514, reason: "ok" });
  assert.equal(1514 - 108, 1414 - 8, "the difference a server can reconcile must not move");
});

test("bloom: a save with no event wallet refuses instead of inventing one", () => {
  // 27 of the 52 saves in the corpus carry the `TrainJourneyDrop` analytics
  // block but no event store — the event has never been opened there. Writing
  // a CurrencyProvider from scratch would leave a wallet with no StateMachine
  // behind it, which the game would read as an event that never started.
  const noEvent = save("");
  assert.equal(bloomInfo(noEvent).reason, "no_wallet");
  assert.throws(() => addBloomTokens(noEvent, 10), /chưa có ví token Bloom & Buzz/);
});

test("bloom: a wallet the writer cannot read refuses rather than guessing", () => {
  const noEarned =
    `<DataElem name="CurrencyProvider" type="dataStore">` +
    `<DataElem name="Amount" type="int" value="7"/></DataElem>`;
  assert.throws(() => addBloomTokens(save(noEarned), 10), /thiếu Amount hoặc TokensEarned/);

  const letters =
    `<DataElem name="CurrencyProvider" type="dataStore">` +
    `<DataElem name="Amount" type="int" value="abc"/>` +
    `<DataElem name="TokensEarned" type="int" value="7"/></DataElem>`;
  assert.throws(() => addBloomTokens(save(letters), 10), /không hợp lệ/);

  const negative =
    `<DataElem name="CurrencyProvider" type="dataStore">` +
    `<DataElem name="Amount" type="int" value="-4"/>` +
    `<DataElem name="TokensEarned" type="int" value="7"/></DataElem>`;
  assert.throws(() => addBloomTokens(save(negative), 10), /không hợp lệ/);

  assert.throws(() => addBloomTokens(base, 0), /không hợp lệ/);
  assert.throws(() => addBloomTokens(base, -5), /không hợp lệ/);
});

test("bloom: the bounds are one definition shared by the UI and the writer", () => {
  // A typo guard, not a game rule: no readable config states a ceiling for
  // this wallet, so all this stops is a stray digit asking for 10^20 tokens.
  assert.equal(BLOOM_TOKENS_MAX, 100_000);
  assert.equal(BLOOM_TOKENS_DEFAULT, 100);
  // Both sides import the same constant: the tab clamps as you type and the
  // server clamps again, so they can never disagree.
  assert.equal(BLOOM_TOKENS_MAX, UI_MAX);
  assert.equal(BLOOM_TOKENS_DEFAULT, UI_DEFAULT);
});

test("bloom gate: a correct edit passes and a clean save reports no problems", () => {
  assert.deepEqual(bloomProblems(base), []);
  assert.doesNotThrow(() => assertBloomSafe(base, addBloomTokens(base, 50)));
  // Repeated pushes in one session keep the same wallet shape, so a second
  // push is not mistaken for tampering.
  let cur = base;
  for (let i = 0; i < 3; i++) {
    const next = addBloomTokens(cur, 100);
    assert.doesNotThrow(() => assertBloomSafe(base, next), `push ${i + 1} must stay green`);
    cur = next;
  }
  assert.equal(bloomInfo(cur).amount, 7300);
});

test("bloom gate: raising Amount on its own is refused", () => {
  // 108 → 200 stays under TokensEarned (1514), so this does not trip the
  // balance rule — it is the spent-difference rule on its own that catches it.
  const spentSave = save(wallet(8, 1414));
  const good = addBloomTokens(spentSave, 100);
  const tampered = good.replace('value="108"', 'value="200"');
  assert.match(tampered, /value="200"/);
  assert.throws(() => assertBloomSafe(spentSave, tampered), /cùng tăng một lượng/);
});

test("bloom gate: a balance above what the account ever earned is refused", () => {
  const out = addBloomTokens(base, 50);
  // Walk Amount past TokensEarned.
  const tampered = out.replace('value="7050"', 'value="9999"');
  assert.throws(() => assertBloomSafe(base, tampered), /bloom-balance-over-earned/);
});

test("bloom gate: any other field of the wallet is refused", () => {
  const out = addBloomTokens(base, 50);
  // Splice inside the TrainJourney block only: the first `InitialValueSet` in
  // the document belongs to DragonNest's wallet, and the gate is scoped to the
  // wallet this feature edits.
  const tjAt = out.indexOf('<DataElem name="TrainJourney"');
  assert.ok(tjAt >= 0);
  const head = out.slice(0, tjAt);
  const tj = out.slice(tjAt);

  const flipped = head + tj.replace(
    'name="InitialValueSet" type="bool" value="true"',
    'name="InitialValueSet" type="bool" value="false"',
  );
  assert.throws(() => assertBloomSafe(base, flipped), /thay đổi ngoài hai số lượng token/);

  const idSet = head + tj.replace('value=""', 'value="tx-42"');
  assert.throws(() => assertBloomSafe(base, idSet), /thay đổi ngoài hai số lượng token/);
});

test("bloom gate: a wallet that disappears or appears from nowhere is refused", () => {
  // No feature in this tool creates a wallet, and nothing but this feature
  // writes one — a restore never copies <DataStoreCollection>.
  const blockNoWallet = save("");
  assert.throws(() => assertBloomSafe(base, blockNoWallet), /biến mất sau khi sửa/);
  assert.throws(() => assertBloomSafe(blockNoWallet, base), /tự sinh ra dù save gốc không có/);
  // Neither exists: nothing to check, nothing blocked.
  const empty = "<root><Global/></root>";
  assert.doesNotThrow(() => assertBloomSafe(empty, empty));
});

test("bloom gate: a save that arrived odd keeps its own keys and stays pushable", () => {
  // Deliberately never measured in the corpus (40/40 valued wallets satisfy
  // Amount <= Earned) — but the rule is a diff, so a file that arrives this
  // way is not refused for the reason it arrived with.
  const odd = save(wallet(900, 100));
  assert.deepEqual(bloomProblems(odd), ["bloom-balance-over-earned"]);
  const edited = addBloomTokens(odd, 50);
  assert.doesNotThrow(() => assertBloomSafe(odd, edited));
  assert.deepEqual(bloomProblems(edited), ["bloom-balance-over-earned"]);
});

test("bloom: the push gate key set is exactly the measured rules", () => {
  assert.deepEqual(bloomProblems(base), [], "a clean wallet reports nothing");
  const broken =
    `<DataElem name="CurrencyProvider" type="dataStore">` +
    `<DataElem name="Amount" type="int" value="7"/></DataElem>`;
  assert.deepEqual(bloomProblems(save(broken)), ["bloom-wallet-incomplete"]);
});
