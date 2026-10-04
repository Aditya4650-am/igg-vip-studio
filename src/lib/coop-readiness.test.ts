import { strict as assert } from "node:assert";
import { test } from "node:test";

const { coopReadiness } = await import("./coop-readiness.ts");

const xml = (body: string) => ['<?xml version="1.0" encoding="utf-8"?>', "<Global>", body, "</Global>"].join("");
const EMOJI_3 = ",st1,,st2,,st3,";
const RECORD = '<MyOldTask id="t1" user="C1"/>';
const ROW = '<DataElem name="cardId" type="string" value="card_09"/>';
const AGED =
  '<Var name="DaysEnteredGame" v="4" t="i"/>' +
  '<Var name="TermsAcceptTime" v="1790653681" t="i"/>' +
  '<Var name="saveGlobalTime" v="1790970500" t="i"/>';

// A 16-shaped save: own name, owned stickers, rookie-consistent counters —
// and still not ready, for the two reasons no file fix can remove.
const SIXTEEN = xml(
  '<Var name="cityId" v="C1" t="s"/>' +
    '<Var name="townName" v="myne"/>' +
    `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` +
    '<Var name="DaysEnteredGame" v="0" t="i"/>' +
    '<Var name="WaitForFirstSow" v="1" t="i"/>' +
    '<Var name="RegataTasksCompleted" v="1" t="i"/>' +
    RECORD +
    ROW,
);

test("coop readiness: a newborn tutorial-open save is not ready, for exactly two reasons", () => {
  const r = coopReadiness(SIXTEEN);
  assert.equal(r.ready, false);
  const bad = r.checks.filter((c) => !c.ok).map((c) => c.key);
  assert.deepEqual(bad, ["tutorial", "age"], `only rookie signals may fail, got: ${bad.join(",")}`);
});

test("coop readiness: the clean-12 shape fails on newborn alone", () => {
  // Own name, owned stickers, finished tutorial, backed counters — the file
  // that chats clean to this minute — yet Day 0. The checklist must say
  // newborn and nothing else, or it is crying wolf.
  const twelve = xml(
    '<Var name="cityId" v="C1" t="s"/>' +
      '<Var name="townName" v="Township"/>' +
      `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` +
      '<Var name="DaysEnteredGame" v="0" t="i"/>' +
      '<Var name="RegataTasksCompleted" v="8998" t="i"/>' +
      '<Var name="FullCardCollections" v="17" t="i"/>' +
      RECORD +
      ROW,
  );
  const r = coopReadiness(twelve);
  assert.equal(r.ready, false);
  assert.deepEqual(
    r.checks.filter((c) => !c.ok).map((c) => c.key),
    ["age"],
  );
});

test("coop readiness: aged, finished and backed is ready", () => {
  const r = coopReadiness(
    xml(
      '<Var name="cityId" v="C1" t="s"/>' +
        '<Var name="townName" v="mine"/>' +
        `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` +
        AGED +
        '<Var name="RegataTasksCompleted" v="9" t="i"/>' +
        RECORD +
        ROW,
    ),
  );
  assert.equal(r.ready, true, JSON.stringify(r.checks));
});

test("coop readiness: unknown age is no rule", () => {
  const r = coopReadiness(
    xml(
      '<Var name="cityId" v="C1" t="s"/>' +
        '<Var name="townName" v="mine"/>' +
        `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` +
        // A completed record implies the counter that counts it — 0 of the 22
        // saves on file carry the record without it, so this is the realistic
        // form of the fixture.
        '<Var name="RegataTasksCompleted" v="1" t="i"/>' +
        RECORD +
        ROW,
    ),
  );
  assert.equal(r.ready, true, "no clock fields means nothing proven young");
});

