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
const { readdirSync } = await import("node:fs");

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
  // The feature was removed: it wrote a counter the game does not honour, so
  // it reported success while changing nothing. Guard the removal at the
  // catalogue level (what the UI renders) and the session level (what the
  // friend flow returns), so it cannot quietly come back.
  assert.equal(studio.catalogs().fields.find((f) => f.key === "crd"), undefined);

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
  assert.equal(snap["factories"], undefined, "snapshot must not expose factories");
  assert.equal(snap["factoryMax"], undefined, "snapshot must not expose factoryMax");
  assert.equal(snap["trains"], undefined, "snapshot must not expose trains");
  assert.equal(snap["trainMax"], undefined, "snapshot must not expose trainMax");
  assert.equal(snap["islands"], undefined, "snapshot must not expose islands");
  assert.equal(snap["islandMax"], undefined, "snapshot must not expose islandMax");
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
  cardEntry("card_1", 1, 0, false, 0),
  cardEntry("card_2", 1, 1, true, 1),
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
  const out = studio.applySave({ token, sessionId: snap.sessionId, cards: ["card_1", "card_2", "card_3", "card_999"] });
  assert.ok(out.parts.some((p) => p.startsWith("cards(")), "the run must be reported in parts");
  assert.match(cardBlock(out.xml!, "card_1"), /name="inStockCount"[^>]*value="1"/, "card_1 stock must reach 1");
  assert.match(cardBlock(out.xml!, "card_1"), /name="isNew"[^>]*value="true"/, "card_1 must be marked new");
  assert.match(cardBlock(out.xml!, "card_1"), /name="generatedCount"[^>]*value="1"/, "generatedCount must survive untouched");
  assert.match(cardBlock(out.xml!, "card_3"), /name="inStockCount"[^>]*value="1"/, "absent card_3 must be inserted owned");
  assert.doesNotMatch(out.xml!, /card_999/, "unknown ids must be dropped, never written");
  assert.match(out.xml!, /name="trackedUniqueCollectedCards"[^>]*value="3"/, "unique counter must follow the array");
  balanced(out.xml!);
});

test("cards: a repeat run is a real no-op, not a false success", () => {
  const snap = loadCards();
  studio.applySave({ token, sessionId: snap.sessionId, cards: ["card_1", "card_3"] });
  assert.throws(
    () => studio.applySave({ token, sessionId: snap.sessionId, cards: ["card_1", "card_3"] }),
    /Không có thẻ nào thay đổi/,
    "a second identical run must say nothing changed instead of claiming success",
  );
});

test("cards: a save without the event refuses instead of guessing structure", () => {
  const snap = load();
  assert.throws(
    () => studio.applySave({ token, sessionId: snap.sessionId, cards: ["card_1"] }),
    /sự kiện Card Collections/,
    "missing CardCollections block must refuse with guidance",
  );
});
