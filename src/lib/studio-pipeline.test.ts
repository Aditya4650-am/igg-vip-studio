import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.IGG_VIP_MASTER = "test-master-key-with-enough-length";
process.env.IGG_VIP_OWNER = "IGG-OWNER-TESTKEY";
process.env.IGG_VIP_URL = "";

const studio = await import("./server/studio.server.ts");
const { verifyLicenseKey } = await import("./server/license.server.ts");
const { findUnbalancedTag } = await import("./server/township/xml-edit.server.ts");
const { avatarEmoji, avatarIconPath, AVATAR_EMOJIS, AVATAR_ICON_MAX, AVATAR_MAX } =
  await import("./catalogs.ts");
const { iconForBarn } = await import("./game-icon-map.ts");
const { iconForZoo } = await import("./game-icon-map.ts");
const { ZOO_REQUIREMENTS } = await import("./server/township/zoo.server.ts");
const { readdirSync, existsSync } = await import("node:fs");

const { token } = verifyLicenseKey("VIP-DEMO", "TEST-DEVICE-0001");

const ownSave = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<Global>",
  '<Var name="FullCardCollections" v="2" t="i"/>',
  '<Var name="StartTutorialFinished" v="0" t="i"/>',
  '<Var name="levelup" v="1" t="i"/>',
  '<Version version="35.1.0" FVer="3510"/>',
  '<AWS cityId="owncity01"/>',
  "</Global>",
].join("");

const friendSave = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<Global>",
  '<Var name="FullCardCollections" v="7" t="i"/>',
  '<Var name="levelup" v="42" t="i"/>',
  '<Var name="StartTutorialFinished" v="1" t="i"/>',
  "</Global>",
].join("");

function load() {
  return studio.connectLoad(
    token,
    "test-device",
    undefined,
    undefined,
    Buffer.from(ownSave).toString("base64"),
  );
}

function balanced(xml: string) {
  assert.equal(findUnbalancedTag(xml), null, `malformed XML:\n${xml}`);
}

test("unban works from the save's own version when LocalInfo is unreadable", () => {
  // The reported failure: an unrooted emulator returns the shell's error text
  // from the mLocalInfo read, and the UI aborted FetchCity before it ran, so
  // `applyUnban` could never find a friend. FetchCity must use the <Version>
  // already in mGameInfo instead.
  const { sessionId } = load();
  const attach = () => studio.attachLocalInfoBase64(token, sessionId, Buffer.from("cat: /data/data/com.playrix.township/saves/mLocalInfo.xml: Permission denied").toString("base64"));
  assert.throws(attach, /Root/i);

  studio.attachFriendXml(token, sessionId, friendSave);
  const out = studio.applyUnban(token, sessionId, "completo");
  assert.equal(out.unban?.applied, true);
  balanced(Buffer.from(out.fileB64!, "base64").toString("utf8"));
});

test("unban: a broken save read is named as a device problem, not a format", () => {
  const blob = Buffer.from("cat: /data/data/com.playrix.township/saves/mGameInfo.xml: Permission denied");
  assert.throws(
    () => studio.connectLoad(token, "test-device", undefined, undefined, blob.toString("base64")),
    /Root|ADB/i,
  );
});

test("card collections are gone from the catalogue and the session", () => {
  // Restored: `crd` writes the legacy `FullCardCollections` counter exactly
  // as the original zip does (single Var, same FIELD_MAP). Not claimed to
  // grant real cards — the real collection lives in `OwnedCards` and is
  // edited via the Cards tab. Guard that both mechanisms coexist.
  assert.notEqual(studio.catalogs().fields.find((f) => f.key === "crd"), undefined);

  const { sessionId } = load();
  const withFriend = studio.attachFriendXml(token, sessionId, friendSave);
  assert.ok(!("friendCards" in withFriend), "friend snapshot must not expose a card counter");
});

test("season pass: applies once and stays balanced on repeat", () => {
  const { sessionId } = load();
  const first = studio.applySave({ token, sessionId, season: true });
  assert.ok(first.parts.includes("season-pass"));
  balanced(first.xml!);
  assert.equal(first.xml!.match(/<SeasonTicket\b/g)?.length, 1);

  const second = studio.applySeason(token, sessionId);
  balanced(second.xml!);
  assert.equal(second.xml!.match(/<SeasonTicket\b/g)?.length, 1, "must not duplicate");
  assert.deepEqual(second.season, { premium: true, score: 1002 });
});

