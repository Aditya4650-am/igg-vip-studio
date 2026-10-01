import { strict as assert } from "node:assert";
import { test } from "node:test";

import { applyDesban, setTutorialFlag, skipTutorials } from "./desban.server.ts";
import { findUnbalancedTag } from "./xml-edit.server.ts";

const wellFormed = (xml: string) =>
  assert.equal(findUnbalancedTag(xml), null, `expected balanced XML, got: ${xml}`);

// Fixture mirrors the real save's encodings: Var bools use 0/1, Var ints
// use numbers, DataElem bools use true/false, arrays/dataStores carry
// children instead of scalar values, and some names repeat.
const SAVE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<Global>",
  '<Var name="NeedArrowOnMarket" v="1" t="b"/>',
  '<Var name="DealerWelcome_state" v="10" t="i"/>',
  '<Var name="DealerWelcomesq0_state" v="0" t="i"/>',
  '<Var name="tutorial_state" v="18" t="i"/>',
  '<Var name="TapDealerAfterTutorial" v="0" t="i"/>',
  '<Var name="FirstGameLoad" v="0" t="b"/>',
  '<Var name="exp_tutorial_tablet_passed" v="1" t="b"/>',
  '<Var name="score" v="999" t="i"/>',
  '<DataElem name="Tablet_Tutorial_Active" type="bool" value="true"/>',
  '<DataElem name="Tablet_Tutorial_part1" type="bool" value="true"/>',
  '<DataElem name="Craft_Tutorial_Active" type="bool" value="false"/>',
  '<DataElem name="score" type="int" value="15"/>',
  '<DataElem name="currentState" type="string" value="ExpeditionActive"/>',
  '<DataElem name="enabled" type="bool" value="true"/>',
  '<DataElem name="finishedTutorials" type="array"/>',
  '<DataElem name="cascadeEventWindowShowed" type="bool" value="false"/>',
  '<DataElem name="lastSeenScore" type="int" value="-1"/>',
  '<DataElem name="lastSeenScore" type="int" value="0"/>',
  '<DataElem name="requests" type="array"/>',
  '<DataElem name="beforeOpenTutorShown" type="bool" value="false"/>',
  '<DataElem name="TUTM3_CascadeEvent" type="int" value="4"/>',
  '<DataElem name="HandTutorial_state" v="18" t="i"/>',
  "</Global>",
].join("");

test("skipTutorials completes dealer state and hides arrows", () => {
  const out = skipTutorials(SAVE);
  wellFormed(out);
  assert.match(out, /<Var name="DealerWelcome_state" v="18" t="i"\/>/);
  assert.match(out, /<Var name="NeedArrowOnMarket" v="0" t="b"\/>/);
  assert.match(out, /<Var name="DealerWelcomesq0_state" v="0" t="i"\/>/);
  assert.match(out, /<Var name="tutorial_state" v="18" t="i"\/>/);
});

