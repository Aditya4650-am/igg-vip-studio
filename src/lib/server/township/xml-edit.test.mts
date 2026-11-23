import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assertRegattaSafe,
  injectAvatars,
  injectRegata,
  injectSeason,
  inspectRegatta,
  REGATTA_MAX_TASKS,
  regattaTaskIsMeasured,
} from "./inject.server.ts";
import {
  REGATTA_MAX_PER_DAY,
  REGATTA_MIN_GAP,
  regattaDayCap,
  regattaDensityGap,
  regattaMinGap,
  regattaWant,
} from "../../regatta.ts";
import { maxBuildingsStash, maxFragments, parseOwnMeta, unlockEmoji } from "./desban.server.ts";
import { applyStatChanges, parseStats, writeVar } from "./vars.server.ts";
import { attrValue, findUnbalancedTag, insertInsideRoot, replaceElement } from "./xml-edit.server.ts";

const wellFormed = (xml: string) => assert.equal(findUnbalancedTag(xml), null, `expected balanced XML, got: ${xml}`);

test("writeVar inserts inside the root with the game's own type attributes", () => {
  // The game writes a string with **no** `t` at all. The same var,
  // `tutorial_finished_step`, carries no `t` in 14 of the 15 saves we hold;
  // the single `t="s"` sits in a file this tool exported, so `t="s"` was our
  // fingerprint rather than the game's. A var we create must look like one the
  // game created.
  const out = writeVar("<Global><Var name='a' v='1'/></Global>", "NewVar", "hello");
  wellFormed(out);
  const created = /<Var name="NewVar"[^>]*>/.exec(out)![0];
  assert.match(created, /v="hello"/);
  assert.equal(/\bt="/.test(created), false, "a string var carries no t");
  assert.ok(out.indexOf("NewVar") < out.indexOf("</Global>"), "insert must be inside the root");

  const numeric = writeVar("<Global/>", "N", "42");
  assert.match(numeric, /t="i"/);

  const flag = writeVar("<Global/>", "Unlocked_ava12", "0");
  assert.match(flag, /t="b"/, "an avatar var stays a flag even at v=\"0\"");
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

test("season refuses to invent a ticket the save does not have", () => {
  // No SeasonTicket means no season is running, so the only thing a writer
  // could produce is a bare `<SeasonTicket premium="1" score="1002"/>` with no
  // window — a card no season on the server can claim. 5/5 saves that hold a
  // ticket carry `startTime`/`endTime`, so absence is refused, not filled in.
  assert.throws(() => injectSeason('<Global><AWS cityId="c1"/></Global>'), /không có SeasonTicket/);
  // A save that *does* have one still round-trips.
  const out = injectSeason('<Global><SeasonTicket id="800" startTime="1" endTime="2"/></Global>');
  wellFormed(out);
  assert.match(out, /premium="1"/);
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
    `<FreeTask id="match3_bomb_999" num="4" ver="99"/>${task}</Regata></Global>`
  );
}

/**
 * A regatta that opened `ago` seconds ago and already holds one completion
 * inside it — the shape both "the regatta window is too short" reports came
 * from. Built fresh rather than re-based from `liveRegattaSave`, so the save's
 * own record sits inside the window it declares, the way a real client would
 * have written it.
 */
function youngRegattaSave(ago = 600) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - ago;
  return (
    '<Global><Var name="cityId" v="MECITY1" t="s"/>' +
    `<Regata id="507" startTime="${start}" endTime="${now + 7 * 86400}" score="135" scoreUpd="${start + 50}">` +
    '<FreeTask id="match3_bomb_999" num="4" ver="99"/>' +
    `<MyOldTask id="match3_bomb_999" type="event_order" eventType="Match3" target="create_bonus_bomb" ` +
    `need="100" have="100" user="MECITY1" num="4" ver="1" takenCounter="1" score="135" ` +
    `takeTime="${start + 60}" completeTime="${start + 120}" endTime="${start + 180}" ` +
    `realEndTime="${start + 180}" regataCash="17" anlNumber="1" anlLimit="10"/>` +
    "</Regata></Global>"
  );
}

test("regata clones a real record field for field instead of inventing one", () => {
  const out = injectRegata(liveRegattaSave(), 4);
  wellFormed(out);

  const tasks = [...out.matchAll(/<MyOldTask\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(tasks.length, 5, "the save's own record plus the four it was asked to add");

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
  assert.equal(completions.size, 13, "each task needs its own completion time, not one shared stamp");
});

test("regata raises the lifetime counter instead of rewinding it", () => {
  // The save already reports 2315 completions. Writing the batch size over it
  // would move a lifetime stat backwards, which a server can read for free.
  const out = injectRegata(liveRegattaSave({ life: 2315 }), 12);
  const tag = out.match(/<Var\b[^>]*name="RegataTasksCompleted"[^>]*>/)![0];
  assert.equal(Number(attrValue(tag, "v")), 2315 + 12, "the batch adds to the count already recorded");

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
  // Real records never repeat a `(num, ver)`: the pair names a generation of a
  // slot, and a generation is issued once. `liveRegattaSave` owns (4,1), so
  // these two take (4,2) and (4,3) — the shape a real save shows, and the shape
  // the batch's own minting has to keep.
  const rec = (tc: number, age: number, ver: number) =>
    `<MyOldTask id="match3_bomb_999" type="event_order" eventType="Match3" target="create_bonus_bomb" ` +
    `need="100" have="100" user="MECITY1" num="4" ver="${ver}" takenCounter="${tc}" score="135" ` +
    `takeTime="${start + age}" completeTime="${start + age + 60}" endTime="${start + age + 120}" ` +
    `realEndTime="${start + age + 120}" regataCash="17" anlNumber="1" anlLimit="10"/>`;

  // This week is already three tasks in: numbered 1, 3 and 4. The template
  // the injector picks is the first row (takenCounter 1).
  const xml = liveRegattaSave().replace("</Regata>", `${rec(3, 1500, 2)}${rec(4, 2400, 3)}</Regata>`);

  const out = injectRegata(xml, 6); // three already there, and six more are added
  const counters = [...out.matchAll(/<MyOldTask\b[^>]*>/g)].map((m) => Number(attrValue(m[0], "takenCounter")));
  assert.deepEqual(counters, [1, 3, 4, 5, 6, 7, 8, 9, 10], `take counter must keep growing: ${counters.join(",")}`);
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

test("regata mints its own counter when the live week is empty but an archive supplies the templates", () => {
  // `regattaTemplates()` scans the WHOLE document, so `<PrevRegata>` hands over
  // its records as templates even when the live week has completed nothing —
  // which is precisely the "Completed 0 → 12, Templates: 9" badge. Those
  // archived records carry their own `takenCounter`, and it is a *per-regatta*
  // number: two archives lifted from different weeks can read 10 and 2.
  //
  // `maxTaken` is read from the LIVE block only, so it came out -1, `takenBase`
  // fell through to -1 on the clone path, and the `takenBase >= 0` guard meant
  // `takenCounter` was never rewritten — every new record kept its template's
  // archived number. Cycling them wrote 10, 2, 25… into the live week and the
  // push gate refused with `regatta-taken-counter:10-2`: a clean save locked
  // out of the whole feature over a field this tool had copied verbatim.
  //
  // Three untouched weeks all start their counter at 2, so that is the seed for
  // both paths — the clone path must not differ from the synthesized one here.
  const now = Math.floor(Date.now() / 1000);
  const start = now - 4 * 86400;
  const end = now + 4 * 86400;
  // A complete, measured record — `match3_create_bonus_with_chips_3` is
  // 150/120/15 on every save that has ever completed one, and `15` is the
  // block's own `TaskQuota`, which is where a real `anlLimit` comes from.
  const archived = [10, 2, 25, 7]
    .map(
      (c, i) =>
        `<MyOldTask id="match3_create_bonus_with_chips_3" type="event_order" eventType="Match3" ` +
        `target="create_bonus_with_chips" need="150" have="150" user="MECITY1" num="${i + 1}" ` +
        `ver="1" takenCounter="${c}" score="120" regataCash="15" anlNumber="1" anlLimit="15" ` +
        `takeTime="${start + 300}" completeTime="${start + 900}" endTime="${start + 1000}" ` +
        `realEndTime="${start + 1000}"/>`,
    )
    .join("");
  const xml =
    `<?xml version="1.0" encoding="utf-8"?><Global>` +
    `<Var name="cityId" v="MECITY1" t="s"/>` +
    `<PrevRegata>${archived}</PrevRegata>` +
    `<Regata id="533" startTime="${start}" endTime="${end}" season="108" week="4" league="4" ` +
    `score="120" scoreUpd="${start + 900}">` +
    `<FreeTask id="match3_win_game_in_row_1" type="" num="1" ver="59"/>` +
    `<Vars><Var name="TaskQuota" v="15"/></Vars>` +
    `</Regata></Global>`;

  const before = inspectRegatta(xml, 12);
  assert.equal(before.current, 0, "the live week starts empty");
  assert.ok(before.templates > 0, "the archive is what supplies the templates");

  const out = injectRegata(xml, 12);
  wellFormed(out);
  const inner = out.match(/<Regata\b[^>]*>([\s\S]*?)<\/Regata\s*>/)![1];
  const counters = [...inner.matchAll(/<MyOldTask\b[^>]*\btakenCounter="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(counters.length, 12, "every new record carries a counter");
  assert.equal(counters[0], 2, "a fresh week starts at 2, like every untouched one");
  for (let i = 1; i < counters.length; i++) {
    assert.ok(counters[i]! > counters[i - 1]!, `counter ran backwards: ${counters.join(",")}`);
  }
  // The archived donor's own number must not survive into the live week.
  assert.ok(!counters.includes(25), "an archived counter must not be copied through");

  assert.doesNotThrow(() => assertRegattaSafe(xml, out), "a fresh counter must pass the push gate");
});

test("regata takes any count, on a young window too — the daily envelope no longer refuses", () => {
  // Two refusals used to live here: `window_closed` (a week opened that
  // afternoon could not take 20) and `day_full` (a rolling 24 h above
  // `2 * TaskQuota` was refused). Both are gone: the count is whatever the user
  // types. What survives is the *shape* — new records still take the safe
  // spacing when the window holds it, and never share a second.
  const justOpened = youngRegattaSave();
  const young = inspectRegatta(justOpened, 20);
  assert.equal(young.reason, "ok", "a young week refuses nothing");
  assert.notEqual(young.current, undefined);
  const out = injectRegata(justOpened, 20);
  const times = [...out.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(times.length, 21, "the save's own record plus the twenty it was asked to add");
  const wallNow = Math.floor(Date.now() / 1000);
  const start = Number(/<Regata\b[^>]*\bstartTime="(\d+)"/.exec(out)![1]);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i]! - times[i - 1]! >= 1, "no two completions share a second");
  }
  for (const t of times) {
    assert.ok(t >= start, "no completion sits before the week opened");
    assert.ok(t < wallNow, "and none is dated in the future");
  }
  assert.doesNotThrow(() => assertRegattaSafe(justOpened, out), "a young week still passes the ban gate");

  // The same save, aged: spacing widens back to the safe gap on its own, so a
  // batch is spread rather than packed whenever the window has the room.
  const aged = youngRegattaSave(6 * 3600);
  const agedOut = injectRegata(aged, 5);
  const agedTimes = [...agedOut.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1]));
  const gap = regattaDensityGap(regattaDayCap(inspectRegatta(aged, 1).quota));
  for (let i = 1; i < agedTimes.length; i++) {
    assert.ok(agedTimes[i]! - agedTimes[i - 1]! >= gap, "an aged week keeps the full safe gap");
  }
  assert.doesNotThrow(() => assertRegattaSafe(aged, agedOut), "an aged young week still passes every gate");
});

test("regata counts how many tasks to add, so a save already holding some still takes more", () => {
  const full = liveRegattaSave();
  // The report this replaces: *"after i push 50 tasks it works, but if i want
  // to push more then i can't push it shows error"*. The count used to be read
  // as the week's **target total**, so the first push filled it and the next
  // one came back `already_full (50/50)` for the rest of the week. It is how
  // many tasks this push *adds*, which is what makes a second push possible.
  assert.equal(inspectRegatta(full, 1).reason, "ok", "one more than the save already holds is not 'full'");
  assert.equal(
    (injectRegata(full, 1).match(/<MyOldTask\b/g) ?? []).length,
    2,
    "the save's own record plus the one more it was asked for",
  );

  // Whatever is typed, a week takes it: the daily envelope no longer refuses a
  // batch, and the only bound left on the number is the typo guard that stops a
  // stray digit from asking for a million records.
  assert.equal(regattaWant(9999), REGATTA_MAX_TASKS);
  assert.equal(inspectRegatta(full, 1).reason, "ok");
  assert.equal(inspectRegatta(full, 2 * REGATTA_MAX_PER_DAY).reason, "ok", "a whole day's envelope is pressable");
  assert.equal(inspectRegatta(full, REGATTA_MAX_TASKS).reason, "ok", "and so is a thousand tasks");
  const big = injectRegata(full, 300);
  assert.equal(
    (big.match(/<MyOldTask\b/g) ?? []).length,
    301,
    "the batch the user typed is the batch that lands",
  );
  assert.doesNotThrow(() => assertRegattaSafe(full, big), "and the ban gate still accepts the shape");
});

// <Regata>'s own <Vars> counts the records in that same block. Measured on all
// seven real saves available: taskCounter == takeConfirm == count(<MyOldTask>)
// exactly (1/1, 14/14, 20/20, 1/1, 1/1, 1/1, 1/1) and takeAttempts >=
// takeConfirm (1/1, 17/14, 39/20, 1/1, …). A batch that grows the records
// without moving them writes a save that disagrees with itself in three fields.
function countedRegattaSave(count: number) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 4 * 86400;
  const end = now + 4 * 86400;
  const task = (i: number) =>
    `<MyOldTask id="trains_${i}" type="trains" user="MECITY1" num="${i}" ver="1" score="100" ` +
    `takeTime="${start + 300 + i}" completeTime="${start + 900 + i}" endTime="${start + 1000 + i}" ` +
    `realEndTime="${start + 1000 + i}"/>`;
  return (
    `<Global><Var name="cityId" v="MECITY1" t="s"/>` +
    `<RegataCenter>` +
    `<Regata id="507" startTime="${start}" endTime="${end}" score="100" scoreUpd="${start + 900}">` +
    `<FreeTask id="trains_1" num="1" ver="9"/>` +
    Array.from({ length: count }, (_, i) => task(i + 1)).join("") +
    `<Vars><Var name="taskCounter" v="${count}" t="i"/>` +
    `<Var name="takeConfirm" v="${count}" t="i"/>` +
    `<Var name="takeAttempts" v="${count + 6}" t="i"/>` +
    `<Var name="UnrelatedCounter" v="7" t="i"/></Vars>` +
    `<Team clanId="x"></Team>` +
    `</Regata></RegataCenter></Global>`
  );
}

const varNum = (xml: string, name: string): number | null => {
  const m = new RegExp(`<Var\\b[^>]*\\bname="${name}"[^>]*>`, "i").exec(xml);
  const v = m ? /v="(\d+)"/.exec(m[0]) : null;
  return v ? Number(v[1]) : null;
};

const regattaInner = (xml: string) => /<Regata\b[^>]*>([\s\S]*?)<\/Regata\s*>/i.exec(xml)?.[1] ?? "";

test("regata keeps the block's own counters in step with the records it grew", () => {
  const out = injectRegata(countedRegattaSave(2), 6); // 2 present, and 6 more are added
  wellFormed(out);

  const inner = regattaInner(out);
  const tasks = (inner.match(/<MyOldTask\b/g) ?? []).length;
  assert.equal(tasks, 8, "the batch lands in the block");
  assert.equal(varNum(inner, "taskCounter"), 8, "taskCounter must equal the records the block holds");
  assert.equal(varNum(inner, "takeConfirm"), 8, "takeConfirm tracks the same records");
  assert.ok(
    (varNum(inner, "takeAttempts") ?? 0) >= 8,
    `takeAttempts must never trail takeConfirm, got ${varNum(inner, "takeAttempts")}`,
  );
  assert.equal(varNum(inner, "UnrelatedCounter"), 7, "a Var that is not a task count stays put");
});

test("regata gives a block that never counted its records the tally every save has", () => {
  // `liveRegattaSave`'s <Regata> carries no <Vars> at all. Every save in the
  // corpus that holds records declares `taskCounter == takeConfirm ==
  // count(<MyOldTask>)` and `takeAttempts >= takeConfirm` — 7/7 measured — so
  // a block left with records and no tally is the one shape no real save has.
  // It is also precisely what the known bad output (105 records, every counter
  // absent) looked like, which makes it a refusal that costs nothing to avoid.
  //
  // `RegataTasksCompleted` is the opposite case and is untouched here: it is a
  // lifetime stat a save may genuinely never have tracked, so it is bumped only
  // when already present.
  const out = injectRegata(liveRegattaSave(), 4);
  wellFormed(out);
  const inner = regattaInner(out);
  assert.equal((inner.match(/<MyOldTask\b/g) ?? []).length, 5, "the save's own record plus the four added");
  assert.equal(varNum(inner, "taskCounter"), 5, "the tally counts every record in the block");
  assert.equal(varNum(inner, "takeConfirm"), 5, "takeConfirm tracks the same records");
  assert.equal(varNum(inner, "takeAttempts"), 5, "takeAttempts never trails");
  assert.ok(inner.indexOf("<MyOldTask") < inner.indexOf("<Vars"), "the tally sits after the records it counts");
  assert.ok(!/<Var\b[^>]*\bname="RegataTasksCompleted"/.test(out), "a lifetime stat it never had stays uncreated");
});

test("regata puts new records where real saves keep them", () => {
  const out = injectRegata(countedRegattaSave(1), 4);
  const inner = regattaInner(out);
  const lastTask = inner.lastIndexOf("<MyOldTask");
  const vars = inner.indexOf("<Vars");
  assert.ok(lastTask > 0, "the batch must be inside the block");
  assert.ok(vars > lastTask, `records belong before <Vars>; real saves read FreeTask/TakenTask/MyOldTask/Vars, got: ${inner.slice(0, 160)}`);
  assert.ok(inner.indexOf("<Team") > vars, "<Team> keeps following <Vars>");
});

test("the status shown for a batch size is the decision the server makes for it", () => {
  const saves = [
    ["one task", liveRegattaSave()],
    ["no template", liveRegattaSave({ hasTask: false })],
    ["two tasks", countedRegattaSave(2)],
    ["nine tasks", countedRegattaSave(9)],
  ] as const;

  for (const [label, xml] of saves) {
    for (const n of [1, 3, 12, 15, 99]) {
      const reason = inspectRegatta(xml, n).reason;
      let threw = false;
      try {
        injectRegata(xml, n);
      } catch {
        threw = true;
      }
      assert.equal(
        reason === "ok",
        !threw,
        `${label}: inspectRegatta says "${reason}" for ${n} tasks but injectRegata ${threw ? "refused" : "accepted"} it`,
      );
    }
  }
});

/**
 * The state the Add button used to be permanently dead in: a save genuinely
 * taking part in a regatta, with a full task pool, that has completed
 * **nothing** this week — so there is no `<MyOldTask>` to clone.
 * `mGameInfo.current-9.xml` arrived exactly like this (live `<Regata>` window,
 * 12 `<FreeTask>`, 16 `<TakenTask>`, `TaskQuota=15`, 0 records) and every
 * reading of it said `no_template`.
 */
function greenWeekSave(): string {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 3 * 86400;
  const end = now + 4 * 86400;
  return (
    `<Global>` +
    `<Var name="cityId" v="JqpjJQ9lom" t="s"/>` +
    `<Var name="RegataTasksCompleted" v="2304" t="i"/>` +
    `<Regata id="533" startTime="${start}" endTime="${end}" season="108" week="4" league="4" ` +
    `clanId="RzSwy5Lxfb" score="33890" scoreUpd="${start + 900}">` +
    `<FreeTask id="match3_create_bonus_lightning_7" type="" num="1" ver="59"/>` +
    `<FreeTask id="match3_win_game_in_row_3" type="" num="2" ver="25"/>` +
    `<FreeTask id="match3_create_bonus_bomb_1" type="" num="3" ver="69"/>` +
    `<FreeTask id="match3_create_bonus_plane_1" type="" num="4" ver="85"/>` +
    `<FreeTask id="match3_remove_chips_yellow_green_4" type="" num="5" ver="38"/>` +
    `<FreeTask id="match3_combine_bonus_any_999" type="" num="6" ver="54"/>` +
    `<FreeTask id="fruits_olive_5" type="" num="7" ver="27"/>` +
    `<FreeTask id="orders_5" type="" num="10" ver="29"/>` +
    `<TakenTask id="match3_create_bonus_with_chips_3" type="" need="150" user="6aI0uUa9SN" endTime="${end}" num="-1" ver="0" takenCounter="10"/>` +
    `<TakenTask id="match3_create_bonus_rocket_3" type="" need="65" user="6aI0uUa9SN" endTime="${end}" num="-1" ver="0" takenCounter="11"/>` +
    `<TakenTask id="match3_create_bonus_with_chips_2" type="" need="180" user="6aI0uUa9SN" endTime="${end}" num="-1" ver="0" takenCounter="15"/>` +
    `<TakenTask id="match3_remove_chips_blue_red_999" type="" need="1300" user="6aI0uUa9SN" endTime="${end}" num="-1" ver="0" takenCounter="2"/>` +
    `<TakenTask id="trains_3" type="" need="5" user="K70cFX2LJT" endTime="${end}" num="-1" ver="0" takenCounter="26"/>` +
    `<Member cityId="6aI0uUa9SN" taskId="match3_create_bonus_with_chips_3" count="42" need="150"/>` +
    `<Member cityId="K70cFX2LJT" taskId="trains_3" count="5" need="5"/>` +
    `<Vars>` +
    `<Var name="startTime" v="${start}" t="i"/>` +
    `<Var name="endTime" v="${end}" t="i"/>` +
    `<Var name="TaskQuota" v="15" t="i"/>` +
    `<Var name="MySeenScore" v="33750" t="i"/>` +
    `<Var name="history" v="${start - 7200}:30000,${start + 900}:33890"/>` +
    `</Vars>` +
    `<Team id="f9GxwVNVaF" place="0">` +
    `<Clan id="RzSwy5Lxfb" name="Aristocrats" score="33890" upd="${start + 900}"/>` +
    `</Team>` +
    `</Regata>` +
    `</Global>`
  );
}

const attrsOf = (tag: string) =>
  new Map([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));

test("a save with a full pool and nothing completed can take 10, 12 and 15 tasks", () => {
  const xml = greenWeekSave();
  assert.equal(inspectRegatta(xml).current, 0, "this save has no record to clone");
  // The whole point: the badge and the reason both go live for the counts the
  // user picks, not just the default batch.
  for (const n of [10, 12, 15]) {
    assert.equal(inspectRegatta(xml, n).reason, "ok", `${n} tasks must be offerable`);
    assert.ok(
      inspectRegatta(xml, n).templates >= n,
      `the badge must count at least as many records as the batch asks for (${n})`,
    );
  }

  const out = injectRegata(xml, 15);
  wellFormed(out);
  const recs = [...out.matchAll(/<MyOldTask\b[^>]*?\/?>/g)].map((m) => m[0]);
  assert.equal(recs.length, 15, "the requested batch lands");

  // Every list an id can be sitting on right now. A completed id is on none of
  // them: the batch takes its offer row out and puts the slot back.
  const listed = new Set([
    ...[...out.matchAll(/<FreeTask\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]!),
    ...[...out.matchAll(/<TakenTask\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]!),
    ...[...out.matchAll(/<Member\b[^>]*?\btaskId="([^"]*)"/g)].map((m) => m[1]!),
  ]);
  const start = Number(/<Regata\b[^>]*\bstartTime="(\d+)"/.exec(out)![1]);
  const end = Number(/<Regata\b[^>]*\bendTime="(\d+)"/.exec(out)![1]);
  const now = Math.floor(Date.now() / 1000);
  const byId = new Map<string, Set<string>>();

  for (const r of recs) {
    const a = attrsOf(r);
    const id = a.get("id")!;
    // A record for an id the game has never issued is the old injector's
    // `match3_1..match3_105` output — the single most readable fake there is.
    // The test is "measured", not "still in the pool": a completed task leaves
    // the pool by design, and requiring it to stay there was what made the
    // batch contradict its own offer list.
    assert.ok(regattaTaskIsMeasured(id), `${id} must be an id the corpus has seen completed`);
    assert.ok(!listed.has(id), `${id} must not still be sitting on any list`);
    assert.equal(a.get("user"), "JqpjJQ9lom", "records are attributed to the save's own id");

    const type = a.get("type");
    if (id.startsWith("match3_")) {
      assert.equal(type, "event_order");
      assert.equal(a.get("eventType"), "Match3");
      assert.equal(
        a.get("target"),
        id.replace(/^match3_/, "").replace(/_\d+$/, ""),
        "target is the id minus match3_ and its difficulty suffix",
      );
      assert.equal(
        Number(a.get("regataCash")),
        Math.round(Number(a.get("score")) / 8),
        "regataCash is round(score/8), as on 26/26 real match3 records",
      );
    } else {
      assert.equal(type, "trains");
      assert.equal(a.get("eventType"), undefined, "a trains record carries no eventType");
      assert.equal(a.get("regataCash"), "12", "the one measured trains cash");
    }

    assert.equal(a.get("have"), a.get("need"), "a completion has have == need");
    assert.ok([75, 115, 120, 125, 130, 140, 150].includes(Number(a.get("score"))), "score must be measured data");
    assert.equal(a.get("anlLimit"), "15", "anlLimit is the block's own TaskQuota");
    assert.ok(Number(a.get("anlNumber")) >= 1 && Number(a.get("anlNumber")) <= 15, "anlNumber cycles inside it");

    const take = Number(a.get("takeTime"));
    const done = Number(a.get("completeTime"));
    const real = Number(a.get("realEndTime"));
    assert.ok(take < done && done < real, "takeTime < completeTime < realEndTime, strictly");
    assert.ok(real >= start && real <= end, "timestamps stay inside the window");
    assert.ok(real < now, "a completion is never dated in the future");
    assert.equal(a.get("endTime"), a.get("realEndTime"), "endTime equals realEndTime, as on every real record");

    // Repeats are normal (a real week holds with_chips_3 three times), but a
    // repeated id must repeat its own need/score/cash verbatim.
    const variant = `${a.get("need")}/${a.get("score")}/${a.get("regataCash")}`;
    if (!byId.has(id)) byId.set(id, new Set());
    byId.get(id)!.add(variant);
  }

  // 15 records, 15 distinct measured ids: the batch consumes an offer row and
  // puts the slot back with the next id it has not used, so nothing is cycled
  // into a second copy of itself.
  assert.equal(byId.size, 15, "every record is a different measured task");
  for (const variants of byId.values()) assert.equal(variants.size, 1, "a repeated id repeats identically");

  // The offer list keeps its full complement of slots — a real save holds 12,
  // this fixture 8 — and no completed id is still on it.
  const freeRows = [...out.matchAll(/<FreeTask\b[^>]*?\/?>/g)].map((m) => attrsOf(m[0]));
  assert.equal(freeRows.length, 8, "every consumed offer row is put back");
  const freeIds = new Set(freeRows.map((f) => f.get("id")));
  assert.deepEqual(
    recs.map((r) => attrsOf(r).get("id")).filter((id) => freeIds.has(id!)),
    [],
    "no completed task is still being offered to us",
  );

  // A record's `num` is one of this save's own slots and its `ver` is an
  // older generation of that slot than the row sitting there now — which is
  // what lets the record and the offer coexist without contradicting each
  // other. `ver="0"` is refused outright: no real record carries it, it is the
  // value a teammate's `<TakenTask>` row is cleared to.
  const freeVer = new Map(freeRows.map((f) => [Number(f.get("num")), Number(f.get("ver"))]));
  const triples = new Set<string>();
  for (const r of recs) {
    const a = attrsOf(r);
    const num = Number(a.get("num"));
    const ver = Number(a.get("ver"));
    assert.ok(freeVer.has(num), `slot ${num} is not one of this save's own offer slots`);
    assert.ok(ver >= 1, `ver must be a real generation, never 0: ${r}`);
    assert.ok(ver < freeVer.get(num)!, `a completed task must predate the offer now in slot ${num}`);
    triples.add(`${a.get("id")}/${num}/${ver}`);
  }
  assert.equal(triples.size, 15, "no (id, num, ver) triple is ever issued twice");

  // A wall of one score is the old injector's fingerprint; this batch is not.
  assert.ok(new Set(recs.map((r) => attrsOf(r).get("score"))).size > 1, "scores must not be uniform");

  // takenCounter starts at 2 the way three untouched weeks all do, and only
  // grows inside the block.
  const counters = recs.map((r) => Number(attrsOf(r).get("takenCounter")));
  assert.deepEqual(counters, counters.map((_, i) => 2 + i), "the fresh counter runs 2,3,… in order");

  // Placement, and the lifetime counter: bumped only because it was already
  // there. Writing the batch size over it would move a lifetime stat backwards.
  assert.ok(out.indexOf("<MyOldTask") < out.indexOf("<Vars"), "new records sit before <Vars>");
  assert.match(out, /name="RegataTasksCompleted" v="2319"/, "the lifetime counter gains the batch");

  // <Regata score> and scoreUpd mirror the clan, they do not accumulate
  // locally, so this tool never writes them. All three copies must still read
  // what they read before the batch: the block's own attributes, the tail of
  // its <Var name="history">, and its own <Team><Clan> entry. That triple is
  // the clan leaderboard number Playrix holds server-side, and raising only
  // the block's copy is the cheapest way to disagree with it.
  assert.equal(Number(/<Regata\b[^>]*\bscore="(\d+)"/.exec(out)![1]), 33890, "<Regata score> is not a local counter");
  assert.equal(
    Number(/<Regata\b[^>]*\bscoreUpd="(\d+)"/.exec(out)![1]),
    start + 900,
    "scoreUpd stays the newest real history entry",
  );
  assert.equal(
    /<Var\b[^>]*\bname="history"[^>]*\bv="([^"]*)"/.exec(out)![1].split(",").pop(),
    `${start + 900}:33890`,
    "history is untouched and still agrees with the block",
  );
  assert.match(
    /<Clan id="RzSwy5Lxfb"[^>]*>/.exec(out)![0],
    new RegExp(`score="33890"[^>]*upd="${start + 900}"`),
    "the save's own Clan entry still agrees",
  );

  // The block's own tally is created and counts every record sitting in it —
  // a block with records and no tally at all is the shape no save in the
  // corpus has, and it is what the known bad output left behind.
  const inner = regattaInner(out);
  assert.equal(varNum(inner, "taskCounter"), 15, "taskCounter counts every record in the block");
  assert.equal(varNum(inner, "takeConfirm"), 15, "takeConfirm tracks the same records");
  assert.equal(varNum(inner, "takeAttempts"), 15, "takeAttempts never trails takeConfirm");
});

test("a save that has completed nothing must never be handed a teammate's id", () => {
  // `user=` was measured to live on exactly three tags: <MyOldTask> and
  // <MyTask> always carry the save's own cityId, and <TakenTask> always
  // carries a clanmate's. On a save with no record of its own the old generic
  // `user="…"` fallback matched <TakenTask> first, so every injected record
  // would have been written with somebody else's id — the instant-ban story
  // from the identity notes, and unreachable before only because such saves
  // were refused outright with `no_template`.
  const xml = greenWeekSave();
  assert.match(xml, /<TakenTask[^>]*user="6aI0uUa9SN"/, "the fixture really does hold a teammate's id");
  assert.ok(!/<MyOldTask/.test(xml), "and no record of its own");

  const users = new Set(
    [...injectRegata(xml, 12).matchAll(/<MyOldTask\b[^>]*\buser="([^"]*)"/g)].map((m) => m[1]),
  );
  assert.deepEqual([...users], ["JqpjJQ9lom"], "records are attributed to the save's own cityId");
});

test("the refusal still stands for ids no save has ever completed", () => {
  // Every one of these is a real Township task, but not one appears on a
  // completed record anywhere in the corpus, so `need` and `score` would have
  // to be guessed — and a guessed score is precisely what gets read as a tool.
  const now = Math.floor(Date.now() / 1000);
  const xml =
    `<Global><Var name="cityId" v="CITY1" t="s"/>` +
    `<Regata id="533" startTime="${now - 3 * 86400}" endTime="${now + 4 * 86400}" score="100">` +
    `<FreeTask id="coins_7" type="" num="1" ver="9"/>` +
    `<FreeTask id="wagon_2" type="" num="2" ver="4"/>` +
    `<FreeTask id="match3_create_bonus_rocket_3" type="" num="3" ver="7"/>` +
    `<Vars><Var name="TaskQuota" v="15" t="i"/></Vars>` +
    `</Regata></Global>`;
  assert.equal(inspectRegatta(xml, 12).reason, "no_template");
  assert.throws(() => injectRegata(xml, 12), /regatta/i);
});

test("the regatta push gate refuses a fabricated batch but not a measured one", () => {
  const xml = greenWeekSave();
  const out = injectRegata(xml, 15);
  assert.doesNotThrow(() => assertRegattaSafe(xml, out), "a batch built only from measured values must pass");

  const uniform = out.replace(/score="\d+"/g, 'score="135"');
  assert.throws(() => assertRegattaSafe(xml, uniform), /regatta/i, "135 on every record is the old fingerprint");

  const future = out.replace(/realEndTime="\d+"/g, `realEndTime="${Math.floor(Date.now() / 1000) + 99999}"`);
  assert.throws(() => assertRegattaSafe(xml, future), /regatta/i, "a completion in the future must be refused");

  const foreign = out.replace(/user="JqpjJQ9lom"/g, 'user="SOMEBODYELSE"');
  assert.throws(() => assertRegattaSafe(xml, foreign), /regatta/i, "a second identity must be refused");

  // Four values a server reads for free, each of which this batch must never
  // be able to leave with: a `ver="0"` (the value a teammate's row is cleared
  // to), a completed id back on the offer list, records with no tally at all,
  // and a block score that no longer mirrors the clan's history.
  const first = /<MyOldTask\b[^>]*?>/.exec(out)![0];
  const zeroVer = out.replace(first, first.replace(/ver="\d+"/, 'ver="0"'));
  assert.throws(() => assertRegattaSafe(xml, zeroVer), /regatta/i, "ver=0 must be refused");

  const firstId = /<MyOldTask\b[^>]*?\bid="([^"]*)"/.exec(out)![1];
  const conflict = out.replace("</Regata>", `<FreeTask id="${firstId}" type="" num="11" ver="60"/></Regata>`);
  assert.throws(() => assertRegattaSafe(xml, conflict), /regatta/i, "a completed id still offered must be refused");

  const noTally = out
    .replace(/<Var\b[^>]*\bname="taskCounter"[^>]*>/, "")
    .replace(/<Var\b[^>]*\bname="takeConfirm"[^>]*>/, "");
  assert.throws(() => assertRegattaSafe(xml, noTally), /regatta/i, "records with no tally must be refused");

  const bumped = out.replace('score="33890" scoreUpd=', 'score="35210" scoreUpd=');
  assert.notEqual(bumped, out, "the fixture really does carry the block score");
  assert.throws(() => assertRegattaSafe(xml, bumped), /regatta/i, "a score that outran its own history must be refused");

  // The rule is a diff: a save that *arrived* carrying the old injector's
  // uniform 135 keeps that key on both sides and stays pushable. Refusing it
  // would hold a user's own file hostage for something this tool never did.
  const odd = liveRegattaSave();
  assert.doesNotThrow(
    () => assertRegattaSafe(odd, injectRegata(odd, 6)),
    "an oddity the save arrived with must never block it",
  );
});

