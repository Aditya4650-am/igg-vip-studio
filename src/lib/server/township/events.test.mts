import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  addBloomTokens,
  assertBloomSafe,
  bloomInfo,
  bloomProblems,
  bloomWalletSpan,
  EVENT_WALLETS,
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

/* ------------------------------------------------------------------ *
 * Frozen Fortune (`DragonNest`) — the second wallet the tab can write.
 *
 * Its evidence, so these tests are not read as a guess: the APK carries
 * exactly three `currencyProvider` wallets (TrainJourney, DragonNest,
 * MagicCauldron) and this is the one with real saves behind it — 16 valued
 * wallets, all satisfying `Amount <= TokensEarned`, all `InitialValueSet=true`,
 * all inside `GameFeatures` (58/58 files, one DragonNest store per save). The
 * fixtures below keep both wallets in one document on purpose: scoping is the
 * whole point of a second argument.
 * ------------------------------------------------------------------ */

/** Real saves put DragonNest *inside* GameFeatures; Bloom's fixture above puts
 *  it beside GameFeatures, so both placements are covered. */
const frozenSave = (dnInner: string, tjInner = wallet(7000, 7000)) =>
  `<root><Global>` +
  `<Var name="cityId" v="TESTCITY01"/>` +
  `<DataStoreCollection>` +
  `<DataElem name="GameFeatures" type="dataStore">` +
  `<DataElem name="TrainJourney" type="dataStore">${tjInner}</DataElem>` +
  `<DataElem name="DragonNest" type="dataStore">${dnInner}</DataElem>` +
  `</DataElem>` +
  `</DataStoreCollection>` +
  `</Global><GameInfoPatcher/></root>`;

/** The other field order real wallets use — 6 of the 41 valued wallets in the
 *  corpus carry no `LastTransferTransactionId` at all, and most DragonNest ones
 *  are of that shape. The writer reads a field by name, never by position. */
const walletNoTx = (amount: number, earned: number) =>
  `<DataElem name="CurrencyProvider" type="dataStore">` +
  `<DataElem name="Amount" type="int" value="${amount}"/>` +
  `<DataElem name="InitialValueSet" type="bool" value="true"/>` +
  `<DataElem name="TokensEarned" type="int" value="${earned}"/>` +
  `</DataElem>`;

test("frozen: the wallet list is exactly the measured set, Bloom first", () => {
  // `MagicCauldron` is the third `currencyProvider` in the APK but appears in
  // no save of this account's (3 of 58, all A/B-test friend cities), so it is
  // deliberately absent — a wallet nothing here can be measured against is a
  // wallet nothing here should promise to write.
  assert.deepEqual(EVENT_WALLETS, ["TrainJourney", "DragonNest"]);
});

test("frozen: raises both numbers in the DragonNest wallet and leaves Bloom's alone", () => {
  const f = frozenSave(wallet(252, 252));
  const out = addBloomTokens(f, 48, "DragonNest");
  wellFormed(out);

  assert.deepEqual(bloomInfo(out, "DragonNest"), {
    present: true,
    complete: true,
    amount: 300,
    earned: 300,
    reason: "ok",
  });

  // Byte-for-byte proof of the same kind the Bloom test uses: undoing the two
  // new values must reproduce the input, which also proves Bloom's `7000`
  // pair never moved — one `name="Amount"` replace would have hit both.
  assert.equal(out.split('value="300"').join('value="252"'), f, "only the two token values may differ");
  assert.deepEqual(bloomInfo(out), { present: true, complete: true, amount: 7000, earned: 7000, reason: "ok" });

  // And the reverse direction: writing Bloom must not move Frozen Fortune.
  const back = addBloomTokens(f, 50);
  assert.deepEqual(bloomInfo(back, "DragonNest"), {
    present: true,
    complete: true,
    amount: 252,
    earned: 252,
    reason: "ok",
  });
});