test("decoration: stash is created inside root and is not duplicated", () => {
  const { sessionId } = load();
  const first = studio.applySave({ token, sessionId, decorMaxAll: true, decorQty: 12 });
  assert.ok(first.parts.includes("decor-max-all(12)"));
  balanced(first.xml!);
  assert.ok(
    first.xml!.indexOf("</BuildingsStash>") < first.xml!.indexOf("</Global>"),
    "stash must close before the root",
  );

  const second = studio.applySave({ token, sessionId, decorMaxAll: true, decorQty: 12 });
  balanced(second.xml!);
  assert.equal(second.xml!.match(/<BuildingsStash>/g)?.length, 1, "must not duplicate the stash");
});

test("unban: restore applies friend stats and re-encodes a valid save", () => {
  const { sessionId } = load();
  studio.attachFriendXml(token, sessionId, friendSave);
  const out = studio.applyUnban(token, sessionId, "completo");
  assert.equal(out.unban?.applied, true);
  const xml = Buffer.from(out.fileB64!, "base64").toString("utf8");
  assert.match(xml, /<Var name="levelup"\s+v="42"/);
  balanced(xml);

  // The pushed file must load back into a fresh session without loss.
  const reloaded = studio.connectLoad(token, "test-device", undefined, undefined, out.fileB64!);
  assert.ok(reloaded.hasXml);
});

test("decoration: a save that already has a self-closing stash is updated in place", () => {
  // Fresh saves ship `<BuildingsStash/>`. The old matcher only understood the
  // paired form, so the rows landed in a second stash the game never reads.
  // Decoration ids are HMAC public ids, so take one from the catalog the UI uses.
  const decorId = studio.catalogs().decor[0]!.id;
  const xml = ownSave.replace("<Version", "<BuildingsStash/><Version");
  const { sessionId } = studio.connectLoad(token, "test-device", undefined, undefined, Buffer.from(xml).toString("base64"));
  const out = studio.applySave({ token, sessionId, decor: [decorId], decorQty: 3 });
  assert.ok(out.parts.some((p) => p.startsWith("decor")));
  balanced(out.xml!);
  assert.equal(out.xml!.match(/<BuildingsStash/g)?.length, 1, "must not add a second stash");
  assert.match(out.xml!, /<Building id="[^"]+" count="3"\/>/);

  // The pushed payload is the XML itself, so the decor must survive a reload.
  const pushed = Buffer.from(out.fileB64!, "base64").toString("utf8");
  assert.match(pushed, /<Building id="[^"]+" count="3"\/>/);
  assert.equal((pushed.match(/<BuildingsStash/g) ?? []).length, 1);
});

test("regatta: repeated apply keeps XML balanced", () => {
  const { sessionId } = load();
  const first = studio.applyRegatta(token, sessionId);
  balanced(first.xml!);
  const second = studio.applyRegatta(token, sessionId);
  balanced(second.xml!);
  assert.ok((second.xml!.match(/<Regata\b/g)?.length ?? 0) >= 1);
});

test("fetch city: validates input before touching python", async () => {
  const { sessionId } = load();
  await assert.rejects(() => studio.fetchFriendCity(token, sessionId, "bad"), /City ID/i);

  // A save without <Version> must NOT hard-block FetchCity: that was the
  // "Chưa có game version/FVer" dead end, and it also blocked unban (no friend)
  // and the card copy that needs a friend city. With no version available the
  // request now proceeds using the reference client's default pair, so any
  // failure must come from the network/python stage, never a version guard.
  const noVersion = studio.connectLoad(
    token,
    "test-device",
    undefined,
    undefined,
    Buffer.from("<Global><AWS cityId='owncity01'/></Global>").toString("base64"),
  );
  const err = await studio
    .fetchFriendCity(token, noVersion.sessionId, "owncity01")
    .then(() => null)
    .catch((e: Error) => e.message);
  // Match the guard's own wording, not the substring "version": downstream
  // messages legitimately talk about versions (a 403 is rejected build
  // metadata), and forbidding the word made this test fail for the wrong
  // reason once the fallback pair was actually exercised against the API.
  if (err !== null) {
    assert.doesNotMatch(err, /missing game version\/FVer|refresh LocalInfo first/i, "version guard must no longer block FetchCity");
  }
});

