import { attrValue } from "./xml-edit.server";

/** All igg-vip-tool Data fields (same Var names as the original Python tool). */
export const FIELD_MAP: Record<string, string> = {
  tca: "moneyCash",
  coi: "money",
  lvl: "levelup",
  win: "FirstAttemptM3Levels",
  m3l: "FirstAttemptM3Levels",
  liv: "LivesSent",
  hlp: "Achievement_Teamwork",
  crd: "FullCardCollections",
  reg: "RegataTasksCompleted",
  dat: "gameStartDate",
  exp: "expeditionEnergy",
  residents: "residents",
  match3Life: "match3Life",
  key: "key",
  spentCash: "spentCash",
  earnedCash: "earnedCash",
  EarnedCoins: "EarnedCoins",
  wheatCounter: "wheatCounter",
  plowFieldsAchiev: "plowFieldsAchiev",
  defaultOrdersCount: "defaultOrdersCount",
  mineCounter: "mineCounter",
  timeInGame: "timeInGame",
  WareHouseCashUpgrade: "WareHouseCashUpgrade",
  WHUdup: "WHUdup",
  Match3Lives_infTime: "Match3Lives_infTime",
  xpr: "experience",
  xpl: "ExpandLevel",
  zxl: "ZooExpandLevel",
};

// Match-3 progress is mirrored across these three Vars in the legacy/TWN tool.
// The UI presents one value; reads take the highest present value and writes mirror it
// back to every matching variable that exists (or create the trio when none exists).
export const MATCH3_PROGRESS_VARS = [
  "m3_comp_lvls",
  "Achievement_CompleteMatch3Levels",
  "FirstAttemptM3Levels",
] as const;

/**
 * Save variants across game builds expose these counters under different names.
 * Reads use the first present alias; writes update every alias already present
 * so the value the UI shows is the value the game reads back.
 */
export const STAT_ALIASES: Record<string, readonly string[]> = {
  reg: ["RegataTasksCompleted", "RegattaTasksCompleted"],
  residents: ["residents", "Residents"],
  exp: ["expeditionEnergy", "expeditionEnergy_1"],
};

export const DATA_FIELDS = Object.keys(FIELD_MAP);

export function readVar(xml: string, varName: string): string | null {
  const n = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = xml.match(new RegExp(`<Var\\b[^>]*?\\bname="${n}"[^>]*?\\bv="([^"]*)"`, "i"));
  if (a) return a[1]!;
  const b = xml.match(new RegExp(`<Var\\b[^>]*?\\bv="([^"]*)"[^>]*?\\bname="${n}"`, "i"));
  if (b) return b[1]!;
  const c = xml.match(new RegExp(`<DataElem\\b[^>]*?\\bname="${n}"[^>]*?\\bvalue="([^"]*)"`, "i"));
  if (c) return c[1]!;
  const d = xml.match(new RegExp(`<DataElem\\b[^>]*?\\bvalue="([^"]*)"[^>]*?\\bname="${n}"`, "i"));
  return d ? d[1]! : null;
}

/** First non-empty value among several Var/DataElem aliases. */
export function readAnyVar(xml: string, names: readonly string[]): string | null {
  for (const name of names) {
    const v = readVar(xml, name);
    if (v != null && v !== "") return v;
  }
  return null;
}

/**
 * Account age in seconds **as the save declares it**: `saveGlobalTime -
 * TermsAcceptTime`. `null` when either is missing or the pair is not a sane
 * positive interval, so a save that never tracked them gains no rule below.
 *
 * `TermsAcceptTime` is re-stamped when an account is created — the injected
 * fresh profile's 2025-05-11 value becomes the real creation time on first
 * launch — so this reads the account's own age rather than the age of the
 * profile file it started from.
 */
