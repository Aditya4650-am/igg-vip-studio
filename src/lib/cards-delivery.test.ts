import { strict as assert } from "node:assert";
import { test } from "node:test";

const {
  INBOX_BOX_CAP,
  INBOX_SAFE,
  STALE_BACKLOG_RESERVE,
  STALE_AFTER_MS,
  cardIdOf,
  cardNumber,
  sortCardsNumerically,
  parseCardSnapshot,
  estimateBoxes,
  deliveryCheck,
  confirmedCount,
} = await import("./cards-delivery.ts");

/** The proven cap numbers this whole feature is built on. */
test("inbox cap constants match the measured server behaviour", () => {
  assert.equal(INBOX_BOX_CAP, 100); // 100 kept, the 101st evicts down to 50
  assert.equal(INBOX_SAFE, 90); // waves stay 10 boxes below the cap
  assert.ok(STALE_BACKLOG_RESERVE > 0 && STALE_BACKLOG_RESERVE < INBOX_SAFE);
  assert.ok(STALE_AFTER_MS >= 30 * 60 * 1000);
});

test("card ids round-trip exactly as CARD_IDS writes them", () => {
  assert.equal(cardIdOf(1), "card_01");
  assert.equal(cardIdOf(5), "card_05");
  assert.equal(cardIdOf(10), "card_10");
  assert.equal(cardIdOf(151), "card_151");
  assert.equal(cardNumber("card_01"), 1);
  assert.equal(cardNumber("card_05"), 5);
  assert.equal(cardNumber("card_11"), 11);
  assert.equal(cardNumber("card_100"), 100);
  assert.equal(cardNumber("card_151"), 151);
  // tolerate the 3-digit spelling the research probes used
  assert.equal(cardNumber("card_005"), 5);
  assert.equal(cardNumber("not-a-card"), 0);
});

test("send order is numeric — card_11 before card_100, the harry regression", () => {
  const input = ["card_100", "card_11", "card_02", "card_99", "card_01", "card_151", "card_10"];
  assert.deepEqual(sortCardsNumerically(input), [
    "card_01",
    "card_02",
    "card_10",
    "card_11",
    "card_99",
    "card_100",
    "card_151",
  ]);
  // …while the old lexicographic order really did ship card_100 before card_11,
  // which is exactly how the high cards ended up first into the prune.
  const lex = [...input].sort();
  assert.ok(lex.indexOf("card_100") < lex.indexOf("card_11"));
});

const SAMPLE_XML = [
  '<DataElem type="dataStore"><DataElem name="cardId" type="string" value="card_05"/>',
  '<DataElem name="generatedCount" type="int" value="3"/>',
  '<DataElem name="inStockCount" type="int" value="3"/></DataElem>',
  '<DataElem type="dataStore"><DataElem name="cardId" type="string" value="card_100"/>',
  '<DataElem name="generatedCount" type="int" value="1"/>',
  '<DataElem name="inStockCount" type="int" value="1"/></DataElem>',
  `<box data='{"box_type":"collections_send_card","card_id":"card_07","from":{"city_id":"SELF01"}}' applied="0" time="1791255562"/>`,
  `<box data='{"box_type":"collections_send_card","card_id":"card_07","from":{"city_id":"OTHER1"}}' applied="1" time="1791000000"/>`,
  `<box data='{"box_type":"clan_kick_out","from":{"city_id":"OTHER1"}}' time="5"/>`,
].join("");

test("parseCardSnapshot: album, cap basis, box attribution, merge time", () => {
  const snap = parseCardSnapshot(SAMPLE_XML, { ourCityId: "SELF01", updAt: 1791255971 });
  assert.equal(snap.updAt, 1791255971);
  assert.equal(snap.boxes.length, 3);
  // unapplied boxes of ANY type count toward the 100-box cap; applied do not
  assert.equal(snap.pendingTotal, 2);
  // only our own card boxes attribute to us — the applied one came from another city
  assert.deepEqual(snap.fromUs, { 7: 1 });
  assert.equal(snap.maxBoxTime, 1791255562);
  assert.equal(snap.albumUnique, 2);
  assert.equal(snap.albumCopies, 4);
});

