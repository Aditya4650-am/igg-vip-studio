import { spawn } from "node:child_process";
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
];

const COMPLETO_BLOCKS = [
  "Zoo", "ZooInfo", "ZooQuests", "ArtInfo", "Ernie", "Trains", "IslandsInfo",
  "WildPark", "WildParkStash", "BuildingsStash", "AirInfo", "MapOrders",
  "FragmentedBeautyManager",
];

const NOVO_BLOCKS = ["Minigames", "DSCollapseQuests", "QuestsBook", "DSCollection", "DataStoreCollection"];

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

function cloneMain(src: string, tgt: string, tag: string): { xml: string; action: string } {
  const srcBlk = pickMain(src, tag);
  if (!srcBlk) return { xml: tgt, action: "missing_src" };
  const tgtBlk = pickMain(tgt, tag);
  if (tgtBlk) return { xml: tgt.slice(0, tgtBlk.start) + srcBlk.block + tgt.slice(tgtBlk.end), action: "replace" };
  const z = zooEnd(tgt);
  if (z >= 0) return { xml: tgt.slice(0, z) + "\n" + srcBlk.block + tgt.slice(z), action: "insert" };
  for (const c of ["</Global>", "</root>", "</Root>"]) {
    if (tgt.includes(c)) return { xml: tgt.replace(c, srcBlk.block + "\n" + c), action: "insert" };
  }
  return { xml: tgt + "\n" + srcBlk.block, action: "insert" };
}

