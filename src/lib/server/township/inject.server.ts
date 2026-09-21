import { readVar, writeVar } from "./vars.server";
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

/* ---------------------------------------------------------------------------
 * Zoo / Museum / Academy.
 *
 * Same rule as the rest of this module: touch only variables that already
 * exist in the loaded save. The real save carries 34 `paddock_<id>_state`
 * counters plus a `paddock_<id>sq0_state` companion each, `ZooExpandLevel`,
 * 51 `BLvl_*` factory levels and the two `Achievement_Artefact*` counters.
 * Nothing here invents an id.
 * ------------------------------------------------------------------------- */

/** `paddock_bear_state`, `paddock_bear` and the `sq0` companion all name one counter. */
export function normalizePaddockId(raw: string): string | null {
  let id = String(raw ?? "").trim();
  if (!id) return null;
  if (!id.startsWith("paddock_")) {
    if (!/^[A-Za-z_][\w]*$/.test(id)) return null;
    id = `paddock_${id}`;
  }
  id = id.replace(/sq0_state$/, "_state");
  if (!id.endsWith("_state")) id = `${id}_state`;
  return /^paddock_[A-Za-z_][\w]*_state$/.test(id) ? id : null;
}

export function paddockLabel(id: string): string {
  const base = String(id).replace(/^paddock_/, "").replace(/_state$/, "");
  return base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function injectZooUnlocks(
  xml: string,
  opts: { paddockIds: string[]; unlockedState?: string; zooExpandLevel?: number | null },
) {
  let text = asText(xml);
  // No verified "unlocked" sentinel exists for paddocks in the save data, so the
  // caller must pass the value. Falling back to a fixed number here would be a
  // guess that looks like success while possibly doing nothing in game.
  const state = String(opts.unlockedState ?? "").trim();
  const usable = /^\d+$/.test(state);
  for (const raw of opts.paddockIds ?? []) {
    const id = normalizePaddockId(raw);
    if (!id) continue;
    // Only counters already in the save are written: a missing paddock is one
    // this game build does not have, so creating it would be a fake id.
    if (readVar(text, id) == null) continue;
    if (usable) text = writeVar(text, id, state);
    const sq0 = `${id.slice(0, -"_state".length)}sq0_state`;
    if (readVar(text, sq0) != null) text = writeVar(text, sq0, "0");
  }
  // Expansion is opt-in: a null/absent level leaves the player's current value alone.
  const level = opts.zooExpandLevel;
  if (typeof level === "number" && Number.isFinite(level) && level >= 0 && readVar(text, "ZooExpandLevel") != null) {
    text = writeVar(text, "ZooExpandLevel", String(Math.floor(level)));
  }
  return text;
}

export function injectMuseum(xml: string, opts: { varEdits: Record<string, string> }) {
  let text = asText(xml);
  for (const [name, raw] of Object.entries(opts.varEdits ?? {})) {
    const key = String(name ?? "").trim();
    if (!key || !/^[A-Za-z_][\w.]*$/.test(key)) continue;
    const value = String(raw ?? "").trim();
    if (!/^-?\d+$/.test(value)) continue;
    if (readVar(text, key) == null) continue;
    text = writeVar(text, key, value);
  }
  return text;
}

export function injectAcademyMax(xml: string, opts: { blvlNames: string[]; maxLevel?: string }) {
  let text = asText(xml);
  const rawMax = String(opts.maxLevel ?? "").trim();
  const level = /^\d+$/.test(rawMax) ? rawMax : "999";
  for (const raw of opts.blvlNames ?? []) {
    const name = String(raw ?? "").trim();
    if (!name.startsWith("BLvl_") || !/^BLvl_[\w]+$/.test(name)) continue;
    if (readVar(text, name) == null) continue;
    text = writeVar(text, name, level);
  }
  return text;
}

/**
 * Museum counters are an allowlist rather than a discovered range: the save's
 * `MuseumArtefacts` store is empty, so there are no real artefact ids to expose
 * and inventing any would be a fake entry. Only these two counters exist.
 */
export const MUSEUM_ALLOWLIST = ["Achievement_ArtefactHunter", "Achievement_ArtefactHunterIslands"] as const;

function varsInDocumentOrder(xml: string, re: RegExp) {
  const out: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(re)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value: m[2] ?? "" });
  }
  return out;
}

export function discoverPaddocks(xml: string) {
  // `sq0` companions are the same paddock's secondary slot, not extra paddocks.
  return varsInDocumentOrder(xml, /<Var\b[^>]*\bname="(paddock_[^"]*)"[^>]*\bv="([^"]*)"/gi)
    .filter((v) => /^paddock_[A-Za-z_][\w]*_state$/.test(v.name) && !v.name.endsWith("sq0_state"))
    .map((v) => ({ id: v.name, name: paddockLabel(v.name), state: v.value }));
}

/**
 * Zoo unlock sentinel, read from the save itself instead of a hardcoded guess.
 *
 * Township ships no documented "unlocked" value for `paddock_*_state`, and no
 * constant is safe to invent: the game may reject or ignore a value it never
 * wrote itself. The highest state already present in this save is the only
 * value we can justify, so "unlock" raises every paddock to that level.
 * Returns null when the save has no numeric paddock states to learn from.
 */
export function deriveZooUnlockState(xml: string): string | null {
  const states = discoverPaddocks(xml)
    .map((p) => Number(p.state))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (!states.length) return null;
  const max = Math.max(...states);
  // A save whose paddocks all sit at 0 shows no unlocked paddock to learn from,
  // so writing 0 back would report success while changing nothing.
  return max > 0 ? String(max) : null;
}

export function discoverMuseumVars(xml: string) {
  const out: { name: string; value: string }[] = [];
  for (const name of MUSEUM_ALLOWLIST) {
    const value = readVar(xml, name);
    if (value != null) out.push({ name, value });
  }
  return out;
}

export function discoverAcademy(xml: string) {
  return varsInDocumentOrder(xml, /<Var\b[^>]*\bname="(BLvl_[^"]*)"[^>]*\bv="([^"]*)"/gi)
    .map((v) => ({ name: v.name, level: v.value }));
}