test("regata accepts a record cloned from the save's own archived week, and only then", () => {
  // Reported verbatim: "Không đẩy file lên máy: task regatta vừa thêm không
  // khớp dữ liệu thật (regatta-id:match3_combine_bonus_any_999)".
  //
  // That id is a real offer — the fixture below offers it as slot 6 — but no
  // save in the corpus has ever *completed* it, so it is absent from
  // `REGATTA_TASK` and the gate could not recognise it. `regattaTemplates()`
  // scans the whole document on purpose, so a completed record for it sitting
  // in an archived `<PrevRegata>` week is a legitimate template, and the clone
  // copies its `score` / `regataCash` / `target` / `need` through verbatim:
  // the game's own values, not a guess. The gate read only the live block plus
  // the 23-row catalog and so refused the save's own history.
  //
  // This week deliberately does **not** re-offer the id, so pool membership
  // cannot be what saves it — that is the shape the report came in on.
  const live = greenWeekSave();
  const offer = `<FreeTask id="match3_combine_bonus_any_999" type="" num="6" ver="54"/>`;
  const thisWeek = live.replace(offer, "");
  assert.notEqual(thisWeek, live, "the fixture really does offer that id");

  const now = Math.floor(Date.now() / 1000);
  const done = now - 9 * 86400;
  const archive =
    `<PrevRegata id="532" startTime="${now - 16 * 86400}" endTime="${now - 4 * 86400}" season="108" week="4">` +
    `<MyOldTask id="match3_combine_bonus_any_999" type="match3" user="JqpjJQ9lom" num="6" ver="54" ` +
    `score="150" regataCash="19" need="100" have="100" target="combine_bonus_any" ` +
    `anlNumber="3" anlLimit="15" takenCounter="9" ` +
    `takeTime="${done}" completeTime="${done + 60}" realEndTime="${done + 120}" endTime="${done + 120}"/>` +
    `</PrevRegata>`;
  const xml = thisWeek.replace("<Regata ", archive + "<Regata ");

  const out = injectRegata(xml, 10);
  assert.match(out, /<MyOldTask id="match3_combine_bonus_any_999"/, "the archived record really was cloned");
  assert.doesNotThrow(
    () => assertRegattaSafe(xml, out),
    "a record the save's own history proves the game wrote is not an invention",
  );

  // The relaxation is keyed on that archive, not taken away: strip the archive
  // out of the very same pushed file and the id is once again one no save has
  // ever completed and no offer list carries.
  assert.throws(
    () => assertRegattaSafe(thisWeek, out.replace(archive, "")),
    /regatta/i,
    "the identical record with no archive behind it must still be refused",
  );

  // …and the checks on what this tool itself writes are untouched: a cloned
  // record dated in the future is refused even for an archived id, so the only
  // thing trusted is the data that came verbatim from the game.
  const future = out.replace(/realEndTime="\d+"/g, `realEndTime="${now + 99999}"`);
  assert.notEqual(future, out, "the fixture really does carry realEndTime");
  assert.throws(() => assertRegattaSafe(xml, future), /regatta/i, "our own timestamps are still checked");
});

