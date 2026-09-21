import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.IGG_VIP_MASTER = "test-master-key-with-enough-length";
process.env.IGG_VIP_OWNER = "IGG-OWNER-TESTKEY";
process.env.IGG_VIP_URL = "";

const studio = await import("./server/studio.server.ts");
const { verifyLicenseKey } = await import("./server/license.server.ts");
const { findUnbalancedTag } = await import("./server/township/xml-edit.server.ts");
const { readVar } = await import("./server/township/vars.server.ts");
const {
  deriveZooUnlockState,
  discoverAcademy,
  discoverMuseumVars,
  discoverPaddocks,
  injectAcademyMax,
  injectMuseum,
  injectZooUnlocks,
  normalizePaddockId,
  paddockLabel,
  MUSEUM_ALLOWLIST,
} = await import("./server/township/inject.server.ts");

const { token } = verifyLicenseKey("VIP-DEMO", "TEST-DEVICE-0001");

/**
 * Names/shapes below mirror the ones verified against the real decoded
 * mGameInfo: 34 paddocks with an `sq0` companion each, `ZooExpandLevel`, the
 * `Achievement_Artefact*` counters and `BLvl_*` factory levels.
 */
const save = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<root>",
  '<Var name="paddock_polar_bear_state" v="18" t="i"/>',
  '<Var name="paddock_polar_bearsq0_state" v="0" t="i"/>',
  '<Var name="paddock_bear_state" v="10" t="i"/>',
  '<Var name="paddock_bearsq0_state" v="0" t="i"/>',
  '<Var name="paddock_snow_monkey_state" v="10" t="i"/>',
  '<Var name="paddock_snow_monkeysq0_state" v="0" t="i"/>',
  '<Var name="ZooExpandLevel" v="127" t="i"/>',
  '<Var name="Achievement_ArtefactHunter" v="582" t="i"/>',
  '<Var name="Achievement_ArtefactHunterIslands" v="450" t="i"/>',
  '<Var name="BLvl_milkfactory" v="999" t="i"/>',
  '<Var name="BLvl_bakery" v="2" t="i"/>',
  '<Var name="BLvl_cowfactory" v="1" t="i"/>',
  '<Var name="moneyCash" v="100" t="i"/>',
  '<Var name="levelup" v="5" t="i"/>',
  "</root>",
].join("");

function load(xml = save) {
  return studio.connectLoad(token, "test-device", undefined, undefined, Buffer.from(xml).toString("base64"));
}

function decode(fileB64: string) {
  return Buffer.from(fileB64, "base64").toString("utf8");
}

function balanced(xml: string) {
  assert.equal(findUnbalancedTag(xml), null, `malformed XML:\n${xml}`);
}

/* ------------------------------- discovery ------------------------------- */

test("zoo discovery lists primary paddocks only, never the sq0 companions", () => {
  const found = discoverPaddocks(save);
  assert.equal(found.length, 3);
  assert.deepEqual(
    found.map((p) => p.id),
    ["paddock_polar_bear_state", "paddock_bear_state", "paddock_snow_monkey_state"],
  );
  assert.ok(found.every((p) => !p.id.endsWith("sq0_state")), "sq0 entries leaked into the paddock list");
  assert.equal(found.find((p) => p.id === "paddock_bear_state")?.state, "10");
});

test("paddock names are human readable", () => {
  assert.equal(paddockLabel("paddock_polar_bear_state"), "Polar Bear");
  assert.equal(paddockLabel("paddock_snow_monkey_state"), "Snow Monkey");
  assert.equal(paddockLabel("paddock_WhiteOwl_state"), "White Owl");
  assert.equal(paddockLabel("paddock_girrafe_state"), "Girrafe");
});

test("paddock ids accept bare, full and sq0 forms", () => {
  assert.equal(normalizePaddockId("polar_bear"), "paddock_polar_bear_state");
  assert.equal(normalizePaddockId("paddock_polar_bear_state"), "paddock_polar_bear_state");
  assert.equal(normalizePaddockId("paddock_polar_bearsq0_state"), "paddock_polar_bear_state");
  assert.equal(normalizePaddockId("  paddock_bear_state  "), "paddock_bear_state");
  assert.equal(normalizePaddockId(""), null);
  assert.equal(normalizePaddockId("bad id!"), null);
  assert.equal(normalizePaddockId("paddock_drop;drop_state"), null);
});

test("museum discovery only returns the real allowlisted counters", () => {
  const found = discoverMuseumVars(save);
  assert.deepEqual(found, [
    { name: "Achievement_ArtefactHunter", value: "582" },
    { name: "Achievement_ArtefactHunterIslands", value: "450" },
  ]);
  // Nothing is discovered when the save has none, so no fake artifact appears.
  assert.deepEqual(discoverMuseumVars("<root></root>"), []);
  assert.deepEqual([...MUSEUM_ALLOWLIST], ["Achievement_ArtefactHunter", "Achievement_ArtefactHunterIslands"]);
});

test("academy discovery finds every BLvl_ factory", () => {
  assert.deepEqual(discoverAcademy(save), [
    { name: "BLvl_milkfactory", level: "999" },
    { name: "BLvl_bakery", level: "2" },
    { name: "BLvl_cowfactory", level: "1" },
  ]);
});

