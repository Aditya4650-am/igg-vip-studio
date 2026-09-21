import { strict as assert } from "node:assert";
import { test } from "node:test";

import { publicCatalogs, revealSave } from "../catalogs.server.ts";
import { iconForGroup, iconForSkin } from "../../game-icon-map.ts";
import { injectSkins } from "./inject.server.ts";
import { SKINS_CATALOG } from "./skins-catalog.server.ts";
import { findUnbalancedTag } from "./xml-edit.server.ts";

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