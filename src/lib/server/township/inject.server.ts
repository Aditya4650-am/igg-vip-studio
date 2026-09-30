import {
  REGATTA_DEFAULT_TASKS,
  REGATTA_MAX_TASKS,
  regattaBounds,
  regattaReason,
  regattaWant,
  type RegattaReason,
} from "../../regatta";
import { writeVar } from "./vars.server";
import { AVATAR_MAX } from "../../catalogs";
import { SKINS_CATALOG } from "./skins-catalog.server";
import { attrValue, insertInsideRoot } from "./xml-edit.server";
import { RAW_FACTORIES, RAW_ISLANDS, RAW_TRAINS } from "../catalogs.data.server";

function asText(xml: string | Buffer) {
  return typeof xml === "string" ? xml : xml.toString("utf8");
}

function insertBeforeRoot(xml: string, insert: string) {
  return insertInsideRoot(xml, insert);
}

function insertBeforeGlobal(xml: string, insert: string): string {
  const globalRegex = /<\/Global\s*>/i;
  if (globalRegex.test(xml)) {
    return xml.replace(globalRegex, `${insert}\n$&`);
  }
  return xml + insert;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getExistingAvatars(xml: string, maxAva = AVATAR_MAX): number[] {
  const text = asText(xml);
  const result = new Set<number>();
  const regex = /<Var\s+name="(Unlocked_ava\d+)"[^/]*\/>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const m = match[1].match(/^Unlocked_ava(\d+)$/i);
    if (!m) continue;
    const id = Number(m[1]);
    if (Number.isInteger(id) && id >= 1 && id <= maxAva) {
      result.add(id);
    }
  }
  return [...result].sort((a, b) => a - b);
}

export function unlockAllAvatars(
  xml: string,
  maxAva = AVATAR_MAX
): { xml: string; created: number[]; updated: number[] } {
  let text = asText(xml);
  const created: number[] = [];
  const updated: number[] = [];

  maxAva = Math.max(1, Math.floor(maxAva));
  // Never let a caller reach past the game's own ceiling: a var the game has
  // never issued is a shape no city on the server contains.
  maxAva = Math.min(maxAva, AVATAR_MAX);
  const existing = getExistingAvatars(text, maxAva);
  const existingSet = new Set(existing);

  for (const id of existing) {
    const name = `Unlocked_ava${id}`;
    const regex = new RegExp(`<Var\\s+name="${escapeRegExp(name)}"[^/]*\\/\\s*>`, "i");
    if (regex.test(text)) {
      text = text.replace(regex, `<Var name="${name}" v="1" t="b"/>`);
      updated.push(id);
      continue;
    }
    const reverseRegex = new RegExp(`<Var\\b(?=[^>]*\\bname="${escapeRegExp(name)}")(?=[^>]*\\bv=")[^>]*\\/\\s*>`, "i");
    if (reverseRegex.test(text)) {
      text = text.replace(reverseRegex, `<Var name="${name}" v="1" t="b"/>`);
      updated.push(id);
    }
  }

  const missing: number[] = [];
  for (let id = 1; id <= maxAva; id++) {
    if (!existingSet.has(id)) {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    const insert = missing
      .map((id) => `<Var name="Unlocked_ava${id}" v="1" t="b"/>`)
      .join("\n");
    // `insertBeforeRoot` lands the block before `</Global>` — the game-data
    // container — and, if the save has no `</Global>`, inside the root. The
    // inline `text + insert` fallback this replaces appended past `</root>`,
    // which is well-formed-looking XML the game silently discards: a success
    // that changes nothing in game.
    text = insertBeforeRoot(text, insert);
    created.push(...missing);
  }

  return { xml: text, created, updated };
}

/** Set an attribute on an open-tag attribute string, preserving all others. */
function putAttr(attrs: string, name: string, value: string) {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s/>]+)`, "i");
  if (re.test(attrs)) return attrs.replace(re, `$1"${value}"`);
  return `${attrs.replace(/\s+$/, "")} ${name}="${value}"`;
}

export function injectItems(xml: string, qtyMap: Record<string, number>) {
  let text = asText(xml);
  const add: Record<string, number> = {};
  for (const [k, v] of Object.entries(qtyMap)) {
    const n = Math.floor(Number(v));
    if (k.trim() && n > 0) add[k.trim()] = n;
  }
  if (!Object.keys(add).length) return text;
  const parseCsv = (s: string) => {
    const out: Record<string, number> = {};
    for (const part of (s || "").split(",")) {
      const [name, qty] = part.split(":");
      if (!name?.trim() || !qty) continue;
      const n = Number(qty);
      if (n > 0) out[name.trim()] = (out[name.trim()] ?? 0) + n;
    }
    return out;
  };
  const m =
    text.match(/<Var\b[^>]*\bname="GivingOffersDeferred"[^>]*\bv="([^"]*)"/i) ||
    text.match(/<Var\b[^>]*\bv="([^"]*)"[^>]*\bname="GivingOffersDeferred"/i);
  const merged = parseCsv(m?.[1] ?? "");
  for (const [k, v] of Object.entries(add)) merged[k] = (merged[k] ?? 0) + v;
  const csv = Object.entries(merged)
    .filter(([, q]) => q > 0)
    .map(([k, q]) => `${k}:${q}`)
    .join(",");
  return writeVar(text, "GivingOffersDeferred", csv);
}

export function injectSeason(xml: string, premium = "1", score = "1002") {
  const text = asText(xml);
  const m = /<SeasonTicket\b([^>]*?)(\/?)>/i.exec(text);
  if (m && m.index !== undefined) {
    // A SeasonTicket may carry per-level child elements. Rewriting only the
    // open tag keeps those children intact; emitting a self-closing tag in
    // front of the old `</SeasonTicket>` would corrupt the document.
    const selfClosing = m[2] === "/";
    let attrs = putAttr(m[1] ?? "", "premium", premium);
    attrs = putAttr(attrs, "score", score);
    const tag = selfClosing ? `<SeasonTicket${attrs}/>` : `<SeasonTicket${attrs}>`;
    return text.slice(0, m.index) + tag + text.slice(m.index + m[0].length);
  }
  return insertBeforeRoot(text, `<SeasonTicket premium="${premium}" score="${score}"/>`);
}

export function injectAvatars(xml: string, selection: string[], maxAva = AVATAR_MAX) {
  let text = asText(xml);
  const indices = new Set<number>();
  for (const raw of selection) {
    const m = String(raw).match(/(\d+)/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= maxAva) indices.add(n);
  }
  const list = [...indices].sort((a, b) => a - b);
  if (!list.length) return text;
  for (const i of list) {
    const name = `Unlocked_ava${i}`;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const gClose = text.search(/<\/Global\s*>/i);
    const insideGlobal = gClose >= 0 ? text.slice(0, gClose) : text;
    if (new RegExp(`name="${esc}"`, "i").test(insideGlobal)) {
      text = writeVar(text, name, "1");
      continue;
    }
    if (gClose >= 0) {
      // Drop stale copies stranded outside <Global> by older builds. The game
      // never reads that strip (only GameInfoPatcher lives there), and leaving
      // the stray copy would shadow the fresh var created below.
      const tail = text.slice(gClose);
      const cleaned = tail.replace(new RegExp(`<Var\\b[^>]*?\\bname="${esc}"[^>]*?/>`, "gi"), "");
      if (cleaned.length !== tail.length) text = text.slice(0, gClose) + cleaned;
    }
    text = insertBeforeRoot(text, `<Var name="${name}" v="1" t="b"/>`);
  }
  return text;
}

export function injectSkins(xml: string, selection: Record<string, string[]>) {
  let text = asText(xml);
  const catalog = SKINS_CATALOG;
  const wanted: Record<string, string[]> = {};
  for (const [tid, parts] of Object.entries(selection)) {
    if (tid && parts?.length) wanted[tid] = parts.map(String);
  }
  if (!Object.keys(wanted).length) {
    for (const [tid, avail] of Object.entries(catalog)) {
      wanted[tid] = avail.split("|").filter(Boolean);
    }
  }
  const merge = (old: string, extra: string[]) => {
    const seen: string[] = [];
    for (const p of [...old.split("|"), ...extra]) {
      const t = p.trim();
      if (t && !seen.includes(t)) seen.push(t);
    }
    return seen.join("|") + (seen.length ? "|" : "");
  };
  const blockM = text.match(/<Skins\b[^>]*>[\s\S]*?<\/Skins\s*>/i);
  if (!blockM || blockM.index === undefined) {
    const lines = ["<Skins>"];
    for (const [tid, parts] of Object.entries(wanted)) {
      lines.push(`  <type id="${tid}" available="${merge(catalog[tid] ?? "", parts)}" needViewUpgradeEffect="0"/>`);
    }
    lines.push("</Skins>");
    return insertBeforeRoot(text, lines.join("\n"));
  }
  let block = blockM[0];
  for (const [tid, parts] of Object.entries(wanted)) {
    const esc = tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pat = new RegExp(`(<type\\b[^>]*\\bid="${esc}"[^>]*\\bavailable=")([^"]*)(")`, "i");
    if (pat.test(block)) {
      block = block.replace(pat, (_, a, old, c) => `${a}${merge(old, parts)}${c}`);
      continue;
    }
    const patB = new RegExp(`(<type\\b[^>]*\\bavailable=")([^"]*)("[^>]*\\bid="${esc}")`, "i");
    if (patB.test(block)) {
      block = block.replace(patB, (_, a, old, c) => `${a}${merge(old, parts)}${c}`);
      continue;
    }
    block = block.replace(/<\/Skins\s*>/i, `  <type id="${tid}" available="${merge("", parts)}" needViewUpgradeEffect="0"/>\n</Skins>`);
  }
  return text.slice(0, blockM.index) + block + text.slice(blockM.index + blockM[0].length);
}