/* --------------------------------- inject -------------------------------- */

test("zoo unlock writes the state and clears the sq0 companion", () => {
  const out = injectZooUnlocks(save, { paddockIds: ["polar_bear", "paddock_bear_state"], unlockedState: "18" });
  assert.equal(readVar(out, "paddock_polar_bear_state"), "18");
  assert.equal(readVar(out, "paddock_bear_state"), "18");
  assert.equal(readVar(out, "paddock_bearsq0_state"), "0");
  assert.equal(readVar(out, "paddock_polar_bearsq0_state"), "0");
  balanced(out);
});

test("zoo unlock without an explicit value changes no paddock counter", () => {
  // No documented "unlocked" sentinel exists, so an absent value must not be
  // replaced by a guessed constant: that is the silent no-op this repo bans.
  const out = injectZooUnlocks(save, { paddockIds: ["paddock_snow_monkey_state"] });
  assert.equal(out, save, "no value means no edit, never a hardcoded fallback");
  assert.equal(readVar(out, "ZooExpandLevel"), "127", "expansion must not change unless asked");
});

test("zoo unlock state is derived from the highest state in the save", () => {
  assert.equal(deriveZooUnlockState(save), "18");
  const mixed = save.replace('<Var name="paddock_bear_state" v="10" t="i"/>', '<Var name="paddock_bear_state" v="42" t="i"/>');
  assert.equal(deriveZooUnlockState(mixed), "42", "must learn the max, not assume 18");
  const noPaddocks = "<root><Var name=\"ZooExpandLevel\" v=\"5\" t=\"i\"/></root>";
  assert.equal(deriveZooUnlockState(noPaddocks), null, "nothing to learn from");
  const allZero = '<root><Var name="paddock_bear_state" v="0" t="i"/><Var name="paddock_koala_state" v="0" t="i"/></root>';
  assert.equal(deriveZooUnlockState(allZero), null, "all-zero paddocks show no unlocked level to copy");
});

test("zoo discovery reports the states already in the save", () => {
  const states = discoverPaddocks(save).map((p) => p.state);
  assert.ok(states.every((s) => /^\d+$/.test(s)), "discovery must surface numeric states");
  assert.equal(deriveZooUnlockState(save), String(Math.max(...states.map(Number))));
});

test("zoo unlock only touches ZooExpandLevel when explicitly given", () => {
  const out = injectZooUnlocks(save, { paddockIds: [], zooExpandLevel: 130 });
  assert.equal(readVar(out, "ZooExpandLevel"), "130");
  const kept = injectZooUnlocks(save, { paddockIds: [], zooExpandLevel: null });
  assert.equal(readVar(kept, "ZooExpandLevel"), "127");
});

test("zoo unlock never invents a paddock that is not in the save", () => {
  const out = injectZooUnlocks(save, { paddockIds: ["paddock_unicorn_state", "paddock_t-rex_state"], unlockedState: "18" });
  assert.equal(out, save, "no discovered target means no edit");
  assert.ok(!out.includes("unicorn"));
});

test("zoo unlock leaves TownGround grids untouched", () => {
  const withGround = `<root><TownGround ver="2"><row j="0" v="***()***"/></TownGround>${save.slice("<root>".length)}`;
  const out = injectZooUnlocks(withGround, { paddockIds: ["paddock_bear_state"], unlockedState: "18" });
  assert.ok(out.includes('<row j="0" v="***()***"/>'), "map grid changed");
});

test("zoo unlock is idempotent", () => {
  const once = injectZooUnlocks(save, { paddockIds: ["paddock_bear_state"], unlockedState: "18" });
  const twice = injectZooUnlocks(once, { paddockIds: ["paddock_bear_state"], unlockedState: "18" });
  assert.equal(once, twice);
});

test("museum inject only edits counters that exist", () => {
  const out = injectMuseum(save, {
    varEdits: {
      Achievement_ArtefactHunter: "9999",
      Achievement_ArtefactHunterIslands: "8888",
      MuseumArtefacts: "1",
      NotInSave: "5",
    },
  });
  assert.equal(readVar(out, "Achievement_ArtefactHunter"), "9999");
  assert.equal(readVar(out, "Achievement_ArtefactHunterIslands"), "8888");
  assert.ok(!out.includes("NotInSave"), "a counter absent from the save must not be created");
  assert.ok(!out.includes('name="MuseumArtefacts"'), "the empty artefact store must not be invented");
  balanced(out);
});

test("museum inject rejects unsafe keys and non-numeric values", () => {
  const out = injectMuseum(save, { varEdits: { "Drop;Table": "1", "": "1", Achievement_ArtefactHunter: "abc" } });
  assert.equal(out, save);
});

test("academy max writes 999 by default and respects a custom level", () => {
  const out = injectAcademyMax(save, { blvlNames: ["BLvl_bakery", "BLvl_cowfactory"] });
  assert.equal(readVar(out, "BLvl_bakery"), "999");
  assert.equal(readVar(out, "BLvl_cowfactory"), "999");
  assert.equal(readVar(out, "BLvl_milkfactory"), "999");

  const custom = injectAcademyMax(save, { blvlNames: ["BLvl_bakery"], maxLevel: "500" });
  assert.equal(readVar(custom, "BLvl_bakery"), "500");
});