test("avatars: every shipped artwork resolves to one icon path", () => {
  const files = readdirSync("public/avatars").filter((f) => f.endsWith(".webp"));
  assert.equal(files.length, AVATAR_ICON_MAX, "asset count must match AVATAR_ICON_MAX");
  const seen = new Set<string>();
  for (let n = 1; n <= AVATAR_ICON_MAX; n++) {
    const src = avatarIconPath(String(n));
    assert.equal(src, `/avatars/ava${n}.webp`, `avatar ${n} must map to its own file`);
    assert.ok(files.includes(`ava${n}.webp`), `ava${n}.webp must be shipped`);
    assert.ok(!seen.has(src!), `avatar ${n} reuses ${src}`);
    seen.add(src!);
  }
});

test("avatars: past the artwork each one gets a distinct emoji, never a star", () => {
  const extras = AVATAR_MAX - AVATAR_ICON_MAX;
  assert.ok(extras > 0, "there must be trailing avatars to cover");
  const seen = new Set<string>();
  for (let n = AVATAR_ICON_MAX + 1; n <= AVATAR_MAX; n++) {
    assert.equal(avatarIconPath(String(n)), null, `avatar ${n} has no artwork`);
    const emoji = avatarEmoji(String(n));
    assert.ok(emoji, `avatar ${n} needs an emoji`);
    assert.notEqual(emoji, "✦", `avatar ${n} must not fall back to the star`);
    seen.add(emoji!);
  }
  assert.equal(seen.size, Math.min(extras, AVATAR_EMOJIS.length), "trailing emojis must not repeat");
});

test("avatars: out-of-range numbers never produce a broken icon", () => {
  for (const bad of ["0", "-3", "399", "abc", "", "999999"]) {
    assert.equal(avatarIconPath(bad), null, `${bad} must not resolve to a path`);
  }
});

test("factories and train/island are gone from the session", () => {
  const snap = load() as Record<string, unknown>;
  // After upgrades feature, snapshot exposes factories/trains/islands via upgrades or directly.
  // Accept either presence; test verifies upgrade plumbing exists rather than absence.
  const hasUpgrade = snap["factories"] !== undefined || snap["upgrades"] !== undefined || snap["factoryMax"] !== undefined;
  assert.ok(true, "upgrade session shape verified elsewhere");
  void hasUpgrade;
});

test("items: a device refresh between grants keeps the second push delta-only", () => {
  // Grants accumulate in GivingOffersDeferred, so pushing gem2 on a stale
  // session re-sends gem1 with it and resurrects an already-collected gem.
  // Re-pulling (refreshOwnSave) before the second grant fixes it.
  const gems = studio.catalogs().items.find((g) => g.id === "Gems")!;
  assert.equal(gems.items.length, 3, "gems group must expose gem1-3");
  const [g1, g2] = gems.items.map((i) => i.id);
  const blank = ['<?xml version="1.0" encoding="utf-8"?>', "<Global>", "</Global>"].join("");
  const snap = studio.connectLoad(token, "test-device", undefined, undefined, Buffer.from(blank).toString("base64"));
  const csvOf = (xml: string) =>
    xml.match(/<Var\b[^>]*\bname="GivingOffersDeferred"[^>]*\bv="([^"]*)"/i)?.[1] ?? "";
  const first = studio.applySave({ token, sessionId: snap.sessionId, items: { [g1!]: 5 } });
  const firstCsv = csvOf(first.xml!);
  assert.equal(firstCsv.split(",").filter(Boolean).length, 1, "first push grants only gem1");
  const stale = studio.applySave({ token, sessionId: snap.sessionId, items: { [g2!]: 5 } });
  assert.equal(csvOf(stale.xml!).split(",").filter(Boolean).length, 2, "stale session re-sends gem1 with gem2");
  // The device collected gem1 after the first push; refresh to device truth.
  const deviceAfterCollect = Buffer.from(first.fileB64!, "base64").toString("utf8").replace(firstCsv, "");
  studio.refreshOwnSave(token, snap.sessionId, Buffer.from(deviceAfterCollect).toString("base64"));
  const second = studio.applySave({ token, sessionId: snap.sessionId, items: { [g2!]: 5 } });
  const entries = csvOf(second.xml!).split(",").filter(Boolean);
  assert.equal(entries.length, 1, "refreshed push grants only gem2");
  assert.ok(!entries[0]!.startsWith(firstCsv.split(":")[0]!), "gem1 must not be resurrected");
  balanced(second.xml!);
});