test("a record cloned back onto a list that is offering its id again is never written", () => {
  // Reported on Start after joining a co-op: `regatta-pool-conflict:
  // match3_create_bonus_lightning_3, regatta-pool-conflict:
  // match3_create_bonus_rocket_999`. The gate is right and the writer was not:
  // `regattaTemplates()` reads the whole document (an archived week is the only
  // proof an id's values are the game's own), but a new co-op's week puts ids
  // an archived week completed back on its `<FreeTask>` / `<TakenTask>` /
  // `<Member taskId>` lists — and cloning one then writes a completed record
  // that is *still being offered*, a shape with 0 occurrences in every block
  // of the corpus. The filter in `injectRegata` must drop that template, so a
  // batch the tool writes can never mint a key the save did not arrive with.
  const now = Math.floor(Date.now() / 1000);
  const start = now - 3 * 86400;
  const done = start + 600;
  const id = "match3_combine_bonus_any_999";
  const record =
    `<MyOldTask id="${id}" type="match3" user="JqpjJQ9lom" num="6" ver="54" ` +
    `score="150" regataCash="19" need="100" have="100" target="combine_bonus_any" ` +
    `anlNumber="3" anlLimit="15" takenCounter="9" ` +
    `takeTime="${done}" completeTime="${done + 60}" realEndTime="${done + 120}" endTime="${done + 120}"/>`;
  const archive =
    `<PrevRegata id="532" startTime="${now - 16 * 86400}" endTime="${now - 4 * 86400}" season="108" week="4">` +
    record +
    `</PrevRegata>`;
  // The save after a co-op join: the old week is archived, the new week's live
  // block still offers the id that week completed (slot 6 of greenWeekSave).
  const xml = greenWeekSave().replace("<Regata ", archive + "<Regata ");
  assert.match(xml, new RegExp(`<FreeTask id="${id}"`), "the live week really does re-offer the archived id");

  // (a) The gate still refuses a push that clones it back into the live block —
  // the rule itself is untouched; only the writer learned to avoid it.
  const clash = xml.replace("</Regata>", record + "</Regata>");
  assert.throws(
    () => assertRegattaSafe(xml, clash),
    new RegExp(`regatta-pool-conflict:${id}`),
    "a completed id still offered must still be refused",
  );

  // (b) The save stays fully usable: the badge and the reason read the same
  // filtered source the push does, so the card cannot offer a push that fails.
  assert.equal(inspectRegatta(xml, 12).reason, "ok", "the conflict in the archive must not deaden the week");

  // (c) The batch lands and writes nothing the lists are holding — the
  // conflicting id is never cloned, every other record is ordinary.
  const out = injectRegata(xml, 12);
  wellFormed(out);
  // The live block only — the archived record is still in `<PrevRegata>` and is
  // not part of this batch.
  const liveInner = /<Regata\b[^>]*>([\s\S]*?)<\/Regata>/.exec(out)![1]!;
  const recs = [...liveInner.matchAll(/<MyOldTask\b[^>]*?\/?>/g)].map((m) => m[0]);
  assert.equal(recs.length, 12, "the requested batch lands");
  assert.ok(
    !recs.some((r) => attrsOf(r).get("id") === id),
    "the archived record whose id is being offered again must not be cloned",
  );
  const listed = new Set([
    ...[...liveInner.matchAll(/<FreeTask\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]!),
    ...[...liveInner.matchAll(/<TakenTask\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]!),
    ...[...liveInner.matchAll(/<Member\b[^>]*?\btaskId="([^"]*)"/g)].map((m) => m[1]!),
  ]);
  for (const r of recs) assert.ok(!listed.has(attrsOf(r).get("id")!), `${r} must not be an id the week is offering`);

  // (d) …and that is exactly what keeps the gate green: no new keys at all.
  assert.doesNotThrow(
    () => assertRegattaSafe(xml, out),
    "a batch that avoids the pool must pass every gate",
  );
});