const KEY_MAP: Record<string, string> = {
  Badges: "UnlockedBadges",
  ExpRanks: "UnlockedExpRanks",
  Frames: "UnlockedFrames",
  Styles: "UnlockedStyles",
  Themes: "UnlockedThemes",
  Titles: "UnlockedTitles",
  UnlockedBadges: "UnlockedBadges",
  UnlockedExpRanks: "UnlockedExpRanks",
  UnlockedFrames: "UnlockedFrames",
  UnlockedStyles: "UnlockedStyles",
  UnlockedThemes: "UnlockedThemes",
  UnlockedTitles: "UnlockedTitles",
};

function findConfigsSpan(doc: string): [number, number] | null {
  const pp = doc.match(/<DataElem\b[^>]*\bname="PlayerProfile"[^>]*\btype="dataStore"[^>]*>/i);
  const from = pp?.index !== undefined ? pp.index + pp[0].length : 0;
  const tail = doc.slice(from);
  const m = tail.match(/<DataElem\b[^>]*\bname="Configs"[^>]*\btype="dataStore"[^>]*>/i) ?? tail.match(/<DataElem\b[^>]*\bname="Configs"[^>]*>/i);
  if (!m || m.index === undefined) return null;
  const openEnd = from + m.index + m[0].length;
  let depth = 1;
  let pos = openEnd;
  while (depth > 0 && pos < doc.length) {
    const rest = doc.slice(pos);
    const o = rest.search(/<DataElem\b/i);
    const c = rest.search(/<\/DataElem\s*>/i);
    if (c < 0) return null;
    if (o >= 0 && o < c) {
      const abs = pos + o;
      const gt = doc.indexOf(">", abs);
      if (gt >= 0 && doc[gt - 1] !== "/") depth++;
      pos = gt >= 0 ? gt + 1 : abs + 9;
    } else {
      const absC = pos + c;
      depth--;
      if (depth === 0) return [openEnd, absC];
      pos = absC + c;
    }
  }
  return null;
}

function profileRead(doc: string, span: [number, number] | null, name: string) {
  const region = span ? doc.slice(span[0], span[1]) : doc;
  return region.match(new RegExp(`<DataElem\\b(?=[^>]*\\bname="${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}")[^>]*\\bvalue="([^"]*)"`, "i"))?.[1]?.trim() ?? "";
}

function mergeCsv(old: string, extra: string[]) {
  const seen: string[] = [];
  for (const x of [...old.split(","), ...extra]) {
    const t = x.trim();
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen.join(",");
}

export function parseProfileUnlocked(xml: string): Record<string, string[]> {
  const out: Record<string, string[]> = { Badges: [], Frames: [], Styles: [], Themes: [], ExpRanks: [] };
  const map: Record<string, string> = {
    UnlockedBadges: "Badges",
    UnlockedFrames: "Frames",
    UnlockedStyles: "Styles",
    UnlockedThemes: "Themes",
    UnlockedExpRanks: "ExpRanks",
    UnlockedTitles: "ExpRanks",
  };
  for (const [field, group] of Object.entries(map)) {
    const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = xml.match(new RegExp(`<DataElem\\b(?=[^>]*\\bname="${esc}")[^>]*\\bvalue="([^"]*)"`, "i"));
    if (!m?.[1]) continue;
    for (const id of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!out[group].includes(id)) out[group].push(id);
    }
  }
  return out;
}

export function injectProfile(xml: string, selection: Record<string, string[]>) {
  let text = asText(xml);
  let span = findConfigsSpan(text);
  const unlockMap: Record<string, string> = {};
  for (const [group, ids] of Object.entries(selection)) {
    if (!ids?.length) continue;
    let field = KEY_MAP[group] ?? group;
    if (!field.startsWith("Unlocked")) field = `Unlocked${field}`;
    const existing = profileRead(text, span, field);
    unlockMap[field] = mergeCsv(existing, ids.map(String));
  }
  if (!Object.keys(unlockMap).length) return text;

  for (const [field, value] of Object.entries(unlockMap)) {
    span = findConfigsSpan(text);
    const region = span ? text.slice(span[0], span[1]) : text;
    const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pat = new RegExp(`(<DataElem\\b(?=[^>]*\\bname="${esc}")[^>]*\\bvalue=")([^"]*)(")`, "i");
    const m = pat.exec(region);
    if (m) {
      const s0 = span ? span[0] : 0;
      const abs = s0 + m.index;
      const replacement = m[1] + value + m[3];
      text = text.slice(0, abs) + replacement + text.slice(abs + m[0].length);
    } else if (span) {
      const tag = `\n\t\t\t\t\t<DataElem name="${field}" type="string" value="${value}"/>`;
      text = text.slice(0, span[1]) + tag + text.slice(span[1]);
    } else {
      text = insertBeforeRoot(text, `\n<DataElem name="${field}" type="string" value="${value}"/>`);
    }
  }

  const newMap: Record<string,string> = {
    UnlockedBadges: "NewBadges",
    UnlockedFrames: "NewFrames",
    UnlockedStyles: "NewStyles",
    UnlockedThemes: "NewThemes",
  };
  for (const unlocked of Object.keys(unlockMap)) {
    const newName = newMap[unlocked];
    if (!newName) continue;
    span = findConfigsSpan(text);
    const region = span ? text.slice(span[0], span[1]) : text;
    const esc = newName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pat = new RegExp(`(<DataElem\\b(?=[^>]*\\bname="${esc}")[^>]*\\bvalue=")([^"]*)(")`, "i");
    const m = pat.exec(region);
    if (m) {
      const abs = (span ? span[0] : 0) + m.index;
      text = text.slice(0, abs) + m[1] + "" + m[3] + text.slice(abs + m[0].length);
    }
  }
  return text;
}

