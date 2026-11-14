/**
 * The card event is read from the save, never hardcoded.
 *
 * Both fixtures below are byte-extracted from real saves: collection 7 from
 * `mGameInfo.current-27.xml` (2026-10-28) and collection 8 from
 * `mGameInfo.current-28.xml` (2026-11-14) — the rotation that stopped every
 * client's card sends on 2026-11-13, because the box carried a `col_id` the
 * server no longer knew. The source guard keeps the constants from coming
 * back: a hardcoded event is a time bomb the next rotation detonates.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { activeCardCollection } from "./cardsend.server";

const BLOCK_7 = `<DataElem type="dataStore"><DataElem name="first" type="string" value="RememberTime"/><DataElem name="second" type="dataStore"><DataElem name="ptr" type="dataStore"><DataElem name="configId" type="string" value="CardCollections_7"/><DataElem name="endTime" type="int64" value="1794560400"/><DataElem name="eventId" type="string" value="CardCollections_Regular"/><DataElem name="properties" type="array"><DataElem type="dataStore"><DataElem name="first" type="string" value="balanceId"/><DataElem name="second" type="string" value="CardC7_BalanceIds"/></DataElem><DataElem type="dataStore"><DataElem name="first" type="string" value="collectionId"/><DataElem name="second" type="string" value="7"/></DataElem></DataElem><DataElem name="startTime" type="int64" value="1789117200"/><DataElem name="version" type="int" value="0"/></DataElem><DataElem name="type" type="string" value="gameEventRememberTime"/></DataElem></DataElem>`;

const BLOCK_8 = `<DataElem type="dataStore"><DataElem name="first" type="string" value="RememberTime"/><DataElem name="second" type="dataStore"><DataElem name="ptr" type="dataStore"><DataElem name="configId" type="string" value="CardCollections_8"/><DataElem name="endTime" type="int64" value="1800003600"/><DataElem name="eventId" type="string" value="CardCollections_Regular"/><DataElem name="properties" type="array"><DataElem type="dataStore"><DataElem name="first" type="string" value="balanceId"/><DataElem name="second" type="string" value="CardC8_BalanceIds"/></DataElem><DataElem type="dataStore"><DataElem name="first" type="string" value="collectionId"/><DataElem name="second" type="string" value="8"/></DataElem></DataElem><DataElem name="startTime" type="int64" value="1794560400"/><DataElem name="version" type="int" value="0"/></DataElem><DataElem name="type" type="string" value="gameEventRememberTime"/></DataElem></DataElem>`;

test("the collection window is read out of the save's own RememberTime block", () => {
  assert.deepEqual(activeCardCollection(BLOCK_7), { colId: "7", colEt: 1794560400 });
  // The live collection as of 2026-11-14 — the one the hardcoded "7" missed.
  assert.deepEqual(activeCardCollection(BLOCK_8), { colId: "8", colEt: 1800003600 });
});

test("the newest window wins when a save archives several collections", () => {
  // Both blocks sit in one document (an archive plus the open event): the box
  // must carry the open one, not the first match in document order.
  const doc = `<root>${BLOCK_7}${BLOCK_8}</root>`;
  assert.deepEqual(activeCardCollection(doc), { colId: "8", colEt: 1800003600 });
  // And the reverse order must not change the answer.
  const flipped = `<root>${BLOCK_8}${BLOCK_7}</root>`;
  assert.deepEqual(activeCardCollection(flipped), { colId: "8", colEt: 1800003600 });
});

test("a save with no card collection, or a window with no end, answers nothing", () => {
  assert.equal(activeCardCollection("<root><Var name=\"money\" v=\"1\"/></root>"), null);
  // Another event's window must not be mistaken for a card collection.
  const other = BLOCK_7.replace(/CardCollections_\d+/g, "Bloom_2").replace(
    /value="CardC\d_BalanceIds"/,
    'value="Bloom_BalanceIds"',
  );
  assert.equal(activeCardCollection(other), null);
  // A CardCollections id with no endTime in reach is not a window either.
  const noEnd = '<DataElem name="configId" type="string" value="CardCollections_9"/>';
  assert.equal(activeCardCollection(noEnd), null);
});

test("collectionId property is preferred, configId's number is the fallback", () => {
  // No properties array at all: the number in configId is still the id.
  const bare =
    '<DataElem name="configId" type="string" value="CardCollections_12"/>' +
    '<DataElem name="endTime" type="int64" value="1800003600"/>';
  assert.deepEqual(activeCardCollection(bare), { colId: "12", colEt: 1800003600 });
});

test("the send path reads the event from the save — no constant can come back", () => {
  const src = readFileSync(new URL("./cardsend.server.ts", import.meta.url), "utf8");
  assert.ok(
    !src.includes("CARD_COL_ID") && !src.includes("CARD_COL_ET"),
    "a hardcoded col_id/col_et is what broke every client on 2026-11-13",
  );
  assert.ok(src.includes("col_id: col.colId"), "the box must carry the resolved collection");
  assert.ok(src.includes("col_et: col.colEt"), "the box must carry the resolved window end");
  assert.ok(src.includes("sessionSaveXml"), "the session's save is where the window is read");
  // studio.server must expose the read accessor the dynamic import relies on.
  const studio = readFileSync(new URL("../studio.server.ts", import.meta.url), "utf8");
  assert.ok(
    studio.includes("export function sessionSaveXml"),
    "studio.server must expose sessionSaveXml for the cards path",
  );
});