test("the regatta push gate refuses a lifetime counter with no records behind it", () => {
  // The file the 10-point tutorial-task ban arrived in
  // (`mGameInfo.current-14.xml`): `RegataTasksCompleted=77` over zero
  // `<MyOldTask>`, zero board, zero quota — the game then ran first-timer
  // onboarding under a veteran counter while the server watched. The counter
  // lives outside the `<Regata>` block, so the record-key diff never sees a
  // Var-only change; this refuses exactly that combination.
  const bare =
    '<root><Global><Var name="cityId" v="C1" t="s"/>' +
    '<Var name="RegataTasksCompleted" v="5" t="i"/></Global></root>';
  const raised = bare.replace('v="5"', 'v="77"');
  assert.notEqual(raised, bare, "the raise must actually land");
  assert.throws(
    () => assertRegattaSafe(bare, raised),
    /regatta-counter-without-records/,
    "a counter with no records behind it must be refused on push",
  );
  // Same loaded-vs-pushed rule: arrived-that-way passes, and records behind
  // the raise pass (a batch with history behind it is every other test).
  assert.doesNotThrow(
    () => assertRegattaSafe(raised, raised),
    "a split the save arrived with is never blocked",
  );
  const rec = bare.replace("</Global>", '<MyOldTask id="t1" user="C1"/></Global>');
  const recRaised = rec.replace('v="5"', 'v="77"');
  assert.doesNotThrow(
    () => assertRegattaSafe(rec, recRaised),
    "a counter with records behind it stays pushable",
  );
  // A live board with no records yet is backed too — it runs no tutorial:
  // the instant-copy account that joined regatta straight onto a 12-offer
  // board completed normally and stays clean, so the gate must not fence it.
  const board = bare.replace("</Global>", '<FreeTask id="t1" num="1" ver="1"/></Global>');
  const boardRaised = board.replace('v="5"', 'v="77"');
  assert.doesNotThrow(
    () => assertRegattaSafe(board, boardRaised),
    "a counter with board rows behind it stays pushable",
  );
});

