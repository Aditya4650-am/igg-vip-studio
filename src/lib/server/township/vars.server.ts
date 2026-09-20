import { insertInsideRoot } from "./xml-edit.server";

/** All igg-vip-tool Data fields (same Var names as the original Python tool). */
export const FIELD_MAP: Record<string, string> = {
  tca: "moneyCash",
  coi: "money",
  lvl: "levelup",
  win: "FirstAttemptM3Levels",
  m3l: "FirstAttemptM3Levels",
  liv: "LivesSent",
  hlp: "Achievement_Teamwork",
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

export function writeVar(xml: string, varName: string, value: string): string {
  const n = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const v = String(value);
  const a = new RegExp(`(<Var\\b[^>]*?\\bname="${n}"[^>]*?\\bv=")([^"]*)(")`, "i");
  if (a.test(xml)) return xml.replace(a, `$1${v}$3`);
  const b = new RegExp(`(<Var\\b[^>]*?\\bv=")([^"]*)("[^>]*?\\bname="${n}")`, "i");
  if (b.test(xml)) return xml.replace(b, `$1${v}$3`);
  const c = new RegExp(`(<DataElem\\b[^>]*?\\bname="${n}"[^>]*?\\bvalue=")([^"]*)(")`, "i");
  if (c.test(xml)) return xml.replace(c, `$1${v}$3`);
  const d = new RegExp(`(<DataElem\\b[^>]*?\\bvalue=")([^"]*)("[^>]*?\\bname="${n}")`, "i");
  if (d.test(xml)) return xml.replace(d, `$1${v}$3`);
  // A value typed as `i` but holding something non-numeric makes the game's
  // loader reject the whole save, so only claim a numeric type when the value
  // really is an integer.
  const type = /^-?\d+$/.test(v) ? "i" : "s";
  const insert = `<Var name="${varName}" v="${v}" t="${type}"/>`;
  return insertInsideRoot(xml, insert);
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

export function applyStatChanges(xml: string, changes: Record<string, string>): string {
  let text = xml.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
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
