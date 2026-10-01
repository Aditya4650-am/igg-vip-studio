import { spawn } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_EMOJI_IDS } from "./chat-emoji.server";
import { decodeContainer, extractXml, shellErrorMessage } from "./save-decode.server";
import { writeVar } from "./vars.server";
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
  "levelup", "money", "moneyCash", "EarnedCoins", "residents", "wheatCounter",
  "plowFieldsAchiev", "defaultOrdersCount", "match3Life", "Match3Lives_infTime",
  "spentCash", "earnedCash", "timeInGame", "FirstAttemptM3Levels", "LivesSent",
  "Achievement_Teamwork", "FullCardCollections", "RegataTasksCompleted",
  "gameStartDate", "Achievement_BuiltFactories", "Achievement_EarneCoins",
  "Achievement_IncreasedPopulation", "Achievement_PlowedFields", "Achievement_SpentCoins",
  "Achievement_BuiltHouses", "Achievement_CompleteMatch3Levels", "WareHouseCashUpgrade",
  "WHUdup", "ExpandLevel",
  // Level and experience are one number written twice: `levelup` is derived
  // from the cumulative `experience`, so a copy that moves the level but not
  // the XP hands Playrix a city claiming 1089 levels with a level-30 player's
  // experience behind it. That pair appears in no game-written save — only in
  // files this tool produced — and it is arithmetically impossible, which is
  // the cheapest kind of anomaly for a server to read. All four fetched or
  // decoded saves agree: 30 -> 172109, 30 -> 170849, 999 -> 2436381253,
  // 1089 -> 3370037992, rising together. `experience` has no stat alias, so
  // one write is the whole story.
  "experience",
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
 * Account history — the numbers Playrix keeps **its own** copy of for your
 * account and compares against when you upload.
 *
 * Measured by running all three restore modes over real saves: `inicial` alone
 * moved ~190 vars, and on a level-999 save copying a level-1089 city it wrote
 * `levelup 999 -> 1089`, `experience 2436381253 -> 3370037992`,
 * `RegataTasksCompleted 9868 -> 44911` and `FirstAttemptM3Levels 5698 -> 92524`
 * — every one of them a field the player never earned on this account, in a
 * single sync. The file stayed internally consistent (level and XP arrive as a
 * matched pair, so the shape and progression gates both stayed quiet), and the
 * identity gate found zero leaked cityId/deviceId/user values — yet that is the
 * upload that gets flagged, because the contradiction is against Playrix's
 * records rather than inside the save. No cleanup of the file can hide it.
 *
 * So the boundary is: **the city comes from the friend, the account history
 * stays yours.** Everything below is frozen at our own value on every mode.
 * `Achievement_*` joins by prefix because the restore copies every one of them
 * wholesale (265 on a real run) and a lifetime achievement count that jumps to
 * a stranger's is the same anomaly as the level.
 *
 * Not in this set, and still copied: `residents`, `wheatCounter`,
 * `plowFieldsAchiev`, `defaultOrdersCount`, `match3Life`, `Match3Lives_infTime`,
 * `WareHouseCashUpgrade`, `WHUdup`, `ExpandLevel` — city state, which follows
 * the town it describes. Copying a friend's buildings while keeping your own
 * population and barn would leave the city disagreeing with itself.
 */
const ACCOUNT_HISTORY_VARS = new Set([
  "levelup", "experience", "money", "moneyCash",
  "EarnedCoins", "spentCash", "earnedCash",
  "gameStartDate", "timeInGame",
  "RegataTasksCompleted", "FirstAttemptM3Levels",
  "LivesSent", "Achievement_Teamwork",
  "FullCardCollections",
]);

const isAccountHistory = (name: string) =>
  ACCOUNT_HISTORY_VARS.has(name) || /^Achievement_/i.test(name);

/**
 * Re-assert our own history over whatever the merge wrote.
 *
 * Runs as a single pass so a name our save carries twice keeps two copies (a
 * genuine save may hold up to 35 duplicated var names) and the donor's surplus
 * is dropped rather than left in place. A history var the donor brought that we
 * never had is removed outright — importing a stranger's lifetime counter is
 * exactly what this exists to prevent. Anything of ours a cloned block
 * overwrote is written back through `insertInsideRoot`, so it lands before
 * `</Global>` and never past `</root>` where the game would not read it.
 */
