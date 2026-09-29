import { strict as assert } from "node:assert";
import { test } from "node:test";

import { injectAvatars, injectRegata, injectSeason, inspectRegatta, REGATTA_MAX_TASKS } from "./inject.server.ts";
import { maxBuildingsStash, maxFragments, parseOwnMeta, unlockEmoji } from "./desban.server.ts";
import { applyStatChanges, parseStats, writeVar } from "./vars.server.ts";
import { attrValue, findUnbalancedTag, insertInsideRoot, replaceElement } from "./xml-edit.server.ts";

const wellFormed = (xml: string) => assert.equal(findUnbalancedTag(xml), null, `expected balanced XML, got: ${xml}`);

test("writeVar inserts inside the root with correct type (t=i for numeric, t=s for non-numeric)", () => {
  const out = writeVar("<Global><Var name='a' v='1'/></Global>", "NewVar", "hello");
  wellFormed(out);
  assert.match(out, /<Var name="NewVar" v="hello" t="s"\/>/);
  assert.ok(out.indexOf("NewVar") < out.indexOf("</Global>"), "insert must be inside the root");

  const numeric = writeVar("<Global/>", "N", "42");
  assert.match(numeric, /t="i"/);
});

test("season rewrites a paired SeasonTicket without leaving a stray closer", () => {
  const paired = injectSeason('<Global><SeasonTicket premium="0" score="0"></SeasonTicket></Global>');
  wellFormed(paired);
  assert.match(paired, /premium="1"/);
  assert.match(paired, /score="1002"/);

  const children = injectSeason(
    '<Global><SeasonTicket premium="0" score="0"><Reward id="1"/><Reward id="2"/></SeasonTicket></Global>',
  );
  wellFormed(children);
  assert.match(children, /<Reward id="1"\/>/);
  assert.match(children, /<Reward id="2"\/>/);
});

test("season upserts the element when the save has none", () => {
  const out = injectSeason('<Global><AWS cityId="c1"/></Global>');
  wellFormed(out);
  assert.match(out, /<SeasonTicket premium="1" score="1002"\/>/);
  assert.ok(out.indexOf("SeasonTicket") < out.indexOf("</Global>"));
});

// A regatta window straddling "now" plus the one real completed record this
// save owns. Everything the injector writes has to be derivable from it.
function liveRegattaSave(opts: { user?: string; life?: number | null; hasTask?: boolean } = {}) {
  const { user = "MECITY1", life = null, hasTask = true } = opts;
  const now = Math.floor(Date.now() / 1000);
  const start = now - 4 * 86400;
  const end = now + 4 * 86400;
  const lifeVar = life === null ? "" : `<Var name="RegataTasksCompleted" v="${life}" t="i"/>`;
  const task = hasTask
    ? `<MyOldTask id="match3_bomb_999" type="event_order" eventType="Match3" target="create_bonus_bomb" ` +
      `need="100" have="100" user="${user}" num="4" ver="1" takenCounter="1" score="135" ` +
      `takeTime="${start + 300}" completeTime="${start + 900}" endTime="${start + 1000}" ` +
      `realEndTime="${start + 1000}" regataCash="17" anlNumber="1" anlLimit="10"/>`
    : "";
  return (
    `<Global>${lifeVar}<Var name="cityId" v="${user}" t="s"/>` +
    `<Regata id="507" startTime="${start}" endTime="${end}" score="135" scoreUpd="${start + 900}">` +
    `<FreeTask id="match3_bomb_999" num="4" ver="1"/>${task}</Regata></Global>`
  );
}

