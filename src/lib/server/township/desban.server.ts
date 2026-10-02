import { spawn } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_EMOJI_IDS } from "./chat-emoji.server";
import { decodeContainer, extractXml, shellErrorMessage } from "./save-decode.server";
// `isRealAvatarId` lives in the shape gate on purpose: the restore and the
// gate have to agree on which avatar ids the game can hold, or the restore
// writes ids the gate then refuses. One definition, two callers.
import { isRealAvatarId } from "./save-shape.server";
import { accountAgeSeconds, readCoopId, writeVar } from "./vars.server";
import { attrValue, insertInsideRoot } from "./xml-edit.server";

// Current Township API metadata, matching the reference client's defaults in
// scripts/township/ts_township_core.py. Used only when mLocalInfo cannot supply
// the real values, so FetchCity is not impossible on an unreadable install.
// Acceptance floor measured against township.playrix.com: bver 36.0.0 and below
// are rejected with HTTP 403, 37.0.0 and above are accepted and answer
// "no data" for an unknown city. Keep this in step with current Township
// releases; a fallback below the floor reproduces the same 403 the missing
// LocalInfo caused, which makes the fix look like it did nothing.
const DEFAULT_BVER = "39.0.3";
const DEFAULT_FVER = "3903";

const INICIAL_VARS = [
  "levelup", "money", "moneyCash", "EarnedCoins",
  // `residents` and its capacity move as one pair, the same way
  // `WareHouseCashUpgrade` / `WHUdup` below always do. Copying the population
  // without the cap under it writes a save claiming more residents than the
  // city can hold — measured on the save reported banned on 2026-10-01:
  // `residents=85380` against `maxResidents=75`, **1138x over its own cap**,
  // while both saves the user reports as ban-free sit under theirs (60/75 and
  // 68085/76315) and all five corpus saves do too (85380/85445, 295/1955,
  // 84545/84545, 11055/11265). `maxResidents` appeared nowhere in this codebase
  // before: the cap was simply left behind, which is exactly the shape the
  // `level`/`slx` and `WHUdup` rules exist to refuse. Skipped on its own when a
  // donor has no cap — the loop below only writes names the donor declares.
  "residents", "maxResidents", "wheatCounter",
  "plowFieldsAchiev", "defaultOrdersCount", "match3Life", "Match3Lives_infTime",
  "spentCash", "earnedCash", "timeInGame",
  // Deliberately absent — lifetime facts Playrix tracks against the *player*
  // rather than the town. The reference tool's 18-name tuple leaves all eight
  // out too, though its FIELD_MAP stats loop does re-add the first six — so
  // excluding them is a deliberate divergence, not a match (see the note above
  // TUTORIAL_DONE). The last two are absent from that tool entirely.
  //   gameStartDate, RegataTasksCompleted, FirstAttemptM3Levels,
  //   FullCardCollections, LivesSent, Achievement_Teamwork,
  //   Achievement_BuiltHouses, Achievement_CompleteMatch3Levels
  //
  // The reference tool's five achievements, exactly. It never copies the other
  // ~260 a high-level city carries.
  "Achievement_BuiltFactories", "Achievement_EarneCoins",
  "Achievement_IncreasedPopulation", "Achievement_PlowedFields", "Achievement_SpentCoins",
  // City state rather than account history: barn capacity, its WHUdup partner
  // and land expansions describe the town, so they follow the town.
  "WareHouseCashUpgrade", "WHUdup", "ExpandLevel",
];

/**
 * `experience` is deliberately **not** in `INICIAL_VARS`, and unlike the eight
 * names above it is measured rather than reasoned: it is the *single* variable
 * a basic-stats push writes today that the version known to run without a ban
 * (`ab46f0b`, 2026-09-30 23:10 — the 11:00-11:40pm window on record) left
 * untouched.
 *
 * Both implementations were run over the same four real save pairs and each
 * output diffed against the file it started from. Across all four, the set of
 * values HEAD changes that `ab46f0b` never changed is exactly one entry:
 *
 *   mGameInfo_decoded <- fc_big   experience 2436381253 -> 3370037992
 *   fc_ok             <- fc_big   experience   172109   -> 3370037992
 *   mGameInfo.current <- fc_big   experience     3138   -> 3370037992
 *   save9_after       <- fc_ok    experience      984   ->    172109
 *
 * Every *other* value this writes was already written by `ab46f0b` and drew no
 * ban, and HEAD touches strictly fewer variables than that baseline did (399 vs
 * 454, 387 vs 443, 365 vs 420, 55 vs 92) — so the restore's delta from the
 * loaded file is a strict subset of the proven-good one, plus this single
 * addition. `experience` is a cumulative counter Playrix keeps per account; on
 * the real pairs it moved by up to 933,656,739 in one sync.
 *
 * It joined `INICIAL_VARS` in `4f5a37a` at 05:05 on 2026-10-01 — five hours
 * *after* the working window — and the `level-up-without-experience` gate went
 * in with it, which is why both had to come back out together: leaving the gate
 * while dropping the write would refuse every restore that raises the level.
 *
 * The honest limit: `ab46f0b`'s output carried a level that moved while the XP
 * behind it did not, and it did not ban. So the "arithmetically impossible pair"
 * reasoning below was not what made that build safe, and it must not be used to
 * justify putting `experience` back.
 */

/**
 * Account history that follows the town — **only** in the modes that copy the
 * town (`completo` / `novo`), never in `inicial`.
 *
 * Measured on 2026-10-01 against the user's own proven-good baseline
 * (`ab46f0b`, the 11:00-11:40pm window): running both implementations side by
 * side over four real save pairs in *both directions* gives
 *
 *   [A] written by HEAD, never by ab46f0b ................ 0  (all three modes)
 *   [B] written by ab46f0b, never by HEAD ............... 56 (all three modes)
 *
 * so a restore today is the proven-good one **minus 56 values**, and `[B]` is
 * headed by `gameStartDate` in 4/4 pairs. That is the reported symptom
 * verbatim — *"my original city date is shown, not the copy town date, after
 * copy the town"* — and it is exactly what the reference tool's own
 * "Desban completo" docstring says to copy:
 *
 *   > `Achievement_* vars, ... MapOrders, fielditself, CHT_* hints, _state
 *   > tutorial vars` / `TownGround + Buildings, FIELD_MAP stats, Skins,
 *   > BuildingsStash, Stickers, Badges, Titulos, Molduras, Estilos, Avatares`
 *
 * `FIELD_MAP` carries `gameStartDate`, `FirstAttemptM3Levels`, `LivesSent`,
 * `Achievement_Teamwork`, `FullCardCollections` and `RegataTasksCompleted`.
 *
 * **Why the town decides it.** `inicial` does not clone `TownGround` /
 * `Buildings`, so it changes a handful of flat vars and there is nothing in the
 * file for them to contradict — it works today with this set absent, and stays
 * exactly as it is. `completo` / `novo` transplant the friend's whole town: the
 * museum, zoo, trains, expansions and decor all say "veteran account" while
 * our own counters said "founded two months ago, 5 friends ever helped, 136
 * regatta tasks". The contradiction then sits *inside the blocks just copied*,
 * which is a far cheaper thing for a server to read than a level/XP pair.
 * Copying the history with the town is what removes it, and it is what both
 * the reference tool and the no-ban build did.
 *
 * `experience` is still **not** here — see the note above `INICIAL_VARS`.
 * Nothing here is a value Playrix holds against *our* account once the town it
 * describes belongs to the friend.
 */
export const TOWN_HISTORY_VARS = [
  "gameStartDate", "FirstAttemptM3Levels", "LivesSent",
  "FullCardCollections", "RegataTasksCompleted",
];

const COMPLETO_BLOCKS = [
  "Zoo", "ZooInfo", "ZooQuests", "ArtInfo", "Ernie", "Trains", "IslandsInfo",
  "WildPark", "WildParkStash", "BuildingsStash", "AirInfo", "MapOrders",
  "FragmentedBeautyManager",
];

// DataStoreCollection is deliberately NOT in this list. It is the donor's
// profile/event store (measured on a real FetchCity response: 1.4 MB, 38 copies
// of the donor's cityId, 58 `mainPlayer` records, 161 `saveId` records and the
// `currentProfiles` account-switcher list). Copying it made "All" write another
// player's account as this save's main player, which Playrix rejects on upload —
// an instant ban. Every other block here measured clean of identity markers.
// The reference tool copies DSCollection in the same step and never copies
// DataStoreCollection either.
const NOVO_BLOCKS = ["Minigames", "DSCollapseQuests", "QuestsBook", "DSCollection"];

/**
 * What a restore deliberately does **not** copy — settled by disassembling the
 * reference tool instead of guessing.
 *
 * `twndesban2.pyc`'s basic-stats step, `_apply_desban`, copies exactly 18 vars:
 *
 *   levelup, money, moneyCash, EarnedCoins, residents, wheatCounter,
 *   plowFieldsAchiev, defaultOrdersCount, match3Life, Match3Lives_infTime,
 *   Achievement_IncreasedPopulation, Achievement_PlowedFields,
 *   Achievement_BuiltFactories, Achievement_SpentCoins, Achievement_EarneCoins,
 *   spentCash, earnedCash, timeInGame
 *
 * It writes in **two** passes, and that distinction matters:
 *
 * 1. the 18-name tuple above, via its own `copy_var`;
 * 2. `FIELD_MAP`, eleven display stats it also *writes* — `money`, `levelup`,
 *    `moneyCash`, three match-3 level vars, `expeditionEnergy` and six
 *    lifetime fields: `FirstAttemptM3Levels`, `LivesSent`,
 *    `Achievement_Teamwork`, `FullCardCollections`, `RegataTasksCompleted`,
 *    `gameStartDate`.
 *
 * So the tuple leaves those six out but `FIELD_MAP` puts them back. An earlier
 * revision of this note claimed they occur in that module only for
 * `get_xml_stats` — **false**: `FIELD_MAP` is a module global, so its strings
 * never appear among `_apply_desban`'s own constants, and a search that stops
 * at the tuple misses them. We exclude them anyway; that is a deliberate
 * divergence from the reference tool, taken because each is a lifetime fact
 * Playrix holds against the **account** and none of them describes the town:
 *
 * - `gameStartDate`          one value per player — 1130782500, 1658707200,
 *                            1785587932, 1356976800, 1744643813 across five
 *                            saves — and the cheapest kind of mismatch for a
 *                            server to read.
 * - `RegataTasksCompleted`   9868 -> 44911 across one real copy.
 * - `FirstAttemptM3Levels`   5698 -> 92524 across the same copy.
 * - `FullCardCollections`    lifetime collection progress.
 * - `LivesSent`, `Achievement_Teamwork`   lifetime social counters.
 *
 * For the same reason the blanket achievement loop that used to run here is
 * gone: `for (m of fr.matchAll(/<Var name="(Achievement_[^"]+)"/))` copied
 * **every** achievement the donor held — 265 entries on a real run — while the
 * reference tool copies five through the tuple plus `Achievement_Teamwork`
 * through `FIELD_MAP`. `Achievement_BuiltHouses` and
 * `Achievement_CompleteMatch3Levels` are absent from it entirely.
 *
 * Everything else still moves: level, money, residents, orders, barn,
 * expansions, tutorial state. "Basic stats" still reads as the friend's city;
 * this is the whole of what it stopped touching — and `experience`, which this
 * used to copy, is now absent for a separate and measured reason recorded in
 * the note above `INICIAL_VARS`. Dropping it also brings us back in line with
 * the reference tool, which never copied it either.
 */