function keepOwnHistory(before: string, merged: string): string {
  const ours = new Map<string, string[]>();
  for (const m of before.matchAll(/<Var\s+name="([^"]+)"[^>]*?(?:\/>|>[\s\S]*?<\/Var\s*>)/gi)) {
    const name = m[1]!;
    if (!isAccountHistory(name)) continue;
    const list = ours.get(name);
    if (list) list.push(m[0]!);
    else ours.set(name, [m[0]!]);
  }

  const taken = new Map<string, number>();
  let out = merged.replace(/<Var\s+name="([^"]+)"[^>]*?(?:\/>|>[\s\S]*?<\/Var\s*>)/gi, (full, name: string) => {
    if (!isAccountHistory(name)) return full;
    const list = ours.get(name);
    if (!list) return "";
    const i = taken.get(name) ?? 0;
    if (i >= list.length) return "";
    taken.set(name, i + 1);
    return list[i]!;
  });

  for (const [name, list] of ours) {
    const used = taken.get(name) ?? 0;
    for (let i = used; i < list.length; i++) out = insertInsideRoot(out, list[i]!);
  }
  return out;
}

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

function copyDataElemByName(src: string, tgt: string, name: string, scrub = scrubber(src, tgt)) {
  const srcBlk = findDataElemBlock(src, name);
  if (!srcBlk) return tgt;
  const block = scrub(srcBlk.block);
  const tgtBlk = findDataElemBlock(tgt, name);
  if (tgtBlk) return tgt.slice(0, tgtBlk.start) + block + tgt.slice(tgtBlk.end);
  for (const c of ["</Global>", "</root>", "</Root>"]) {
    if (tgt.includes(c)) return tgt.replace(c, block + "\n" + c);
  }
  return tgt + "\n" + block;
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
  if (low.includes("exped") && (low.includes("lock") || low.includes("reward") || low.includes("tutorial") || low.includes("energy") || low.includes("playbtn") || low.includes("quest") || low.includes("show"))) return true;
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
  const em = readVarLoose(fr, "UnlockedChatEmoji");
  if (em != null) {
    own = writeVar(own, "UnlockedChatEmoji", scrub(em));
    vars.push("UnlockedChatEmoji");
  } else {
    own = unlockEmoji(own);
    vars.push("UnlockedChatEmoji:full");
  }
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
  assertNoForeignIdentity(before, own, fr);
  return { xml: own, report: { blocks, vars: [] } };
}

/** Machine-readable form of the "the town was already the donor's" refusal. */
export const TOWN_UNCHANGED = "town-unchanged";

export function isTownUnchanged(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === TOWN_UNCHANGED;
}

export function applyDesban(ownXml: string, friendXml: string, mode: "inicial" | "completo" | "novo") {
  let own = ownXml.replace(/^\uFEFF/, "");
  const before = own;
  const fr = friendXml.replace(/^\uFEFF/, "");
  const scrub = scrubber(fr, own);
  for (const name of INICIAL_VARS) {
    const val = readVarLoose(fr, name);
    if (val != null) own = writeVar(own, name, scrub(val));
  }
  for (const m of fr.matchAll(/<Var\s+name="(Achievement_[^"]+)"\s+v="([^"]*)"/gi)) {
    own = writeVar(own, m[1]!, scrub(m[2]!));
  }
  if (mode !== "inicial") {
    for (const tag of ["TownGround", "Buildings"]) own = cloneMain(fr, own, tag, scrub).xml;
    for (const tag of COMPLETO_BLOCKS) own = cloneSimple(fr, own, tag, scrub).xml;

    for (const m of fr.matchAll(/<Var\s+name="(Unlocked_ava\d+)"\s+v="([^"]*)"/gi)) own = writeVar(own, m[1]!, scrub(m[2]!));
    const emoji = readVarLoose(fr, "UnlockedChatEmoji");
    if (emoji != null) own = writeVar(own, "UnlockedChatEmoji", scrub(emoji));
    for (const m of fr.matchAll(/<Var\s+name="((?:skin_|Skin_|decor_|Decor_)[^"]+)"\s+v="([^"]*)"/gi)) {
      own = writeVar(own, m[1]!, scrub(m[2]!));
    }

    if (mode === "novo") {
      for (const tag of NOVO_BLOCKS) own = cloneSimple(fr, own, tag, scrub).xml;
    }

    // v1.15 also restores the profile/config DataElem blocks for every full
    // restore mode. These are distinct from the Unlocked* profile CSV fields
    // handled by the normal Profile tool.
    own = copyDataElemByName(fr, own, "PlayerProfile", scrub);
    own = copyDataElemByName(fr, own, "Configs", scrub);
  }

  own = skipTutorials(own, fr);
  // Applied on every mode, last: the city comes from the donor, the account
  // history stays ours. Placing it after the block copies means it also undoes
  // a history var a cloned block brought in, and before the identity gate so a
  // refused merge is what the gate sees.
  own = keepOwnHistory(before, own);
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