test("regata clones a real record field for field instead of inventing one", () => {
  const out = injectRegata(liveRegattaSave(), 4);
  wellFormed(out);

  const tasks = [...out.matchAll(/<MyOldTask\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(tasks.length, 4, "the save's own record plus three added");

  // An id the game never issued is the easiest thing for it to reject, so
  // nothing may be invented: every id must be one this save already holds.
  const ids = [...new Set(tasks.map((t) => attrValue(t, "id")))];
  assert.deepEqual(ids, ["match3_bomb_999"]);

  // Every field a real record carries survives on every copy.
  for (const t of tasks) {
    for (const f of ["type", "eventType", "target", "need", "have", "user", "num", "ver", "score", "regataCash", "anlLimit"]) {
      assert.notEqual(attrValue(t, f), null, `${f} must not be dropped: ${t}`);
    }
  }
  assert.ok(out.indexOf("</Regata>") < out.indexOf("</Global>"), "tasks must stay inside the root");
});

test("regata timestamps sit inside the window, in the past and strictly ordered", () => {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 4 * 86400;
  const end = now + 4 * 86400;
  const out = injectRegata(liveRegattaSave(), 12);
  const completions = new Set<number>();
  for (const m of out.matchAll(/<MyOldTask\b[^>]*>/g)) {
    const t = m[0];
    const take = Number(attrValue(t, "takeTime"));
    const complete = Number(attrValue(t, "completeTime"));
    const real = Number(attrValue(t, "realEndTime"));
    assert.ok(take >= start && real <= end, `outside the regatta window: ${t}`);
    assert.ok(real < now, `dated in the future: ${t}`);
    assert.ok(take < complete && complete < real, `takeTime < completeTime < endTime broken: ${t}`);
    assert.equal(attrValue(t, "endTime"), attrValue(t, "realEndTime"), `endTime/realEndTime disagree: ${t}`);
    completions.add(complete);
  }
  assert.equal(completions.size, 12, "each task needs its own completion time, not one shared stamp");
});

test("regata raises the lifetime counter instead of rewinding it", () => {
  // The save already reports 2315 completions. Writing the batch size over it
  // would move a lifetime stat backwards, which a server can read for free.
  const out = injectRegata(liveRegattaSave({ life: 2315 }), 12);
  const tag = out.match(/<Var\b[^>]*name="RegataTasksCompleted"[^>]*>/)![0];
  assert.equal(Number(attrValue(tag, "v")), 2315 + 11, "the batch adds to the count already recorded");

  // A save that never tracked it must not gain a fabricated one.
  const none = injectRegata(liveRegattaSave(), 3);
  assert.ok(!none.includes("RegataTasksCompleted"), "do not invent a counter the save never had");
});

test("regata numbers new records above the block's own highest", () => {
  // A real save numbers a block's `MyOldTask` list 2,3,…,n in document order
  // (measured on a genuine archived week), so a batch appended after them has
  // to continue from n. Taking the base from the template's own row re-issues
  // numbers the block already holds — …3,4 then 1,2 — which reads as the
  // counter going backwards. The counter is per regatta, so only this block
  // counts; the archive next door starts over at 2 each week.
  const now = Math.floor(Date.now() / 1000);
  const start = now - 4 * 86400;
  const rec = (tc: number, age: number) =>
    `<MyOldTask id="match3_bomb_999" type="event_order" eventType="Match3" target="create_bonus_bomb" ` +
    `need="100" have="100" user="MECITY1" num="4" ver="1" takenCounter="${tc}" score="135" ` +
    `takeTime="${start + age}" completeTime="${start + age + 60}" endTime="${start + age + 120}" ` +
    `realEndTime="${start + age + 120}" regataCash="17" anlNumber="1" anlLimit="10"/>`;

  // This week is already three tasks in: numbered 1, 3 and 4. The template
  // the injector picks is the first row (takenCounter 1).
  const xml = liveRegattaSave().replace("</Regata>", `${rec(3, 1500)}${rec(4, 2400)}</Regata>`);

  const out = injectRegata(xml, 6); // three already there, so three are added
  const counters = [...out.matchAll(/<MyOldTask\b[^>]*>/g)].map((m) => Number(attrValue(m[0], "takenCounter")));
  assert.deepEqual(counters, [1, 3, 4, 5, 6, 7], `take counter must keep growing: ${counters.join(",")}`);
  for (let i = 1; i < counters.length; i++) {
    assert.ok(counters[i]! > counters[i - 1]!, `take counter went backwards at ${i}: ${counters.join(",")}`);
  }
});

test("regata writes into a self-closing block instead of appending a rival one", () => {
  // Fresh saves ship <Regata .../>. Appending a second block would leave the
  // game reading whichever came first, so the batch would silently do nothing.
  const now = Math.floor(Date.now() / 1000);
  const start = now - 4 * 86400;
  const end = now + 4 * 86400;
  const tpl =
    `<MyOldTask id="trains_3" type="trains" user="MECITY1" num="1" ver="1" score="100" ` +
    `takeTime="${start + 300}" completeTime="${start + 900}" endTime="${start + 1000}" ` +
    `realEndTime="${start + 1000}"/>`;
  const xml =
    `<Global><PrevRegata>${tpl}</PrevRegata>` +
    `<Regata id="507" startTime="${start}" endTime="${end}" score="100" scoreUpd="${start + 900}"/></Global>`;

  const out = injectRegata(xml, 3);
  wellFormed(out);
  assert.equal((out.match(/<Regata\b/g) ?? []).length, 1, "exactly one regatta block may exist");
  const inner = out.match(/<Regata\b[^>]*>([\s\S]*?)<\/Regata\s*>/)![1];
  assert.equal((inner.match(/<MyOldTask\b/g) ?? []).length, 3, "the new tasks land inside the block");
  assert.ok(out.indexOf("</Regata>") < out.indexOf("</Global>"), "block must stay inside the root");
});

test("regata refuses a save that is not in a regatta", () => {
  const none = '<Global><AWS cityId="c1"/></Global>';
  assert.equal(inspectRegatta(none).reason, "no_active_regatta");
  assert.throws(() => injectRegata(none, 2), /regatta/i);

  // A finished week is not a live one. Writing completions into a window the
  // server has already closed is exactly what it checks on upload.
  const now = Math.floor(Date.now() / 1000);
  const done = liveRegattaSave().replace(
    /startTime="\d+" endTime="\d+"/,
    `startTime="${now - 40 * 86400}" endTime="${now - 30 * 86400}"`,
  );
  assert.equal(inspectRegatta(done).reason, "no_active_regatta");
  assert.throws(() => injectRegata(done, 5), /regatta/i);
});

test("regata refuses when there is no real record to copy from", () => {
  const bare = liveRegattaSave({ hasTask: false });
  assert.equal(inspectRegatta(bare).reason, "no_template");
  // Inventing every field of a task the game never saw is how the old
  // injector produced records the loader discarded without a word.
  assert.throws(() => injectRegata(bare, 5), /regatta/i);
});

test("regata refuses a batch the window cannot hold", () => {
  const now = Math.floor(Date.now() / 1000);
  const justOpened = liveRegattaSave().replace(
    /startTime="\d+" endTime="\d+"/,
    `startTime="${now - 120}" endTime="${now + 7 * 86400}"`,
  );
  assert.equal(inspectRegatta(justOpened).reason, "window_closed");
  assert.throws(() => injectRegata(justOpened, 12), /regatta/i);
});

test("regata never tops a save up past its own ceiling", () => {
  const full = liveRegattaSave();
  // Already holds one task: asking for one more than that is a no-op, and a
  // no-op must be refused rather than reported as success.
  assert.equal(inspectRegatta(full, 1).reason, "already_full");
  assert.throws(() => injectRegata(full, 1), /regatta/i);

  const out = injectRegata(full, 999);
  assert.equal((out.match(/<MyOldTask\b/g) ?? []).length, REGATTA_MAX_TASKS, "the batch must stay at the ceiling");
  assert.equal(inspectRegatta(out).reason, "already_full");
});

test("building stash handles paired Building elements", () => {
  const paired = maxBuildingsStash(
    '<Global><BuildingsStash><Building id="A" count="2"></Building></BuildingsStash></Global>',
    ["A"],
    10,
  );
  wellFormed(paired);
  assert.match(paired, /<Building id="A" count="10"\/>/);
  assert.ok(!paired.includes("</Building>"), "paired element must be fully replaced");

  const created = maxBuildingsStash("<Global><AWS/></Global>", ["A"], 7);
  wellFormed(created);
  assert.ok(created.indexOf("</BuildingsStash>") < created.indexOf("</Global>"));
});

test("insertInsideRoot keeps fragments inside the document root", () => {
  wellFormed(insertInsideRoot("<Global><a/></Global>", "<b/>"));
  const fragment = insertInsideRoot('<?xml version="1.0"?><Root><a/></Root>', "<b/>");
  assert.match(fragment, /<b\/><\/Root>/);
});

test("replaceElement swaps paired elements with children", () => {
  const out = replaceElement("<Global><Skins><type id='Train'/></Skins></Global>", "Skins", "<Skins/>");
  assert.equal(out, "<Global><Skins/></Global>");
});

test("fragments activation treats zero and false as inactive", () => {
  assert.match(maxFragments('<Global><FragmentedBeautyManager><Item active="0"/></FragmentedBeautyManager></Global>'), /active="1"/);
  assert.match(maxFragments('<Global><FragmentedBeautyManager><Item active="false"/></FragmentedBeautyManager></Global>'), /active="1"/);
  assert.ok(!maxFragments('<Global><FragmentedBeautyManager><Item active="1"/></FragmentedBeautyManager></Global>').includes('active="0"'));
});

test("unlockEmoji merges with the delimiters the game expects", () => {
  const out = unlockEmoji('<Global><Var name="UnlockedChatEmoji" v=",st1,,"/></Global>', ["st2"]);
  wellFormed(out);
  assert.match(out, /v=",st1,,st2,,"/);
});

test("parseOwnMeta reads FVer regardless of attribute order", () => {
  assert.deepEqual(parseOwnMeta('<Global><Version FVer="3510" version="35.1.0"/></Global>'), {
    cityId: "",
    bver: "35.1.0",
    fver: "3510",
  });
  assert.equal(parseOwnMeta("<Global><Version version='35.1.0' FVer='3510'/></Global>").fver, "3510");
  assert.equal(parseOwnMeta("<Global><Version version='35.1.0' FVer='3510'></Version></Global>").fver, "3510");
});

test("stat aliases round-trip without duplicating", () => {
  // Uses a surviving alias pair: the card counter this test originally covered
  // was removed with the card-collections feature.
  const aliased = '<Global><Var name="RegattaTasksCompleted" v="4"/></Global>';
  assert.equal(parseStats(aliased).reg, "4");
  const written = applyStatChanges(aliased, { reg: "9" });
  wellFormed(written);
  assert.equal(parseStats(written).reg, "9");
  assert.ok(!written.includes("RegataTasksCompleted"), "must not add a duplicate alias");

  const canonical = '<Global><Var name="RegataTasksCompleted" v="3"/></Global>';
  assert.equal(parseStats(applyStatChanges(canonical, { reg: "7" })).reg, "7");
});

test("insertInsideRoot lands inside <Global>, not in the dead strip before </root>", () => {
  const doc = "<root><Global><a/></Global><GameInfoPatcher/></root>";
  const out = insertInsideRoot(doc, "<b/>");
  wellFormed(out);
  assert.ok(out.indexOf("<b/>") < out.indexOf("</Global>"), "fragment must sit before </Global>");
  assert.ok(out.indexOf("</Global>") < out.indexOf("</root>"), "closers must keep their order");
});

test("injectAvatars creates the var inside <Global> where the game reads it", () => {
  const doc = '<root><Global><Var name="Unlocked_ava1" v="1" t="b"/></Global><GameInfoPatcher/></root>';
  const out = injectAvatars(doc, ["2"]);
  wellFormed(out);
  assert.match(out, /<Var name="Unlocked_ava2" v="1" t="b"\/>/);
  assert.ok(out.indexOf("Unlocked_ava2") < out.indexOf("</Global>"), "new avatar var must sit before </Global>");
});

test("injectAvatars rescues a stale copy stranded outside <Global>", () => {
  const doc = '<root><Global><a/></Global><Var name="Unlocked_ava2" v="1" t="b"/><GameInfoPatcher/></root>';
  const out = injectAvatars(doc, ["2"]);
  wellFormed(out);
  const at = out.indexOf("Unlocked_ava2");
  assert.ok(at >= 0 && at < out.indexOf("</Global>"), "avatar var must end up inside <Global>");
  assert.equal(out.indexOf("Unlocked_ava2", out.indexOf("</Global>")), -1, "no copy may remain past </Global>");
});

test("findUnbalancedTag flags corruption the old injectors produced", () => {
  assert.ok(findUnbalancedTag("<Global><SeasonTicket/></SeasonTicket></Global>"));
  assert.ok(findUnbalancedTag("<Global><a></Global>"));
  assert.equal(findUnbalancedTag('<?xml version="1.0"?><Global><a b="&lt;"/><!-- x --></Global>'), null);
});