function cloneSimple(src: string, tgt: string, tag: string): { xml: string; action: string } {
  const srcList = findAllBlocks(src, tag);
  if (!srcList.length) return { xml: tgt, action: "missing_src" };
  const block = srcList[0]!.block;
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

function copyDataElemByName(src: string, tgt: string, name: string) {
  const srcBlk = findDataElemBlock(src, name);
  if (!srcBlk) return tgt;
  const tgtBlk = findDataElemBlock(tgt, name);
  if (tgtBlk) return tgt.slice(0, tgtBlk.start) + srcBlk.block + tgt.slice(tgtBlk.end);
  for (const c of ["</Global>", "</root>", "</Root>"]) {
    if (tgt.includes(c)) return tgt.replace(c, srcBlk.block + "\n" + c);
  }
  return tgt + "\n" + srcBlk.block;
}

function isTutorialName(name: string) {
  const low = name.toLowerCase();
  if (name.startsWith("tip") && name.endsWith("TipSO")) return true;
  if (low.includes("tutorial") || low.includes("tutshowed")) return true;
  if (low.startsWith("needarrow")) return true;
  if (low.includes("tutor") && /(show|state|complete|finish)/i.test(low)) return true;
  if (low.endsWith("tutshowed") || low.endsWith("tutor_showed")) return true;
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

export function skipTutorials(xml: string, friend?: string) {
  let out = friend ? copyTutorialsFromFriend(xml, friend) : xml;
  for (const n of TUTORIAL_DONE) out = writeVar(out, n, "1");
  for (const n of TUTORIAL_OFF) out = writeVar(out, n, "0");

  for (const m of out.matchAll(/<Var\s+name="([^"]+)"\s+v="([^"]*)"/gi)) {
    const name = m[1]!;
    const current = m[2]!;
    if (!isTutorialName(name)) continue;
    const target = tutorialTargetValue(name, current);
    if (target !== current) out = writeVar(out, name, target);
  }

  const forced: Array<[string,string]> = [
    ["tutorial_finished_step", "TutorialInFriendCity"],
    ["tutorial_skip_CreateBread", "1"],
    ["tutorial_state", "18"],
    ["SellTutorial_state", "18"], ["SellTutorialsq0_state", "0"],
    ["OrderBreadTutorial_state", "18"], ["OrderMilkTutorial_state", "18"],
    ["PreOrderBreadTutorial_state", "18"], ["TutorialZooGetCompensation_state", "10"],
    ["AfterCloudShopArrowTutorial_state", "18"], ["AfterCloudShopArrowHouseTutorial_state", "10"],
    ["AfterCloudShopArrowFactoryTutorial_state", "10"], ["AfterCloudShopArrowCommunityTutorial_state", "10"],
    ["LabTutor1_state", "18"], ["LabTutor2_state", "18"], ["LabTutor3_state", "18"], ["LabTutor4_state", "18"],
    ["FirstDiggingClayTutorial_state", "18"], ["FirstDiggingStoneTutorial_state", "18"],
    ["FirstDiggingHardstoneTutorial_state", "18"], ["DiggingTutorial_state", "18"],
    ["BarnUpgradeTutorial_state", "18"], ["FactoryTutorial_state", "18"],
  ];
  for (const [name, value] of forced) out = writeVar(out, name, value);
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

export function cloneDecorOnly(ownXml: string, friendXml: string) {
  let own = ownXml.replace(/^\uFEFF/, "");
  const fr = friendXml.replace(/^\uFEFF/, "");
  const blocks: string[] = [];
  const vars: string[] = [];
  for (const tag of ["BuildingsStash", "FragmentedBeautyManager", "ArtInfo"]) {
    const r = cloneSimple(fr, own, tag);
    own = r.xml;
    if (r.action !== "missing_src") blocks.push(`${tag}:${r.action}`);
  }
  const em = readVarLoose(fr, "UnlockedChatEmoji");
  if (em != null) {
    own = writeVar(own, "UnlockedChatEmoji", em);
    vars.push("UnlockedChatEmoji");
  } else {
    own = unlockEmoji(own);
    vars.push("UnlockedChatEmoji:full");
  }
  for (const m of fr.matchAll(/<Var\s+name="((?:skin_|Skin_|decor_|Decor_)[^"]+)"\s+v="([^"]*)"/gi)) {
    own = writeVar(own, m[1]!, m[2]!);
    vars.push(m[1]!);
  }
  own = maxBuildingsStash(own, [], 10);
  own = maxFragments(own);
  return { xml: own, report: { blocks, vars } };
}

export function applyDesban(ownXml: string, friendXml: string, mode: "inicial" | "completo" | "novo") {
  let own = ownXml.replace(/^\uFEFF/, "");
  const fr = friendXml.replace(/^\uFEFF/, "");
  for (const name of INICIAL_VARS) {
    const val = readVarLoose(fr, name);
    if (val != null) own = writeVar(own, name, val);
  }
  for (const m of fr.matchAll(/<Var\s+name="(Achievement_[^"]+)"\s+v="([^"]*)"/gi)) {
    own = writeVar(own, m[1]!, m[2]!);
  }
  if (mode === "inicial") return skipTutorials(own, fr);

  for (const tag of ["TownGround", "Buildings"]) own = cloneMain(fr, own, tag).xml;
  for (const tag of COMPLETO_BLOCKS) own = cloneSimple(fr, own, tag).xml;

  for (const m of fr.matchAll(/<Var\s+name="(Unlocked_ava\d+)"\s+v="([^"]*)"/gi)) own = writeVar(own, m[1]!, m[2]!);
  const emoji = readVarLoose(fr, "UnlockedChatEmoji");
  if (emoji != null) own = writeVar(own, "UnlockedChatEmoji", emoji);
  for (const m of fr.matchAll(/<Var\s+name="((?:skin_|Skin_|decor_|Decor_)[^"]+)"\s+v="([^"]*)"/gi)) {
    own = writeVar(own, m[1]!, m[2]!);
  }

  if (mode === "novo") {
    for (const tag of NOVO_BLOCKS) own = cloneSimple(fr, own, tag).xml;
  }

  // v1.15 also restores the profile/config DataElem blocks for every full
  // restore mode. These are distinct from the Unlocked* profile CSV fields
  // handled by the normal Profile tool.
  own = copyDataElemByName(fr, own, "PlayerProfile");
  own = copyDataElemByName(fr, own, "Configs");

  return skipTutorials(own, fr);
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
  const val = "," + merged.join(",,") + ",,";
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
      const py = spawn(bin, [script, target, useBver, useFver], {
        cwd: dirname(script),
        timeout: 90000,
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      py.stdout.setEncoding("utf8");
      py.stdout.on("data", (d) => { out += d; });
      py.on("error", (e) => {
        lastError = e.message;
        runNext();
      });
      py.on("close", (code) => {
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
