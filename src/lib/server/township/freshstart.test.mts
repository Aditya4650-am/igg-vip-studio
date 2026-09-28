import { strict as assert } from "node:assert";
import { test } from "node:test";
import { encryptStream } from "./crypto.server.ts";

import {
  backupFreshStartState,
  restoreFreshStartState,
  verifyFreshStartState,
  wipeFreshStartPlan,
  type FreshSession,
} from "./freshstart.server.ts";

const CITY = (id: string, level: number) =>
  `<root><Global><AWS cityId="${id}"/><Var name="levelup" v="${level}" t="i"/></Global></root>`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function backedUp(over: Record<string, unknown> = {}) {
  const s: FreshSession = { id: "s1" };
  const r = backupFreshStartState(s, {
    serial: "emulator-5554",
    cityPath: "/data/data/pkg/saves/mGameInfo.xml",
    localPath: "/data/data/pkg/files/mLocalInfo.xml",
    cityB64: b64(CITY("city-old-1", 42)),
    localB64: b64("<root><Global/></root>"),
    androidId: "aaaaaaaaaaaaaaaa",
    ...over,
  } as never);
  return { s, r };
}

test("backup records city id, level, and device id", () => {
  const { s, r } = backedUp();
  assert.equal(r.oldCityId, "city-old-1");
  assert.equal(r.oldLevel, 42);
  assert.equal(s.freshBackupMeta?.oldAndroidId, "aaaaaaaaaaaaaaaa");
  assert.deepEqual(s.freshBackupMeta?.extraPaths, []);
});

test("backup rejects shell-error text and id-less saves", () => {
  const s: FreshSession = { id: "s1" };
  assert.throws(
    () =>
      backupFreshStartState(s, {
        serial: "emulator-5554",
        cityPath: "/a.xml",
        localPath: "/b.xml",
        cityB64: b64("cat: /a.xml: No such file"),
        localB64: b64("<x/>"),
      }),
    /not a save file/,
  );
  assert.throws(
    () =>
      backupFreshStartState(s, {
        serial: "emulator-5554",
        cityPath: "/a.xml",
        localPath: "/b.xml",
        cityB64: b64("<root><Global/></root>"),
        localB64: b64("<x/>"),
      }),
    /no city id/,
  );
});

test("backup accepts shared_prefs XML and SQLite extras, rejects junk", () => {
  const s: FreshSession = { id: "s1" };
  const r = backupFreshStartState(s, {
    serial: "emulator-5554",
    cityPath: "/a.xml",
    localPath: "/b.xml",
    cityB64: b64(CITY("c1", 5)),
    localB64: b64("<x/>"),
    extraFiles: [
      { path: "/prefs/a.xml", b64: b64("<map><string name=\"k\">v</string></map>") },
      { path: "/db/b.db", b64: Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(100)]).toString("base64") },
    ],
  });
  assert.equal(r.extraCount, 2);
  assert.throws(
    () =>
      backupFreshStartState({ id: "s2" }, {
        serial: "emulator-5554",
        cityPath: "/a.xml",
        localPath: "/b.xml",
        cityB64: b64(CITY("c1", 5)),
        localB64: b64("<x/>"),
        extraFiles: [{ path: "/prefs/a.xml", b64: b64("Permission denied") }],
      }),
    /not a save file/,
  );
});

test("wipe plan covers every tracked path", () => {
  const { s } = backedUp({
    extraFiles: [{ path: "/prefs/a.xml", b64: b64("<map/>") }],
  } as never);
  const plan = wipeFreshStartPlan(s);
  assert.deepEqual(plan.paths, [
    "/data/data/pkg/saves/mGameInfo.xml",
    "/data/data/pkg/files/mLocalInfo.xml",
    "/prefs/a.xml",
  ]);
});

test("verify accepts a genuinely new level-1 city with a new device id", () => {
  const { s } = backedUp();
  const r = verifyFreshStartState(s, { cityB64: b64(CITY("city-new-9", 1)), androidId: "bbbbbbbbbbbbbbbb" });
  assert.equal(r.newCityId, "city-new-9");
  assert.equal(r.androidReset, true);
  assert.equal(r.clean, true);
});

test("verify rejects same city, wrong level, and unchanged device id", () => {
  const { s } = backedUp();
  assert.throws(
    () => verifyFreshStartState(s, { cityB64: b64(CITY("city-old-1", 1)), androidId: "bbbbbbbbbbbbbbbb" }),
    /Same city/,
  );
  assert.throws(
    () => verifyFreshStartState(s, { cityB64: b64(CITY("city-new-9", 7)), androidId: "bbbbbbbbbbbbbbbb" }),
    /Not level 1/,
  );
  assert.throws(
    () => verifyFreshStartState(s, { cityB64: b64(CITY("city-new-9", 1)), androidId: "aaaaaaaaaaaaaaaa" }),
    /Same Android ID/,
  );
});

test("restore returns every backed-up blob with its path", () => {
  const { s } = backedUp({
    extraFiles: [{ path: "/prefs/a.xml", b64: b64("<map/>") }],
  } as never);
  const r = restoreFreshStartState(s);
  assert.equal(r.cityPath, "/data/data/pkg/saves/mGameInfo.xml");
  assert.equal(r.localPath, "/data/data/pkg/files/mLocalInfo.xml");
  assert.deepEqual(Object.keys(r.extra), ["/prefs/a.xml"]);
  assert.ok(r.cityB64.length > 0 && r.localB64.length > 0);
});

test("backup accepts a container-wrapped city like the device stores", () => {
  const wrapped = encryptStream(
    Buffer.from(CITY("city-wrap-7", 12), "utf8"),
    Buffer.from([0x79, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
  ).toString("base64");
  const s: FreshSession = { id: "s1" };
  const r = backupFreshStartState(s, {
    serial: "emulator-5554",
    cityPath: "/data/data/pkg/saves/mGameInfo.xml",
    localPath: "/data/data/pkg/files/mLocalInfo.xml",
    cityB64: wrapped,
    localB64: b64("<root><Global/></root>"),
    androidId: "aaaaaaaaaaaaaaaa",
  });
  assert.equal(r.oldCityId, "city-wrap-7");
  assert.equal(r.oldLevel, 12);
});

test("backup rejects adb shell error text, not just non-XML", () => {
  const s: FreshSession = { id: "s1" };
  assert.throws(
    () =>
      backupFreshStartState(s, {
        serial: "emulator-5554",
        cityPath: "/data/data/pkg/saves/mGameInfo.xml",
        localPath: "/data/data/pkg/files/mLocalInfo.xml",
        cityB64: b64("cat: /data/data/pkg/saves/mGameInfo.xml: No such file or directory\n"),
        localB64: b64("<root><Global/></root>"),
      }),
    /not a save file/,
  );
});

test("plan and verify require a backup first", () => {
  const s: FreshSession = { id: "empty" };
  assert.throws(() => wipeFreshStartPlan(s), /Backup first/);
  assert.throws(() => verifyFreshStartState(s, { cityB64: b64(CITY("x", 1)) }), /Backup first/);
  assert.throws(() => restoreFreshStartState(s), /Backup first/);
});