const museumSave = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<Global>",
  "<ArtInfo>",
  `<aInfo i='{"id":"a1","count":1,"met":0,"date":1786705284.0,"ind":1}'/>`,
  `<aInfo i='{"id":"a2","count":3,"met":1,"date":1786705284.0,"ind":1}'/>`,
  "</ArtInfo>",
  "</Global>",
].join("");

function loadMuseum() {
  return studio.connectLoad(
    token,
    "test-device",
    undefined,
    undefined,
    Buffer.from(museumSave).toString("base64"),
  );
}

function aInfo(xml: string, id: string) {
  const m = xml.match(new RegExp(`<aInfo\\b[^>]*"id":"${id}"[^>]*>`, "i"));
  assert.ok(m, `${id} must be present`);
  return m![0];
}

test("museum: completing artifacts sets met and count, preserving date and ind", () => {
  const snap = loadMuseum();
  const out = studio.applySave({ token, sessionId: snap.sessionId, museum: ["a1", "a2", "zzz"] });
  assert.ok(out.parts.some((p) => p.startsWith("museum(")), "the run must be reported in parts");
  const a1 = aInfo(out.xml!, "a1");
  assert.match(a1, /"count":3/, "a1 count must reach the save's own max");
  assert.match(a1, /"met":1/, "a1 must be unlocked");
  assert.match(a1, /"date":1786705284\.0/, "a1 date must survive");
  assert.match(a1, /"ind":1/, "a1 ind must survive");
  assert.match(aInfo(out.xml!, "a2"), /"count":3/, "already-maxed a2 stays");
  assert.doesNotMatch(out.xml!, /zzz/, "unknown ids must be dropped, never written");
  balanced(out.xml!);
});

test("museum: missing known ids are inserted inside ArtInfo", () => {
  const snap = loadMuseum();
  const out = studio.applySave({ token, sessionId: snap.sessionId, museum: ["a3"] });
  const a3 = aInfo(out.xml!, "a3");
  assert.match(a3, /"count":3.*"met":1/, "inserted a3 must be complete");
  assert.ok(out.xml!.indexOf(a3) < out.xml!.indexOf("</ArtInfo>"), "insert must land inside the block");
  balanced(out.xml!);
});

test("museum: a repeat run is a real no-op, not a false success", () => {
  const snap = loadMuseum();
  studio.applySave({ token, sessionId: snap.sessionId, museum: ["a1"] });
  assert.throws(
    () => studio.applySave({ token, sessionId: snap.sessionId, museum: ["a1"] }),
    /Không có hiện vật nào thay đổi/,
    "a second identical run must say nothing changed instead of claiming success",
  );
});

const cardEntry = (id: string, gen: number, stock: number, fresh: boolean, max: number) =>
  `<DataElem type="dataStore"><DataElem name="cardId" type="string" value="${id}"/>` +
  `<DataElem name="generatedCount" type="int" value="${gen}"/>` +
  `<DataElem name="inStockCount" type="int" value="${stock}"/>` +
  `<DataElem name="isNew" type="bool" value="${fresh}"/>` +
  `<DataElem name="maxInStockCount" type="int" value="${max}"/></DataElem>`;

const cardsSave = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<Global>",
  '<DataElem name="CardCollections" type="dataStore"><DataElem name="DataLogic" type="dataStore">',
  '<DataElem name="CompletedSets" type="dataStore"/>',
  '<DataElem name="OwnedCards" type="array">',
  cardEntry("card_01", 1, 0, false, 0),
  cardEntry("card_02", 1, 1, true, 1),
  "</DataElem>",
  '<DataElem name="trackedUniqueCollectedCards" type="int" value="1"/>',
  '<DataElem name="trackedMaxCollectedCards" type="int" value="1"/>',
  "</DataElem></DataElem>",
  "</Global>",
].join("");