test("frozen: the spent difference is preserved, in either field order", () => {
  for (const maker of [wallet, walletNoTx]) {
    const f = frozenSave(maker(8, 1414));
    const out = addBloomTokens(f, 100, "DragonNest");
    assert.deepEqual(
      bloomInfo(out, "DragonNest"),
      { present: true, complete: true, amount: 108, earned: 1514, reason: "ok" },
      "the pair must move together whatever order the fields are written in",
    );
    assert.equal(1514 - 108, 1414 - 8, "the difference a server can reconcile must not move");
    assert.equal(bloomInfo(out).amount, 7000, "Bloom's wallet stays out of it");
  }
});

test("frozen: an unopened event refuses instead of inventing a wallet", () => {
  // The empty shape is the common one: 42 of 58 saves hold
  // `<DataElem name="CurrencyProvider" type="dataStore"/>` with no numbers in
  // it — the event was scheduled on that account but never opened. The block
  // is there, the values are not, so the two integers must not be made up.
  const unopened = frozenSave(`<DataElem name="CurrencyProvider" type="dataStore"/>`);
  assert.equal(bloomInfo(unopened, "DragonNest").reason, "incomplete");
  assert.throws(() => addBloomTokens(unopened, 10, "DragonNest"), /thiếu Amount hoặc TokensEarned/);
  // The refusal names the card the user pressed, not Bloom's.
  assert.throws(() => addBloomTokens(unopened, 10, "DragonNest"), /Ví token Frozen Fortune thiếu Amount/);

  // And a save with no DragonNest store at all answers the way Bloom's does.
  const noDn =
    `<root><Global><DataStoreCollection>` +
    `<DataElem name="GameFeatures" type="dataStore">` +
    `<DataElem name="TrainJourney" type="dataStore">${wallet(7, 7)}</DataElem>` +
    `</DataElem></DataStoreCollection></Global></root>`;
  assert.equal(bloomInfo(noDn, "DragonNest").reason, "no_wallet");
  assert.throws(() => addBloomTokens(noDn, 10, "DragonNest"), /chưa có ví token Frozen Fortune/);
  // Writing Bloom on that same save is unaffected by the missing second wallet.
  assert.doesNotThrow(() => addBloomTokens(noDn, 10));
});

test("frozen gate: a correct edit passes, and each wallet reports its own keys", () => {
  const f = frozenSave(wallet(252, 252));
  assert.deepEqual(bloomProblems(f, "DragonNest"), []);
  assert.doesNotThrow(() => assertBloomSafe(f, addBloomTokens(f, 50, "DragonNest")));

  // Amount raised on its own → refused on the second wallet's own rule. The
  // wallet must be a *spent* one (108 of 1514 earned) exactly like Bloom's
  // test: on a full wallet the raise would also push Amount past Earned and
  // the key rule would fire first.
  const spent = frozenSave(wallet(8, 1414));
  const good = addBloomTokens(spent, 100, "DragonNest");
  const tampered = good.replace('value="108"', 'value="200"');
  assert.throws(() => assertBloomSafe(spent, tampered), /cùng tăng một lượng/);

  // A balance above what the account ever earned → the `frozen-` key, never
  // Bloom's prefix, so a message can be matched to the card that caused it.
  const over = addBloomTokens(frozenSave(wallet(252, 252)), 1, "DragonNest").replace('value="253"', 'value="900"');
  assert.deepEqual(bloomProblems(over, "DragonNest"), ["frozen-balance-over-earned"]);
  assert.deepEqual(bloomProblems(over), [], "Bloom's wallet is clean and must say so");
  assert.throws(() => assertBloomSafe(frozenSave(wallet(252, 252)), over), /frozen-balance-over-earned/);

  // A wallet that vanishes, and one that appears from nowhere: same two
  // refusals, naming this event.
  assert.throws(() => assertBloomSafe(f, frozenSave("")), /Frozen Fortune.*biến mất sau khi sửa/);
  assert.throws(() => assertBloomSafe(frozenSave(""), f), /Frozen Fortune.*tự sinh ra dù save gốc không có/);
});

