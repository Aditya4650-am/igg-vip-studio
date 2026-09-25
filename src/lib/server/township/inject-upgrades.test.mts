import { strict as assert } from "node:assert";
import { test } from "node:test";

import { discoverUpgrades, injectUpgradeLevels, upgradeMaxLevel } from "./inject.server.ts";
import { findUnbalancedTag } from "./xml-edit.server.ts";

const wellFormed = (xml: string) =>
  assert.equal(findUnbalancedTag(xml), null, `expected balanced XML, got: ${xml}`);

const SLX = 32162029;

// Paired block mirroring the real save encoding: self-closing rows,
// level/slx pair, per-row bonus attributes.
const PAIRED = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<Global>",
  '<Upgrade version="4">',
  '<Factory id="bagfactory" level="39" slx="32161994" xpBonus="100" moneyBonus="100" timeBonus="100" shelfBonus="2"/>',
  '<Factory id="bakery" level="53" slx="32162008" xpBonus="100" moneyBonus="100" timeBonus="100" shelfBonus="2"/>',
  '<Factory id="mill" level="53" slx="32162008" xpBonus="100" moneyBonus="100"/>',
  '<Train id="1" level="31" slx="32162034" xpBonus="100" timeBonus="100"/>',
  '<Island id="i1" level="31" slx="32162034" timeBonus="101" probability2="100" probability3="100"/>',
  "</Upgrade>",
  "</Global>",
].join("");

const EMPTY_SELF_CLOSING = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<Global>",
  '<Upgrade version="4"/>',
  "</Global>",
].join("");

const NO_BLOCK = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<Global>",
  '<Var name="levelup" v="1" t="i"/>',
  "</Global>",
].join("");

test("upgradeMaxLevel reads the save ceiling per kind", () => {
  assert.equal(upgradeMaxLevel(PAIRED, "Factory"), 53);
  assert.equal(upgradeMaxLevel(PAIRED, "Train"), 31);
  assert.equal(upgradeMaxLevel(PAIRED, "Island"), 31);
  assert.equal(upgradeMaxLevel(EMPTY_SELF_CLOSING, "Factory"), 0);
  assert.equal(upgradeMaxLevel(NO_BLOCK, "Factory"), 0);
});

test("discoverUpgrades parses paired rows with real ids", () => {
  const d = discoverUpgrades(PAIRED);
  assert.deepEqual(
    d.factories.map((r) => r.id),
    ["bagfactory", "bakery", "mill"],
  );
  assert.deepEqual(
    d.trains.map((r) => r.id),
    ["1"],
  );
});

test("inject raises below-max rows and rewrites slx as level XOR key", () => {
  const r = injectUpgradeLevels(PAIRED, "Factory", ["bagfactory"], 53);
  wellFormed(r.xml);
  assert.equal(r.changed, 1);
  assert.equal(r.reason, "ok");
  assert.match(r.xml, /<Factory id="bagfactory" level="53" slx="32162008"/);
  // Untouched rows keep their own bonus attributes.
  assert.match(r.xml, /<Factory id="mill" level="53" slx="32162008" xpBonus="100" moneyBonus="100"\/>/);
  assert.equal(53 ^ SLX, 32162008);
});

test("inject clamps an above-ceiling target down to the save max", () => {
  const r = injectUpgradeLevels(PAIRED, "Factory", ["bagfactory"], 999);
  wellFormed(r.xml);
  assert.equal(r.changed, 1);
  assert.match(r.xml, /<Factory id="bagfactory" level="53" slx="32162008"/);
});

test("inject reports noop when rows already sit at the target", () => {
  const atMax = injectUpgradeLevels(PAIRED, "Factory", ["bakery", "mill"], 53);
  assert.equal(atMax.changed, 0);
  assert.equal(atMax.reason, "noop");
  assert.equal(atMax.xml, PAIRED);
});

test("inject lowers a row when the target sits below its level", () => {
  const below = injectUpgradeLevels(PAIRED, "Factory", ["bakery"], 1);
  wellFormed(below.xml);
  assert.equal(below.changed, 1);
  assert.equal(below.reason, "ok");
  assert.match(below.xml, new RegExp(`<Factory id="bakery" level="1" slx="${1 ^ SLX}"`));
});

test("inject reports noop for unknown ids without touching the save", () => {
  const r = injectUpgradeLevels(PAIRED, "Factory", ["nopefactory"], 53);
  assert.equal(r.changed, 0);
  assert.equal(r.reason, "noop");
  assert.equal(r.xml, PAIRED);
});

