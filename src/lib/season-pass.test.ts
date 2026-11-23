import { strict as assert } from "node:assert";
import { test } from "node:test";

const { SEASON_PASSES, seasonPassById } = await import("./season-pass.ts");
const { readSeasonPassState, seasonPassOptions, swapSeasonPass } = await import(
  "./server/township/season-pass.server.ts"
);

const NOW = 1_800_000_000;
const DAY = 86_400;

/** A save carrying one live ticket (season 830) with a two-line reward road. */
function save(over: { premium?: string; score?: string; start?: number; end?: number; id?: string; theme?: string } = {}) {
  const id = over.id ?? "830";
  const theme = over.theme ?? "skiresort_83";
  const start = over.start ?? NOW - 5 * DAY;
  const end = over.end ?? NOW + 10 * DAY;
  return [
    "<root><Global>",
    `<Var name="SeasonTicketStartedIds" v="${id}" t="s"/>`,
    `<SeasonTicketCenter lastId="${id}">`,
    `<SeasonTicket id="${id}" packageId="${id}" version="0" startTime="${start}" endTime="${end}" theme="${theme}" `,
    `score="${over.score ?? "0"}" notSeenScore="0" premium="${over.premium ?? "0"}" fullEnded="0">`,
    "<Vars>",
    `<Var name="startStage_SeasonTicket_${id}" v="250" t="i"/>`,
    "</Vars>",
    "<FreeRoad>",
    '<Stage score="0"><Reward type="cash" count="10"/></Stage>',
    '<Stage score="1002"><Reward type="Glass" count="2"/></Stage>',
    "</FreeRoad>",
    "<PremiumRoad>",
    '<Stage score="0"><Reward type="SP_RewardPack" count="1"/></Stage>',
    '<Stage score="1002"><Reward type="ST_Chest" count="1"/></Stage>',
    "</PremiumRoad>",
    "</SeasonTicket>",
    "</SeasonTicketCenter>",
    "</Global></root>",
  ].join("");
}

test("pass: the swap moves only the season the ticket points at", () => {
  const src = save();
  const out = swapSeasonPass(src, "800", NOW);

  assert.equal((out.match(/<SeasonTicket\b/g) ?? []).length, 1, "one ticket, never a rival");
  assert.equal((out.match(/<\/SeasonTicket>/g) ?? []).length, 1, "and it stays balanced");
  assert.match(out, /<SeasonTicketCenter lastId="800">/, "the center names the season it shows");

  const state = readSeasonPassState(out, NOW);
  assert.equal(state.id, "800");
  assert.equal(state.theme, "harvest_80");
  assert.equal(state.premium, true, "the golden road is opened");
  assert.equal(state.score, 1002, "at the block's own highest stage");
  assert.deepEqual(state.startedIds, ["830", "800"], "a started season is only ever added, never dropped");

  // The reward roads are the pass's content and must survive untouched.
  for (const marker of [
    '<Stage score="0"><Reward type="cash" count="10"/></Stage>',
    '<Stage score="1002"><Reward type="ST_Chest" count="1"/></Stage>',
    "<FreeRoad>",
    "<PremiumRoad>",
  ]) {
    assert.ok(out.includes(marker), `road content survived: ${marker}`);
  }
  assert.ok(out.includes('<Var name="startStage_SeasonTicket_830"'), "the block's own vars are kept");
});

test("pass: every catalog season is one this build ships art for", () => {
  const themes: Record<string, string> = {
    "800": "harvest_80",
    "810": "wildwest_81",
    "820": "halloween_82",
    "830": "skiresort_83",
    "840": "christmas_84",
  };
  for (const s of SEASON_PASSES) {
    assert.equal(s.theme, themes[s.id], `${s.id} keeps its measured theme`);
    assert.ok(s.art.startsWith("/game-icons/passes/"), `${s.id} has its cropped plaque`);
    assert.ok(s.name.endsWith("Pass"), `${s.id} is named the way the game names it`);
  }
  assert.equal(seasonPassById("790"), null, "an id with no pack is never offered");
});

test("pass: a season this build has no content for is refused", () => {
  const src = save();
  for (const dead of ["790", "760", "730", "0", ""]) {
    assert.throws(() => swapSeasonPass(src, dead, NOW), /không có dữ liệu/, `refused ${dead}`);
  }
});

test("pass: a save that never ran a season is refused, not invented", () => {
  const bare = "<root><Global><Var name=\"SeasonTicketShowArrow\" v=\"0\"/></Global></root>";
  assert.throws(() => swapSeasonPass(bare, "800", NOW), /chưa có SeasonTicket/);
  assert.equal(readSeasonPassState(bare, NOW).id, null);
});

test("pass: a season already open at maximum is not reported as applied", () => {
  const open = save({ premium: "1", score: "1002" });
  assert.throws(() => swapSeasonPass(open, "830", NOW), /đã mở sẵn/);
});

test("pass: a closed window is re-anchored around now, a live one is kept", () => {
  const live = save();
  const kept = swapSeasonPass(live, "800", NOW);
  assert.equal(readSeasonPassState(kept, NOW).start, NOW - 5 * DAY);
  assert.equal(readSeasonPassState(kept, NOW).end, NOW + 10 * DAY);

  const closed = save({ start: NOW - 40 * DAY, end: NOW - 20 * DAY });
  const moved = swapSeasonPass(closed, "800", NOW);
  const st = readSeasonPassState(moved, NOW);
  assert.ok(st.live, "the pass is enterable again");
  assert.ok(st.start! <= NOW && st.end! >= NOW);
  assert.equal(st.end! - st.start!, 20 * DAY, "the block's own length is preserved");
});

test("pass: the options list marks the season the save is showing", () => {
  const opts = seasonPassOptions(save());
  assert.equal(opts.length, SEASON_PASSES.length);
  assert.deepEqual(opts.filter((o) => o.current).map((o) => o.id), ["830"]);
  const switched = seasonPassOptions(swapSeasonPass(save(), "820", NOW));
  assert.deepEqual(switched.filter((o) => o.current).map((o) => o.id), ["820"]);
});