test("frozen gate: one wallet's oddness can never mask the other's", () => {
  // The save *arrives* with Bloom's balance over its earned total — a key it
  // keeps on both sides — while this push breaks Frozen Fortune's instead. If
  // the two wallets shared a key set, that new problem would be filtered out
  // as "already there" and the push would leave on the wrong reason.
  const loaded = frozenSave(wallet(252, 252), wallet(900, 100));
  assert.deepEqual(bloomProblems(loaded), ["bloom-balance-over-earned"], "arrived odd, on Bloom's side");
  assert.deepEqual(bloomProblems(loaded, "DragonNest"), [], "and clean on Frozen Fortune's");

  const pushed = addBloomTokens(loaded, 50, "DragonNest").replace('value="302"', 'value="900"');
  assert.throws(() => assertBloomSafe(loaded, pushed), /frozen-balance-over-earned/);

  // The same pairing the other way round stays green: an odd wallet that did
  // not move is not a reason to refuse the edit next to it.
  const raised = addBloomTokens(loaded, 50, "DragonNest");
  assert.doesNotThrow(() => assertBloomSafe(loaded, raised));
});

test("frozen gate: a save that arrived odd keeps its own keys and stays pushable", () => {
  // Deliberately never measured (16/16 valued DragonNest wallets satisfy
  // Amount <= Earned) — but the rule is a diff, so a file that arrives this
  // way is not refused for the reason it arrived with.
  const odd = frozenSave(wallet(900, 100));
  assert.deepEqual(bloomProblems(odd, "DragonNest"), ["frozen-balance-over-earned"]);
  assert.doesNotThrow(() => assertBloomSafe(odd, addBloomTokens(odd, 50, "DragonNest")));
});

const msgOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

test("bloom: every refusal still reads exactly as it shipped", () => {
  // Frozen Fortune rides this same writer, so the only way to prove Bloom's
  // own text did not drift with it is to pin the strings character for
  // character against the commit the Events tab shipped in.
  assert.equal(
    msgOf(() => addBloomTokens(save(""), 10)),
    "Save chưa có ví token Bloom & Buzz (TrainJourney) — hãy mở sự kiện trong game một lần rồi thử lại. " +
      "Công cụ không tự sinh ví mới vì sẽ thiếu cả StateMachine của sự kiện.",
  );
  assert.equal(
    msgOf(() => addBloomTokens(save(`<DataElem name="CurrencyProvider" type="dataStore"/>`), 10)),
    "Ví token Bloom & Buzz thiếu Amount hoặc TokensEarned — không thể sửa an toàn",
  );
  assert.equal(
    msgOf(() =>
      addBloomTokens(
        save(
          `<DataElem name="CurrencyProvider" type="dataStore">` +
            `<DataElem name="CurrencyProvider" type="dataStore">` +
            `<DataElem name="Amount" type="int" value="1"/>` +
            `<DataElem name="TokensEarned" type="int" value="1"/>` +
            `</DataElem></DataElem>`,
        ),
        10,
      ),
    ),
    "Ví token Bloom & Buzz bị lồng sai — không sửa để tránh hỏng save",
  );
  assert.equal(
    msgOf(() =>
      addBloomTokens(
        save(
          `<DataElem name="CurrencyProvider" type="dataStore">` +
            `<DataElem name="Amount" type="int" value="abc"/>` +
            `<DataElem name="TokensEarned" type="int" value="7"/></DataElem>`,
        ),
        10,
      ),
    ),
    "Ví token Bloom & Buzz chứa số không hợp lệ — không sửa để tránh hỏng save",
  );
  assert.equal(msgOf(() => addBloomTokens(base, BLOOM_TOKENS_MAX + 1)), `Số token tối đa mỗi lần là ${BLOOM_TOKENS_MAX}`);
  assert.equal(
    msgOf(() => assertBloomSafe(base, save(""))),
    "Không đẩy file lên máy: ví token Bloom & Buzz biến mất sau khi sửa",
  );
});