test("skipTutorials deactivates tablet steps with false, never true", () => {
  const out = skipTutorials(SAVE);
  wellFormed(out);
  assert.match(out, /<DataElem name="Tablet_Tutorial_Active" type="bool" value="false"\/>/);
  assert.match(out, /<DataElem name="Tablet_Tutorial_part1" type="bool" value="false"\/>/);
  assert.ok(!/Tablet_Tutorial_(Active|part1)" type="bool" value="true"/.test(out));
  // An already-idle step set is left alone, not flipped on.
  assert.match(out, /<DataElem name="Craft_Tutorial_Active" type="bool" value="false"\/>/);
});

test("skipTutorials never rewrites scores, states or engine flags", () => {
  const out = skipTutorials(SAVE);
  wellFormed(out);
  assert.match(out, /<Var name="score" v="999" t="i"\/>/);
  assert.match(out, /<DataElem name="score" type="int" value="15"\/>/);
  assert.match(out, /<DataElem name="currentState" type="string" value="ExpeditionActive"\/>/);
  assert.match(out, /<DataElem name="enabled" type="bool" value="true"\/>/);
  assert.match(out, /<DataElem name="beforeOpenTutorShown" type="bool" value="false"\/>/);
  assert.match(out, /<DataElem name="TUTM3_CascadeEvent" type="int" value="4"\/>/);
});

test("skipTutorials never adds value attributes to array blocks", () => {
  const out = skipTutorials(SAVE);
  wellFormed(out);
  assert.match(out, /<DataElem name="finishedTutorials" type="array"\/>/);
  assert.match(out, /<DataElem name="requests" type="array"\/>/);
  assert.ok(!/name="finishedTutorials"[^>]*value=/.test(out));
  assert.ok(!/name="requests"[^>]*value=/.test(out));
});

test("skipTutorials marks cascade windows shown and scores seen everywhere", () => {
  const out = skipTutorials(SAVE);
  wellFormed(out);
  assert.match(out, /<DataElem name="cascadeEventWindowShowed" type="bool" value="true"\/>/);
  assert.ok(!/name="lastSeenScore" type="int" value="-1"/.test(out));
});

test("setTutorialFlag keeps each element encoding and skips valueless blocks", () => {
  const xml = [
    "<Global>",
    '<Var name="NeedArrowOnMarket" v="1" t="b"/>',
    '<DataElem name="Tablet_Tutorial_Active" type="bool" value="true"/>',
    '<DataElem name="finishedTutorials" type="array"/>',
    "</Global>",
  ].join("");
  const out = setTutorialFlag(setTutorialFlag(xml, "NeedArrowOnMarket", "off"), "Tablet_Tutorial_Active", "off");
  wellFormed(out);
  assert.match(out, /<Var name="NeedArrowOnMarket" v="0" t="b"\/>/);
  assert.match(out, /<DataElem name="Tablet_Tutorial_Active" type="bool" value="false"\/>/);
  const untouched = setTutorialFlag(xml, "finishedTutorials", "shown");
  assert.equal(untouched, xml);
});

test("the tutorial copier never takes the friend's expedition energy or event state", () => {
  // `isTutorialName` matched `exped` **plus** `energy`, so
  // `isTutorialName("expeditionEnergy")` was true and
  // `copyTutorialsFromFriend` wrote the donor's spendable resource into our
  // save — in every mode, through a path no copy list mentions, which is why
  // no diff of the copy sets ever showed it. `tutorialTargetValue` returns a
  // non-empty friend value verbatim, so a *resource* was copied as if it were
  // a finished-tutorial flag.
  //
  // Measured on the real saves: own 11 -> donor 33854 with only
  // `expeditionEnergy` differing as input; the file reported banned carries
  // the donor's 33854 while both files reported ban-free carry their own 193.
  const RESOURCES = [
    "expeditionEnergy", "TsExpeditionEnergy", "ExpeditionInLastEnergy",
    "ExpeditionLastEnergySpent", "ExpeditionEnergyTooltipLastValue",
  ];
  const build = (vals: Record<string, string>) => [
    "<Global>",
    ...RESOURCES.map((n) => `<Var name="${n}" v="${vals[n]}" t="i"/>`),
    '<Var name="exp_tutorial_tablet_passed" v="0" t="b"/>',
    '<Var name="NeedArrowOnMarket" v="1" t="b"/>',
    "</Global>",
    '<TownGround ver="2"><row j="0" v="T"/></TownGround><Buildings><Object id="o"/></Buildings>',
  ].join("");
  const own = build(Object.fromEntries(RESOURCES.map((n) => [n, "193"])));
  const friend = [
    "<Global>",
    ...RESOURCES.map((n) => `<Var name="${n}" v="33854" t="i"/>`),
    '<Var name="exp_tutorial_tablet_passed" v="1" t="b"/>',
    '<Var name="NeedArrowOnMarket" v="1" t="b"/>',
    "</Global>",
    '<TownGround ver="2"><row j="0" v="F"/></TownGround><Buildings><Object id="p"/></Buildings>',
  ].join("");

  const out = skipTutorials(own, friend);
  wellFormed(out);
  for (const n of RESOURCES) {
    assert.ok(
      out.includes(`<Var name="${n}" v="193"`),
      `${n} is a resource, not a tutorial flag — the friend's value must not be taken`,
    );
  }
  // ...and the copier itself is unharmed: a real tutorial flag still comes across.
  assert.match(out, /<Var name="exp_tutorial_tablet_passed" v="1" t="b"\/>/);
  assert.match(out, /<Var name="NeedArrowOnMarket" v="0" t="b"\/>/);

  // End to end: no restore mode may move them either. This is the shape the
  // 2026-10-01 ban report was made of — the resources are the one value pair
  // that differed between the banned file (donor's) and both ban-free ones
  // (their own) after the population cap was fixed.
  for (const mode of ["inicial", "completo", "novo"] as const) {
    const o = applyDesban(own, friend, mode);
    for (const n of RESOURCES) {
      assert.ok(o.includes(`<Var name="${n}" v="193"`), `${mode}: ${n} stays ours`);
    }
    assert.match(o, /<Var name="exp_tutorial_tablet_passed" v="1" t="b"\/>/, `${mode}: tutorials still copied`);
  }
});