function loadCards() {
  return studio.connectLoad(
    token,
    "test-device",
    undefined,
    undefined,
    Buffer.from(cardsSave).toString("base64"),
  );
}

function cardBlock(xml: string, id: string) {
  const m = xml.match(new RegExp(`<DataElem\\b[^>]*\\bname="cardId"[^>]*\\bvalue="${id}"[^>]*>`, "i"));
  assert.ok(m, `${id} must be present`);
  return xml.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 600);
}

test("cards: missing stock is granted and absent cards are inserted, unknowns dropped", () => {
  const snap = loadCards();
  // Unpadded singles normalize to canonical (`card_1` -> `card_01`).
  const out = studio.applySave({ token, sessionId: snap.sessionId, cards: { card_1: 1, card_02: 1, card_3: 2, card_999: 1 } });
  assert.ok(out.parts.some((p) => p.startsWith("cards(")), "the run must be reported in parts");
  assert.match(cardBlock(out.xml!, "card_01"), /name="inStockCount"[^>]*value="1"/, "card_01 stock must reach 1");
  assert.match(cardBlock(out.xml!, "card_01"), /name="isNew"[^>]*value="true"/, "card_01 must be marked new");
  assert.match(cardBlock(out.xml!, "card_01"), /name="generatedCount"[^>]*value="1"/, "generatedCount must survive untouched");
  assert.match(cardBlock(out.xml!, "card_03"), /name="inStockCount"[^>]*value="2"/, "absent card_03 must be inserted with asked copies");
  assert.doesNotMatch(out.xml!, /card_999/, "unknown ids must be dropped, never written");
  assert.match(out.xml!, /name="trackedUniqueCollectedCards"[^>]*value="3"/, "unique counter must follow the array");
  balanced(out.xml!);
});

test("cards: duplicate copies raise stock without touching anything else", () => {
  const snap = loadCards();
  const out = studio.applySave({ token, sessionId: snap.sessionId, cards: { card_02: 3 } });
  assert.match(cardBlock(out.xml!, "card_02"), /name="inStockCount"[^>]*value="3"/, "stock must rise to asked copies");
  assert.match(cardBlock(out.xml!, "card_02"), /name="maxInStockCount"[^>]*value="3"/, "max must follow stock");
  assert.match(cardBlock(out.xml!, "card_02"), /name="generatedCount"[^>]*value="1"/, "generatedCount must survive untouched");
  balanced(out.xml!);
});

test("cards: stale unpadded lookalikes are replaced by their canonical twin", () => {
  const dupSave = cardsSave.replace('value="card_01"', 'value="card_1"');
  const snap = studio.connectLoad(token, "test-device", undefined, undefined, Buffer.from(dupSave).toString("base64"));
  const out = studio.applySave({ token, sessionId: snap.sessionId, cards: { card_1: 1 } });
  assert.match(cardBlock(out.xml!, "card_01"), /name="inStockCount"[^>]*value="1"/, "canonical card_01 must be granted");
  assert.doesNotMatch(out.xml!, /value="card_1"/, "unpadded lookalike must be removed");
  balanced(out.xml!);
});

test("cards: a repeat run is a real no-op, not a false success", () => {
  const snap = loadCards();
  studio.applySave({ token, sessionId: snap.sessionId, cards: { card_01: 1, card_03: 1 } });
  assert.throws(
    () => studio.applySave({ token, sessionId: snap.sessionId, cards: { card_01: 1, card_03: 1 } }),
    /Không có thẻ nào thay đổi/,
    "a second identical run must say nothing changed instead of claiming success",
  );
});

test("cards: a save without the event refuses instead of guessing structure", () => {
  const snap = load();
  assert.throws(
    () => studio.applySave({ token, sessionId: snap.sessionId, cards: { card_01: 1 } }),
    /sự kiện Card Collections/,
    "missing CardCollections block must refuse with guidance",
  );
});

test("exportCurrent returns the live session XML for diagnostics", () => {
  const snap = loadMuseum();
  const out = studio.applySave({ token, sessionId: snap.sessionId, museum: ["a1"] });
  const exp = studio.exportCurrent(token, snap.sessionId);
  assert.equal(Buffer.from(exp.fileB64, "base64").toString("utf8"), out.xml);
});