export function accountAgeSeconds(xml: string): number | null {
  const raw = (name: string): number | null => {
    const v = readVar(xml, name);
    if (v == null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const start = raw("TermsAcceptTime");
  const end = raw("saveGlobalTime");
  if (start == null || end == null) return null;
  const age = end - start;
  return age > 0 ? age : null;
}

/**
 * `true` when the save claims more seconds of play than the account has
 * existed — `timeInGame > saveGlobalTime - TermsAcceptTime`.
 *
 * Measured over the 11 saves on file: **7/7 banned, 3/4 clean**, and the one
 * clean file that trips it (`SJzfOUKzQx`) is a 2022 account whose
 * `TermsAcceptTime` was re-stamped on a 2026 reinstall while `timeInGame`
 * kept its genuine 66 days — so the relation can fire on a real old account
 * and is not a ban verdict on its own. On the banned files the magnitude is
 * 13x to 12,478x: a 6-minute-old account claiming 1,202 hours of play.
 *
 * This is the shape a copy creates, because `timeInGame` follows the friend
 * while `TermsAcceptTime` / `saveGlobalTime` stay ours. The trip point is set
 * by the donor's own number — 3.3049 hours on `3ZVJSA080P` — so any account
 * younger than the friend's playtime becomes arithmetically impossible the
 * moment the value lands on it.
 */
export function timeInGameExceedsAge(xml: string): boolean {
  const raw = readVar(xml, "timeInGame");
  if (raw == null || raw.trim() === "") return false;
  const tig = Number(raw);
  if (!Number.isFinite(tig) || tig <= 0) return false;
  const age = accountAgeSeconds(xml);
  return age != null && tig > age;
}

/**
 * The two places a save declares the co-op (clan) it belongs to, kept apart on
 * purpose: `<MyClan id="...">` on the element and `<Var name="MyClanId">`.
 * `null` means "this document does not carry that field at all", which is
 * different from `""` — an empty id is the game's own "not in a co-op".
 *
 * Measured on every save on file (7/7): the two always carry the same value,
 * and `<RegataCenter clanId>` / `<Regata clanId>` agree with them wherever they
 * appear. Two of those saves declare no co-op and both fields are `""` or
 * absent together, so "absent" and "empty" both mean the same thing to a
 * reader — only the *split* is an anomaly.
 *
 * Co-op membership is account state, not town state: which team this file
 * claims to be in is part of whose file it is, so a copy that moved it would
 * hand the server a file disagreeing with itself about its own team. Nothing
 * here writes it; this reader exists so the restore and the push gate can both
 * prove that.
 */
export function readCoopId(xml: string): { tag: string | null; v: string | null } {
  const t = /<MyClan\b[^>]*>/i.exec(xml);
  return { tag: t ? attrValue(t[0], "id") : null, v: readVar(xml, "MyClanId") };
}

/** True when a save carries both co-op fields and they name different clans. */
export function coopIdSplit(xml: string): boolean {
  const { tag, v } = readCoopId(xml);
  return tag != null && v != null && tag !== v;
}

export function writeVar(xml: string, varName: string, value: string): string {
  const n = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const v = String(value);
  const isAvatar = /^Unlocked_ava\d+$/.test(varName);
  const tailCapture = isAvatar ? "([^>]*)" : "";
  const tailRef = isAvatar ? "$4" : "";

  // Var with v="..." (name before v) - replace ALL, preserve rest of tag for avatars
  const a = new RegExp(`(<Var\\b[^>]*?\\bname="${n}"[^>]*?\\bv=")([^"]*)(")${tailCapture}`, "i");
  if (a.test(xml)) return xml.replace(a, `$1${v}$3${tailRef}`);
  // Var with v="..." (v before name) - replace ALL, preserve rest for avatars
  const b = new RegExp(`(<Var\\b[^>]*?\\bv=")([^"]*)(")([^>]*?\\bname="${n}"[^>]*)`, "i");
  if (b.test(xml)) return xml.replace(b, `$1${v}$3$4`);
  // DataElem with value="..." (name before value)
  const c = new RegExp(`(<DataElem\\b[^>]*?\\bname="${n}"[^>]*?\\bvalue=")([^"]*)(")`, "i");
  if (c.test(xml)) return xml.replace(c, `$1${v}$3`);
  // DataElem with value="..." (value before name)
  const d = new RegExp(`(<DataElem\\b[^>]*?\\bvalue=")([^"]*)("[^>]*?\\bname="${n}")`, "i");
  if (d.test(xml)) return xml.replace(d, `$1${v}$3`);
  // Insert only. The game writes an integer as `t="i"`, a flag as `t="b"` and
  // a string with **no `t` at all** — measured on the same var,
  // `tutorial_finished_step`, across 15 saves: 14 carry no `t` and the single
  // `t="s"` is in a file this tool exported. `t="s"` was ours, so a var we
  // create now looks exactly like one the game created. Floats take no `t`
  // either rather than guessing between the game's `f` and `d`.
  const type = isAvatar ? "b" : /^-?\d+$/.test(v) ? "i" : "";
  const insert = type ? `<Var name="${varName}" v="${v}" t="${type}"/>` : `<Var name="${varName}" v="${v}"/>`;
  for (const closer of ["</Global>", "</root>", "</Root>", "</ROOT>"]) {
    if (xml.includes(closer)) return xml.replace(closer, insert + closer);
  }
  return xml + insert;
}

export function formatDat(raw: string | null): string {
  if (!raw) return "";
  if (/^\d+$/.test(raw) && Number(raw) > 1_000_000_000) {
    const d = new Date(Number(raw) * 1000);
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getUTCFullYear()}`;
  }
  return raw;
}

export function parseDat(raw: string): string {
  const s = raw.trim();
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (!m) return s;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  return String(Math.floor(Date.UTC(yyyy, mm - 1, dd) / 1000));
}

export function parseStats(xml: string): Record<string, string> {
  const stats: Record<string, string> = {};
  for (const fid of DATA_FIELDS) {
    if (fid === "win" || fid === "m3l") continue;
    const aliases = STAT_ALIASES[fid];
    const v = aliases ? readAnyVar(xml, aliases) : readVar(xml, FIELD_MAP[fid]!);
    if (v == null) continue;
    stats[fid] = fid === "dat" ? formatDat(v) : v;
  }

  const m3Values = MATCH3_PROGRESS_VARS
    .map((name) => readVar(xml, name))
    .map((value) => value == null ? null : Number.parseInt(value, 10))
    .filter((value): value is number => Number.isFinite(value));
  if (m3Values.length) {
    const shared = String(Math.max(...m3Values));
    stats.win = shared;
    stats.m3l = shared;
  }
  return stats;
}

/**
 * Anti-instant-ban soft caps for cash/coins by city level.
 *
 * A level-10 city can never legitimately hold millions, and Playrix flags
 * impossible values on the next sync. These community-style bands are a
 * heuristic, not official limits: values above the band are clamped down to
 * it, everything else passes through untouched. Only `tca` (T-cash) and
 * `coi` (coins) are capped — levels, dates and other fields are left alone.
 */
export function sanitizeStatChanges(xml: string, changes: Record<string, string>): Record<string, string> {
  const out = { ...changes };
  const levelRaw = readVar(xml, "levelup") ?? readVar(xml, "level") ?? "1";
  const level = Math.max(1, parseInt(String(levelRaw), 10) || 1);

  let maxCash = 50000;
  if (level < 20) maxCash = 3000;
  else if (level < 35) maxCash = 8000;
  else if (level < 50) maxCash = 15000;
  else if (level < 70) maxCash = 30000;

  let maxCoins = 5000000;
  if (level < 20) maxCoins = 200000;
  else if (level < 50) maxCoins = 1000000;

  if (out.tca != null && out.tca !== "") {
    const v = parseInt(String(out.tca), 10);
    if (Number.isFinite(v) && v > maxCash) out.tca = String(maxCash);
  }
  if (out.coi != null && out.coi !== "") {
    const v = parseInt(String(out.coi), 10);
    if (Number.isFinite(v) && v > maxCoins) out.coi = String(maxCoins);
  }
  return out;
}

export function applyStatChanges(xml: string, changes: Record<string, string>): string {
  let text = xml.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  changes = sanitizeStatChanges(text, changes);
  const sharedM3 = (changes.win ?? changes.m3l ?? "").trim();

  for (const fid of DATA_FIELDS) {
    if (fid === "win" || fid === "m3l") continue;
    if (!(fid in changes)) continue;
    const val = changes[fid]?.trim() ?? "";
    if (!val) continue;
    const value = fid === "dat" ? parseDat(val) : val;
    const aliases = STAT_ALIASES[fid];
    if (aliases) {
      const present = aliases.filter((name) => readVar(text, name) != null);
      // Update every alias already in the save; only create one when the save
      // has none, so we never litter the document with duplicate counters.
      for (const name of present.length ? present : [aliases[0]!]) {
        text = writeVar(text, name, value);
      }
      continue;
    }
    text = writeVar(text, FIELD_MAP[fid]!, value);
  }

  if (sharedM3) {
    const present = MATCH3_PROGRESS_VARS.filter((name) => readVar(text, name) != null);
    if (present.length) {
      for (const name of present) text = writeVar(text, name, sharedM3);
    } else {
      for (const name of MATCH3_PROGRESS_VARS) text = writeVar(text, name, sharedM3);
    }
  }
  return text;
}