test("academy max only accepts BLvl_ names and never creates one", () => {
  const out = injectAcademyMax(save, { blvlNames: ["BLvl_bakery", "levelup", "moneyCash", "BLvl_missing"] });
  assert.equal(readVar(out, "BLvl_bakery"), "999");
  assert.equal(readVar(out, "levelup"), "5", "a non-BLvl_ var must be ignored");
  assert.equal(readVar(out, "moneyCash"), "100");
  assert.ok(!out.includes("BLvl_missing"), "a missing factory must not be created");
});

/* -------------------------------- pipeline ------------------------------- */

test("zoo saves through the normal pipeline and reports a part", () => {
  const { sessionId } = load();
  const r = studio.applySave({ token, sessionId, zooPaddocks: ["paddock_bear_state"] });
  assert.deepEqual(r.parts, ["zoo(1→18)"]);
  const xml = decode(r.fileB64!);
  assert.equal(readVar(xml, "paddock_bear_state"), "18");
  balanced(xml);
  assert.equal(r.zoo.find((p) => p.id === "paddock_bear_state")?.state, "18", "snapshot must show the new state");
});

test("academy saves through the normal pipeline and reports a part", () => {
  const { sessionId } = load();
  const r = studio.applySave({ token, sessionId, academyBlvl: ["BLvl_bakery"] });
  assert.deepEqual(r.parts, ["academy(1)"]);
  assert.equal(readVar(decode(r.fileB64!), "BLvl_bakery"), "999");
  assert.equal(r.academy.find((f) => f.name === "BLvl_bakery")?.level, "999");
});

test("museum saves through the normal pipeline and reports a part", () => {
  const { sessionId } = load();
  const r = studio.applySave({ token, sessionId, museumVars: { Achievement_ArtefactHunter: "9999" } });
  assert.deepEqual(r.parts, ["museum(1)"]);
  assert.equal(readVar(decode(r.fileB64!), "Achievement_ArtefactHunter"), "9999");
  assert.equal(r.museum.find((m) => m.name === "Achievement_ArtefactHunter")?.value, "9999");
});

test("the three features work independently, together, and alongside existing ones", () => {
  // Independent: each produces only its own part.
  const a = load();
  assert.deepEqual(studio.applySave({ token, sessionId: a.sessionId, zooPaddocks: ["paddock_bear_state"] }).parts, ["zoo(1→18)"]);
  const b = load();
  assert.deepEqual(studio.applySave({ token, sessionId: b.sessionId, academyBlvl: ["BLvl_bakery"] }).parts, ["academy(1)"]);
  const c = load();
  assert.deepEqual(studio.applySave({ token, sessionId: c.sessionId, museumVars: { Achievement_ArtefactHunter: "7" } }).parts, ["museum(1)"]);

  // Together, in the documented order, plus an unrelated existing op.
  const { sessionId } = load();
  const r = studio.applySave({
    token,
    sessionId,
    zooPaddocks: ["paddock_bear_state", "paddock_snow_monkey_state"],
    academyBlvl: ["BLvl_bakery"],
    museumVars: { Achievement_ArtefactHunterIslands: "7777" },
    barnUpgrades: 100,
  });
  assert.deepEqual(r.parts, ["barn(100)", "zoo(2→18)", "academy(1)", "museum(1)"]);
  const xml = decode(r.fileB64!);
  assert.equal(readVar(xml, "paddock_bear_state"), "18");
  assert.equal(readVar(xml, "paddock_snow_monkey_state"), "18");
  assert.equal(readVar(xml, "BLvl_bakery"), "999");
  assert.equal(readVar(xml, "Achievement_ArtefactHunterIslands"), "7777");
  balanced(xml);
});

test("a zoo/academy/museum-only save no longer reports 'Nothing selected'", () => {
  const { sessionId } = load();
  assert.doesNotThrow(() => studio.applySave({ token, sessionId, zooPaddocks: ["paddock_bear_state"] }));
  const { sessionId: s2 } = load();
  assert.doesNotThrow(() => studio.applySave({ token, sessionId: s2, academyBlvl: ["BLvl_bakery"] }));
  // ...while an empty request keeps the original error.
  const { sessionId: s3 } = load();
  assert.throws(() => studio.applySave({ token, sessionId: s3 }), /Nothing selected/);
});

test("zoo stats stay consistent after an unlock (existing stat reading still works)", () => {
  const { sessionId } = load();
  const before = studio.applySave({ token, sessionId, zooPaddocks: ["paddock_bear_state"] });
  const { sessionId: s2 } = load();
  const after = studio.applySave({ token, sessionId: s2, stats: { tca: "100" }, zooPaddocks: ["paddock_bear_state"] });
  // The zoo step must not disturb the pre-existing stats snapshot behaviour.
  assert.deepEqual(Object.keys(before.stats).sort(), Object.keys(after.stats).sort());
});