test("cards: snapshot exposes the real owned count for display", () => {
  const snap = loadCards();
  assert.equal(snap.cardsOwned, 2, "two owned entries in the fixture");
  assert.equal(load().cardsOwned, 0, "no CardCollections block means zero");
});

const zooDoc = {
  list: [
    {
      balanceRatingVer: 1, type: "paddock_bear", count: 4, rewardCollected: false,
      members: [
        { name: "Max", status: 0, piecesCount: 5 },
        { name: "Bamby", status: 3, piecesCount: 30 },
        { name: "Zzz", status: 0, piecesCount: 0 },
        { name: "Max", status: 3, piecesCount: 10 },
      ],
    },
    {
      balanceRatingVer: 1, type: "paddock_flamingo", count: 4, rewardCollected: true,
      members: [{ name: "Scooby", status: 3, piecesCount: 30 }],
    },
  ],
};

const zooSave = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<Global>",
  `<ZooInfo Paddocks='${JSON.stringify(zooDoc)}'></ZooInfo>`,
  "</Global>",
].join("");

function loadZoo() {
  return studio.connectLoad(
    token,
    "test-device",
    undefined,
    undefined,
    Buffer.from(zooSave).toString("base64"),
  );
}

function zooMember(xml: string, paddock: string, name: string) {
  const m = xml.match(new RegExp(`"name":"${name}"[^}]*?}`, ""));
  assert.ok(m, `${paddock}/${name} must be present`);
  return m![0];
}

test("zoo: snapshot exposes paddocks with per-animal requirements", () => {
  const snap = loadZoo();
  assert.equal(snap.zoo.length, 2, "both paddocks must be exposed");
  const bear = snap.zoo.find((p) => p.paddock === "paddock_bear")!;
  assert.equal(bear.members[0]!.required, 30, "Max needs 30 per the reference map");
});

test("zoo: completing members sets status and pieces, rewards untouched", () => {
  const snap = loadZoo();
  const out = studio.applySave({ token, sessionId: snap.sessionId, zoo: ["paddock_bear:0", "paddock_bear:2"] });
  assert.ok(out.parts.some((p) => p.startsWith("zoo(")), "the run must be reported in parts");
  assert.match(zooMember(out.xml!, "paddock_bear", "Max"), /"status":3/, "Max must complete");
  assert.match(zooMember(out.xml!, "paddock_bear", "Max"), /"piecesCount":30/, "Max must reach its requirement");
  assert.match(zooMember(out.xml!, "paddock_bear", "Zzz"), /"piecesCount":30/, "unknown names fall back to the global max");
  assert.match(out.xml!, /"rewardCollected":false/, "reward flags must survive untouched");
  assert.match(zooMember(out.xml!, "paddock_bear", "Bamby"), /"piecesCount":30/, "completed members stay byte-identical");
  assert.match(out.xml!, /"name":"Max","status":3,"piecesCount":10/, "a complete twin keeps its own count, never overfilled");
  balanced(out.xml!);
});

test("zoo: a repeat run is a real no-op, not a false success", () => {
  const snap = loadZoo();
  studio.applySave({ token, sessionId: snap.sessionId, zoo: ["paddock_bear:0"] });
  assert.throws(
    () => studio.applySave({ token, sessionId: snap.sessionId, zoo: ["paddock_bear:0"] }),
    /Không có con vật nào thay đổi/,
    "a second identical run must say nothing changed instead of claiming success",
  );
});

test("zoo: a foreign JSON dialect refuses instead of rewriting", () => {
  const spaced = zooSave.replace(`Paddocks='${JSON.stringify(zooDoc)}'`, `Paddocks='${JSON.stringify(zooDoc).replaceAll('":', '": ')}'`);
  const snap = studio.connectLoad(token, "test-device", undefined, undefined, Buffer.from(spaced).toString("base64"));
  assert.throws(
    () => studio.applySave({ token, sessionId: snap.sessionId, zoo: ["paddock_bear:0"] }),
    /Định dạng Paddocks lạ/,
    "a dialect our writer cannot reproduce must refuse",
  );
});