test("regata never issues a slot generation the block already holds", () => {
  // Cause 4 from the ban notes: the clone path copied its source's `num` and
  // `ver` verbatim, so every record it added restated a generation that was
  // already spent — measured at 15 records with **1** distinct triple and 14
  // copies of it, while nothing here looked.
  const out = injectRegata(liveRegattaSave(), 20);
  const recs = [...out.matchAll(/<MyOldTask\b[^>]*?\/?>/g)].map((m) => attrsOf(m[0]));
  const pairs = recs.map((a) => `${a.get("num")}|${a.get("ver")}`);
  assert.equal(pairs.length, 21, "the save's own record plus the twenty added");
  assert.equal(new Set(pairs).size, 21, `a generation may only be issued once: ${pairs.join(" ")}`);

  // And none may run up to the slot's own offer row: a completed task has to
  // predate the offer sitting there now, measured 148>145, 65>55, 58>1, 516>479.
  const rowVer = Number(attrsOf(/<FreeTask\b[^>]*>/.exec(out)![0]).get("ver"));
  for (const a of recs) {
    assert.ok(
      Number(a.get("ver")) < rowVer,
      `slot ${a.get("num")} generation ${a.get("ver")} ran past its offer (${rowVer})`,
    );
  }
});

test("the push gate refuses a repeated slot generation, but not a save that arrived with one", () => {
  const xml = greenWeekSave();
  const out = injectRegata(xml, 15);
  const two = [...out.matchAll(/<MyOldTask\b[^>]*?>/g)].map((m) => m[0]);
  assert.ok(two.length >= 2, "the fixture must hold at least two records to collide");

  // Hand the second record the first one's slot generation — the exact shape
  // the clone path used to write on every record it added.
  const a0 = attrsOf(two[0]!);
  const clone = two[1]!.replace(/num="\d+"/, `num="${a0.get("num")}"`).replace(/ver="\d+"/, `ver="${a0.get("ver")}"`);
  const dupe = out.replace(two[1]!, clone);
  assert.notEqual(dupe, out, "the fixture really does carry the collision");

  let msg = "";
  try {
    assertRegattaSafe(xml, dupe);
  } catch (e) {
    msg = (e as Error).message;
  }
  assert.match(msg, /regatta-slot-gen/, `a repeated generation must be refused, got: ${msg || "(no throw)"}`);

  // The rule is a diff, same as every other key: a file that *arrived* holding
  // the collision keeps it on both sides and is never held hostage for it.
  assert.doesNotThrow(() => assertRegattaSafe(dupe, dupe), "an oddity the save arrived with must never block it");
});