test("coop readiness: each missing piece fails its own check", () => {
  const base = (extra: string) =>
    coopReadiness(xml('<Var name="cityId" v="C1" t="s"/>' + AGED + extra));
  const failKeys = (r: { checks: { key: string; ok: boolean }[] }) =>
    r.checks.filter((c) => !c.ok).map((c) => c.key);

  // A completed record implies the lifetime counter that counts it, so these
  // name/stickers fixtures carry both halves — otherwise they would be testing
  // the split rule in the test below rather than the field they are about.
  const CTR = '<Var name="RegataTasksCompleted" v="1" t="i"/>';
  // No name at all.
  assert.deepEqual(failKeys(base(CTR + RECORD + ROW)), ["name", "stickers"]);
  // No stickers: sending anything would spend what the account never owned.
  assert.deepEqual(failKeys(base('<Var name="townName" v="mine"/>' + CTR + RECORD + ROW)), ["stickers"]);
  // Broken envelope is not an owned set either (`,a,,b,,` + one more comma).
  assert.deepEqual(
    failKeys(
      base('<Var name="townName" v="mine"/><Var name="UnlockedChatEmoji" v=",st1,,st2,,"/>' + CTR + RECORD + ROW),
    ),
    ["stickers"],
  );
  // A lone veteran counter with no records behind it.
  assert.deepEqual(
    failKeys(
      base('<Var name="townName" v="mine"/>' + `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` + '<Var name="RegataTasksCompleted" v="77" t="i"/>' + ROW),
    ),
    ["counters"],
  );
  // But a live board with no records yet is backed — it runs no tutorial:
  // the instant-copy account that joined regatta straight onto a 12-offer
  // board completed normally and stays clean.
  const boarded =
    '<Var name="townName" v="mine"/>' +
    `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` +
    '<Var name="RegataTasksCompleted" v="77" t="i"/>' +
    '<FreeTask id="t1" num="1" ver="1"/>' +
    ROW;
  assert.deepEqual(failKeys(base(boarded)), [], "board rows back the counter");
  // A lone collections counter with no rows behind it.
  assert.deepEqual(
    failKeys(
      base('<Var name="townName" v="mine"/>' + `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` + '<Var name="FullCardCollections" v="216" t="i"/>' + RECORD),
    ),
    ["counters"],
  );
  // Empty input reports nothing ready rather than throwing.
  assert.equal(coopReadiness("").ready, false);
});

test("coop readiness: a live board with no lifetime counter fails", () => {
  // The mirror of the rule in `each missing piece`, and the shape
  // `mGameInfo.current-22.xml` reached a first regatta task with: a 12-offer /
  // 18-taken board, `RegataTasksCompleted` absent — so the game runs the
  // first-timer regatta flow on a city claiming years of history. Every clean
  // save on file carries both halves; the split is what this flags.
  const r = coopReadiness(
    xml(
      '<Var name="cityId" v="C1" t="s"/>' +
        '<Var name="townName" v="mine"/>' +
        `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` +
        AGED +
        '<FreeTask id="t1" num="1" ver="1"/>' +
        '<TakenTask id="t2" num="2" ver="1"/>' +
        ROW,
    ),
  );
  assert.deepEqual(
    r.checks.filter((c) => !c.ok).map((c) => c.key),
    ["counters"],
  );
  // And a genuine rookie with neither half is not flagged: that is an account
  // that has simply never touched a regatta, not a save contradicting itself.
  const rookie = coopReadiness(
    xml(
      '<Var name="cityId" v="C1" t="s"/>' +
        '<Var name="townName" v="mine"/>' +
        `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` +
        AGED +
        ROW,
    ),
  );
  assert.deepEqual(
    rookie.checks.filter((c) => !c.ok).map((c) => c.key),
    [],
  );
});

test("coop readiness: only an open tutorial flag fails, never a cleared one", () => {
  const doc = (flag: string) =>
    xml(
      '<Var name="cityId" v="C1" t="s"/>' +
        '<Var name="townName" v="mine"/>' +
        `<Var name="UnlockedChatEmoji" v="${EMOJI_3}"/>` +
        AGED +
        // Both regatta halves, so `counters` stays out of this test's way —
        // it is here to speak about the tutorial flag only.
        '<Var name="RegataTasksCompleted" v="1" t="i"/>' +
        RECORD +
        ROW +
        flag,
    );
  const open = coopReadiness(doc('<Var name="WaitForFirstSow" v="1" t="i"/>'));
  assert.deepEqual(
    open.checks.filter((c) => !c.ok).map((c) => c.key),
    ["tutorial"],
  );
  assert.equal(coopReadiness(doc("")).ready, true, "absent means finished");
  assert.equal(
    coopReadiness(doc('<Var name="WaitForFirstSow" v="0" t="i"/>')).ready,
    true,
    "a cleared flag is not an open tutorial",
  );
});