const TUTORIAL_DONE = [
  "StartTutorialFinished",
  "SecondStartTutorialFinished",
  "SecondStartTutorialShowed",
  "TrainTutorialShowed",
  "wasTrainTutorial",
  "CommTutorialShowed",
  "HarborTutorShowed",
  "HarborTutor2Showed",
  "DiggingTutorShowed",
  "AirTutorShowed",
  "AirTutorialShowed",
  "DealerAvailableTutShowed",
  "DealerShowedOnce",
  "NeedHousesTutShowed",
  "TutorialEditGroundShowed",
  "TutorialEditGroundTipShowed",
  "FirstDiggingRoomShowed",
  "FirstDiggingStoneShowed",
  "FirstDiggingHardstoneShowed",
  "BuildSmelteryTutShowed",
  "BuildAcademyTutShowed",
  "IndustryAcademyTutShowed",
  "SeasonTicketTutorShowed",
  "QuestsBookTutorialShowed",
  "CityM3FirstTutorialCompleted",
  "MayorsDutiesTutorialCompleted",
  "MayorsBreakTutorialCompleted",
  "CardC_Tutorial_MainWindow_Completed",
  "CardC_Tutorial_Button_Completed",
  "CardC_Tutorial_Set_Completed",
  "CascadeEventMergeTutorialShowed",
  "ClanCongratShowed",
  "ClanInviteShowed",
  "FriendsCodeHelpShowed",
  "FriendsInviteHelpShowed",
  "museumThanksShowed",
  "museumUpdateShowed",
  "CherylTutorialLastEnable",
  "appsFlyerTutorialFinishedTracked",
  "TutorialTrainGenerated",
  "tutorialAllowBigStoreBages",
  "DN_Tutor1_Completed",
  "DN_Tutor2_Completed",
  "DN_Tutor3_Completed",
  "DN_Tutor4_Completed",
  "DN_Tutor5_Completed",
  "DN_Tutor6_Completed",
  "DN_Tutor1_Promo_Completed",
  "DN_Tutor3_Started",
  "DN_Tutor6_Started",
  "RoomsCommonTutorialShowed",
  "RoomOffice_Tutorial_Friend_Showed",
  "Room_Tutorial_CityHall_OldRoomBecomeAvailable_Shown",
  "TutorialCloudHousesShowed",
  "TutorialCloudMilkfactoryShowed",
  "TutorialCloudStore101Showed",
  "TutorialCloudCountmessage_houses_tutorial",
  "TutorialCloudCountmessage_build_milkfactory_tutorial",
  "TutorialCloudCountmessage_build_store_tutorial",
  "TutorialCloudCountmessage_hungry_cows_tutorial",
  "TutorialCloudCountmessage_sell_products_tutorial",
  "TutorialCloudCountmessage_community_ready_tutorial",
  "TutorialCloudCountmessage_free_field_tutorial",
  "TutorialEventRegataTaskShow",
  "Tutorial_SuperLightning_PlayBtn_Shown",
  "Tutorial_SP_DiggingPremium",
  "Tutorial.HelpedInNewWindow",
  "TermsOfServiceAccept",
  "TutorialZooShowed",
  "TutorialZooStartShowed",
  "TutorialZooDupCardShowed",
  "ZooVisited",
  "ZooRepairShowed",
  "ZooRepairReminderShowed",
  "MarketVisited",
  "wasMarketOffer",
  "RefuseOrderTutShowed",
  "TutorialDealerFreeDayNotice",
  "TutorialRegataSeasonStoreShowed",
  "flowerShopIntro",
  "FirstDiggingClayShowed",
  "RepairDiggingTutShowed",
];

const TUTORIAL_OFF = [
  "FirstGameLoad",
  "NeedArrowOnMarket",
  "NeedArrowOnZoo",
  "NeedArrowOnYachtPier",
  "NeedArrowOnDigging",
  "NeedArrowOnHarbor",
  "NeedArrowOnTrain",
  "NeedArrowOnAir",
  "NeedArrowOnClan",
  "NeedArrowOnShield",
  "NeedOpenEventCenterPanelAfterRestartGame",
  "warehouse_full_tutorial",
  "warehouse_full_tutorial_second",
  "DealerNeedTutorialArrow",
  "TapDealerAfterTutorial",
  "NeedShowDiggingFirecracker",
  "NeedShowDiggingMissTools",
];

const STATE_SUFFIXES = [
  "Tutorial_state",
  "Tutorialsq0_state",
  "Tutorialsq1_state",
];

export type Friend = { id: string; name: string; level: number; type: "friend" | "request" };

function readVarLoose(xml: string, name: string): string | null {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    xml.match(new RegExp(`<Var\\b[^>]*\\bname="${n}"[^>]*\\bv="([^"]*)"`, "i"))?.[1] ??
    xml.match(new RegExp(`<Var\\b[^>]*\\bv="([^"]*)"[^>]*\\bname="${n}"`, "i"))?.[1] ??
    null
  );
}

function setOrInsert(xml: string, name: string, value: string) {
  const before = xml;
  const next = writeVar(xml, name, value);
  return { xml: next, action: next === before ? "same" : "set" };
}

function findAllBlocks(xml: string, tag: string): { start: number; end: number; block: string }[] {
  const low = xml.toLowerCase();
  const needle = `<${tag.toLowerCase()}`;
  const results: { start: number; end: number; block: string }[] = [];
  let start = 0;
  while (true) {
    const i = low.indexOf(needle, start);
    if (i < 0) break;
    const after = i + needle.length;
    if (after < xml.length && !" \t\r\n>/".includes(xml[after]!)) {
      start = after;
      continue;
    }
    const gt = xml.indexOf(">", i);
    if (gt < 0) break;
    if (xml[gt - 1] === "/") {
      results.push({ start: i, end: gt + 1, block: xml.slice(i, gt + 1) });
      start = gt + 1;
      continue;
    }
    const j = low.indexOf(`</${tag.toLowerCase()}`, gt + 1);
    if (j < 0) {
      start = after;
      continue;
    }
    const gt2 = xml.indexOf(">", j);
    if (gt2 < 0) break;
    results.push({ start: i, end: gt2 + 1, block: xml.slice(i, gt2 + 1) });
    start = gt2 + 1;
  }
  return results;
}

function zooEnd(xml: string) {
  const m = xml.match(/<\/Zoo\s*>/i);
  return m && m.index !== undefined ? m.index + m[0].length : -1;
}

function pickMain(xml: string, tag: string) {
  const blocks = findAllBlocks(xml, tag);
  if (!blocks.length) return null;
  const z = zooEnd(xml);
  const after = z >= 0 ? blocks.filter((b) => b.start >= z) : [];
  const pool = after.length ? after : blocks;
  return pool.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
}

/**
 * The user id a save's own records are attributed to, in the order builds
 * actually expose it: an `<Object user="...">` (what the reference tool
 * rewrites), the declared cityId, then any record already carrying one. Saves
 * disagree on which of these is live, so take the first that exists rather
 * than assuming a single layout.
 */
function attributedUser(xml: string): string | null {
  const obj = xml.match(/<Object\b[^>]*\buser="([^"]+)"/i);
  if (obj?.[1]) return obj[1]!;
  const owner = parseOwnMeta(xml).cityId;
  if (owner) return owner;
  return xml.match(/\buser="([^"]+)"/i)?.[1] ?? null;
}

/**
 * Re-point records copied out of another player's save at us. Current builds
 * carry no `user=` on town objects at all (verified against every save on hand,
 * including a live FetchCity response), so this is normally a no-op — but a
 * foreign owner left on a copied object is the one thing a cloned town must
 * never carry. When the donor's id cannot be re-pointed at ours, the attribute
 * is dropped rather than pushed.
 */
function reattribute(block: string, src: string, tgt: string): string {
  if (!/\buser="/i.test(block)) return block;
  const ours = attributedUser(tgt);
  if (!ours) return block.replace(/\s+user="[^"]*"/gi, "");
  const theirs = attributedUser(src);
  const point = theirs ? block.split(`user="${theirs}"`).join(`user="${ours}"`) : block;
  // Anything still carrying another owner is foreign — never push it.
  return point.replace(/\s+user="([^"]*)"/g, (_m, v: string) => (v === ours ? ` user="${ours}"` : ""));
}

/**
 * Merge guard: a copy taken from another player's save must not carry that
 * player's identity into ours. Playrix checks the declared owner of a save on
 * upload, so a leaked cityId / deviceId / profile record there is an instant
 * ban rather than a cosmetic bug — fail loudly before the file is pushed.
 *
 * Every check compares the result against the save we started from, so a
 * marker already in our own file (a teammate in our roster, say) is never
 * mistaken for one we just imported.
 */
export function assertNoForeignIdentity(own: string, merged: string, donor: string) {
  const problems: string[] = [];

  const wasOwner = parseOwnMeta(own).cityId;
  const nowOwner = parseOwnMeta(merged).cityId;
  if (wasOwner && nowOwner && nowOwner !== wasOwner) problems.push(`cityId ${wasOwner} → ${nowOwner}`);

  const hadDevices = new Set([...own.matchAll(/<Var\s+name="deviceId"\s+v="([^"]*)"/gi)].map((m) => m[1]!));
  for (const [, d] of merged.matchAll(/<Var\s+name="deviceId"\s+v="([^"]*)"/gi)) {
    if (d && !hadDevices.has(d)) problems.push(`deviceId ${d}`);
  }

  const hadUsers = new Set([...own.matchAll(/\buser="([^"]*)"/gi)].map((m) => m[1]!));
  const ours = declaredIds(own);
  for (const [, u] of merged.matchAll(/\buser="([^"]*)"/gi)) {
    // Ids our own file claims (cityId, SaveId, …) count as ours: a rewritten
    // donor record is attributed to us even when this save carried no user= of
    // its own before the merge.
    if (u && !hadUsers.has(u) && !ours.has(u)) problems.push(`user id ${u}`);
  }

  const donorId = parseOwnMeta(donor).cityId;
  if (donorId) {
    const before = own.split(donorId).length - 1;
    const after = merged.split(donorId).length - 1;
    if (after > before) problems.push(`thành phố của bạn cũ ${donorId} (+${after - before})`);
  }

  const mpBefore = (own.match(/name="mainPlayer"/gi) ?? []).length;
  const mpAfter = (merged.match(/name="mainPlayer"/gi) ?? []).length;
  if (mpAfter > mpBefore) problems.push(`mainPlayer +${mpAfter - mpBefore}`);

  if (problems.length) {
    throw new Error(
      `Bản sao mang theo danh tính của người khác (${problems.join(", ")}). ` +
        "Đã hủy trước khi đẩy lên máy để tránh khóa tài khoản.",
    );
  }
}

