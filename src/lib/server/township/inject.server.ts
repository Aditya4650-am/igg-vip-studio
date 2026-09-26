import { writeVar } from "./vars.server";
import { SKINS_CATALOG } from "./skins-catalog.server";
import { insertInsideRoot } from "./xml-edit.server";
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

export function getExistingAvatars(xml: string, maxAva = 500): number[] {
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
  maxAva = 500
): { xml: string; created: number[]; updated: number[] } {
  let text = asText(xml);
  const created: number[] = [];
  const updated: number[] = [];

  maxAva = Math.max(1, Math.floor(maxAva));
  maxAva = Math.min(maxAva, 500);
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
    const globalRegex = /<\/Global\s*>/i;
    if (globalRegex.test(text)) {
      text = text.replace(globalRegex, `${insert}\n$&`);
    } else {
      text = text + "\n" + insert;
    }
    created.push(...missing);
  }

  // Also populate UnlockedAvatars with comma-separated list of all unlocked avatars
  const allAvatars = [...Array(maxAva).keys()].map(i => i + 1).join(",");
  text = writeVar(text, "UnlockedAvatars", allAvatars);
  // Ensure AvaUnlocked flag is set
  text = writeVar(text, "AvaUnlocked", "1");
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

export function injectAvatars(xml: string, selection: string[], maxAva = 500) {
  let text = asText(xml);
  const indices = new Set<number>();
  for (const raw of selection) {
    const m = String(raw).match(/(\d+)/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= Math.max(maxAva, 9999)) indices.add(n);
  }
  const list = [...indices].sort((a, b) => a - b);
  if (!list.length) return text;
  for (const i of list) {
    const name = `Unlocked_ava${i}`;
    if (new RegExp(`name="${name}"`, "i").test(text)) text = writeVar(text, name, "1");
    else text = insertBeforeRoot(text, `<Var name="${name}" v="1" t="b"/>`);
  }
  // Ensure AvaUnlocked flag is set so game shows unlocked avatars in UI
  text = writeVar(text, "AvaUnlocked", "1");
  // Also populate UnlockedAvatars with comma-separated list (game may require this)
  const unlockedList = list.join(",");
  text = writeVar(text, "UnlockedAvatars", unlockedList);
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

export function injectRegata(xml: string, nTasks = 105, score = 135) {
  let text = asText(xml);
  text = writeVar(text, "RegataTasksCompleted", String(nTasks));

  const patterns = [
    /(<Regata\b[^>]*>[\s\S]*?<\/Regata\s*>)/i,
    /(<Regatta\b[^>]*>[\s\S]*?<\/Regatta\s*>)/i,
    /(<regata\b[^>]*>[\s\S]*?<\/regata\s*>)/i,
  ];
  let m: RegExpMatchArray | null = null;
  for (const pat of patterns) {
    m = text.match(pat);
    if (m) break;
  }

  if (!m || m.index === undefined) {
    let user = "0";
    for (const name of ["SaveId", "userId", "UserId", "cityId", "PlayerId"]) {
      const r =
        text.match(new RegExp(`<Var\\b[^>]*\\bname="${name}"[^>]*\\bv="([^"]*)"`, "i")) ??
        text.match(new RegExp(`<Var\\b[^>]*\\bv="([^"]*)"[^>]*\\bname="${name}"`, "i"));
      if (r?.[1]?.trim()) {
        user = r[1].trim();
        break;
      }
    }
    // Insert a fresh block inside the root, then operate on it in place. The
    // previous version appended at EOF when no root closer matched, which left
    // the new element outside the document (and unreachable by the game).
    const block = `<Regata user="${user}"><FreeTask id="match3_1"/></Regata>`;
    text = insertBeforeRoot(text, block);
    m = text.match(patterns[0]);
    if (!m || m.index === undefined) {
      // The insert did not produce a matchable open/close pair; fall back to a
      // self-closing element rather than emitting mismatched tags.
      return insertBeforeRoot(text, `<Regata user="${user}"/>`);
    }
  }

  const block = m[1]!;
  const user = block.match(/\buser="([^"]*)"/i)?.[1] ?? "0";
  // FreeTask ids come from inside the block; when the block has too few (or
  // none), top up from the document so every generated MyOldTask gets a
  // distinct id. Repeating one id across 105 tasks makes them collide.
  const freeIds = [...block.matchAll(/<FreeTask\b[^>]*\bid="([^"]*)"/gi)].map((x) => x[1]!);
  for (const x of text.matchAll(/<FreeTask\b[^>]*\bid="([^"]*)"/gi)) {
    if (!freeIds.includes(x[1]!)) freeIds.push(x[1]!);
  }

  let clean = block.replace(/<MyOldTask\b[^>]*\/>/gi, "").replace(/<MyOldTask\b[^>]*>[\s\S]*?<\/MyOldTask\s*>/gi, "");
  const baseTime = Math.floor(Date.now() / 1000) + 3600;
  const tasks: string[] = [];
  for (let i = 0; i < nTasks; i++) {
    const tid = freeIds[i] ?? `match3_${i + 1}`;
    const endTime = baseTime + i * 90;
    tasks.push(
      `<MyOldTask id="${tid}" type="event_order" eventType="Match3" target="${tid}" user="${user}" num="${i + 1}" ver="1" takenCounter="1" score="${score}" realEndTime="${endTime}"/>`,
    );
  }
  if (tasks.length) {
    clean = clean.replace(/<\/(Regata|Regatta|regata)\s*>/i, `${tasks.join("")}</$1>`);
  }
  text = text.slice(0, m.index) + clean + text.slice(m.index + m[0].length);
  return text;
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