/**
 * The id this save's own regatta records are attributed to. Healthy saves put
 * the save's own cityId on `MyOldTask` and teammates only on `TakenTask`
 * (verified on two real saves), so the existing `MyOldTask` value is
 * authoritative — reading it back means this feature can never hand one save
 * two identities, which is what a server notices when it is looking.
 *
 * Only a `MyOldTask` / `MyTask` tag may declare ours. `user=` was measured to
 * appear on exactly those three tags and nowhere else: in a fetched city all
 * 37 `MyOldTask` and the single `MyTask` carry its own `cityId`, while the ten
 * `TakenTask` rows carry ten *different* clanmates and never that cityId. The
 * old generic `\buser="..."` fallback therefore only ever resolved to a
 * teammate — it was unreachable whenever a save had a record of its own, but
 * on a save that has completed nothing this week it fired first and every new
 * record would have been written with somebody else's id. That is the
 * instant-ban story from the identity notes, so the fallback narrows to tags
 * that are measurably ours and otherwise falls through to `cityId`.
 */
function resolveRegataUser(text: string): string {
  for (const pat of [/<MyOldTask\b[^>]*?\buser="([^"]*)"/gi, /<MyTask\b[^>]*?\buser="([^"]*)"/gi]) {
    for (const m of text.matchAll(pat)) if (m[1]?.trim()) return m[1].trim();
  }
  for (const name of ["SaveId", "userId", "UserId", "cityId", "PlayerId"]) {
    const r =
      text.match(new RegExp(`<Var\\b[^>]*\\bname="${name}"[^>]*\\bv="([^"]*)"`, "i")) ??
      text.match(new RegExp(`<Var\\b[^>]*\\bv="([^"]*)"[^>]*\\bname="${name}"`, "i"));
    if (r?.[1]?.trim()) return r[1].trim();
  }
  // Some saves declare it only on <AWS>; parseOwnMeta reads both shapes, so
  // this must too or a save with no cityId Var falls through to "0".
  const aws = text.match(/<AWS\b([^>]*?)\/?>/i)?.[1] ?? "";
  const a = aws.match(/\bcityId="([^"]*)"/i)?.[1];
  if (a?.trim()) return a.trim();
  return "0";
}

// The decision lives in ../../regatta: the tab re-runs it for the batch size
// the user actually chose, so it must be the same code the server runs.
export type { RegattaReason };

export interface RegattaState {
  reason: RegattaReason;
  /** A live <Regata> block: it has a window and the save sits inside it. */
  active: boolean;
  /** <MyOldTask> already completed in the current regatta. */
  current: number;
  /** Records usable as templates anywhere in the save. */
  templates: number;
  /** Distinct <FreeTask> ids the game is offering. */
  pool: number;
  /** Mean score of the tasks already in the block (what the badge shows). */
  avgScore: number;
  /** What new tasks would be attributed to. */
  user: string;
  window: { start: number; end: number } | null;
}

// Re-exported so every existing call site keeps its import path; the values
// now live next to the reason function that must agree with them.
export { REGATTA_DEFAULT_TASKS, REGATTA_MAX_TASKS };

const REGATTA_ERR = {
  no_active_regatta:
    "Save chưa có regatta đang diễn ra. Vào regatta trong game trước rồi thử lại - không thêm task ngoài một regatta đang mở, vì Playrix đối chiếu cửa sổ thời gian.",
  no_template:
    "Save chưa có task regatta thật nào để chép, và không có task nào trong pool đủ dữ liệu thật (need/score/type) để dựng. Không tạo task giả.",
  window_closed: "Khoảng thời gian regatta hiện tại chưa đủ để thêm task an toàn.",
  already_full: "Regatta này đã có đủ task (%s) - không thêm nữa.",
} as const;

/**
 * Every field a real completed task carries, measured on untouched reference
 * saves (both the Match3 and the trains record shapes). A record missing one
 * of these cannot be cloned safely: the game then reads that value from
 * nothing, which is how the old injector produced tasks the loader discarded.
 */
const TASK_TEMPLATE_FIELDS = [
  "id",
  "type",
  "user",
  "num",
  "ver",
  "score",
  "takeTime",
  "completeTime",
  "realEndTime",
];

/** Attribute string of a single tag: `<X a="1" b="2"/>` -> ` a="1" b="2"`. */
function tagAttrs(tag: string): string {
  const m = tag.match(/^<[A-Za-z][\w:.-]*\s*([\s\S]*?)\/?>$/);
  return m ? m[1] : "";
}