/**
 * Build a scrubber for one operation.
 *
 * Rewriting the reference keeps the identity guard strict *and* the copy
 * usable: the block still parses, the reference now points at us (which is
 * what a clone means), and no string belonging to the donor survives. Because
 * it rewrites rather than whitelists, it covers a layout nobody has seen yet —
 * any place the id turns up is handled, not just the ones we know about.
 *
 * Both ids are resolved **once** and captured in the closure: `applyDesban`
 * calls the scrubber once per copied Var, and re-deriving the ids each time
 * meant seven full-document regex scans per Var — slow enough to time out a
 * real save.
 */
function scrubber(src: string, tgt: string): (text: string) => string {
  const donor = parseOwnMeta(src).cityId;
  if (!donor) return (text) => text;
  // Already guaranteed distinct from `donor` by the predicate below.
  const ours = [...declaredIds(tgt)].find((id) => id && id !== donor);
  if (!ours) return (text) => text;
  return (text) => (text.includes(donor) ? text.split(donor).join(ours) : text);
}

function cloneMain(src: string, tgt: string, tag: string, scrub = scrubber(src, tgt)): { xml: string; action: string } {
  const srcBlk = pickMain(src, tag);
  if (!srcBlk) return { xml: tgt, action: "missing_src" };
  const tgtBlk = pickMain(tgt, tag);
  const block = scrub(reattribute(srcBlk.block, src, tgt));
  if (tgtBlk) return { xml: tgt.slice(0, tgtBlk.start) + block + tgt.slice(tgtBlk.end), action: "replace" };
  const z = zooEnd(tgt);
  if (z >= 0) return { xml: tgt.slice(0, z) + "\n" + block + tgt.slice(z), action: "insert" };
  for (const c of ["</Global>", "</root>", "</Root>"]) {
    if (tgt.includes(c)) return { xml: tgt.replace(c, block + "\n" + c), action: "insert" };
  }
  return { xml: tgt + "\n" + block, action: "insert" };
}

function cloneSimple(src: string, tgt: string, tag: string, scrub = scrubber(src, tgt)): { xml: string; action: string } {
  const srcList = findAllBlocks(src, tag);
  if (!srcList.length) return { xml: tgt, action: "missing_src" };
  const block = scrub(srcList[0]!.block);
  const tgtList = findAllBlocks(tgt, tag);
  if (tgtList.length) {
    const t = tgtList[0]!;
    return { xml: tgt.slice(0, t.start) + block + tgt.slice(t.end), action: "replace" };
  }
  for (const c of ["</Global>", "</root>", "</Root>"]) {
    if (tgt.includes(c)) return { xml: tgt.replace(c, block + "\n" + c), action: "insert" };
  }
  return { xml: tgt + "\n" + block, action: "insert" };
}