test("inject ignores ids of another kind instead of creating them", () => {
  const r = injectUpgradeLevels(PAIRED, "Train", ["bakery"], 31);
  assert.equal(r.changed, 0);
  assert.equal(r.reason, "noop");
  assert.equal(r.xml, PAIRED);
});

test("inject creates a missing row with the exact reference encoding", () => {
  // mGameInfo_decoded.xml carries this exact bakery row: a created row at
  // the same level must be byte-identical to game-accepted data.
  const r = injectUpgradeLevels(EMPTY_SELF_CLOSING, "Factory", ["bakery"], 53);
  wellFormed(r.xml);
  assert.equal(r.changed, 1);
  assert.equal(r.reason, "ok");
  assert.match(
    r.xml,
    /<Upgrade version="4"><Factory id="bakery" level="53" slx="32162008" xpBonus="100" moneyBonus="100" timeBonus="100" shelfBonus="2"\/><\/Upgrade>/,
  );
});

test("inject builds a missing block inside the root with kind templates", () => {
  const t = injectUpgradeLevels(NO_BLOCK, "Train", ["1"], 31);
  wellFormed(t.xml);
  assert.equal(t.changed, 1);
  assert.equal(t.reason, "ok");
  assert.match(
    t.xml,
    /<Upgrade version="4"><Train id="1" level="31" slx="32162034" xpBonus="100" timeBonus="100"\/><\/Upgrade>/,
  );
  assert.ok(t.xml.indexOf("<Upgrade") < t.xml.indexOf("</Global>"), "block must be inside the root");
  const isl = injectUpgradeLevels(NO_BLOCK, "Island", ["i3"], 31);
  wellFormed(isl.xml);
  assert.match(
    isl.xml,
    /<Island id="i3" level="31" slx="32162034" timeBonus="101" probability2="100" probability3="100"\/>/,
  );
});

test("inject caps creation at the reference ceiling when the save has no max", () => {
  const r = injectUpgradeLevels(EMPTY_SELF_CLOSING, "Factory", ["bakery"], 999);
  wellFormed(r.xml);
  assert.equal(r.changed, 1);
  assert.match(r.xml, /<Factory id="bakery" level="53" slx="32162008"/);
});

test("inject fills gaps in a partial block without touching current rows", () => {
  const r = injectUpgradeLevels(PAIRED, "Factory", ["bakery", "wheelfactory"], 53);
  wellFormed(r.xml);
  assert.equal(r.changed, 1);
  assert.equal(r.reason, "ok");
  // bakery already at 53 stays exactly as it was.
  assert.match(r.xml, /<Factory id="bakery" level="53" slx="32162008" xpBonus="100" moneyBonus="100" timeBonus="100" shelfBonus="2"\/>/);
  assert.match(
    r.xml,
    /<Factory id="wheelfactory" level="53" slx="32162008" xpBonus="100" moneyBonus="100" timeBonus="100" shelfBonus="2"\/>/,
  );
});

test("inject with a non-positive target changes nothing", () => {
  const r = injectUpgradeLevels(PAIRED, "Factory", ["bagfactory"], 0);
  assert.equal(r.changed, 0);
  assert.equal(r.reason, "empty");
  assert.equal(r.xml, PAIRED);
});

test("inject handles train and island rows independently", () => {
  const t = injectUpgradeLevels(PAIRED, "Train", ["1"], 5);
  wellFormed(t.xml);
  assert.equal(t.changed, 1);
  assert.match(t.xml, new RegExp(`<Train id="1" level="5" slx="${5 ^ SLX}"`));
  // Factory rows are never touched by a train run.
  assert.match(t.xml, /<Factory id="bagfactory" level="39"/);
  const newTrain = injectUpgradeLevels(EMPTY_SELF_CLOSING, "Train", ["1"], 5);
  wellFormed(newTrain.xml);
  assert.equal(newTrain.changed, 1);
  assert.equal(newTrain.reason, "ok");
  assert.match(newTrain.xml, new RegExp(`<Train id="1" level="5" slx="${5 ^ SLX}" xpBonus="100" timeBonus="100"`));
  const isl = injectUpgradeLevels(PAIRED, "Island", ["i1"], 31);
  assert.equal(isl.changed, 0);
  assert.equal(isl.reason, "noop");
});
