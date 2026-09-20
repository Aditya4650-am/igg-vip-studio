import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.IGG_VIP_MASTER = "test-master-key-with-enough-length";
process.env.IGG_VIP_OWNER = "IGG-OWNER-TESTKEY";
process.env.IGG_VIP_URL = "";

const studio = await import("./server/studio.server.ts");
const { verifyLicenseKey } = await import("./server/license.server.ts");
const { findUnbalancedTag } = await import("./server/township/xml-edit.server.ts");

const crdId = studio.catalogs().fields.find((f) => f.key === "crd")!.id;
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

function cardsValue(xml: string) {
  return xml.match(/<Var name="FullCardCollections"\s+v="([^"]*)"/)?.[1] ?? "";
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

test("cards: mine is written back and the friend counter is surfaced", () => {
  const { sessionId } = load();
  assert.equal(cardsValue(ownSave), "2");

  const withFriend = studio.attachFriendXml(token, sessionId, friendSave);
  assert.equal(withFriend.friendCards, "7");

  const saved = studio.applySave({ token, sessionId, stats: { [crdId]: "250" } });
  assert.ok(saved.parts.includes("stats"));
  balanced(saved.xml);
  assert.equal(cardsValue(saved.xml), "250");
  assert.equal(saved.stats[crdId], "250");
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
  if (err !== null) {
    assert.doesNotMatch(err, /version|FVer|LocalInfo/i, "version guard must no longer block FetchCity");
  }
});