test("parseCardSnapshot survives a box whose payload is not JSON", () => {
  // bracketed but unparseable — the real corruption case: the box element is
  // there and still occupies a cap slot, we just cannot read its card id
  const snap = parseCardSnapshot(`<box data='{"broken":}' applied="0" time="9"/>`, {
    ourCityId: "SELF01",
    updAt: 1,
  });
  assert.equal(snap.boxes.length, 1);
  assert.equal(snap.pendingTotal, 1); // still occupies a cap slot
  assert.equal(snap.maxBoxTime, 9);
});

test("estimateBoxes: save footprint + our unmerged sends + stale reserve", () => {
  const now = 1_791_350_000_000;
  // unreadable save → reserve only (conservative, never blind-zero)
  assert.equal(estimateBoxes(null, 0, now), STALE_BACKLOG_RESERVE);
  assert.equal(estimateBoxes(null, 30, now), STALE_BACKLOG_RESERVE + 30);

  const fresh = parseCardSnapshot(SAMPLE_XML, {
    ourCityId: "SELF01",
    updAt: Math.floor(now / 1000),
  });
  // pending 2 + unmerged 10, no reserve (fresh snapshot)
  assert.equal(estimateBoxes(fresh, 10, now), 2 + 10);

  // stale snapshot adds the reserve for boxes we cannot see
  const stale = parseCardSnapshot(SAMPLE_XML, {
    ourCityId: "SELF01",
    updAt: Math.floor((now - (STALE_AFTER_MS + 60_000)) / 1000),
  });
  assert.equal(estimateBoxes(stale, 0, now), 2 + STALE_BACKLOG_RESERVE);

  // a footprint at the ceiling leaves no room — that is the wave boundary
  assert.ok(estimateBoxes(fresh, INBOX_SAFE, now) >= INBOX_SAFE);
});

test("deliveryCheck: in-transit sends are never called missing", () => {
  const since = 1_791_300_000_000;
  const mergeSec = Math.floor(since / 1000) + 60;
  const snap = parseCardSnapshot(
    `<box data='{"box_type":"collections_send_card","card_id":"card_07","from":{"city_id":"SELF01"}}' applied="0" time="${mergeSec}"/>`,
    { ourCityId: "SELF01", updAt: mergeSec },
  );

  // (a) the newest batch predates the run → no proof, nothing missing
  const oldSnap = parseCardSnapshot(
    `<box data='{"box_type":"collections_send_card","card_id":"card_07","from":{"city_id":"SELF01"}}' applied="0" time="${Math.floor(since / 1000) - 300}"/>`,
    { ourCityId: "SELF01", updAt: Math.floor(since / 1000) - 300 },
  );
  const noProof = deliveryCheck({ 7: 2 }, oldSnap, { 7: [since + 5_000] }, since);
  assert.equal(noProof.evidence, false);
  assert.deepEqual(noProof.missing, {});

  // (b) proof exists, they hold 1 of 2, and the 2nd was sent AFTER the batch → in transit
  const inFlight = deliveryCheck({ 7: 2 }, snap, { 7: [mergeSec * 1000 + 1_000] }, since);
  assert.equal(inFlight.evidence, true);
  assert.deepEqual(inFlight.have, { 7: 1 });
  assert.deepEqual(inFlight.missing, {});

  // (c) proof exists, the send predates the batch and is still not in the save → provably lost
  const lost = deliveryCheck({ 7: 2 }, snap, { 7: [mergeSec * 1000 - 60_000] }, since);
  assert.equal(lost.evidence, true);
  assert.deepEqual(lost.missing, { 7: 1 });

  // (d) they already hold enough → nothing to top up
  const full = deliveryCheck({ 7: 1 }, snap, {}, since);
  assert.deepEqual(full.missing, {});
});

test("confirmedCount clamps to the requested amount", () => {
  assert.equal(confirmedCount({ 1: 2, 2: 3 }, { 1: 5, 2: 1 }), 2 + 1);
  assert.equal(confirmedCount({ 1: 2 }, {}), 0);
});