// ---------------------------------------------------------------------------
// The three rails that make "10-15 tasks a day, not a week" honest.
// ---------------------------------------------------------------------------

test("regata never dates a completion before the ones already in the block", () => {
  // `realEndTime` is non-decreasing in document order in every block of the
  // corpus (35/35, 14/14, 104/104 — the fabricator's own output kept it too).
  // A second push used to take its range from the window alone, so its first
  // record landed *before* the batch above it: measured at exactly one
  // out-of-order record per repeat push. Anchoring the range after the newest
  // completion already present makes that impossible rather than unlikely.
  const now = Math.floor(Date.now() / 1000);
  const real = now - 90_000; // finished about a day ago, close enough to "now"
  const xml = liveRegattaSave().replace(
    /takeTime="\d+" completeTime="\d+" endTime="\d+" realEndTime="\d+"/,
    `takeTime="${real - 2100}" completeTime="${real - 120}" endTime="${real}" realEndTime="${real}"`,
  );
  assert.ok(xml.includes(`realEndTime="${real}"`), "the fixture really does sit a day behind");

  const out = injectRegata(xml, 15);
  wellFormed(out);
  const times = [...out.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(times.length, 16, "the save's own record plus the fifteen added");
  assert.equal(times[0], real, "the save's own record keeps the time it arrived with");
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], `completion ${i} (${times[i]}) went back before ${times[i - 1]}`);
  }
  assert.ok(times[times.length - 1] < now, "every added completion is still in the past");
  assert.doesNotThrow(() => assertRegattaSafe(xml, out), "an ordered batch must pass the gate");
});

test("regata spreads a batch far past the old daily envelope instead of refusing it", () => {
  // The fabricator's output was 105 records all landing on **one** calendar
  // day, and the save behind the ban report held 200 completions in a rolling
  // day against its own `TaskQuota` of 15. That refusal is gone (2026-11-24):
  // the count is taken as typed. What survives is the shape — records still aim
  // for `regattaDensityGap(2 * quota)` and never share a second, so a large
  // batch is spread out rather than piled onto one day.
  const xml = liveRegattaSave();
  const quota = inspectRegatta(xml, 1).quota;
  const cap = regattaDayCap(quota);
  const over = cap + 1;

  assert.equal(inspectRegatta(xml, over).reason, "ok", "one past the old envelope is still pressable");

  const out = injectRegata(xml, over);
  const times = [...out.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(times.length, over + 1, "the save's own record plus every task asked for");
  const winStart = Number(/<Regata\b[^>]*\bstartTime="(\d+)"/.exec(xml)![1]);
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < times.length; i++) {
    if (i) assert.ok(times[i]! > times[i - 1]!, "no two completions share a second");
    assert.ok(times[i]! >= winStart, "no completion sits before the week opened");
    assert.ok(times[i]! < now, "and none is dated in the future");
  }
  assert.doesNotThrow(() => assertRegattaSafe(xml, out), "a batch past the old envelope passes every gate");
});

test("the daily quota is the game's own number, read out of the save", () => {
  // The live client shows "Your Tasks — Today's Tasks: 4/17" with "Quota resets
  // in: 11h 10m" under it: 17 per day is *the game's* number, not this repo's.
  // The same value is already sitting in the save as `<Var name="TaskQuota">`
  // and is mirrored onto every record's `anlLimit` (5/5 real saves), so it has
  // to be read per save — a player whose quota is 9 must not be judged by the
  // 17 a different player sees, and neither may be judged by a figure this
  // tool chose. It now sets the spacing records are *asked* to sit at and
  // nothing more: it is no longer a reason to refuse a batch.
  assert.equal(REGATTA_MAX_PER_DAY, 17, "the ceiling is the quota the game itself displays");

  const at = (quota: string) =>
    liveRegattaSave().replace("</Regata>", `<Vars><Var name="TaskQuota" v="${quota}" t="i"/></Vars></Regata>`);
  const none = liveRegattaSave();

  assert.equal(inspectRegatta(none, 12).quota, 17, "a save that states no quota falls back to the game's own");
  assert.equal(inspectRegatta(at("9"), 12).quota, 9, "a save that states a smaller quota is held to it");
  assert.equal(inspectRegatta(at("30"), 12).quota, 17, "a quota no save has ever shown is clamped, not believed");

  const times = (xml: string) =>
    [...xml.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);

  // The quota still sets the spacing a batch **aims** for — a save at quota 9
  // gets a wider gap than one at 17 — but it no longer refuses anything. That
  // is the whole difference: the number is a shape guard, not a limit.
  assert.equal(inspectRegatta(none, 100).reason, "ok", "100 in one day is taken as typed");
  assert.equal(inspectRegatta(at("9"), 100).reason, "ok", "and so is 100 on a quota-9 save");

  // What it writes still honours the spacing its own quota asks for.
  const low = times(injectRegata(at("9"), 18));
  assert.equal(low.length, 19, "the quota-9 batch really is written (one record was already there)");
  const gap = regattaDensityGap(regattaDayCap(9));
  for (let i = 1; i < low.length; i++) {
    assert.ok(low[i]! - low[i - 1]! >= gap, "two completions sat closer than a quota-9 day allows");
  }
});