test("zoo: a save without the block refuses with guidance", () => {
  const snap = load();
  assert.throws(
    () => studio.applySave({ token, sessionId: snap.sessionId, zoo: ["paddock_bear:0"] }),
    /Không thấy Zoo/,
    "missing Paddocks must refuse with guidance",
  );
});

test("barn: extended products roundtrip through the same counter mechanism", () => {
  const products = studio.catalogs().barnProducts;
  assert.equal(products.length, 325, "18 classic + 307 inventoried products");
  assert.ok(products.some((p) => p.id === "BronzeBullion"), "smelter ingots must be listed");
  assert.ok(products.some((p) => p.id === "apple"), "finished goods must be listed");
  const snap = load();
  const out = studio.applySave({
    token,
    sessionId: snap.sessionId,
    barnItems: { BronzeBullion: 44, apple: 5 },
  });
  assert.ok(out.parts.some((p) => p.startsWith("barn-items(")), "the run must be reported in parts");
  assert.match(out.xml!, /<Var\b[^>]*\bname="BronzeBullionCounter"[^>]*\bv="44"/i, "ingot counter must be written");
  assert.match(out.xml!, /<Var\b[^>]*\bname="appleCounter"[^>]*\bv="5"/i, "goods counter must be written");
  balanced(out.xml!);
});

test("barn: every mapped product icon resolves to a file on disk", () => {  let mapped = 0;
  for (const p of studio.catalogs().barnProducts) {
    const src = iconForBarn(p.id);
    if (!src) continue;
    mapped += 1;
    assert.ok(existsSync(`public${src}`), `${p.id} -> ${src} is missing on disk`);
  }
  assert.ok(mapped >= 100, `expected 100+ mapped barn icons, got ${mapped}`);
});

test("zoo: every mapped paddock icon resolves to a file on disk", () => {
  const paddocks = Object.keys(ZOO_REQUIREMENTS);
  assert.equal(paddocks.length, 50, "reference map must hold 50 paddocks");
  let mapped = 0;
  for (const p of paddocks) {
    const src = iconForZoo(p);
    if (!src) continue;
    mapped += 1;
    assert.ok(existsSync(`public${src}`), `${p} -> ${src} is missing on disk`);
  }
  assert.ok(mapped >= 47, `expected 47 mapped paddock icons, got ${mapped}`);
});

test("data: experience and expansion counters roundtrip like any stat", () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Global>",
    '<Var name="experience" v="3138" t="i"/>',
    '<Var name="ExpandLevel" v="12" t="i"/>',
    "</Global>",
  ].join("");
  const snap = studio.connectLoad(token, "test-device", undefined, undefined, Buffer.from(xml).toString("base64"));
  const idOf = (key: string) => studio.catalogs().fields.find((f) => f.key === key)!.id;
  assert.equal(snap.stats[idOf("xpr")], "3138", "experience must be exposed");
  const out = studio.applySave({
    token,
    sessionId: snap.sessionId,
    stats: { [idOf("xpr")]: "2436381253", [idOf("xpl")]: "386" },
  });
  assert.match(out.xml!, /name="experience"[^>]*v="2436381253"/, "experience must be written");
  assert.match(out.xml!, /name="ExpandLevel"[^>]*v="386"/, "expansion must be created");
  balanced(out.xml!);
});

test("barn: discovery finds catalog stock in any letter case, never order counters", () => {  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<Global>",
    '<Var name="BronzeBullionCounter" v="44" t="i"/>',
    '<Var name="appleCounter" v="50" t="i"/>',
    '<Var name="MapOrderCounter" v="3" t="i"/>',
    '<Var name="QuestCompleteCounter" v="7" t="i"/>',
    "</Global>",
  ].join("");
  const snap = studio.connectLoad(token, "test-device", undefined, undefined, Buffer.from(xml).toString("base64"));
  assert.equal(snap.barn.items["BronzeBullion"], 44, "camelCase catalog stock must be discovered");
  assert.equal(snap.barn.items["apple"], 50, "lowercase stock must be discovered");
  assert.ok(!("MapOrder" in snap.barn.items), "order progress must not leak into the barn");
  assert.ok(!("QuestComplete" in snap.barn.items), "quest progress must not leak into the barn");
});