/** Set an attribute on a whole tag (open or self-closing), keeping it well formed. */
function setTagAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s/>]+)`, "i");
  if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
  return tag.replace(/(\s*\/?>)$/, ` ${name}="${value}"$1`);
}

/**
 * The current regatta block. `<RegataCenter>` and `<PrevRegata>` must not
 * match: the `\b` after `Regata` excludes `RegataCenter`, and the `<` anchor
 * excludes `PrevRegata`, so a finished week's archive is never mistaken for a
 * live one. `close === null` means the block is self-closing (no tasks yet).
 */
function regattaBlock(text: string): { attrs: string; inner: string; close: string | null } | null {
  const paired = text.match(/(<Regata\b[^>]*>)([\s\S]*?)(<\/Regata\s*>)/i);
  if (paired) {
    const m = paired[1].match(/^(<Regata\b)([^>]*)(>)$/i);
    if (!m) return null;
    return { attrs: m[2], inner: paired[2], close: m[3] };
  }
  const self = text.match(/<Regata\b([^>]*?)\/>/i);
  if (self) return { attrs: self[1]!, inner: "", close: null };
  return null;
}

function regattaWindow(attrs: string): { start: number; end: number } | null {
  const start = Number(attrValue(attrs, "startTime"));
  const end = Number(attrValue(attrs, "endTime"));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start <= 0 || end <= start) return null;
  return { start, end };
}

/** Completed records safe to clone: all required fields present, not expired. */
function regattaTemplates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<MyOldTask\b[^>]*?\/?>/gi)) {
    const attrs = tagAttrs(m[0]);
    if (!attrs) continue;
    if (!TASK_TEMPLATE_FIELDS.every((f) => attrValue(attrs, f) !== null)) continue;
    const expired = attrValue(attrs, "expired");
    if (expired && expired !== "0") continue;
    out.push(m[0]);
  }
  return out;
}

/**
 * `id -> [need, score, regataCash]`, measured from completed `<MyOldTask>`
 * records in real saves (67 game-written records across five files).
 *
 * This is what lets injection run on a save that holds **no** completed record
 * to clone. `need` and `score` are per-id constants living in Playrix's
 * server-side config: the same id repeats the same triple in every save, week
 * and league in which it appears (`with_chips_3` = 150/120/15 three times,
 * `rocket_1` = 85/140/18 three times, `plane_1` = 120/140/18 twice), so
 * neither can be invented for an id this table has never seen. Duplicate ids
 * inside one week are normal (`with_chips_3` x3, `rocket_1` x3) — that is how
 * a save reaches 10/12/15 tasks from a handful of distinct ids, and the same
 * cycling the clone path has always done.
 *
 * `regataCash` is round(score/8) on **every** match3 record measured (26/26:
 * 75->9, 115->14, 120->15, 125->16, 130->16, 140->18, 150->19). The trains row
 * keeps its own measured cash (120->12) because `type="trains"` is the one
 * family where that relation does not hold.
 *
 * Deliberately absent — no save in the corpus has ever completed them, so a
 * value would have to be guessed:
 *
 * - `trains_1` / `trains_2` / `trains_4` / `match3_create_bonus_rocket_3`,
 *   and every `coins_`, `wagon_`, `feed_`, `ore_`, `orders_`, `factory_`,
 *   `fruits_`, `digtools_`, `casino_` id: their `score` is server config we
 *   hold no sample of, and a guessed score is exactly the "uniform 135"
 *   fingerprint the old injector is recognised by.
 * - anything inferred from a family, a difficulty suffix or a league. The same
 *   `need` maps to different scores across families (1000->115 but
 *   1300->140), so that inference is provably wrong.
 */
const REGATTA_TASK: Readonly<Record<string, readonly [need: number, score: number, cash: number]>> = {
  match3_create_bonus_bomb_1: [50, 140, 18],
  match3_create_bonus_bomb_3: [32, 120, 15],
  match3_create_bonus_bomb_999: [60, 150, 19],
  match3_create_bonus_lightning_3: [8, 115, 14],
  match3_create_bonus_lightning_999: [12, 150, 19],
  match3_create_bonus_plane_1: [120, 140, 18],
  match3_create_bonus_plane_2: [100, 130, 16],
  match3_create_bonus_plane_999: [140, 150, 19],
  match3_create_bonus_rocket_1: [85, 140, 18],
  match3_create_bonus_rocket_2: [70, 125, 16],
  match3_create_bonus_rocket_999: [100, 150, 19],
  match3_create_bonus_with_chips_1: [220, 140, 18],
  match3_create_bonus_with_chips_2: [180, 125, 16],
  match3_create_bonus_with_chips_3: [150, 120, 15],
  match3_create_bonus_with_chips_8: [80, 75, 9],
  match3_create_bonus_with_chips_999: [280, 150, 19],
  match3_remove_chips_blue_red_999: [1300, 150, 19],
  match3_remove_chips_red_green_1: [1300, 140, 18],
  match3_remove_chips_red_green_3: [1000, 115, 14],
  match3_remove_chips_red_green_999: [1500, 150, 19],
  match3_remove_chips_yellow_green_2: [1150, 125, 16],
  match3_remove_chips_yellow_green_999: [1500, 150, 19],
  match3_win_game_in_row_1: [4, 130, 16],
  trains_3: [5, 120, 12],
};

/** Every score a real completed record has ever been seen carrying. */
const REGATTA_SCORES = new Set<number>(Object.values(REGATTA_TASK).map((r) => r[1]));

/**
 * `type` / `eventType` a completed record carries for this id — only families
 * a real record has been seen for. `match3_*` is always `event_order` +
 * `eventType="Match3"`; `trains_*` is `trains` with no eventType/target at
 * all. Every other family has **no** completed record anywhere in the corpus,
 * so its `type` is unknown and an id from it is skipped rather than guessed —
 * guessing `type` is what made the old injector write `type="event_order"` on
 * a trains task.
 */
function regattaTaskShape(id: string): { type: string; eventType?: string } | null {
  if (id.startsWith("match3_")) return { type: "event_order", eventType: "Match3" };
  if (id.startsWith("trains_")) return { type: "trains" };
  return null;
}

/** The `target` a match3 record states: the id minus `match3_` and its
 *  trailing difficulty suffix. 23/23 measured records satisfy this
 *  (`match3_create_bonus_bomb_999` -> `create_bonus_bomb`,
 *  `match3_win_game_in_row_1` -> `win_game_in_row`). */
function regattaTarget(id: string): string {
  return id.startsWith("match3_") ? id.slice("match3_".length).replace(/_\d+$/, "") : "";
}

/** The block's own `<Var name="TaskQuota">` — measured equal to `anlLimit` on
 *  5/5 real saves (9, 11, 13, 17, 17). No other source for `anlLimit` exists. */
function regattaTaskQuota(inner: string): number | null {
  for (const m of inner.matchAll(/<Var\b[^>]*?>/gi)) {
    const a = tagAttrs(m[0]);
    if (attrValue(a, "name") !== "TaskQuota") continue;
    const v = attrValue(a, "v");
    if (v && /^\d+$/.test(v) && Number(v) > 0) return Number(v);
  }
  return null;
}

/** The `need` this save already states per id: a teammate's
 *  `<TakenTask id=… need=…>` and the clan roster's
 *  `<Member cityId=… taskId=… need=…>` agree on every id both carry, and both
 *  agree with the measured catalog wherever all three exist. */
function regattaStatedNeeds(inner: string): Map<string, number> {
  const out = new Map<string, number>();
  const put = (id: string | null, need: string | null): void => {
    if (!id || !need || !/^\d+$/.test(need) || out.has(id)) return;
    out.set(id, Number(need));
  };
  for (const m of inner.matchAll(/<TakenTask\b[^>]*?\/?>/gi)) {
    const a = tagAttrs(m[0]);
    put(attrValue(a, "id"), attrValue(a, "need"));
  }
  for (const m of inner.matchAll(/<Member\b[^>]*?\/?>/gi)) {
    const a = tagAttrs(m[0]);
    put(attrValue(a, "taskId") ?? attrValue(a, "id"), attrValue(a, "need"));
  }
  return out;
}

/**
 * Completed records built from the save's **own** pool, for a save that holds
 * no completed record to clone — a green week where `current` is 0 but the
 * pool is full, which is how a real save with 0 `<MyOldTask>` looked like a
 * permanently dead button.
 *
 * Everything a record needs has a source in this document:
 *
 * - `type` / `eventType` / `target` from the family rule above;
 * - `need` from the save's own `<TakenTask>` / `<Member>`, else the measured
 *   catalog (they agree wherever both exist — if they ever disagree the id is
 *   skipped rather than arbitrated);
 * - `score` / `regataCash` from the measured catalog only;
 * - `num` / `ver` from this save's own `<FreeTask>` entry for that id, which
 *   is proven to be what a real record carries (a live week's `bomb_999` has
 *   FreeTask and MyOldTask num/ver identical). An id a teammate holds has its
 *   pool entry cleared to `num="-1"` and carries no `num` of its own, so it
 *   borrows a slot number **from this save's own pool** (real records repeat
 *   slot numbers constantly — one week reads 1,3,1,3,3,6) and takes `ver`
 *   from the save's own `<TakenTask>`, which is `"0"`; `ver="0"` is carried by
 *   a real record too, so neither value is invented out of nothing;
 * - `anlLimit` from `<Var name="TaskQuota">`. Without it there is no source
 *   for a field every real record carries, so no records are built.
 *
 * An id the corpus has never seen completed (`REGATTA_TASK` misses) is
 * skipped: its `score` would have to be guessed. Repeats then carry the
 * requested batch to 10/12/15 exactly as the clone path always has.
 */
function regattaSyntheticTasks(text: string): string[] {
  const block = regattaBlock(text);
  if (!block) return [];
  const inner = block.inner;
  const quota = regattaTaskQuota(inner);
  if (quota === null) return [];

  const free = new Map<string, { num: string; ver: string }>();
  for (const m of inner.matchAll(/<FreeTask\b[^>]*?\/?>/gi)) {
    const a = tagAttrs(m[0]);
    const id = attrValue(a, "id");
    const num = attrValue(a, "num");
    const ver = attrValue(a, "ver");
    if (!id || num === null || ver === null || !/^\d+$/.test(num) || Number(num) < 1) continue;
    free.set(id, { num, ver });
  }
  const held = new Map<string, string>();
  for (const m of inner.matchAll(/<TakenTask\b[^>]*?\/?>/gi)) {
    const id = attrValue(tagAttrs(m[0]), "id");
    if (id) held.set(id, attrValue(tagAttrs(m[0]), "ver") ?? "0");
  }

  const slots = [...free.values()].map((v) => v.num);
  const stated = regattaStatedNeeds(inner);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const id of [...free.keys(), ...held.keys()]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const shape = regattaTaskShape(id);
    if (!shape) continue;
    const row = REGATTA_TASK[id];
    if (!row) continue;
    const own = stated.get(id);
    if (own !== undefined && own !== row[0]) continue;
    const need = own ?? row[0];
    const entry = free.get(id);
    const num = entry ? entry.num : slots.length ? slots[out.length % slots.length]! : null;
    if (num === null) continue;
    const ver = entry ? entry.ver : held.get(id) ?? "0";

    out.push(
      `<MyOldTask id="${id}" type="${shape.type}"` +
        (shape.eventType ? ` eventType="${shape.eventType}" target="${regattaTarget(id)}"` : "") +
        ` need="${need}" have="${need}" user="" endTime="0" num="${num}" ver="${ver}"` +
        ` takenCounter="0" score="${row[1]}" regataCash="${row[2]}" takeTime="0"` +
        ` completeTime="0" realEndTime="0" anlNumber="0" anlLimit="${quota}"/>`,
    );
  }
  return out;
}

/**
 * The records this save can be topped up from: a completed record to clone if
 * it has one, otherwise its own pool. The distinction matters to the injector
 * alone — a fresh block has no `takenCounter` to continue from, so its batch
 * starts at 2 the way three untouched weeks all do.
 */
function regattaSources(text: string): { tags: string[]; synthetic: boolean } {
  const templates = regattaTemplates(text);
  if (templates.length) return { tags: templates, synthetic: false };
  const tags = regattaSyntheticTasks(text);
  return { tags, synthetic: tags.length > 0 };
}

function regattaPool(text: string): number {
  return new Set([...text.matchAll(/<FreeTask\b[^>]*\bid="([^"]*)"/gi)].map((m) => m[1]!)).size;
}

/** Read-only status so the UI can say *why* a save cannot take tasks before
 *  the user presses anything. Mirrors `injectRegata`'s checks exactly for the
 *  batch size it is given, and never throws. */
export function inspectRegatta(xml: string, nTasks = REGATTA_DEFAULT_TASKS): RegattaState {
  const text = asText(xml).replace(/^\uFEFF/, "");
  // A save with no completed record to clone is no longer automatically a
  // refusal: its own FreeTask/TakenTask pool states which ids it is offering,
  // and those plus the measured task catalog are enough to build a record.
  // The badge and the server both read this number, so "pressable" and "will
  // succeed" stay one decision.
  const sources = regattaSources(text);
  const pool = regattaPool(text);
  const user = resolveRegataUser(text);
  const block = regattaBlock(text);
  const base = { templates: sources.tags.length, pool, avgScore: 0, user, window: null };
  if (!block) return { ...base, reason: "no_active_regatta", active: false, current: 0 };

  const win = regattaWindow(block.attrs);
  const now = Math.floor(Date.now() / 1000);
  const current = (block.inner.match(/<MyOldTask\b/gi) ?? []).length;
  const scores = [...block.inner.matchAll(/<MyOldTask\b[^>]*\bscore="(\d+)"/g)].map((m) => Number(m[1]));
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const active = !!win && now >= win.start && now <= win.end;
  // Exactly what `injectRegata` will decide for this batch size, in the same
  // order — now shared with the tab, which re-runs it for the count the user
  // actually picked instead of trusting this default-12 answer.
  const reason = regattaReason({ window: win, templates: sources.tags.length, current }, nTasks, now);

  return { reason, active, current, templates: sources.tags.length, pool, avgScore, user, window: win };
}

/**
 * Where new records go inside `<Regata>`.
 *
 * Every untouched save orders the block `FreeTask* / TakenTask* / MyOldTask* /
 * Vars / Team / …`. Appending at the end would park the batch *after* `<Vars>`
 * and `<Team>` — a shape no real save has, and the cheapest thing to spot when
 * comparing two weeks side by side. So: straight after the last record of its
 * own kind, otherwise immediately before `<Vars>`, otherwise at the end.
 */
function placeNewTasks(inner: string, body: string): string {
  let idx = -1;
  for (const m of inner.matchAll(/<MyOldTask\b[^>]*\/?>/gi)) idx = m.index + m[0].length;
  if (idx < 0) {
    const vars = /<Vars\b/i.exec(inner);
    idx = vars ? vars.index : inner.length;
  }
  return inner.slice(0, idx) + body + inner.slice(idx);
}

/**
 * `<Regata>`'s own `<Vars>` counts the records sitting in that same block. On
 * all seven real saves examined, `taskCounter == takeConfirm ==
 * count(<MyOldTask>)` exactly (1/1, 14/14, 20/20, 1/1, 1/1, 1/1, 1/1), and
 * `takeAttempts >= takeConfirm` (1/1, 17/14, 39/20, 1/1, …).
 *
 * Growing the block without moving them leaves a save that disagrees with
 * itself in three fields a server can read for free — and, if the game counts
 * a week from `taskCounter`, is why an injected batch registers as nothing.
 * Same rule as `RegataTasksCompleted` and `<Regata score>`: move what is
 * already there, never invent a counter the block never had.
 */
function bumpRegattaTaskVars(varsInner: string, added: number): string {
  let out = varsInner;
  const findTag = (name: string): string | null =>
    new RegExp(`<Var\\b[^>]*\\bname="${name}"[^>]*>`, "i").exec(out)?.[0] ?? null;
  const read = (tag: string): number | null => {
    const m = /\bv="([^"]*)"/i.exec(tag);
    return m && /^\d+$/.test(m[1]) ? Number(m[1]) : null;
  };
  const set = (tag: string, value: number): void => {
    out = out.replace(tag, () => setTagAttr(tag, "v", String(value)));
  };

  const counterTag = findTag("taskCounter");
  const confirmTag = findTag("takeConfirm");
  const counter = counterTag ? read(counterTag) : null;
  const confirm = confirmTag ? read(confirmTag) : null;
  const nextCounter = counter !== null ? counter + added : null;
  const nextConfirm = confirm !== null ? confirm + added : null;

  if (counterTag && nextCounter !== null) set(counterTag, nextCounter);
  if (confirmTag && nextConfirm !== null) set(confirmTag, nextConfirm);

  // `takeAttempts` never trails `takeConfirm` in a real save, so raise it to
  // the new count when the batch would otherwise push it under.
  const attemptsTag = findTag("takeAttempts");
  const attempts = attemptsTag ? read(attemptsTag) : null;
  if (attemptsTag && attempts !== null && nextConfirm !== null && attempts < nextConfirm) {
    set(attemptsTag, nextConfirm);
  }
  return out;
}

/**
 * Add completed tasks to a regatta the save is genuinely taking part in.
 *
 * With a completed record to clone, every field of a new task is copied from
 * it (`regattaTemplates`), so nothing is invented: `type`, `eventType`,
 * `target`, `need`, `have`, `score`, `regataCash` and `anlLimit` are proven to
 * reconcile with that id. With none — a green week where the counter is still
 * 0 — the save's own pool is read instead (`regattaSyntheticTasks`), where
 * `need` comes from the save's own TakenTask/Member rows, `score` from the
 * measured catalog, `num`/`ver` from its own FreeTask entry and `anlLimit`
 * from its own TaskQuota. Only the counters and the timestamps move in either
 * case, and an id without a measured score is skipped rather than guessed.
 *
 * Refuses (rather than reporting a success the game ignores) when the save has
 * no live `<Regata>`, no real task to clone and no sourceable pool entry, no
 * usable window, or already has enough tasks. Throws, so `applySave` surfaces
 * the reason instead of ticking.
 */
export function injectRegata(xml: string, nTasks = REGATTA_DEFAULT_TASKS): string {
  const text0 = asText(xml).replace(/^\uFEFF/, "");
  const want = regattaWant(nTasks);

  const block = regattaBlock(text0);
  const win = block ? regattaWindow(block.attrs) : null;
  const now = Math.floor(Date.now() / 1000);
  if (!block || !win || now < win.start || now > win.end) throw new Error(REGATTA_ERR.no_active_regatta);

  const src = regattaSources(text0);
  if (!src.tags.length) throw new Error(REGATTA_ERR.no_template);

  const current = (block.inner.match(/<MyOldTask\b/gi) ?? []).length;
  const need = want - current;
  if (need <= 0) throw new Error(REGATTA_ERR.already_full.replace("%s", `${current}/${want}`));

  // The save's own id, never a fresh one: a save that hands its records a
  // second identity is exactly what a server notices when it is looking.
  const user = resolveRegataUser(text0);

  // Timestamps must sit inside the regatta window AND in the past. A completion
  // dated in the future, or outside the window the server is holding, is the
  // single easiest anomaly to spot.
  const { hi, lo } = regattaBounds(win, now);
  // Both floors matter: the first keeps `lo` clear of `win.start + 122` below,
  // so task times never collapse onto one another, and the second leaves each
  // task at least a minute of its own.
  if (hi - win.start < 600 || hi - lo < need * 60) throw new Error(REGATTA_ERR.window_closed);
  const gap = need > 1 ? Math.floor((hi - lo) / (need - 1)) : 0;

  // `takenCounter` runs monotonically across the `MyOldTask` list of a single
  // block: a real save's archived week reads 2,3,…,37 in document order, and
  // the new week restarts at 2 — the counter is per regatta, so it must be
  // read against the block we are appending to, not the whole document.
  // Basing it on the template's own value re-issued numbers the block already
  // holds (appending 3 after the block's 4), and restarting it per template id
  // let two ids interleave out of order: both are steps backwards in a field
  // that only ever grows, and exactly what a server can read for free.
  //
  // A block that holds no record at all has no counter to continue, but every
  // real record still carries one and three untouched weeks each start theirs
  // at 2 — so a synthesized batch starts there too. The clone path keeps its
  // old behaviour untouched: a save whose records simply lack the field still
  // gains none.
  let maxTaken = -1;
  for (const m of block.inner.matchAll(/<MyOldTask\b[^>]*\btakenCounter="(\d+)"/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > maxTaken) maxTaken = v;
  }
  const takenBase = maxTaken >= 0 ? maxTaken + 1 : src.synthetic ? 2 : -1;

  const tasks: string[] = [];
  let addedScore = 0;

  for (let i = 0; i < need; i++) {
    const tpl = src.tags[i % src.tags.length]!;
    const a = tagAttrs(tpl);
    // Real records keep takeTime < completeTime < endTime strictly, and all
    // three inside the window. The floors below hold that ordering even when
    // the regatta has only just opened.
    const endTime = Math.max(lo + i * gap, win.start + 122);
    const complete = Math.max(win.start + 1, endTime - 120);
    const take = Math.max(win.start, Math.min(complete - 1, complete - 1800));

    let tag = setTagAttr(tpl, "user", user);
    tag = setTagAttr(tag, "takeTime", String(take));
    tag = setTagAttr(tag, "completeTime", String(complete));
    tag = setTagAttr(tag, "realEndTime", String(endTime));
    if (attrValue(a, "endTime") !== null) tag = setTagAttr(tag, "endTime", String(endTime));
    const anlLimit = Number(attrValue(a, "anlLimit") ?? 0);
    if (Number.isFinite(anlLimit) && anlLimit > 0) tag = setTagAttr(tag, "anlNumber", String((i % anlLimit) + 1));
    if (takenBase >= 0 && attrValue(a, "takenCounter") !== null) {
      tag = setTagAttr(tag, "takenCounter", String(takenBase + i));
    }

    tasks.push(tag);
    addedScore += Number(attrValue(a, "score") ?? 0);
  }

  const body = tasks.join("");
  let text = text0;
  if (block.close) {
    text = text.replace(/(<Regata\b[^>]*>)([\s\S]*?)(<\/Regata\s*>)/i, (_f, o, inner, c) => `${o}${placeNewTasks(inner, body)}${c}`);
  } else {
    const selfRe = /<Regata\b[^>]*\/>/i;
    const self = text.match(selfRe);
    if (!self) throw new Error(REGATTA_ERR.no_active_regatta);
    text = text.replace(selfRe, self[0].replace(/\/>$/, `>${body}</Regata>`));
  }

  // Lifetime counter: bump what is already there, never overwrite it. Writing
  // the batch size over it moved a lifetime stat backwards - a counter that
  // goes down after months of going up is about the cheapest anomaly there is.
  const life =
    text.match(/<Var\b[^>]*\bname="RegataTasksCompleted"[^>]*\bv="(\d+)"/i) ??
    text.match(/<Var\b[^>]*\bv="(\d+)"[^>]*\bname="RegataTasksCompleted"/i);
  if (life?.[1]) text = writeVar(text, "RegataTasksCompleted", String(Number(life[1]) + need));

  // <Regata score> counts the tasks it holds and scoreUpd is the newest
  // completeTime in the block (both verified on untouched reference saves).
  // They are rewritten together so the block never contradicts itself.
  const after = text.match(/(<Regata\b[^>]*>)([\s\S]*?)(<\/Regata\s*>)/i);
  const open = after ? after[1].match(/^(<Regata\b)([^>]*)(>)$/i) : null;
  if (after && open) {
    let attrs = open[2];
    const times = [...after[2].matchAll(/\bcompleteTime="(\d+)"/g)].map((x) => Number(x[1]));
    const newest = times.length ? Math.max(...times) : 0;
    // Only touch an attribute the block already declares: adding one the save
    // never carried is a shape change the loader has no reason to accept.
    const rawScore = attrValue(attrs, "score");
    if (rawScore !== null && /^\d+$/.test(rawScore) && Number.isFinite(addedScore)) {
      attrs = putAttr(attrs, "score", String(Number(rawScore) + addedScore));
    }
    const rawUpd = attrValue(attrs, "scoreUpd");
    if (rawUpd !== null && /^\d+$/.test(rawUpd) && newest > Number(rawUpd)) {
      attrs = putAttr(attrs, "scoreUpd", String(newest));
    }
    text = text.replace(after[0], () => `${open[1]}${attrs}${open[3]}${bumpRegattaTaskVars(after[2], need)}${after[3]}`);
  }

  return text;
}

/**
 * Fields every game-written completed record carries — all 67 measured records
 * hold them. `have` is checked separately because an *expired* record is
 * allowed to omit it (two real ones do), while a completion always has it
 * `== need`.
 */
const REGATTA_RECORD_FIELDS = [
  "id",
  "type",
  "user",
  "endTime",
  "num",
  "ver",
  "takenCounter",
  "score",
  "regataCash",
  "takeTime",
  "completeTime",
  "realEndTime",
  "anlNumber",
  "anlLimit",
  "need",
];

/**
 * Regatta's half of the push gate: invariants a real completed record holds,
 * refused only when this tool is what broke them. Same loaded-vs-pushed rule
 * as `assertSaveShapeSafe`, and for the same reason — a save that arrived with
 * an oddity (an old injector's uniform 135, a record missing counters) keeps
 * that key on both sides and stays pushable, so no feature is held hostage for
 * something this tool never touched. Against a save that holds **no** record,
 * which is exactly the state the new synthesized batch starts from, every key
 * below is new — so this is the check that decides whether the batch may leave.
 *
 * Each rule was measured before being written here:
 *
 * - `regatta-record-missing:<field>` — the full field set real records carry.
 * - `regatta-time-order:<id>` — `takeTime < completeTime < realEndTime`,
 *   strictly, in that order, on every record in every save.
 * - `regatta-time-outside:<id>` — all three inside the block's own window.
 * - `regatta-time-future:<id>` — a completion dated in the future is the
 *   easiest anomaly there is to spot.
 * - `regatta-user:<id>` — records are attributed to the save's own id, never
 *   to a teammate (that is the identity story the unban tab learned the hard
 *   way).
 * - `regatta-score:<v>` — outside the measured score set; 135 is the old
 *   injector's uniform value and appears on no real record.
 * - `regatta-cash:<id>:<v>` — for `event_order`, `regataCash` must be
 *   round(score/8), which holds on 26/26 match3 records.
 * - `regatta-target:<id>:<v>` — target must be the id minus `match3_` and its
 *   trailing suffix (23/23 measured).
 * - `regatta-need:<id>` — must be the number this very save already states for
 *   that id in `<TakenTask>` / `<Member>`.
 * - `regatta-anl-limit:<v>` / `regatta-anl-number:<v>` — `anlLimit` is
 *   `<Var name="TaskQuota">` (5/5 measured) and `anlNumber` cycles inside it.
 * - `regatta-id:<id>` — an id that is in neither this document's pool nor a
 *   record it already held is an id the game never offered: the old
 *   `match3_1..match3_105` output.
 * - `regatta-taken-counter:<prev>-<next>` — the counter only ever grows inside
 *   a block (2,3,…,37 in an archived week, restarting at 2).
 * - `regatta-counter-mismatch` — a block that declares `taskCounter` /
 *   `takeConfirm` must have them equal to the records it holds (7/7 saves).
 */
export function regattaProblems(xml: string, own: string): string[] {
  const block = regattaBlock(xml.replace(/^\uFEFF/, ""));
  if (!block) return [];
  const inner = block.inner;
  const win = regattaWindow(block.attrs);
  const now = Math.floor(Date.now() / 1000);
  const quota = regattaTaskQuota(inner);
  const stated = regattaStatedNeeds(inner);
  const keys = new Set<string>();

  const pool = new Set<string>();
  for (const m of inner.matchAll(/<FreeTask\b[^>]*\bid="([^"]*)"/gi)) pool.add(m[1]!);
  for (const m of inner.matchAll(/<TakenTask\b[^>]*\bid="([^"]*)"/gi)) pool.add(m[1]!);

  let prevTaken: number | null = null;
  for (const m of inner.matchAll(/<MyOldTask\b[^>]*?\/?>/gi)) {
    const a = tagAttrs(m[0]);
    const id = attrValue(a, "id") ?? "?";
    const expired = attrValue(a, "expired");
    const isExpired = !!expired && expired !== "0";

    for (const f of REGATTA_RECORD_FIELDS) {
      if (attrValue(a, f) === null) keys.add(`regatta-record-missing:${f}`);
    }
    if (!isExpired && attrValue(a, "have") === null) keys.add("regatta-record-missing:have");

    const take = Number(attrValue(a, "takeTime"));
    const done = Number(attrValue(a, "completeTime"));
    const real = Number(attrValue(a, "realEndTime"));
    if (Number.isFinite(take) && Number.isFinite(done) && Number.isFinite(real)) {
      if (!(take < done && done < real)) keys.add(`regatta-time-order:${id}`);
      if (win && !(real >= win.start && real <= win.end)) keys.add(`regatta-time-outside:${id}`);
      if (real >= now) keys.add(`regatta-time-future:${id}`);
    }

    if (attrValue(a, "user") !== own) keys.add(`regatta-user:${id}`);

    const score = Number(attrValue(a, "score"));
    if (Number.isFinite(score) && !REGATTA_SCORES.has(score)) keys.add(`regatta-score:${score}`);

    const cash = Number(attrValue(a, "regataCash"));
    if (attrValue(a, "type") === "event_order" && Number.isFinite(score) && Number.isFinite(cash)) {
      if (cash !== Math.round(score / 8)) keys.add(`regatta-cash:${id}:${cash}`);
    }

    const target = attrValue(a, "target");
    if (id.startsWith("match3_") && target !== null && target !== regattaTarget(id)) {
      keys.add(`regatta-target:${id}:${target}`);
    }

    const need = attrValue(a, "need");
    const ownNeed = stated.get(id);
    if (need && /^\d+$/.test(need) && ownNeed !== undefined && Number(need) !== ownNeed) {
      keys.add(`regatta-need:${id}`);
    }

    const anlLimitRaw = attrValue(a, "anlLimit");
    if (anlLimitRaw && /^\d+$/.test(anlLimitRaw)) {
      const anlLimit = Number(anlLimitRaw);
      if (quota !== null && anlLimit !== quota) keys.add(`regatta-anl-limit:${anlLimit}`);
      const anlNumberRaw = attrValue(a, "anlNumber");
      if (anlLimit > 0 && anlNumberRaw && /^\d+$/.test(anlNumberRaw)) {
        const anlNumber = Number(anlNumberRaw);
        if (anlNumber < 1 || anlNumber > anlLimit) keys.add(`regatta-anl-number:${anlNumber}`);
      }
    }

    if (!pool.has(id)) keys.add(`regatta-id:${id}`);

    const takenRaw = attrValue(a, "takenCounter");
    if (takenRaw && /^\d+$/.test(takenRaw)) {
      const taken = Number(takenRaw);
      if (prevTaken !== null && taken <= prevTaken) keys.add(`regatta-taken-counter:${prevTaken}-${taken}`);
      prevTaken = taken;
    }
  }

  // Only a counter the block already declares is ever compared: a block with
  // none gains none (`regatta never invents a counter the block never had`).
  const declared = (name: string): number | null => {
    for (const m of inner.matchAll(/<Var\b[^>]*?>/gi)) {
      const a = tagAttrs(m[0]);
      if (attrValue(a, "name") !== name) continue;
      const v = attrValue(a, "v");
      if (v && /^\d+$/.test(v)) return Number(v);
    }
    return null;
  };
  const count = (inner.match(/<MyOldTask\b/gi) ?? []).length;
  for (const name of ["taskCounter", "takeConfirm"]) {
    const v = declared(name);
    if (v !== null && v !== count) keys.add("regatta-counter-mismatch");
  }

  return [...keys];
}

export function assertRegattaSafe(loaded: string, pushed: string) {
  if (loaded === pushed) return;

  // The save's own id is read off the file as it **arrived**: resolving it
  // from `pushed` would let a batch that wrote someone else's id define what
  // counts as "ours" and pass on its own terms.
  const own = resolveRegataUser(loaded);
  const before = new Set(regattaProblems(loaded, own));
  const broken = regattaProblems(pushed, own).filter((k) => !before.has(k));
  if (!broken.length) return;

  throw new Error(
    `Không đẩy file lên máy: task regatta vừa thêm không khớp dữ liệu thật (${broken.slice(0, 6).join(", ")}` +
      `${broken.length > 6 ? `, +${broken.length - 6}` : ""}). ` +
      "Thành phố thật chưa từng cho kết quả này, nên server Playrix có thể coi save của bạn là gian lận.",
  );
}

const UPGRADE_KEY = 32162029;

function slxFor(level: number): number {
  return level ^ UPGRADE_KEY;
}

/**
 * Reference ceilings measured from mGameInfo_decoded.xml (a real, working
 * save in this repo): the highest level observed per kind. Used ONLY when
 * the save carries no rows of that kind yet — saves with rows keep their
 * own max as the ceiling, so a level the save never reached is never
 * invented for it.
 */
export const UPGRADE_REF_CAP = { Factory: 53, Train: 31, Island: 31 } as const;

// Uniform maxed bonus templates measured from the same reference save:
// every L38+ factory row carries xp/money/timeBonus=100 + shelfBonus=2,
// every train row xp/timeBonus=100, every island row timeBonus=101 +
// probability2/3=100. Created rows reuse these verbatim, so every value
// written already appears in game-accepted data.
const UPGRADE_BONUS: Record<"Factory" | "Train" | "Island", Record<string, string>> = {
  Factory: { xpBonus: "100", moneyBonus: "100", timeBonus: "100", shelfBonus: "2" },
  Train: { xpBonus: "100", timeBonus: "100" },
  Island: { timeBonus: "101", probability2: "100", probability3: "100" },
};

// Real game ids per kind. Creation only ever uses these — an unknown id
// can neither match nor be created.
const KNOWN_UPGRADE_IDS: Record<"Factory" | "Train" | "Island", ReadonlySet<string>> = {
  Factory: new Set(RAW_FACTORIES.flatMap((g) => g.items.map((i) => i.id))),
  Train: new Set(RAW_TRAINS.flatMap((g) => g.items.map((i) => i.id))),
  Island: new Set(RAW_ISLANDS.flatMap((g) => g.items.map((i) => i.id))),
};

function parseUpgradeBlock(xml: string) {
  const m = xml.match(/<Upgrade\b[^>]*version="4"[^>]*>([\s\S]*?)<\/Upgrade>/i);
  if (m) {
    const inner = m[1]!;
    const factories = [...inner.matchAll(/<Factory\b([^>]*?)\/?>/gi)].map(m => parseAttrs(m[1]));
    const trains = [...inner.matchAll(/<Train\b([^>]*?)\/?>/gi)].map(m => parseAttrs(m[1]));
    const islands = [...inner.matchAll(/<Island\b([^>]*?)\/?>/gi)].map(m => parseAttrs(m[1]));
    return { factories, trains, islands, raw: m[0], index: m.index!, length: m[0].length };
  }
  // A fresh/untouched city ships a self-closing <Upgrade version="4"/> with
  // no rows. Match it too so callers can tell "empty block" apart from
  // "no block at all" instead of failing both the same silent way.
  const s = xml.match(/<Upgrade\b[^>]*version="4"[^>]*\/>/i);
  if (s) return { factories: [], trains: [], islands: [], raw: s[0], index: s.index!, length: s[0].length };
  return { factories: [], trains: [], islands: [], raw: "", index: -1, length: 0 };
}

function parseAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of attrStr.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function serializeAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
}

function rebuildUpgradeBlock(block: { factories: Record<string,string>[]; trains: Record<string,string>[]; islands: Record<string,string>[] }): string {
  const parts: string[] = [];
  for (const f of block.factories) parts.push(`<Factory${serializeAttrs(f)}/>`);
  for (const t of block.trains) parts.push(`<Train${serializeAttrs(t)}/>`);
  for (const i of block.islands) parts.push(`<Island${serializeAttrs(i)}/>`);
  return `<Upgrade version="4">${parts.join("")}</Upgrade>`;
}

/** Discover all upgrade rows in the save. Returns real game IDs. */
export function discoverUpgrades(xml: string) {
  return parseUpgradeBlock(xml);
}

/** Maximum level already present in the save for a given kind (ceiling). */
export function upgradeMaxLevel(xml: string, kind: "Factory" | "Train" | "Island"): number {
  const { factories, trains, islands } = parseUpgradeBlock(xml);
  const arr = kind === "Factory" ? factories : kind === "Train" ? trains : islands;
  return arr.reduce((max, row) => Math.max(max, Number(row.level) || 0), 0);
}

/**
 * Raise selected rows to targetLevel (clamped to the save's own max when it
 * has rows, else to the reference cap). `ids` are real game IDs; unknown ids
 * are ignored entirely. Rows the save never had are created with the
 * reference bonus template and an exact level/slx pair, then counted in
 * `changed`. Returns { xml, changed, reason }: "missing" only when there is
 * no Upgrade block to work with is now handled by creation, so in practice
 * callers see "ok", "empty" (non-positive target) or "noop" (rows already
 * at/above the clamped target). The no-op case must still surface as an
 * error, never as success.
 */
export function injectUpgradeLevels(
  xml: string,
  kind: "Factory" | "Train" | "Island",
  ids: string[],
  targetLevel: number
): { xml: string; changed: number; reason: "ok" | "missing" | "empty" | "noop" } {
  const known = KNOWN_UPGRADE_IDS[kind];
  const want = new Set(ids.filter((id) => known.has(id)));
  if (!want.size) return { xml, changed: 0, reason: "noop" };

  const parsed = parseUpgradeBlock(xml);
  const hasBlock = parsed.raw !== "";
  const rows = kind === "Factory" ? parsed.factories : kind === "Train" ? parsed.trains : parsed.islands;

  const saveMax = upgradeMaxLevel(xml, kind);
  const cap = saveMax > 0 ? saveMax : UPGRADE_REF_CAP[kind];
  const clamped = Math.min(targetLevel, cap);
  if (clamped <= 0) return { xml, changed: 0, reason: "empty" };

  let changed = 0;

  for (const row of rows) {
    if (!want.has(row.id)) continue;
    if (Number(row.level) !== clamped) {
      row.level = String(clamped);
      row.slx = String(slxFor(clamped));
      changed++;
    }
  }

  // Create rows the save never had. Attribute order (id, level, slx, then
  // bonuses) mirrors the reference save exactly.
  const have = new Set(rows.map((r) => r.id));
  for (const id of want) {
    if (!id || have.has(id)) continue;
    rows.push({ id, level: String(clamped), slx: String(slxFor(clamped)), ...UPGRADE_BONUS[kind] });
    have.add(id);
    changed++;
  }

  if (!changed) return { xml, changed: 0, reason: "noop" };

  const newBlock = rebuildUpgradeBlock(parsed);
  if (!hasBlock) return { xml: insertInsideRoot(xml, newBlock), changed, reason: "ok" };
  const newXml = xml.slice(0, parsed.index) + newBlock + xml.slice(parsed.index + parsed.length);
  return { xml: newXml, changed, reason: "ok" };
}

