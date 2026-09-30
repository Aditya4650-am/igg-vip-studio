import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assertRegattaSafe,
  injectAvatars,
  injectRegata,
  injectSeason,
  inspectRegatta,
  REGATTA_MAX_TASKS,
} from "./inject.server.ts";
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
    `<FreeTask id="trains_1" num="1" ver="1"/>` +
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
  const out = injectRegata(countedRegattaSave(2), 6); // 2 present, so 4 are added
  wellFormed(out);

  const inner = regattaInner(out);
  const tasks = (inner.match(/<MyOldTask\b/g) ?? []).length;
  assert.equal(tasks, 6, "the batch lands in the block");
  assert.equal(varNum(inner, "taskCounter"), 6, "taskCounter must equal the records the block holds");
  assert.equal(varNum(inner, "takeConfirm"), 6, "takeConfirm tracks the same records");
  assert.ok(
    (varNum(inner, "takeAttempts") ?? 0) >= 6,
    `takeAttempts must never trail takeConfirm, got ${varNum(inner, "takeAttempts")}`,
  );
  assert.equal(varNum(inner, "UnrelatedCounter"), 7, "a Var that is not a task count stays put");
});

test("regata never invents a counter the block never had", () => {
  // `liveRegattaSave`'s <Regata> carries no <Vars> at all: a block that never
  // tracked a count gains none, exactly like RegataTasksCompleted.
  const out = injectRegata(liveRegattaSave(), 3);
  assert.ok(!/<Var\b[^>]*\bname="taskCounter"/.test(out), "no fabricated taskCounter");
  assert.ok(!/<Var\b[^>]*\bname="takeConfirm"/.test(out), "no fabricated takeConfirm");
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
    `score="33890" scoreUpd="${start + 900}">` +
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
    `</Vars>` +
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
    assert.equal(inspectRegatta(xml, n).templates, 6, "the badge counts usable sources");
  }

  const out = injectRegata(xml, 15);
  wellFormed(out);
  const recs = [...out.matchAll(/<MyOldTask\b[^>]*?\/?>/g)].map((m) => m[0]);
  assert.equal(recs.length, 15, "the requested batch lands");

  const pool = new Set([
    ...[...out.matchAll(/<FreeTask\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]!),
    ...[...out.matchAll(/<TakenTask\b[^>]*\bid="([^"]*)"/g)].map((m) => m[1]!),
  ]);
  const start = Number(/<Regata\b[^>]*\bstartTime="(\d+)"/.exec(out)![1]);
  const end = Number(/<Regata\b[^>]*\bendTime="(\d+)"/.exec(out)![1]);
  const now = Math.floor(Date.now() / 1000);
  const byId = new Map<string, Set<string>>();

  for (const r of recs) {
    const a = attrsOf(r);
    const id = a.get("id")!;
    // A record for an id this save was never offered is the old injector's
    // `match3_1..match3_105` output — the single most readable fake there is.
    assert.ok(pool.has(id), `${id} must come from this save's own pool`);
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

  // 6 distinct ids the save can actually source, cycled to 15 — and any id the
  // save offers in `<FreeTask>` keeps that entry's num/ver exactly, which is
  // what a real record does.
  assert.equal(byId.size, 6, "only ids with a measured need and score are used");
  for (const variants of byId.values()) assert.equal(variants.size, 1, "a repeated id repeats identically");

  const freeEntries = new Map(
    [...out.matchAll(/<FreeTask\b[^>]*?\/?>/g)].map((m) => {
      const a = attrsOf(m[0]);
      return [a.get("id")!, { num: a.get("num"), ver: a.get("ver") }];
    }),
  );
  const freeIds = new Set<string>();
  for (const r of recs) {
    const a = attrsOf(r);
    const free = freeEntries.get(a.get("id")!);
    if (!free) continue;
    freeIds.add(a.get("id")!);
    assert.equal(a.get("num"), free.num, "num comes from the save's own pool entry");
    assert.equal(a.get("ver"), free.ver, "ver comes from the save's own pool entry");
  }
  assert.deepEqual(
    [...freeIds].sort(),
    ["match3_create_bonus_bomb_1", "match3_create_bonus_plane_1"],
    "both pool-sourced ids keep their own num/ver on every repeat",
  );

  // A wall of one score is the old injector's fingerprint; this batch is not.
  assert.ok(new Set(recs.map((r) => attrsOf(r).get("score"))).size > 1, "scores must not be uniform");

  // takenCounter starts at 2 the way three untouched weeks all do, and only
  // grows inside the block.
  const counters = recs.map((r) => Number(attrsOf(r).get("takenCounter")));
  assert.deepEqual(counters, counters.map((_, i) => 2 + i), "the fresh counter runs 2,3,… in order");

  // Placement, and the three counters that have to move with the records.
  assert.ok(out.indexOf("<MyOldTask") < out.indexOf("<Vars"), "new records sit before <Vars>");
  assert.match(out, /name="RegataTasksCompleted" v="2319"/, "the lifetime counter gains the batch");
  const added = recs.reduce((a, r) => a + Number(attrsOf(r).get("score")), 0);
  const blockScore = Number(/<Regata\b[^>]*\bscore="(\d+)"/.exec(out)![1]);
  assert.equal(blockScore, 33890 + added, "<Regata score> carries the delta of the batch it holds");
  const newest = Math.max(...recs.map((r) => Number(attrsOf(r).get("completeTime"))));
  assert.equal(Number(/<Regata\b[^>]*\bscoreUpd="(\d+)"/.exec(out)![1]), newest, "scoreUpd is the newest completion");
  // The block declares no taskCounter/takeConfirm, and it gains none.
  assert.ok(!/<Var\b[^>]*\bname="taskCounter"/.test(out), "no fabricated taskCounter");
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

  // The rule is a diff: a save that *arrived* carrying the old injector's
  // uniform 135 keeps that key on both sides and stays pushable. Refusing it
  // would hold a user's own file hostage for something this tool never did.
  const odd = liveRegattaSave();
  assert.doesNotThrow(
    () => assertRegattaSafe(odd, injectRegata(odd, 6)),
    "an oddity the save arrived with must never block it",
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