test("regatta takes any count the window can hold — the ceiling is a typo guard, not a rule", () => {
  // The field used to snap back to 73 and the payload was clamped to the same
  // figure, so asking for 100 came back as 73 with a paragraph of prose under
  // the button explaining a limit nobody had asked for. Both are gone: the
  // number is taken as typed, and all that survives is a bound large enough
  // that a stray digit cannot ask the injector to emit a million records and
  // hang the session.
  assert.ok(REGATTA_MAX_TASKS >= 100, "the ceiling must sit above any count a user realistically types");
  assert.notEqual(REGATTA_MAX_TASKS, 73, "the old policy figure must not come back");
  assert.equal(regattaWant(50), 50, "50 is taken as typed");
  assert.equal(regattaWant(100), 100, "100 is taken as typed");
  assert.equal(regattaWant(REGATTA_MAX_TASKS + 1), REGATTA_MAX_TASKS, "a typo still cannot ask for a million");

  // The count is taken as typed — no snap-back, no paragraph of prose about a
  // limit nobody asked for, and no daily-envelope refusal either: the only
  // bound left is the typo guard above.
  const xml = liveRegattaSave();
  assert.equal(inspectRegatta(xml, REGATTA_MAX_TASKS).reason, "ok", "even the typo ceiling is pressable");

  const out = injectRegata(xml, 300);
  assert.equal(
    (out.match(/<MyOldTask\b/g) ?? []).length,
    301,
    "three hundred tasks land on top of the save's own record",
  );
  const times = [...out.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1]));
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < times.length; i++) {
    if (i) assert.ok(times[i]! > times[i - 1]!, "no two completions share a second");
    assert.ok(times[i]! < now, "a completion must never be dated in the future");
  }
});

test("regatta takes every count today's envelope holds, and refuses the next — on every save shape", () => {
  // The reports this pins came from the same tab: 20 refused as "the regatta
  // window is too short" on a week opened that afternoon, 50 refused as "no
  // real task to copy" on a save that had completed nothing, and 50 refused
  // again as "already full". None of those three survive. What governs a push
  // now is the save's own daily envelope — `2 * TaskQuota` completions in any
  // rolling 24 h, spaced `regattaDensityGap` apart — and the badge reports the
  // same number the push enforces, so a count inside it always goes through
  // and the next one is refused with "only N fit".
  const now = Math.floor(Date.now() / 1000);
  const clone = liveRegattaSave(); // holds one record -> the normal clone path
  const young = youngRegattaSave(); // opened ten minutes ago, record 7 min old
  // A green week: a full offer pool, a quota, and nothing completed. `TaskQuota`
  // is required because a record's `anlLimit` mirrors it on 5/5 real saves and
  // a block that states none has no state to build the field from.
  const green =
    '<Global><Var name="cityId" v="MECITY1" t="s"/>' +
    `<Regata id="533" startTime="${now - 3 * 86400}" endTime="${now + 4 * 86400}" score="100" scoreUpd="1">` +
    '<FreeTask id="match3_create_bonus_bomb_1" num="1" ver="9"/>' +
    '<FreeTask id="match3_create_bonus_rocket_1" num="2" ver="4"/>' +
    '<FreeTask id="trains_3" num="3" ver="12"/>' +
    '<Vars><Var name="TaskQuota" v="15" t="i"/></Vars>' +
    "</Regata></Global>";

  const fixtures: readonly (readonly [string, string])[] = [
    ["clone", clone], // one record already there, no TaskQuota
    ["young", young], // opened ten minutes ago, newest completion 7 min old
    ["green", green], // a full offer pool, TaskQuota 15, nothing completed
  ];
  for (const [name, xml] of fixtures) {
    const already = (xml.match(/<MyOldTask\b/g) ?? []).length;
    // Every count, small and far past the old daily envelope, is pressable and
    // writes exactly that many records. The three refusals that used to live
    // here (window too short, already full, today's envelope crossed) are gone.
    for (const n of [1, 2, 5, 12, 20, 50, 100]) {
      assert.equal(inspectRegatta(xml, n).reason, "ok", `${name}: ${n} must be pressable`);
      const out = injectRegata(xml, n);
      assert.equal(
        (out.match(/<MyOldTask\b/g) ?? []).length,
        already + n,
        `${name}: ${n} asked but ${(out.match(/<MyOldTask\b/g) ?? []).length} written`,
      );
      const winStart = Number(/<Regata\b[^>]*\bstartTime="(\d+)"/.exec(xml)![1]);
      const winEnd = Number(/<Regata\b[^>]*\bendTime="(\d+)"/.exec(xml)![1]);
      // Taken after the push, for the same reason as above: the injector dates
      // every record before its own `now`, so a clock read before it would race.
      const wallNow = Math.floor(Date.now() / 1000);
      let prev = 0;
      for (const m of out.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)) {
        const t = Number(m[1]);
        assert.ok(t >= prev, `${name} ${n}: the block stays ordered`);
        assert.ok(t >= winStart && t <= winEnd, `${name} ${n}: ${t} sits outside the window`);
        assert.ok(t < wallNow, `${name} ${n}: a completion may never be dated in the future`);
        prev = t;
      }
      assert.doesNotThrow(() => assertRegattaSafe(xml, out), `${name} ${n}: every gate must stay green`);
    }
  }
});

test("a second push takes what today's envelope still holds, and refuses the rest instead of piling up", () => {
  // The report, verbatim: *"after i push 50 tasks it works, but if i want to
  // push more then i can't push it shows error"*. The count is **added**, not
  // the week's target total (`already_full` is gone) — but a repeat push may
  // not pile onto the day it just filled either: it takes what the save's own
  // envelope still holds, and the refusal names the number instead of writing
  // 50 completions inside 55 seconds, which is the shape that got an account
  // banned (101 records, 45 identical timestamps, one rolling day).
  const now = Math.floor(Date.now() / 1000);
  const start = now - 4 * 86400;
  const rec = (real: number, ver: number) =>
    `<MyOldTask id="match3_bomb_999" type="event_order" eventType="Match3" target="create_bonus_bomb" ` +
    `need="100" have="100" user="MECITY1" num="4" ver="${ver}" takenCounter="${ver}" score="135" ` +
    `takeTime="${real - 2100}" completeTime="${real - 120}" endTime="${real}" realEndTime="${real}" ` +
    `regataCash="17" anlNumber="1" anlLimit="10"/>`;
  const xmlAt = (done: number) =>
    '<Global><Var name="cityId" v="MECITY1" t="s"/>' +
    `<Regata id="507" startTime="${start}" endTime="${now + 7 * 86400}" score="135" scoreUpd="${start}">` +
    '<FreeTask id="match3_bomb_999" num="4" ver="99"/>' +
    rec(done, 1) +
    "</Regata></Global>";

  // A short while after the first push of the day: one record, finished an hour
  // ago. Fifty more used to be refused here ("only one fits"); it is now taken
  // as typed and spread across the seconds the block has left.
  const xml = xmlAt(now - 3600);
  assert.equal(inspectRegatta(xml, 50).reason, "ok", "fifty is a count, not a refusal");

  const many = injectRegata(xml, 50);
  const manyTimes = [...many.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(manyTimes.length, 51, "the record the block held plus all fifty");
  for (let i = 1; i < manyTimes.length; i++) {
    assert.ok(manyTimes[i]! > manyTimes[i - 1]!, "ordered, and no two share a second");
  }
  const wallNow = Math.floor(Date.now() / 1000);
  for (const t of manyTimes) assert.ok(t >= start && t < wallNow, "inside the window and never in the future");
  assert.doesNotThrow(() => assertRegattaSafe(xml, many), "a large repeat push stays clean through the gate");

  // And a small batch on the same save still takes the safe spacing when the
  // block has the room for it.
  const later = xmlAt(now - 10 * 3600);
  const room = 8;
  const batch = injectRegata(later, room);
  const times = [...batch.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(times.length, room + 1, "the batch lands on top of the record the block already held");
  const gap = regattaDensityGap(regattaDayCap(inspectRegatta(later, 1).quota));
  const now2 = Math.floor(Date.now() / 1000);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i]! - times[i - 1]! >= gap, "ten hours of room still gets the full safe gap");
    assert.ok(times[i]! >= start && times[i]! < now2, "ordered, inside the window and never in the future");
  }
  assert.doesNotThrow(() => assertRegattaSafe(later, batch), "a batch after the pile ages must stay clean");
});

