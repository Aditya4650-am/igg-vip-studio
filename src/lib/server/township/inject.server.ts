import { writeVar } from "./vars.server";
import { SKINS_CATALOG } from "./skins-catalog.server";
import { insertInsideRoot } from "./xml-edit.server";

function asText(xml: string | Buffer) {
  return typeof xml === "string" ? xml : xml.toString("utf8");
}

function insertBeforeRoot(xml: string, insert: string) {
  return insertInsideRoot(xml, insert);
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

export function injectAvatars(xml: string, selection: string[], maxAva = 398) {
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

function parseUpgradeBlock(xml: string) {
  const m = xml.match(/<Upgrade\b[^>]*version="4"[^>]*>([\s\S]*?)<\/Upgrade>/i);
  if (!m) return { factories: [], trains: [], islands: [], raw: "", index: -1, length: 0 };
  const inner = m[1];
  const factories = [...inner.matchAll(/<Factory\b([^>]*?)\/?>/gi)].map(m => parseAttrs(m[1]));
  const trains = [...inner.matchAll(/<Train\b([^>]*?)\/?>/gi)].map(m => parseAttrs(m[1]));
  const islands = [...inner.matchAll(/<Island\b([^>]*?)\/?>/gi)].map(m => parseAttrs(m[1]));
  return { factories, trains, islands, raw: m[0], index: m.index!, length: m[0].length };
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
 * Upgrade selected rows to targetLevel (clamped to save's own max).
 * `ids` are real game IDs. Returns { xml, changed }.
 * Throws no-op error via caller if changed === 0.
 */
export function injectUpgradeLevels(
  xml: string,
  kind: "Factory" | "Train" | "Island",
  ids: string[],
  targetLevel: number
): { xml: string; changed: number } {
  const parsed = parseUpgradeBlock(xml);
  if (!parsed.raw) return { xml, changed: 0 };

  const maxAllowed = upgradeMaxLevel(xml, kind);
  const clamped = Math.min(targetLevel, maxAllowed);
  if (clamped <= 0) return { xml, changed: 0 };

  let changed = 0;
  const want = new Set(ids);

  if (kind === "Factory") {
    for (const row of parsed.factories) {
      if (want.has(row.id)) {
        const newLevel = Math.min(clamped, maxAllowed);
        if (Number(row.level) !== newLevel) {
          row.level = String(newLevel);
          row.slx = String(slxFor(newLevel));
          changed++;
        }
      }
    }
  } else if (kind === "Train") {
    for (const row of parsed.trains) {
      if (want.has(row.id)) {
        const newLevel = Math.min(clamped, maxAllowed);
        if (Number(row.level) !== newLevel) {
          row.level = String(newLevel);
          row.slx = String(slxFor(newLevel));
          changed++;
        }
      }
    }
  } else {
    for (const row of parsed.islands) {
      if (want.has(row.id)) {
        const newLevel = Math.min(clamped, maxAllowed);
        if (Number(row.level) !== newLevel) {
          row.level = String(newLevel);
          row.slx = String(slxFor(newLevel));
          changed++;
        }
      }
    }
  }

  if (!changed) return { xml, changed: 0 };

  const newBlock = rebuildUpgradeBlock(parsed);
  const newXml = xml.slice(0, parsed.index) + newBlock + xml.slice(parsed.index + parsed.length);
  return { xml: newXml, changed };
}

