import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { publicCatalogs, revealSave } from "../catalogs.server.ts";
import { iconForGroup, iconForSkin } from "../../game-icon-map.ts";
import { injectSkins } from "./inject.server.ts";
import { SKINS_CATALOG } from "./skins-catalog.server.ts";
import { findUnbalancedTag } from "./xml-edit.server.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const catalogGroup = (id: string) => publicCatalogs().skins.find((g) => g.id === id);

test("the skins catalog exposes a TrainStation group with the real game type id", () => {
  // "TrainStation" is the <type id> the game itself writes; verified against a
  // decoded mGameInfo.xml, which contains <type id="TrainStation" .../>.
  assert.ok(SKINS_CATALOG.TrainStation, "TrainStation must be in the injection catalog");
  const parts = SKINS_CATALOG.TrainStation.split("|").filter(Boolean);
  assert.ok(parts.length > 0, "TrainStation must offer at least one skin");
  for (const p of parts) {
    assert.ok(p.startsWith("Skin_TrainStation_"), `unexpected station skin id: ${p}`);
  }
});

test("the public skin catalog lists TrainStation so the UI can render it", () => {
  const g = catalogGroup("TrainStation");
  assert.ok(g, "TrainStation group missing from publicCatalogs().skins");
  assert.equal(g.label, "Station");
  assert.equal(g.emoji, "🚉");
  assert.ok(g.items.length > 0, "station group must not be empty");
});

test("station skins get icons instead of a blank placeholder", () => {
  assert.equal(iconForGroup("TrainStation"), "/game-icons/Train_Station_Skin.png");
  assert.equal(iconForSkin("TrainStation", "Default"), "/game-icons/Train_Station_Skin.png");
});

test("injectSkins writes available station skins into a save with no Skins block", () => {
  const out = injectSkins("<Global><Vars/></Global>", { TrainStation: ["Skin_TrainStation_SP5"] });
  assert.equal(findUnbalancedTag(out), null, `unbalanced XML: ${out}`);
  assert.match(out, /<type id="TrainStation" available="[^"]*Skin_TrainStation_SP5[^"]*"/);
  assert.ok(out.indexOf("TrainStation") < out.indexOf("</Global>"), "must inject inside the root");
});

test("injectSkins merges station skins into an existing Skins block without dropping others", () => {
  const save =
    '<Global>\n<Skins>\n<type id="Train" available="Skin_Train_SP5|"/>\n<item id="Train0" current="Skin_Train_SP5"/>\n</Skins>\n</Global>';
  const out = injectSkins(save, { TrainStation: ["Skin_TrainStation_SP5"] });
  assert.equal(findUnbalancedTag(out), null, `unbalanced XML: ${out}`);
  // The pre-existing Train entry survives.
  assert.match(out, /<type id="Train" available="Skin_Train_SP5\|"\s*\/>/);
  // The station type is appended inside the existing block, not as a second block.
  assert.match(out, /<type id="TrainStation" available="[^"]*Skin_TrainStation_SP5[^"]*"/);
  assert.equal(out.match(/<Skins>/g)?.length, 1, "must not create a duplicate Skins block");
});

test("selecting TrainStation round-trips through the public-id cloak", () => {
  const g = catalogGroup("TrainStation")!;
  const selection = { TrainStation: [g.items[0].id] };
  const revealed = revealSave({ skins: selection });
  assert.equal(revealed.skins.TrainStation.length, 1, "public id must map back to a real skin id");
  const real = revealed.skins.TrainStation[0];
  assert.ok(real.startsWith("Skin_TrainStation_"), `revealed id was not a station skin: ${real}`);
  // And that real id is what injection consumes.
  const out = injectSkins("<Global/>", revealed.skins);
  assert.match(out, new RegExp(`available="[^"]*${real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("every station skin in the catalog has a resolvable label", () => {
  const g = catalogGroup("TrainStation")!;
  for (const it of g.items) {
    assert.ok(it.label && it.label.length > 0, `station skin ${it.id} has no label`);
    assert.ok(!it.label.includes("TrainStation"), `label leaked the raw id: ${it.label}`);
  }
});

// The 22 ids confirmed by the game data: 21 have an identical twin in the
// already-shipping Train group (Skin_TrainStation_X <-> Skin_Train_X), and
// SP2/SP5 are confirmed rendering in-game.
const EXPECTED_STATION_IDS = [
  "Skin_TrainStation_SP2",
  "Skin_TrainStation_SP5",
  "Skin_TrainStation_SP8",
  "Skin_TrainStation_western",
  "Skin_TrainStation_christmas",
  "Skin_TrainStation_easter",
  "Skin_TrainStation_prehistoric",
  "Skin_TrainStation_theatrical",
  "Skin_TrainStation_lunarNY2022",
  "Skin_TrainStation_mars",
  "Skin_TrainStation_robinHood",
  "Skin_TrainStation_rocknroll",
  "Skin_TrainStation_knight",
  "Skin_TrainStation_italy2024",
  "Skin_TrainStation_halloween2024",
  "Skin_TrainStation_christmas2024",
  "Skin_TrainStation_festival",
  "Skin_TrainStation_hellas2025",
  "Skin_TrainStation_Gatsby",
  "Skin_TrainStation_france_68",
  "Skin_TrainStation_celebrity_73",
  "Skin_TrainStation_vacation_78",
];

test("the catalog ships every confirmed station skin id and nothing invented", () => {
  const skins = SKINS_CATALOG.TrainStation.split("|").filter((p) => p && p !== "Skin_TrainStation_Default");
  assert.deepEqual([...skins].sort(), [...EXPECTED_STATION_IDS].sort());
});

test("every confirmed station id is offered by the public catalog", () => {
  // Public ids are cloaked, so uncloak the whole group the way a save does.
  const g = catalogGroup("TrainStation")!;
  const revealed = revealSave({ skins: { TrainStation: g.items.map((i) => i.id) } });
  const expected = [...EXPECTED_STATION_IDS, "Skin_TrainStation_Default"].sort();
  assert.deepEqual([...revealed.skins.TrainStation].sort(), expected);
});

test("station icons resolve to files that exist on disk", () => {
  let mapped = 0;
  for (const it of catalogGroup("TrainStation")!.items) {
    const icon = iconForSkin("TrainStation", it.label);
    if (!icon) continue;
    mapped += 1;
    assert.ok(existsSync(join(repoRoot, "public", icon.replace(/^\//, ""))), `icon file missing: ${icon}`);
  }
  // France/Celebrity/Vacation have no artwork yet, so 20 of 23 rows carry an icon.
  assert.equal(mapped, 20, `expected 20 station icons, got ${mapped}`);
});

test("station labels stay short and unique for the picker", () => {
  const seen = new Set<string>();
  for (const it of catalogGroup("TrainStation")!.items) {
    assert.ok(it.label.length <= 16, `label too long for the picker: ${it.label}`);
    assert.ok(!seen.has(it.label), `duplicate station label: ${it.label}`);
    seen.add(it.label);
  }
});

test("every confirmed station skin injects end to end", () => {
  const out = injectSkins("<Global><Skins/></Global>", { TrainStation: EXPECTED_STATION_IDS });
  assert.equal(findUnbalancedTag(out), null, `unbalanced XML: ${out}`);
  for (const id of EXPECTED_STATION_IDS) assert.ok(out.includes(id), `injection dropped ${id}`);
});