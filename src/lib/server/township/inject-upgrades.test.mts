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

test("inject reports empty for a self-closing Upgrade block", () => {
  const r = injectUpgradeLevels(EMPTY_SELF_CLOSING, "Factory", ["bakery"], 20);
  assert.equal(r.changed, 0);
  assert.equal(r.reason, "empty");
  assert.equal(r.xml, EMPTY_SELF_CLOSING);
});

test("inject reports missing when no Upgrade block exists", () => {
  const r = injectUpgradeLevels(NO_BLOCK, "Factory", ["bakery"], 20);
  assert.equal(r.changed, 0);
  assert.equal(r.reason, "missing");
  assert.equal(r.xml, NO_BLOCK);
});

test("inject handles train and island rows independently", () => {
  const t = injectUpgradeLevels(PAIRED, "Train", ["1"], 5);
  wellFormed(t.xml);
  assert.equal(t.changed, 1);
  assert.match(t.xml, new RegExp(`<Train id="1" level="5" slx="${5 ^ SLX}"`));
  // Factory rows are never touched by a train run.
  assert.match(t.xml, /<Factory id="bagfactory" level="39"/);
  const noTrain = injectUpgradeLevels(EMPTY_SELF_CLOSING, "Train", ["1"], 5);
  assert.equal(noTrain.reason, "empty");
  const isl = injectUpgradeLevels(PAIRED, "Island", ["i1"], 31);
  assert.equal(isl.changed, 0);
  assert.equal(isl.reason, "noop");
});