function findDataElemBlock(xml: string, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<DataElem\\b(?=[^>]*\\bname="${esc}")[^>]*>`, "i");
  const m = re.exec(xml);
  if (!m || m.index === undefined) return null;
  const start = m.index;
  const openTag = m[0];
  if (/\/\>\s*$/i.test(openTag)) return { start, end: start + openTag.length, block: openTag };
  let depth = 1;
  let pos = start + openTag.length;
  const token = /<\/DataElem\s*>|<DataElem\b[^>]*>/gi;
  token.lastIndex = pos;
  let hit: RegExpExecArray | null;
  while ((hit = token.exec(xml))) {
    const t = hit[0];
    if (/^<\/DataElem/i.test(t)) {
      depth--;
      if (depth === 0) {
        const end = hit.index + t.length;
        return { start, end, block: xml.slice(start, end) };
      }
    } else if (!/\/\s*>$/.test(t)) {
      depth++;
    }
  }
  return null;
}

/**
 * The four profile lists a full restore takes — and only those four.
 *
 * Measured against `twndesban2.pyc` as shipped in `TWN-1.zip` (v5.0): its
 * `_apply_desban` loops exactly `UnlockedBadges` / `UnlockedExpRanks` /
 * `UnlockedFrames` / `UnlockedStyles` through its own `_clone_dataelem`, and
 * `PlayerProfile` / `Configs` appear there only as *insertion* points for a
 * list the donor is missing. The pair is never replaced wholesale — that is
 * what used to import the donor's `UnlockedThemes`, their `New*` "not reviewed
 * yet" markers and any `BadgeFrameIncident*` flag, none of which TWN copies
 * either and none of which a restore is for.
 *
 * A list our save does not carry is inserted *inside* `<Configs>`, never
 * beside it: a DataElem the game only reads under `PlayerProfile > Configs`
 * placed anywhere else is well-formed XML that changes nothing in game.
 */
const PROFILE_CLONE_LISTS = ["UnlockedBadges", "UnlockedExpRanks", "UnlockedFrames", "UnlockedStyles"];

function copyProfileLists(src: string, tgt: string, scrub: (s: string) => string): string {
  let out = tgt;
  for (const name of PROFILE_CLONE_LISTS) {
    const s = findDataElemBlock(src, name);
    if (!s) continue;
    const block = scrub(s.block);
    const t = findDataElemBlock(out, name);
    if (t) {
      out = out.slice(0, t.start) + block + out.slice(t.end);
      continue;
    }
    const cfg = findDataElemBlock(out, "Configs");
    const close = cfg ? cfg.block.lastIndexOf("</DataElem>") : -1;
    if (cfg && close >= 0) {
      out = out.slice(0, cfg.start + close) + "\n          " + block + out.slice(cfg.start + close);
      continue;
    }
    for (const c of ["</Global>", "</root>", "</Root>"]) {
      if (out.includes(c)) {
        out = out.replace(c, block + "\n" + c);
        break;
      }
    }
  }
  return out;
}

/**
 * The six appearance vars TWN's step 3 takes through its `_clone_global_block`.
 *
 * Measured on the v5.0 build: `_MY_VARS = ('MyBadge', 'MyPicture', 'MyTheme',
 * 'MyFrame', 'MyStyle', 'townName')`, read out of the donor's `<Global>` and
 * written over ours — the badge, picture, frame, style and theme shown beside
 * the town's name, i.e. the town's own card. We take them from the donor and
 * nothing else: `MyBadge`/`MyPicture`/… are exactly the row the copied town is
 * displayed under, so leaving ours behind is the same mismatch as leaving our
 * founding date behind (see `TOWN_HISTORY_VARS`).
 *
 * These six are TWN's, and yesterday's build did not have them: they are the
 * one addition over `954002e`, taken because the user asked for reference parity
 * and because they describe the town rather than the account. The sticker list
 * is handled separately — see `cloneAvatarUnion`'s neighbour in `applyDesban`,
 * where the evidence for it is a live city rather than the reference tool.
 */
const PROFILE_APPEARANCE_VARS = ["MyBadge", "MyPicture", "MyTheme", "MyFrame", "MyStyle", "townName"];

/**
 * Which profile pictures this account holds — the **union** of ours and the
 * donor's, with the donor's value winning on an id both hold.
 *
 * That is `_clone_avatares` in the reference tool, read off the disassembly:
 * its `_fix` returns `avatares_src.get(nome, ours)`, i.e. an id only *we* have
 * keeps our own value and is never dropped, an id both hold takes the donor's,
 * and ids only the donor has are appended before `</Global>`. A restore that
 * *replaced* the set would take avatars away from the user; a restore that
 * refused the donor's would be the rule this reverses.
 *
 * Ids `isRealAvatarId()` rejects are skipped rather than written: they are
 * shapes no city on the server holds, so writing them would hand the push gate
 * a refusal this feature caused (the same `399..500` ids an earlier build wrote
 * after raising `AVATAR_MAX` with no evidence).
 */
function cloneAvatarUnion(src: string, tgt: string, scrub: (s: string) => string): string {
  let out = tgt;
  for (const m of src.matchAll(/<Var\s+name="Unlocked_ava(\d+)"\s+v="([^"]*)"[^>]*\/>/gi)) {
    const id = Number(m[1]);
    if (!isRealAvatarId(id)) continue;
    out = writeVar(out, `Unlocked_ava${id}`, scrub(m[2]!));
  }
  return out;
}

function isTutorialName(name: string) {
  const low = name.toLowerCase();
  if (name.startsWith("tip") && name.endsWith("TipSO")) return true;
  if (low.includes("tutorial") || low.includes("tutshowed")) return true;
  if (low.startsWith("needarrow")) return true;
  if (low.startsWith("needshow")) return true;
  if (low.includes("hand") && (low.includes("tutor") || low.includes("show") || low.includes("guide"))) return true;
  if (low.includes("guide") && (low.includes("tutor") || low.includes("show") || low.includes("complete"))) return true;
  if (low.includes("hint") && (low.includes("tutor") || low.includes("show"))) return true;
  if (low.includes("tutor") && /(show|state|complete|finish|start)/i.test(low)) return true;
  if (low.endsWith("tutshowed") || low.endsWith("tutor_showed")) return true;
  if (low.includes("arrow") && (low.includes("tutor") || low.includes("need") || low.includes("show"))) return true;
  // Mining/digging/cascade tutorial control vars
  if (low.includes("digging") && (low.includes("visited") || low.includes("fullcompleted") || low.includes("ready") || low.includes("regenerated") || low.includes("tutor") || low.includes("showed") || low.includes("room") || low.includes("stone") || low.includes("hardstone") || low.includes("clay") || low.includes("premium"))) return true;
  if (low.includes("cascade") && (low.includes("event") || low.includes("window") || low.includes("reward") || low.includes("launch") || low.includes("stop") || low.includes("merge") || low.includes("expedition") || low.includes("tutorial"))) return true;
  // `energy` was in that disjunction and must **not** be: it made
  // `isTutorialName("expeditionEnergy")` true, so `copyTutorialsFromFriend`
  // transplanted the donor's spendable expedition energy into our save in
  // **every mode** — no copy list mentions it, which is exactly why it was
  // invisible to every diff of the copy sets. Measured: own 11 -> donor 33854
  // with only `expeditionEnergy` differing as input, and on the real saves the
  // file reported banned carries the donor's 33854 while both reported
  // ban-free carry their own 193. `tutorialTargetValue` returns a non-empty
  // friend value verbatim, so a *resource* was copied as if it were a flag.
  // The rule is for expedition **tutorial** control vars; the terms that
  // actually identify those (`tutorial`, `show`, `lock`, `reward`, `quest`,
  // `playbtn`) are untouched. The four `*CascadeEventExpedition` names this
  // appeared to remove are still matched by the cascade rule above.
  if (low.includes("exped") && (low.includes("lock") || low.includes("reward") || low.includes("tutorial") || low.includes("playbtn") || low.includes("quest") || low.includes("show"))) return true;
  if (low.startsWith("tutm3_")) return true;
  if (low.includes("digging") && (low.includes("beauty") || low.includes("generated") || low.includes("tools") || low.includes("chunk"))) return true;
  if (low.includes("m3_cascade")) return true;
  return [
    "FirstGameLoad", "wasTrainTutorial", "StartTutorialFinished",
    "SecondStartTutorialFinished", "SecondStartTutorialShowed",
    "DealerAvailableTutShowed", "NeedHousesTutShowed", "TermsOfServiceAccept",
  ].includes(name);
}

function tutorialTargetValue(name: string, friendVal?: string) {
  const low = name.toLowerCase();
  if (low.startsWith("needarrow") || TUTORIAL_OFF.includes(name) || name === "FirstGameLoad") return "0";
  if (STATE_SUFFIXES.some((suf) => name.endsWith(suf))) {
    const n = Number(friendVal ?? "");
    return Number.isFinite(n) && n >= 10 ? String(Math.trunc(n)) : "18";
  }
  if (friendVal != null && friendVal !== "") {
    if ((friendVal === "0" || friendVal === "false") && /(showed|completed|finished|tutshowed)/i.test(low)) return "1";
    return friendVal;
  }
  if (/(showed|completed|finished|tutshowed)/i.test(low)) return "1";
  if (name.startsWith("tip") && name.endsWith("TipSO")) return "1";
  return "1";
}

function copyTutorialsFromFriend(own: string, friend: string) {
  let out = own;
  const seen = new Set<string>();
  for (const m of friend.matchAll(/<Var\s+name="([^"]+)"\s+v="([^"]*)"/gi)) {
    const name = m[1]!;
    const val = m[2]!;
    if (seen.has(name) || !isTutorialName(name)) continue;
    seen.add(name);
    out = writeVar(out, name, tutorialTargetValue(name, val));
  }
  return out;
}

export type TutorialIntent = "off" | "shown" | "done18";

/**
 * Rewrite one exact tutorial flag wherever it already exists, preserving
 * each element's own encoding: Var bools use 0/1, DataElem bools use
 * true/false, integer state machines use "18" for finished. Elements
 * without a scalar value (array/dataStore blocks such as finishedTutorials
 * or requests) are never touched — adding a value attribute there corrupts
 * the structure. Missing names are never inserted.
 */
export function setTutorialFlag(xml: string, name: string, intent: TutorialIntent): string {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const varRe = new RegExp(`<Var\\b[^>]*?\\bname="${n}"[^>]*?>`, "gi");
  xml = xml.replace(varRe, (tag) => {
    if (!/\bv\s*=/i.test(tag)) return tag;
    const t = /(\bt\s*=\s*")([^"]*)(")/i.exec(tag);
    const type = (t?.[2] ?? "").toLowerCase();
    if (type === "b" || type === "") {
      const v = intent === "off" ? "0" : "1";
      return tag.replace(/(\bv\s*=\s*")([^"]*)(")/i, `$1${v}$3`);
    }
    if (type === "i") {
      const v = intent === "done18" ? "18" : intent === "off" ? "0" : "1";
      return tag.replace(/(\bv\s*=\s*")([^"]*)(")/i, `$1${v}$3`);
    }
    return tag;
  });
  const deRe = new RegExp(`<DataElem\\b[^>]*?\\bname="${n}"[^>]*?>`, "gi");
  xml = xml.replace(deRe, (tag) => {
    if (!/\bvalue\s*=/i.test(tag)) return tag;
    const ty = /(\btype\s*=\s*")([^"]*)(")/i.exec(tag);
    const type = (ty?.[2] ?? "").toLowerCase();
    if (type === "bool") {
      const v = intent === "off" ? "false" : "true";
      return tag.replace(/(\bvalue\s*=\s*")([^"]*)(")/i, `$1${v}$3`);
    }
    if ((type === "int" || type === "int64") && intent !== "shown") {
      const v = intent === "done18" ? "18" : "0";
      return tag.replace(/(\bvalue\s*=\s*")([^"]*)(")/i, `$1${v}$3`);
    }
    return tag;
  });
  return xml;
}

export function skipTutorials(xml: string, friend?: string) {
  let out = friend ? copyTutorialsFromFriend(xml, friend) : xml;
  for (const n of TUTORIAL_DONE) out = writeVar(out, n, "1");
  for (const n of TUTORIAL_OFF) out = writeVar(out, n, "0");

  // Safety net for tutorial flags outside the curated list (including
  // future ones): only ever moves a flag toward its finished/hidden state,
  // and only through setTutorialFlag, which keeps each element's own
  // encoding and never touches valueless blocks.
  const seen = new Set<string>();
  const consider = (name: string, current: string) => {
    if (seen.has(name) || !isTutorialName(name)) return;
    seen.add(name);
    const low = name.toLowerCase();
    if (low.startsWith("needarrow") || TUTORIAL_OFF.includes(name) || name === "FirstGameLoad") {
      out = setTutorialFlag(out, name, "off");
      return;
    }
    if (STATE_SUFFIXES.some((suf) => name.endsWith(suf))) {
      const num = Number(current);
      if (!Number.isFinite(num) || num < 10) out = setTutorialFlag(out, name, "done18");
      return;
    }
    if (
      (current === "0" || current === "false") &&
      /(showed|completed|finished|tutshowed)/i.test(low)
    ) {
      out = setTutorialFlag(out, name, "shown");
      return;
    }
    if (name.startsWith("tip") && name.endsWith("TipSO")) {
      out = setTutorialFlag(out, name, "shown");
    }
  };
  // Var/DataElem with name before value/v
  const re1 = /<(Var|DataElem)\b[^>]*\bname="([^"]+)"[^>]*\b(?:v|value)="([^"]*)"[^>]*>/gi;
  // Var/DataElem with value/v before name
  const re2 = /<(Var|DataElem)\b[^>]*\b(?:v|value)="([^"]*)"[^>]*\bname="([^"]+)"[^>]*>/gi;
  // DataElem with type="..." value="..." (name before type)
  const re3 = /<DataElem\b[^>]*\bname="([^"]+)"[^>]*\btype="[^"]*"[^>]*\bvalue="([^"]*)"[^>]*>/gi;
  // DataElem with type="..." value="..." (value before name)
  const re4 = /<DataElem\b[^>]*\btype="[^"]*"[^>]*\bvalue="([^"]*)"[^>]*\bname="([^"]+)"[^>]*>/gi;
  // DataElem with type="..." value="..." (name after value)
  const re5 = /<DataElem\b[^>]*\bvalue="([^"]*)"[^>]*\btype="[^"]*"[^>]*\bname="([^"]+)"[^>]*>/gi;
  // DataElem with type="..." value="..." (type before name)
  const re6 = /<DataElem\b[^>]*\btype="[^"]*"[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]*)"[^>]*>/gi;

  for (const m of out.matchAll(re1)) consider(m[2]!, m[3]!);
  for (const m of out.matchAll(re2)) consider(m[3]!, m[2]!);
  for (const m of out.matchAll(re3)) consider(m[1]!, m[2]!);
  for (const m of out.matchAll(re4)) consider(m[2]!, m[1]!);
  for (const m of out.matchAll(re5)) consider(m[2]!, m[1]!);
  for (const m of out.matchAll(re6)) consider(m[1]!, m[2]!);

  // [name, intent]: off = hidden/inactive (false/0), shown = already
  // shown/finished (true/1), done18 = finished state machine ("18").
  // Every entry is an exact tutorial flag from real saves. Generic engine
  // names (score, state, enabled, currentState, ...) are deliberately
  // absent: each occurs dozens of times in unrelated event, race and
  // score structures and must never be rewritten globally. Array/dataStore
  // elements (finishedTutorials, requests, ...) carry children rather than
  // scalar values, so the writer leaves them untouched.
  const FORCED_TUTORIALS: Array<[string, TutorialIntent]> = [
    // --- main tutorial state machines: 10/15 = in progress, 18 = done ---
    ["tutorial_state", "done18"],
    ["SellTutorial_state", "done18"],
    ["OrderBreadTutorial_state", "done18"],
    ["OrderMilkTutorial_state", "done18"],
    ["PreOrderBreadTutorial_state", "done18"],
    ["AfterCloudShopArrowTutorial_state", "done18"],
    ["AfterCloudShopArrowHouseTutorial_state", "done18"],
    ["AfterCloudShopArrowFactoryTutorial_state", "done18"],
    ["AfterCloudShopArrowCommunityTutorial_state", "done18"],
    ["LabTutor1_state", "done18"],
    ["LabTutor2_state", "done18"],
    ["LabTutor3_state", "done18"],
    ["LabTutor4_state", "done18"],
    ["FirstDiggingClayTutorial_state", "done18"],
    ["FirstDiggingStoneTutorial_state", "done18"],
    ["FirstDiggingHardstoneTutorial_state", "done18"],
    ["DiggingTutorial_state", "done18"],
    ["BarnUpgradeTutorial_state", "done18"],
    ["FactoryTutorial_state", "done18"],
    ["HandTutorial_state", "done18"],
    ["GuideTutorial_state", "done18"],
    ["HintTutorial_state", "done18"],
    ["ArrowTutorial_state", "done18"],
    ["AppearFirstTrain_state", "done18"],
    ["OpenTrains_state", "done18"],
    ["SendTheTrain_state", "done18"],
    ["HurryUpTrain_state", "done18"],
    ["GetMaterials_state", "done18"],
    ["OpenFullFirstTime_state", "done18"],
    ["OpenFullSecondTime_state", "done18"],
    ["HarborFirstLook_state", "done18"],
    ["HarborFirstLook2_state", "done18"],
    ["HarborBoatSend_state", "done18"],
    ["VisitAirTop_state", "done18"],
    ["AirFirstLook_state", "done18"],
    ["AirFirstLoadTrain_state", "done18"],
    ["AirFirstLoadAllTrains_state", "done18"],
    ["IslandsDailyChestStep1_state", "done18"],
    ["IslandsDailyChestStep2_state", "done18"],
    ["AskForHelp_state", "done18"],
    ["AcceptHelp_state", "done18"],
    ["HelpErnie2_state", "done18"],
    ["HelpErnie3_state", "done18"],
    ["DealerWelcome_state", "done18"],
    ["BuildHouseTutorial_state", "done18"],
    ["PreNewFieldTutorial_state", "done18"],
    ["BuildNewFieldTutorial_state", "done18"],
    ["PlaceCropfieldTutorial2_state", "done18"],
    ["PlaceCropfieldsTutorial_state", "done18"],
    ["PlaceHouseTutorial_state", "done18"],
    ["SeedFieldTutorial_state", "done18"],
    ["HurryHouseTutorial_state", "done18"],
    ["GreenPinAccentTutorial_state", "done18"],
    ["ShowNeedHouses_state", "done18"],
    ["FarmFieldTutorial_state", "done18"],
    ["GrowFieldTutorial_state", "done18"],
    ["Seed6fieldsTutorial_state", "done18"],
    ["Crop6fieldsAgainTutorial_state", "done18"],
    ["OpenCowpastureTutorialNew_state", "done18"],
    ["SelectMillTutorial_state", "done18"],
    ["BuildMillTutorial_state", "done18"],
    ["SelectHouseTutorial_state", "done18"],
    ["SelectBakeryTutorial_state", "done18"],
    ["BuildBakeryTutorial_state", "done18"],
    ["BuildBakery2Tutorial_state", "done18"],
    ["CreateBreadTutorial_state", "done18"],
    ["PreOrderBreadTutorial_state", "done18"],
    ["OrderBreadTutorial_state", "done18"],
    ["OrderMilkTutorial_state", "done18"],
    ["CreateMilkTutorial_state", "done18"],
    ["EndOfTimeBreadTutorial_state", "done18"],
    ["WaitingForExitLevelUp2_state", "done18"],
    ["WaitingForExitLevelUp3_state", "done18"],
    ["SendHeicopter_state", "done18"],
    ["RenameCity_state", "done18"],
    ["ValentinesDayStartTutorial_state", "done18"],
    ["FriendshipDayStartTutorial_state", "done18"],
    ["SwapProductsTutorial_state", "done18"],
    ["EventCenterTutorial_state", "done18"],
    ["AvatarAfterUpdateTutorial_state", "done18"],
    ["AvatarOpenCondTutorial_state", "done18"],
    ["AvatarReminderTutorial_state", "done18"],
    ["BuildCommunityTutorial_state", "done18"],
    ["TutorialZooGetCompensation_state", "done18"],
    ["ExtractClayVideoTutorial_state", "done18"],
    ["DestroyClayTutorial_state", "done18"],
    ["DestroyClay2Tutorial_state", "done18"],
    // --- arrows / hands / wait flags: hide ---
    ["NeedArrowOnMarket", "off"],
    ["NeedArrowOnZoo", "off"],
    ["NeedArrowOnYachtPier", "off"],
    ["NeedArrowOnDigging", "off"],
    ["NeedArrowOnHarbor", "off"],
    ["NeedArrowOnTrain", "off"],
    ["NeedArrowOnAir", "off"],
    ["NeedArrowOnClan", "off"],
    ["NeedArrowOnShield", "off"],
    ["NeedOpenEventCenterPanelAfterRestartGame", "off"],
    ["warehouse_full_tutorial", "off"],
    ["warehouse_full_tutorial_second", "off"],
    ["DealerNeedTutorialArrow", "off"],
    ["TapDealerAfterTutorial", "off"],
    ["NeedShowDiggingFirecracker", "off"],
    ["NeedShowDiggingMissTools", "off"],
    ["NeedShowHandOnMarket", "off"],
    ["NeedShowHandOnZoo", "off"],
    ["NeedShowHandOnTrain", "off"],
    ["NeedShowHandOnAirport", "off"],
    ["NeedShowHandOnHarbor", "off"],
    ["NeedShowHandOnDigging", "off"],
    ["NeedShowHandOnClan", "off"],
    ["NeedShowHandOnIsland", "off"],
    ["ShowHandOnFactory", "off"],
    ["ShowHandOnBarn", "off"],
    ["ShowHandOnMarket", "off"],
    ["FirstGameLoad", "off"],
    ["WaitForArrowOnCow", "off"],
    ["WaitForArrowOnReadyField", "off"],
    ["WaitForFirstHarvest", "off"],
    ["WaitForFirstFeed", "off"],
    ["WaitForFirstFactoryOrder", "off"],
    ["CHT_FactoryArrowMoving_waiting", "off"],
    ["SeasonTicketShowArrow", "off"],
    ["FieldHintNeed", "off"],
    ["showNewOfferSign", "off"],
    ["GenerateDiggingBeautys", "off"],
    ["FirstShowCascadePromoWindowForExpeditionStatus", "off"],
    ["WaitTutorialEnd", "off"],
    // --- expedition / quest / sidequest / tablet step flags: false = idle ---
    // A finished step set reads all-false in real saves (e.g. Craft_Tutorial_*).
    ["Tablet_Tutorial_Active", "off"],
    ["Tablet_Tutorial_part1", "off"],
    ["Tablet_Tutorial_part2", "off"],
    ["Tablet_Tutorial_part3", "off"],
    ["Tablet_Tutorial_part4", "off"],
    ["SQ_Tutorial_Active", "off"],
    ["SQ_Tutorial_part1", "off"],
    ["SQ_Tutorial_part2", "off"],
    ["InfSQ_Tutorial_Active", "off"],
    ["InfSQ_Tutorial_part1", "off"],
    ["InfSQ_Tutorial_part2", "off"],
    ["InfSideQuest_Tutorial", "off"],
    ["QuestHUD_Tutorial", "off"],
    ["QuestInfiniteWindow_Tutorial", "off"],
    ["QuestNode_Tutorial_Active", "off"],
    ["QuestWindow_Tutorial", "off"],
    ["Craft_Tutorial_Active", "off"],
    ["SideQuestHUD_Tutorial", "off"],
    ["SideQuestInfiniteWindow_Tutorial", "off"],
    ["SideQuestNotif_Tutorial", "off"],
    ["SideQuest_Tutorial", "off"],
    ["FirstShowSideQuestInfinite_Tutorial", "off"],
    ["ShouldShowEnergyShortageTutorial", "off"],
    ["ShouldShowEnergyUnder100Tutorial", "off"],
    ["EXP_EnergyTutorialStart", "off"],
    // --- "already shown / finished" markers ---
    ["TutorialHandShown", "shown"],
    ["TutorialGuideShown", "shown"],
    ["TutorialHintShown", "shown"],
    ["TapToContinueTutorialShown", "shown"],
    ["SwipeTutorialShown", "shown"],
    ["TutorialCloudShowedAll", "shown"],
    ["cascadeEventWindowShowed", "shown"],
    ["DiggingVisited", "shown"],
    ["diggingFullCompleted", "shown"],
    ["DiggingReady", "shown"],
    ["DiggingRegeneratedForMuseum", "shown"],
    ["OldPlayersDiggingTutShowed", "shown"],
    ["DiggingTutorShowed", "shown"],
    ["Tutorial_SP_DiggingPremium", "shown"],
    ["FirstDiggingStoneShowed", "shown"],
    ["FirstDiggingHardstoneShowed", "shown"],
    ["FirstDiggingRoomShowed", "shown"],
    ["RepairHarborTutShowed", "shown"],
    ["DealerFreeOnce", "shown"],
    ["WasTutorialUnlock", "shown"],
    ["HelicTutorWas", "shown"],
    ["IslandsMapShowed", "shown"],
    ["NewBankShowed", "shown"],
    ["NewPlayerProfileShowed", "shown"],
    ["tutorial_finished_step", "shown"],
    ["tutorial_skip_CreateBread", "shown"],
    ["tip5TipSO", "shown"],
    ["tip8TipSO", "shown"],
    ["tip11TipSO", "shown"],
    ["tip12TipSO", "shown"],
    ["tip13TipSO", "shown"],
    ["tip15TipSO", "shown"],
    ["tip23TipSO", "shown"],
    ["tip29TipSO", "shown"],
    ["tip2TipSO", "shown"],
    ["tip4TipSO", "shown"],
    ["exp_tutorial_tablet_rewards_banner_passed", "shown"],
    ["exp_tutorial_tablet_rewards_passed", "shown"],
    ["exp_tutorial_tablet_passed", "shown"],
    ["ExpedCanShowSTPanels", "shown"],
    ["Tutorial_SuperLightning_PlayBtn_Shown", "shown"],
    ["Tutorial:IslandsDailyChest:CountVisit", "shown"],
    ["IslandsTutor_FirstOpen_Step2", "shown"],
    ["IslandsTutor_FirstOpen_Step3", "shown"],
    // --- cascade score markers: seen, no remainder ---
    ["lastSeenScore", "off"],
    ["scoreRemainder", "off"],
  ];
  for (const [name, intent] of FORCED_TUTORIALS) out = setTutorialFlag(out, name, intent);
  return out;
}


function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1]!.toLowerCase()] = m[2] ?? "";
  }
  return attrs;
}

function attrFirst(attrs: Record<string, string>, names: string[]): string {
  for (const name of names) {
    const value = attrs[name.toLowerCase()];
    if (value != null && value !== "") return value;
  }
  return "";
}

export function parseInvitedFriends(xml: string): Friend[] {
  const out: Friend[] = [];
  const block = xml.match(/<InvitedFriends\b[^>]*>([\s\S]*?)<\/InvitedFriends>/i)?.[1] ?? "";
  const seen = new Set<string>();

  for (const m of block.matchAll(/<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>/g)) {
    const attrs = parseAttrs(m[0]!);
    const id = attrFirst(attrs, ["city_id", "cityid", "fromid", "id"]);
    if (!/^[A-Za-z0-9]+$/.test(id) || seen.has(id)) continue;
    const name = attrFirst(attrs, ["city_name", "cityname", "name", "displayname", "playername", "nickname", "nick"]);
    const levelRaw = attrFirst(attrs, ["level", "citylevel", "playerlevel"]);
    seen.add(id);
    out.push({ id, name: name || id, level: /^\d+$/.test(levelRaw) ? Number(levelRaw) : 0, type: "request" });
  }

  if (!out.length) {
    for (const m of block.matchAll(/(?:city_id|cityId|fromId|id)="([A-Za-z0-9]+)"/gi)) {
      const id = m[1]!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: id, level: 0, type: "request" });
    }
  }
  return out;
}

export function parseLocalFriends(xml: string): Friend[] {
  const out = new Map<string, Friend>();

  // LocalInfo variants put attributes in different orders. Parse every tag
  // independently and require a friend-like level/name field.
  for (const m of xml.matchAll(/<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>/g)) {
    const tag = m[0]!;
    if (/^<\/?(?:InvitedFriends|Global|root|Save)\b/i.test(tag)) continue;
    const attrs = parseAttrs(tag);
    const id = attrFirst(attrs, ["city_id", "cityid", "fromid", "id"]);
    if (!/^[A-Za-z0-9]+$/.test(id)) continue;
    const name = attrFirst(attrs, ["city_name", "cityname", "name", "displayname", "playername", "nickname", "nick"]);
    const levelRaw = attrFirst(attrs, ["level", "citylevel", "playerlevel"]);
    if (!name && !levelRaw) continue;
    const level = /^\d+$/.test(levelRaw) ? Number(levelRaw) : 0;
    const prev = out.get(id);
    const friend: Friend = { id, name: name || id, level, type: "friend" };
    if (!prev || (prev.name === id && friend.name !== id) || (prev.level === 0 && level > 0)) {
      out.set(id, friend);
    }
  }

  // Last-resort fallback for LocalInfo variants that expose only cityId.
  if (!out.size) {
    for (const m of xml.matchAll(/\bcityId="([A-Za-z0-9]+)"/gi)) {
      const id = m[1]!;
      if (!out.has(id)) out.set(id, { id, name: id, level: 0, type: "friend" });
    }
  }
  return [...out.values()];
}

// Kept as a compatibility helper for existing imports.
export function parseFriends(xml: string): Friend[] {
  const invited = parseInvitedFriends(xml);
  const local = parseLocalFriends(xml);
  const byId = new Map<string, Friend>();
  for (const f of invited) byId.set(f.id, f);
  for (const f of local) byId.set(f.id, f);
  return [...byId.values()];
}

/**
 * Decode a Township LocalInfo/mGameInfo payload into UTF-8 XML.
 *
 * Device builds wrap the document in one of several containers, so this
 * dispatches on the leading byte rather than assuming the 0x79 wrapper. When a
 * read fails the client can hand us the shell's error text instead of the file
 * (see `shellErrorMessage`), so that is detected first and reported as a device
 * problem rather than an unknown format.
 */
export function decodeLocalInfoBase64(b64: string) {
  const raw = Buffer.from(String(b64 || ''), 'base64');
  if (!raw.length) throw new Error('LocalInfo rỗng');
  const shellErr = shellErrorMessage(raw);
  if (shellErr) {
    throw new Error(
      `Không đọc được mLocalInfo từ máy ảo (ADB trả về lỗi shell: "${shellErr}"). ` +
        'Hãy kiểm tra giả lập đã Root chưa và mở Township ít nhất một lần.',
    );
  }
  const decoded = decodeContainer(raw);
  if (decoded) {
    const xml = extractXml(decoded);
    if (xml) return xml;
  }
  const head = raw.subarray(0, 256).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<')) return raw.toString('utf8').replace(/^\uFEFF/, '');
  throw new Error(
    `LocalInfo không nhận dạng được định dạng (byte đầu 0x${raw[0]!.toString(16)}); không thể lấy Version/FVer`,
  );
}

export function parseOwnMeta(xml: string) {
  const aws = xml.match(/<AWS\b([^>]*)>/i)?.[1] ?? "";
  // `<Version>` is self-closing in mGameInfo and paired in some LocalInfo
  // builds; attribute order also varies. Capture the whole tag and read each
  // attribute independently instead of assuming a fixed layout.
  const ver = xml.match(/<Version\b([^>]*?)\/?>/i)?.[1] ?? "";
  return {
    cityId: attrValue(aws, "cityId") ?? readVarLoose(xml, "cityId") ?? "",
    bver: attrValue(ver, "version") ?? "",
    fver: attrValue(ver, "FVer") ?? "",
  };
}

/**
 * Every id this save claims for itself: the declared cityId plus the id Vars
 * older builds name differently (SaveId / userId / PlayerId). A record
 * attributed to any of them is our own even when this save never wrote a
 * `user=` before — and a save that can only tell us its SaveId still has a
 * real identity, so refusing it would break a feature without protecting
 * anything. Built from the save we *started* with, never from a merge result.
 */
export function declaredIds(xml: string): Set<string> {
  const out = new Set<string>();
  const c = parseOwnMeta(xml).cityId;
  if (c) out.add(c);
  for (const name of ["SaveId", "userId", "UserId", "PlayerId", "cityId"]) {
    const v = readVarLoose(xml, name);
    if (v) out.add(v);
  }
  return out;
}

/**
 * Every decoration id already in our stash, in document order.
 *
 * Copying a friend replaces the stash outright. That is right for a first copy
 * and wrong for every one after it: the next friend's file would silently drop
 * the friend copied before, and the user would still see a green tick. Reading
 * our ids up front lets `maxBuildingsStash` put back whatever the donor's
 * stash lacked, so the collection grows across friends instead of being
 * swapped out each time.
 */
function stashIds(xml: string): string[] {
  const block = xml.match(/<BuildingsStash\b[^>]*>[\s\S]*?<\/BuildingsStash\s*>/i)?.[0];
  if (!block) return [];
  return [...block.matchAll(/<Building\b[^>]*?\bid="([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * Every clone step ends by proving it left the co-op alone.
 *
 * Which team a save belongs to is account identity, not town data: `<MyClan
 * id>` and `<Var name="MyClanId">` say *who* is in the file, and a copy that
 * moved either one would ship a file claiming a clan it has never joined. The
 * restore has never written them (measured across all three modes over every
 * save pair in the corpus), so this never fires today — it is here so that a
 * future block list which starts covering `<MyClan>` fails loudly in the
 * function that did it, instead of on a user's account at their first message
 * in a co-op chat.
 *
 * Both fields are compared separately rather than as one resolved id: a step
 * that updated only one of the two is exactly the split the shape gate refuses
 * later, and catching it here names the step.
 */
export function assertCoopIdentityKept(before: string, after: string) {
  const a = readCoopId(before);
  const b = readCoopId(after);
  if (a.tag === b.tag && a.v === b.v) return;
  throw new Error(
    `Không đẩy file lên máy: bước sao chép này đã đổi co-op của save ` +
      `(<MyClan id> ${a.tag ?? "-"} -> ${b.tag ?? "-"}, MyClanId ${a.v ?? "-"} -> ${b.v ?? "-"}). ` +
      "Co-op là danh tính của tài khoản, không phải dữ liệu của thành phố — " +
      "sao chép nó sẽ khiến save của bạn khai bạn là thành viên một nhóm mà bạn chưa tham gia.",
  );
}

export function cloneDecorOnly(ownXml: string, friendXml: string) {
  let own = ownXml.replace(/^\uFEFF/, "");
  const before = own;
  const fr = friendXml.replace(/^\uFEFF/, "");
  const scrub = scrubber(fr, own);
  const blocks: string[] = [];
  const vars: string[] = [];
  for (const tag of ["BuildingsStash", "FragmentedBeautyManager", "ArtInfo"]) {
    const r = cloneSimple(fr, own, tag, scrub);
    own = r.xml;
    if (r.action !== "missing_src") blocks.push(`${tag}:${r.action}`);
  }
  // The sticker set, and the one place a copy must NOT take the donor's.
  //
  // Reported precisely: typing in co-op chat is fine, **sending a sticker that
  // came with the copied town bans**. The live device says why — the account
  // that has been clean and that just sent stickers without a ban holds
  // `UnlockedChatEmoji` equal to `CHAT_EMOJI_IDS`, all 112 ids in catalog
  // order, i.e. `unlockEmoji()`'s output on a save that had no list of its
  // own. That is the state to reproduce.
  //
  // The two-branch rule that used to live here wrote the donor's list whenever
  // they had one, and replaying it against the corpus shows it leaving the safe
  // state every time: `fc_big` (107 ids) cost six real stickers and added
  // `desc`; `save9` (2 ids) cost 110. So the donor's list is never read — we
  // union our own ids with the catalog, which can only add and is a
  // byte-identical no-op on the safe set.
  own = unlockEmoji(own);
  vars.push("UnlockedChatEmoji:catalog");
  for (const m of fr.matchAll(/<Var\s+name="((?:skin_|Skin_|decor_|Decor_)[^"]+)"\s+v="([^"]*)"/gi)) {
    own = writeVar(own, m[1]!, scrub(m[2]!));
    vars.push(m[1]!);
  }
  // The donor's stash replaced ours wholesale. Hand back any decoration they
  // did not have, so copying a second friend adds to the collection instead of
  // discarding the first friend's.
  const ours = stashIds(before);
  if (ours.length) own = maxBuildingsStash(own, ours, 10);
  own = maxBuildingsStash(own, [], 10);
  own = maxFragments(own);
  assertCoopIdentityKept(before, own);
  assertNoForeignIdentity(before, own, fr);
  return { xml: own, report: { blocks, vars } };
}

/**
 * Clone town layout — paste another player's town into ours and nothing else.
 * Only the main town's `<TownGround>` + `<Buildings>` move across (`pickMain`
 * skips the Zoo's own pair, which is deliberately left alone); no stats, no
 * profile stores, no event state, so there is no account identity to leak in
 * the first place. The donor file is only ever read: our cityId, session and
 * device id stay exactly as they were.
 */
export function cloneTownLayout(ownXml: string, friendXml: string) {
  const before = ownXml.replace(/^\uFEFF/, "");
  let own = before;
  const fr = friendXml.replace(/^\uFEFF/, "");
  const scrub = scrubber(fr, own);
  const blocks: string[] = [];
  for (const tag of ["TownGround", "Buildings"]) {
    const r = cloneMain(fr, own, tag, scrub);
    own = r.xml;
    blocks.push(`${tag}:${r.action}`);
  }
  if (blocks.every((b) => b.endsWith(":missing_src"))) {
    throw new Error("File bạn không chứa TownGround/Buildings — cần City XML của một thành phố thật.");
  }
  // Never report a success that changed nothing: the game would silently keep
  // the old town and the user would see a green tick for an untouched save.
  if (own === before) {
    const err = new Error(
      "Thành phố không có gì thay đổi — file của bạn đã giống hệt file được chọn.",
    ) as Error & { code?: string };
    err.code = TOWN_UNCHANGED;
    throw err;
  }
  assertCoopIdentityKept(before, own);
  assertNoForeignIdentity(before, own, fr);
  return { xml: own, report: { blocks, vars: [] } };
}

/** Machine-readable form of the "the town was already the donor's" refusal. */
export const TOWN_UNCHANGED = "town-unchanged";

export function isTownUnchanged(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === TOWN_UNCHANGED;
}

/**
 * Restore a friend's city over ours — the town, its counters and the card it
 * is displayed under.
 *
 * The profile half of this function was written, then removed, then put back,
 * so both measurements are on file rather than only the last one.
 *
 * **Why it was removed (2026-10-01 report).** *"after copy all city then I join
 * the Co-op and type something, or send a request for barn items or stickers in
 * coop chat, then I got instant ban."* The user's own discriminator — basic
 * stats is clean, the full copy bans — matched exactly which modes wrote
 * **profile identity**: `inicial` wrote none of it, `completo` / `novo` wrote
 * `UnlockedChatEmoji`, `Unlocked_ava*` and the four lists in
 * `PlayerProfile > Configs`. All three render next to your name in the co-op
 * roster, which is where the report happened.
 *
 * **Why it came back.** Once the four banned saves were captured, the
 * discriminator did not hold: *none* of them carries a single donor profile
 * value. `mGameInfo.current-3/4/5` copied `fc_big`, which holds 19 / 15 / 9 /
 * 20 badges / frames / styles / exp ranks, 386 avatars and 107 chat stickers —
 * and all three hold 0 / 0 / 0 / 0, 16–27 avatars of their own and no sticker
 * list at all. `mGameInfo.current-6` is the same shape against its donor. The
 * two *no-ban* saves carry none of the donor's either. Six files, zero donor
 * profile on both sides of the line: this field never separated a ban from a
 * clean push, so removing it could not have been what fixed anything, and
 * leaving it out is not what the evidence asks for.
 *
 * What the evidence *does* support is copying what the reference tool copies
 * and refusing what it copies badly. So `completo` / `novo` now take, exactly
 * as `twndesban2.pyc` (v5.0, `TWN-1.zip`) does:
 *
 * - `Unlocked_ava*` — the **union** of our profile pictures and the donor's,
 *   never a replacement; see `cloneAvatarUnion`.
 * - `MyBadge` / `MyPicture` / `MyTheme` / `MyFrame` / `MyStyle` / `townName` —
 *   the town's own card, TWN's step-3 `_MY_VARS`; see `PROFILE_APPEARANCE_VARS`.
 * - `UnlockedBadges` / `UnlockedExpRanks` / `UnlockedFrames` /
 *   `UnlockedStyles` — the four lists TWN's `_clone_dataelem` loops, inserted
 *   inside `<Configs>`; see `copyProfileLists`.
 * - `UnlockedChatEmoji` — the sticker set, and the one field where the right
 *   move is to **not** take the donor's. The restore never reads their list; it
 *   runs `unlockEmoji()`, which unions this account's own ids with
 *   `CHAT_EMOJI_IDS`. The live device settles why: the city that has been
 *   running clean and that just sent stickers in co-op chat *without* a ban
 *   holds exactly `CHAT_EMOJI_IDS` — 112 ids, catalog order — while replaying
 *   the old "take the donor's" rule against the corpus replaces that working
 *   set with the friend's (`fc_big` cost six real stickers and gained `desc`;
 *   `save9` cost 110). Sending a **copied town's** sticker is the reported ban;
 *   sending a catalog sticker is the observed clean case.
 *
 * and deliberately does **not** take:
 *
 * - the donor's `UnlockedChatEmoji` list — see above. A copy never replaces
 *   this account's sticker set with somebody else's, whatever mode runs.
 * - `UnlockedThemes`, the `New*` markers and any `BadgeFrameIncident*` flag —
 *   TWN does not copy those either; they arrive only when `PlayerProfile` /
 *   `Configs` are replaced wholesale.
 * - `DataStoreCollection` — TWN **does** clone it, and that is the proof that
 *   "TWN does it" is not evidence of safety: measured on a real FetchCity
 *   response it is 1.4 MB holding 38 copies of the friend's `cityId`, 58
 *   `mainPlayer`, 161 `saveId` and their account-switcher list, and a save
 *   carrying it declares another player as its main player — an instant ban.
 *   It stays out regardless of what the reference does.
 *
 * `inicial` takes none of the profile set, because it copies no town and there
 * is nothing in the file for the town's card to belong to.
 *
 * **Honest limit.** Matching the reference tool removes a difference between
 * this output and one the user reports as working; it does not identify
 * Playrix's rule, and no tool can. A green gate means "nothing provably
 * wrong", never "cannot be banned".
 */
export function applyDesban(ownXml: string, friendXml: string, mode: "inicial" | "completo" | "novo") {
  let own = ownXml.replace(/^\uFEFF/, "");
  const before = own;
  const fr = friendXml.replace(/^\uFEFF/, "");
  const scrub = scrubber(fr, own);
  // `timeInGame` is the one value in this list whose safe copy depends on the
  // *recipient* rather than on the donor: it is seconds of play, and the save
  // also carries how long the account has existed
  // (`saveGlobalTime - TermsAcceptTime`). A copy writes the friend's playtime
  // onto our clock and leaves our clock alone, so an account younger than the
  // friend's own playtime ends up claiming more hours than it has lived —
  // measured at 13x to 12,478x over the 7 banned saves on file, every one of
  // which reached Playrix. The donor's value alone sets the trip point at
  // 3.3049 hours, so this fires on any younger account.
  //
  // Skipping only in that case keeps the copy byte-identical to today on any
  // account already older than the friend's playtime, which is every account
  // the proven-good baseline drew no ban with. The save keeps its own
  // `timeInGame`, which is consistent with its own age by construction.
  const ownAge = accountAgeSeconds(own);
  for (const name of INICIAL_VARS) {
    const val = readVarLoose(fr, name);
    if (val == null) continue;
    if (name === "timeInGame" && ownAge != null) {
      const donorPlay = Number(val);
      if (Number.isFinite(donorPlay) && donorPlay > ownAge) continue;
    }
    own = writeVar(own, name, scrub(val));
  }
  // The old rule here was "deliberately not `every Achievement_*` the donor
  // holds" — the reference tool copies five. That reading came from its
  // basic-stats tuple, but its **"Desban completo"** docstring (the step that
  // also clones `TownGround + Buildings`) says `Achievement_* vars` outright,
  // and the proven-good baseline ran the loop in every mode. It is therefore
  // tied to the town above rather than to `inicial`, which is the split the
  // evidence actually supports: 0 values newly written vs `ab46f0b`, and the
  //56-value gap closed. See `TOWN_HISTORY_VARS`.
  if (mode !== "inicial") {
    // History follows the town. See `TOWN_HISTORY_VARS`: the town transplant
    // above/below only stays internally consistent if the counters describing
    // the account behind it arrive in the same step. The reference tool's
    // "Desban completo" docstring lists `Achievement_* vars` and its FIELD_MAP
    // lifetime stats in the same pass as `TownGround + Buildings`, and the
    // proven-good baseline (`ab46f0b`) ran the achievement loop before its
    // `inicial` early return — HEAD's trimmed set is what the 56-value gap in
    // `[B]` is made of. `inicial` deliberately gets none of this: it copies no
    // town, so there is nothing in the file for these to contradict.
    for (const name of TOWN_HISTORY_VARS) {
      const val = readVarLoose(fr, name);
      if (val != null) own = writeVar(own, name, scrub(val));
    }
    for (const m of fr.matchAll(/<Var\s+name="(Achievement_[^"]+)"\s+v="([^"]*)"/gi)) {
      own = writeVar(own, m[1]!, scrub(m[2]!));
    }

    for (const tag of ["TownGround", "Buildings"]) own = cloneMain(fr, own, tag, scrub).xml;
    for (const tag of COMPLETO_BLOCKS) own = cloneSimple(fr, own, tag, scrub).xml;

    // `skin_` / `decor_` vars: they describe how *this* town's buildings look,
    // so they follow the town the way `TOWN_HISTORY_VARS` does.
    for (const m of fr.matchAll(/<Var\s+name="((?:skin_|Skin_|decor_|Decor_)[^"]+)"\s+v="([^"]*)"/gi)) {
      own = writeVar(own, m[1]!, scrub(m[2]!));
    }

    // Profile identity, matched field for field against the reference tool
    // rather than guessed at — see `cloneAvatarUnion`, `PROFILE_APPEARANCE_VARS`
    // and `copyProfileLists` for the measurements behind each one. Written only
    // here, never by `inicial`, because they are the row the copied town is
    // displayed under and `inicial` copies no town.
    //
    // The sticker set, and it is the one field where "take the donor's" is
    // provably the wrong direction.
    //
    // The user reported the split precisely: *typing* in co-op chat is fine,
    // **sending a sticker that came with the copied town bans**. Measured on
    // the live device (`adb pull` + `decodeContainer` + `postProcessDecrypt`),
    // the account that has been running clean and that just sent stickers
    // without a ban holds `UnlockedChatEmoji` equal to `CHAT_EMOJI_IDS` — all
    // 112 ids, in catalog order. So the proven-safe state is *our own* set.
    //
    // Replaying this exact restore against the corpus shows the old rule
    // leaving that state every time the friend has a list of their own:
    //
    //   donor `fc_big` (107 ids) -> we wrote 107, gained `desc` (an id our
    //   catalog has never seen) and LOST six real stickers
    //   (`st20 st21 st33 sp3 sp28 sp29`);
    //   donor `save9` (2 ids)   -> we wrote 2, dropping 110;
    //   donor with no list      -> unchanged, the safe 112.
    //
    // That is a *replacement* of a working set with somebody else's, and the
    // ids being sent afterwards are the friend's — exactly the reported case.
    // So the restore never reads the donor's list: it unions our own ids with
    // the catalog. That can only add, never remove, and for an account already
    // holding the safe set it is a byte-identical no-op.
    own = cloneAvatarUnion(fr, own, scrub);
    own = unlockEmoji(own);
    for (const name of PROFILE_APPEARANCE_VARS) {
      const val = readVarLoose(fr, name);
      if (val != null) own = writeVar(own, name, scrub(val));
    }
    own = copyProfileLists(fr, own, scrub);

    if (mode === "novo") {
      for (const tag of NOVO_BLOCKS) own = cloneSimple(fr, own, tag, scrub).xml;
    }
  }

  own = skipTutorials(own, fr);
  assertCoopIdentityKept(before, own);
  assertNoForeignIdentity(before, own, fr);
  return own;
}

export function maxBuildingsStash(xml: string, ids: string[] = [], count = 10) {
  const text = xml.replace(/^\uFEFF/, "");
  const want = ids.length ? new Set(ids) : null;
  const countText = String(Math.max(1, Math.floor(Number(count) || 10)));
  let changed = false;
  let touched = 0;

  const patchBlock = (block: string) => {
    const seen = new Set<string>();
    // A self-closing `<BuildingsStash/>` has nowhere to host the rows we may
    // need to add, and an empty stash is exactly what a fresh save has. Expand
    // it to a paired tag first, otherwise the insert below finds no anchor and
    // we would append a *second* stash that the game ignores.
    let body = block;
    if (/^<BuildingsStash\b[^>]*\/>$/i.test(block.trim())) {
      body = `${block.trim().replace(/\/>\s*$/, "")}></BuildingsStash>`;
    }
    // Match both `<Building .../>` and `<Building ...>children</Building>`.
    // Rewriting only the open tag of the paired form would leave its closing
    // tag behind and corrupt the document.
    const patched = body.replace(
      /<Building\b([^>]*?)(\/>|>[\s\S]*?<\/Building\s*>)/gi,
      (full, attrs: string) => {
        const id = attrs.match(/\bid="([^"]+)"/i)?.[1];
        if (!id) return full;
        seen.add(id);
        if (want && !want.has(id)) return full;
        touched += 1;
        changed = true;
        const nextAttrs = attrs.replace(/\s+count="[^"]*"/i, "").replace(/\s+\/\s*$/i, "");
        return `<Building${nextAttrs} count="${countText}"/>`;
      },
    );

    if (want) {
      const missing = [...want].filter((id) => !seen.has(id));
      if (missing.length) {
        const rows = missing.map((id) => `  <Building id="${id}" count="${countText}"/>`).join("\n");
        changed = true;
        touched += missing.length;
        return patched.replace(/<\/BuildingsStash\s*>/i, `${rows}\n</BuildingsStash>`);
      }
    }
    return patched;
  };

  const blockRe = /<BuildingsStash\b([^>]*?)(\/>|>[\s\S]*?<\/BuildingsStash\s*>)/i;
  const m = text.match(blockRe);
  if (m?.index !== undefined) {
    const block = patchBlock(m[0]);
    return text.slice(0, m.index) + block + text.slice(m.index + m[0].length);
  }

  // Some newer saves can expose the stash under a DataStore-style element.
  // Accept it without changing the surrounding container shape.
  const dataStoreRe = /(<DataElem\b[^>]*\bname="BuildingsStash"[^>]*>)([\s\S]*?)(<\/DataElem\s*>)/i;
  const dm = text.match(dataStoreRe);
  if (dm?.index !== undefined) {
    const body = dm[2];
    const pseudo = `<BuildingsStash>${body}</BuildingsStash>`;
    const fixed = patchBlock(pseudo).replace(/^<BuildingsStash>/i, "").replace(/<\/BuildingsStash>$/i, "");
    return text.slice(0, dm.index) + dm[1] + fixed + dm[3] + text.slice(dm.index + dm[0].length);
  }

  const rows = want ? [...want].map((id) => `  <Building id="${id}" count="${countText}"/>`).join("\n") : "";
  const block = `<BuildingsStash>\n${rows}${rows ? "\n" : ""}</BuildingsStash>\n`;
  return insertInsideRoot(text, block);
}

export function maxFragments(xml: string) {
  return xml.replace(/<FragmentedBeautyManager\b[\s\S]*?<\/FragmentedBeautyManager\s*>/i, (block) =>
    // `active` is written as 0/1 by the game; treat anything non-1 as inactive.
    block.replace(/\bactive="(?:0|false)"/gi, 'active="1"'),
  );
}

export function unlockEmoji(xml: string, ids?: string[]) {
  const list = ids?.length ? ids : CHAT_EMOJI_IDS;
  const existing = (readVarLoose(xml, "UnlockedChatEmoji") ?? "").split(",").filter((x) => x.trim());
  const merged = [...new Set([...existing, ...list])];
  // Every real save writes this list as `,st1,,st2,,st3,` — one comma wrapped
  // at each end, double separator between ids: for n ids the value splits into
  // exactly 1 + 2n entries. The trailing `,,` this used to append produced one
  // entry more than any city on the server holds, i.e. a shape no save has.
  const val = "," + merged.join(",,") + ",";
  return writeVar(xml, "UnlockedChatEmoji", val);
}

function scriptPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "scripts/township/fetch_city.py"),
    join(here, "../../../../scripts/township/fetch_city.py"),
    join(here, "../../../scripts/township/fetch_city.py"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/**
 * Overall deadline for one FetchCity download.
 *
 * This is the only ceiling on *how big a city we can download* - the child does
 * the HTTP fetch, the response AES and the container decode+inflate in one go,
 * and that time scales with the payload. A 150 KB city measured 3.5 s of AES on
 * a dev box; a 750 KB one measured 17 s and several times that on the instance,
 * so the old 90 s cap killed exactly the large cities while small ones
 * succeeded - reported as the generic "FetchCity thất bại", because a killed
 * child closes with `code === null` rather than a non-zero code. There is no
 * limit on city level, city id or save size anywhere else in this path.
 */
const FETCH_CITY_TIMEOUT_MS = 300_000;

/**
 * Open a FetchCity response body handed over by fetch_city.py --pipe-decrypt.
 *
 * This is the one expensive step of the download, and it is expensive only
 * because the helper does it in Python: a faithful port of Playrix's AES costs
 * ~22 us per byte, so 3.5 s for a 150 KB city and 17 s for a 750 KB one where
 * every other stage together is under 10 ms. OpenSSL does the same work
 * natively here, in about a millisecond.
 *
 * The counter is the game's own GCM framing: J0 = iv || 0x00000001, so the
 * first data block is iv || 0x00000002 with the counter in the last four bytes,
 * which is exactly what `aes-128-ctr` does with that 16-byte initial counter.
 * Verified byte-for-byte against the Python port on two real responses
 * (153,534 B and 761,217 B) and on round trips from 16 to 300,000 B.
 *
 * The key comes over with the body rather than being duplicated here, so
 * TS_AES_KEY has exactly one home and the two sides cannot drift apart.
 */
export function decryptResponseBody(bodyB64: string, tsId: string, keyB64: string): Buffer {
  if (tsId.length !== 3 + 24 + 32 || !tsId.startsWith("002")) throw new Error("bad ts-id");
  const iv = Buffer.concat([Buffer.from(tsId.slice(3, 27), "hex"), Buffer.from([0, 0, 0, 2])]);
  const dec = createDecipheriv("aes-128-ctr", Buffer.from(keyB64, "base64"), iv);
  return Buffer.concat([dec.update(Buffer.from(bodyB64, "base64")), dec.final()]);
}

export function fetchCityXml(cityId: string, bver = "", fver = ""): Promise<string> {
  const target = cityId.trim();
  if (!target || target.length < 4 || /\s/.test(target)) {
    return Promise.reject(new Error("City ID không hợp lệ"));
  }
  // A real bver/fver pair keeps the request identical to the live client, and
  // LocalInfo supplies it when readable. When it is missing we still try with
  // the current known-good pair rather than refusing: FetchCity was otherwise
  // impossible on any install whose mLocalInfo cannot be read, which also
  // blocked unban (no friend) and the card copy that depends on it.
  const useBver = bver || DEFAULT_BVER;
  const useFver = fver || DEFAULT_FVER;

  return new Promise((resolve, reject) => {
    const script = scriptPath();
    const pythonCandidates = [process.env.PYTHON_BIN, "python3", "python"].filter(
      (x): x is string => Boolean(x),
    );
    let settled = false;
    let lastError = "";
    let index = 0;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message.slice(0, 300)));
    };

    const runNext = () => {
      if (settled) return;
      const bin = pythonCandidates[index++];
      if (!bin) {
        fail("FetchCity không thể khởi chạy Python trên server");
        return;
      }

      let out = "";
      let timedOut = false;
      let stageHandled = false;
      const py = spawn(bin, [script, target, useBver, useFver, "--pipe-decrypt"], {
        cwd: dirname(script),
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      // Our own timer instead of spawn's `timeout` option: it has to be able to
      // tell a deliberate kill apart from anything else, because a killed child
      // closes with `code === null` and would read as a generic failure.
      const killTimer = setTimeout(() => {
        timedOut = true;
        py.kill();
      }, FETCH_CITY_TIMEOUT_MS);

      py.stdout.setEncoding("utf8");
      // The helper opens the response envelope with a message asking us to
      // decrypt it, then blocks on stdin. Handle that handover before any of
      // the normal output arrives; whatever else the first line turns out to be
      // (an early error, say) is put straight back for close() to interpret.
      py.stdout.on("data", (d) => {
        out += d;
        if (stageHandled) return;
        const nl = out.indexOf("\n");
        if (nl < 0) return;
        stageHandled = true;
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        type Stage = { stage?: string; ts_id?: string; key_b64?: string; body_b64?: string };
        let msg: Stage = {};
        try {
          msg = JSON.parse(line) as Stage;
        } catch {
          msg = {};
        }
        if (msg.stage !== "decrypt" || !msg.ts_id || !msg.key_b64 || !msg.body_b64) {
          out = line + "\n" + out;
          return;
        }
        if (!py.stdin) {
          py.kill();
          fail("FetchCity không giải mã được dữ liệu");
          return;
        }
        try {
          py.stdin.write(decryptResponseBody(msg.body_b64, msg.ts_id, msg.key_b64));
          py.stdin.end();
        } catch {
          py.kill();
          fail("FetchCity không giải mã được dữ liệu");
        }
      });
      // A helper that exits before we finish writing surfaces as EPIPE; close()
      // is what reports the real reason, so this must not become an unhandled
      // stream error.
      py.stdin?.on("error", () => {});
      py.on("error", (e) => {
        clearTimeout(killTimer);
        lastError = e.message;
        runNext();
      });
      py.on("close", (code) => {
        clearTimeout(killTimer);
        if (settled) return;

        // The helper is intentionally stdout-only JSON. If a runtime wrapper
        // adds whitespace, BOM, or an accidental extra line, recover the last
        // valid JSON object instead of treating a good FetchCity response as a
        // parser failure.
        const candidates = out
          .replace(/^\uFEFF/, "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .reverse();
        type PyResult = { ok?: boolean; xml_b64?: string; error?: string };
        let parsed: PyResult | null = null;
        for (const line of candidates) {
          try {
            parsed = JSON.parse(line) as PyResult;
            break;
          } catch {
            // try the next line
          }
        }

        if (parsed?.ok && parsed.xml_b64) {
          try {
            const xml = Buffer.from(parsed.xml_b64, "base64").toString("utf8").replace(/^\uFEFF/, "");
            if (!xml.trimStart().startsWith("<")) throw new Error("invalid city payload");
            settled = true;
            resolve(xml);
            return;
          } catch {
            fail("FetchCity trả về dữ liệu city không hợp lệ");
            return;
          }
        }

        // Killed by our own deadline: there is no helper output to interpret,
        // and the reason is the deadline rather than a failure.
        if (timedOut) {
          fail("FetchCity timeout — máy chủ game phản hồi quá lâu, thử lại sau");
          return;
        }

        const detail = String(parsed?.error || lastError || "");
        if (detail) {
          // Never surface raw upstream/Python metadata (including versions, ids,
          // request headers or implementation details) in the Client console.
          const lower = detail.toLowerCase();
          if (lower.includes("403")) {
            fail("FetchCity HTTP 403: Forbidden");
          } else if (lower.includes("timeout") || lower.includes("timed out")) {
            fail("FetchCity timeout");
          } else if (lower.includes("network") || lower.includes("urlopen") || lower.includes("connection")) {
            fail("FetchCity network error");
          } else if (lower.includes("city id không hợp lệ") || lower.includes("invalid city")) {
            fail("City ID không hợp lệ");
          } else if (lower.includes("no data")) {
            // Playrix answered `{"result": null}`: the request was fine but that
            // id has no city on the game server (never synced, or it is not a
            // city id). Measured on a real friend from the client's list whose
            // fetch failed three times while two other friends returned full
            // cities with the same version — so the version is not the cause.
            // Reporting the generic failure here makes a valid id look like a
            // broken downloader.
            fail("Playrix không có city cho id này — có thể người chơi chưa từng đồng bộ");
          } else {
            fail("FetchCity thất bại");
          }
          return;
        }
        fail(code === 0 ? "FetchCity không trả về city" : "FetchCity thất bại");
      });
    };

    runNext();
  });
}