test("regatta adds to an existing pile without refusing, and the gate still decides the shape", () => {
  // The save behind the ban report held 200 live completions inside one
  // rolling day against its own `TaskQuota` of 15. That is a shape worth
  // refusing only if *this tool* writes it; the count itself is no longer
  // refused, so a save that already carries a pile still takes a batch — placed
  // after its newest record, in distinct seconds, and judged by the ban gate.
  const now = Math.floor(Date.now() / 1000);
  const start = now - 4 * 86400;
  const end = now + 3 * 86400;
  const pile = (count: number, base: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `<MyOldTask id="match3_bomb_999" type="event_order" eventType="Match3" target="create_bonus_bomb" ` +
        `need="100" have="100" user="MECITY1" num="4" ver="1" takenCounter="${i + 2}" score="135" ` +
        `takeTime="${base + i}" completeTime="${base + i}" endTime="${base + i}" realEndTime="${base + i}" ` +
        `regataCash="17" anlNumber="1" anlLimit="15"/>`,
    ).join("");
  const save = (base: number) =>
    '<Global><Var name="cityId" v="MECITY1" t="s"/>' +
    `<Regata id="540" startTime="${start}" endTime="${end}" score="135" scoreUpd="${start}">` +
    '<FreeTask id="match3_bomb_999" num="4" ver="99"/>' +
    '<Vars><Var name="TaskQuota" v="15" t="i"/></Vars>' +
    pile(30, base) +
    "</Regata></Global>";

  // Thirty completions inside the newest minutes no longer blocks the next one.
  const today = save(now - 600);
  const state = inspectRegatta(today, 1);
  assert.equal(state.quota, 15, "the save's own quota is what governs, not a constant");
  assert.equal(state.reason, "ok", "a pile already on file is not a reason to refuse");
  const one = injectRegata(today, 1);
  const oneTimes = [...one.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(oneTimes.length, 31, "one more lands on top of the thirty");
  assert.ok(oneTimes[30]! > oneTimes[29]!, "after the pile's newest record, never before it");
  assert.doesNotThrow(() => assertRegattaSafe(today, one), "the gate still decides the shape");

  // An older pile takes a whole batch: the batch packs to the recent end, away
  // from the pile, so it shares no rolling day with it.
  const aged = save(now - 2 * 86400);
  const batch = injectRegata(aged, 40);
  const times = [...batch.matchAll(/<MyOldTask\b[^>]*?\brealEndTime="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(times.length, 70, "the aged pile plus every task asked for");
  const wallNow = Math.floor(Date.now() / 1000);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! > times[i - 1]!, "ordered, distinct seconds");
  for (const t of times) assert.ok(t >= start && t < wallNow, "inside the window and never in the future");
  assert.doesNotThrow(() => assertRegattaSafe(aged, batch), "a batch beside an old pile stays clean through the gate");
});

test("a cloned record takes the live block's TaskQuota, never the archive's", () => {
  // The banned save carried 200 records reading `anlLimit="17"` inside a live
  // block that said `TaskQuota=15`: the templates came from `<PrevRegata>`,
  // whose `anlLimit` mirrors *that* week's quota. The clone path copied the
  // field verbatim, and the gate excuses an archived id from the comparison —
  // which is why nothing caught it. A record has to mirror the block it lands
  // in.
  const now = Math.floor(Date.now() / 1000);
  const start = now - 4 * 86400;
  const rec = (real: number, ver: number, limit: number) =>
    `<MyOldTask id="match3_bomb_999" type="event_order" eventType="Match3" target="create_bonus_bomb" ` +
    `need="100" have="100" user="MECITY1" num="4" ver="${ver}" takenCounter="${ver}" score="135" ` +
    `takeTime="${real - 900}" completeTime="${real - 300}" endTime="${real}" realEndTime="${real}" ` +
    `regataCash="17" anlNumber="1" anlLimit="${limit}"/>`;
  // The live week states quota 15 and already holds one record carrying that
  // block's own `anlLimit="10"`; the template comes from `<PrevRegata>`, the
  // week that wrote 17.
  const xml =
    '<Global><Var name="cityId" v="MECITY1" t="s"/>' +
    `<Regata id="540" startTime="${start}" endTime="${now + 3 * 86400}" score="135" scoreUpd="${start}">` +
    '<FreeTask id="match3_bomb_999" num="4" ver="99"/>' +
    rec(start - 200, 1, 10) +
    '<Vars><Var name="TaskQuota" v="15" t="i"/></Vars>' +
    "</Regata>" +
    `<PrevRegata id="539">${rec(start - 1200, 9, 17)}</PrevRegata>` +
    "</Global>";

  const out = injectRegata(xml, 2);
  const live = out.slice(out.indexOf('<Regata id="540"'), out.indexOf("</Regata>"));
  const records = [...live.matchAll(/<MyOldTask\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(records.length, 3, "the save's own record plus the two the push added");
  assert.equal(attrValue(records[0]!, "anlLimit"), "10", "the record the save arrived with is untouched");
  for (const r of records.slice(1)) {
    assert.equal(attrValue(r, "anlLimit"), "15", "the record mirrors the block it lands in");
    const n = Number(attrValue(r, "anlNumber"));
    assert.ok(n >= 1 && n <= 15, `anlNumber ${n} sits outside the live quota`);
  }
  // The archive is read, never rewritten.
  assert.match(out, /<PrevRegata id="539">[\s\S]*anlLimit="17"/, "the archived record keeps its own quota");
  assert.doesNotThrow(() => assertRegattaSafe(xml, out), "the push gate stays green");
});

test("the day's share is a spacing, so a rolling day can never hold one more", () => {
  // With spacing `s`, any rolling 86400s window holds at most
  // `floor(86400 / s) + 1` completions — so only `s > 86400 / q` keeps that
  // under `q`. `ceil(86400 / q)` lands exactly *on* the boundary and lets one
  // window hold `q + 1`; `floor(86400 / q) + 1` is the smallest spacing that
  // does not. Checked for every quota the game has been seen to hand out.
  for (let q = 1; q <= REGATTA_MAX_PER_DAY; q++) {
    const gap = regattaMinGap(q);
    const held = Math.floor(86400 / gap) + 1;
    assert.ok(held <= q, `quota ${q} allowed a rolling day to hold ${held} completions`);
  }
  assert.equal(
    regattaMinGap(REGATTA_MAX_PER_DAY + 13),
    regattaMinGap(REGATTA_MAX_PER_DAY),
    "a quota past the ceiling is clamped before it is turned into a spacing",
  );
  assert.equal(REGATTA_MIN_GAP, regattaMinGap(), "the fallback is the full-quota spacing");
});

test("regata refreshes a slot's offer row instead of stranding a week on day one", () => {
  // One day's push leaves a slot reading record V / offer V+1 — the state the
  // synthesized path writes *by design*, because a completed task is what
  // replaces an offer. The next day's push has to take generation V+1, which
  // only stays honest by refreshing the row to V+2 alongside it. Refusing here
  // would strand the user on day one of a seven-day week: 10-15 tasks today,
  // and nothing more until the row moved by itself.
  const xml = liveRegattaSave().replace('ver="99"/>', 'ver="2"/>');
  assert.notEqual(xml, liveRegattaSave(), "the fixture really is the day-one state");

  const out = injectRegata(xml, 4);
  wellFormed(out);

  const rowVer = Number(attrValue(/<FreeTask\b[^>]*>/.exec(out)![0], "ver"));
  const recVers = [...out.matchAll(/<MyOldTask\b[^>]*?\bver="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(recVers.length, 5, "the save's own record plus the four added");
  assert.equal(new Set(recVers).size, 5, "a slot generation is issued once");
  assert.ok(rowVer > 2, `the offer row moved forward, got ${rowVer}`);
  for (const v of recVers) {
    assert.ok(v < rowVer, `record ${v} must sit under its slot's offer row ${rowVer}`);
  }
  assert.doesNotThrow(() => assertRegattaSafe(xml, out), "a refreshed row must pass the gate");
  assert.equal(
    inspectRegatta(xml, 4).reason,
    "ok",
    "the tab must predict the very push the server is about to run",
  );
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
  // The shape every real save uses: `,st1,` — one comma wrapped at each end,
  // `,,` between ids, so n ids split into exactly 1 + 2n entries.
  const out = unlockEmoji('<Global><Var name="UnlockedChatEmoji" v=",st1,"/></Global>', ["st2"]);
  wellFormed(out);
  const v = out.match(/\bv="([^"]*)"/)?.[1];
  assert.equal(v, ",st1,,st2,");
  assert.equal(v!.split(",").length, 1 + 2 * 2, "2 ids must yield 5 entries, not 6");
  assert.ok(!v!.endsWith(",,"), "a second trailing comma is a shape no save has");
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