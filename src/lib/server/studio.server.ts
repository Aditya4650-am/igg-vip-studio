import { requireToken } from "./license.server";
import {
  decryptStream,
  postProcessDecrypt,
} from "./township/crypto.server";
import { applyStatChanges, parseStats, readAnyVar, STAT_ALIASES } from "./township/vars.server";
import { shellErrorMessage } from "./township/save-decode.server";
import { findUnbalancedTag } from "./township/xml-edit.server";
import { applyBarnCapacity, applyBarnItems, barnInfo } from "./township/barn.server";
import { injectAvatars, injectItems, injectProfile, injectRegata, injectSeason, injectSkins, parseProfileUnlocked } from "./township/inject.server";
import {
  applyDesban,
  cloneDecorOnly,
  fetchCityXml,
  maxBuildingsStash,
  maxFragments,
  parseInvitedFriends,
  parseLocalFriends,
  parseOwnMeta,
  decodeLocalInfoBase64,
  unlockEmoji,
} from "./township/desban.server";
import {
  BARN_CAPACITY,
  cloakBarnItems,
  cloakStats,
  publicCatalogs,
  cloakProfileUnlocked,
  revealSave,
} from "./catalogs.server";

export type Friend = { id: string; name: string; level: number; type: "friend" | "request" };

export type BarnState = {
  upgrades: number | null;
  capacity: number | null;
  items: Record<string, number>;
};

export type Session = {
  id: string;
  token: string;
  kind: "xml" | "lz4";
  device: string;
  rawXml: string | null;
  header: Buffer | null;
  originalDecrypted: Buffer | null;
  friendXml: string | null;
  ownMeta: { cityId: string; bver: string; fver: string };
  stats: Record<string, string>;
  profile: Record<string, string[]>;
  profileUnlocked: Record<string, string[]>;
  avatars: string[];
  skins: Record<string, string[]>;
  items: Record<string, number>;
  decor: string[];
  barn: BarnState;
  season: { premium: boolean; score: number };
  regatta: { tasks: number; score: number } | null;
  friends: Friend[];
  friendCity: string | null;
  friendCards: string | null;
  unban: { mode: string | null; applied: boolean };
  log: string[];
};

const sessions = new Map<string, Session>();

function id() {
  return crypto.randomUUID();
}

function requireSession(sessionId: string, token: string): Session {
  requireToken(token);
  const s = sessions.get(sessionId);
  if (!s || s.token !== token) throw new Error("Session expired — connect again");
  return s;
}

export function catalogs() {
  return publicCatalogs();
}

export function listDevices() {
  return [] as { id: string; label: string }[];
}

function encodeSave(s: Session): string | null {
  if (!s.rawXml) return null;
  // v1.15 client behavior: after Load/Decode and edits, the payload sent to
  // the desktop is the decoded XML itself. The desktop writes those bytes
  // directly to /data/data/<package>/saves/mGameInfo.xml (and .bak).
  // Encryption/container handling is intentionally NOT applied here.
  const xml = Buffer.from(s.rawXml.replace(/^\uFEFF/, ""), "utf8");
  return xml.toString("base64");
}

function openSave(buf: Buffer) {
  const shellErr = shellErrorMessage(buf);
  if (shellErr) {
    throw new Error(
      `Không đọc được mGameInfo từ máy ảo (ADB trả về lỗi shell: "${shellErr}"). ` +
        "Hãy kiểm tra giả lập đã Root chưa và mở Township ít nhất một lần.",
    );
  }
  const textHead = buf.subarray(0, 80).toString("utf8");
  if (/adb:|Permission denied|failed to stat|su:|not found/i.test(textHead)) {
    throw new Error("File kéo từ ADB bị lỗi (chưa Root / sai đường dẫn), không phải mGameInfo.");
  }
  const utfHead = buf.subarray(0, Math.min(buf.length, 256)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (utfHead.startsWith("<")) {
    return { xml: buf.toString("utf8").replace(/^\uFEFF/, ""), kind: "xml" as const, header: null as Buffer | null, original: null as Buffer | null };
  }
  if (buf.length < 64) {
    throw new Error(`File quá ngắn (${buf.length} byte) — ADB chưa kéo đủ save.`);
  }
  const header = buf.subarray(0, 8);
  const dec = decryptStream(buf);
  const { xml, kind } = postProcessDecrypt(dec);
  if (kind === "raw") {
    const hex = buf.subarray(0, 8).toString("hex");
    throw new Error(`Không giải được save (${buf.length} byte, head ${hex}). Cần file mGameInfo gốc.`);
  }
  return { xml: xml.toString("utf8"), kind: kind as "xml" | "lz4", header, original: dec };
}

export function connectLoad(token: string, device: string, _saveXml?: string, _preview?: boolean, saveB64?: string) {
  requireToken(token);
  const sessionId = id();
  let blob: Buffer | null = null;
  if (saveB64?.trim()) blob = Buffer.from(saveB64.trim(), "base64");
  if (blob && blob.length >= 8) {
    const opened = openSave(blob);
    const stats = parseStats(opened.xml);
    const barn = barnInfo(opened.xml);
    const friends = parseInvitedFriends(opened.xml);
    const ownMeta = parseOwnMeta(opened.xml);
    const s: Session = {
      id: sessionId,
      token,
      kind: opened.kind,
      device,
      rawXml: opened.xml,
      header: opened.header,
      originalDecrypted: opened.original,
      friendXml: null,
      ownMeta,
      stats,
      profile: {},
      profileUnlocked: cloakProfileUnlocked(parseProfileUnlocked(opened.xml)),
      avatars: [],
      skins: {},
      items: {},
      decor: [],
      barn,
      season: { premium: /premium="1"/i.test(opened.xml), score: Number(opened.xml.match(/SeasonTicket[^>]*score="(\d+)"/i)?.[1] ?? 0) },
      regatta: null,
      friends,
      friendCity: null,
      friendCards: null,
      unban: { mode: null, applied: false },
      log: [
        "Save loaded",
        `Stats ready: ${Object.keys(stats).length} fields`,
        `Friends ready: ${friends.length}`,
      ],
    };
    sessions.set(sessionId, s);
    return snapshot(s);
  }
  throw new Error("Chưa có mGameInfo từ emulator. Hãy kết nối giả lập và Load lại.");
}


export function refreshOwnSave(token: string, sessionId: string, saveB64: string) {
  const s = requireSession(sessionId, token);
  const blob = Buffer.from(saveB64.trim(), "base64");
  if (blob.length < 8) throw new Error("mGameInfo mới quá ngắn");
  const opened = openSave(blob);
  const friendXml = s.friendXml;
  const friendCity = s.friendCity;
  const friends = s.friends;
  const unban = s.unban;
  s.kind = opened.kind;
  s.rawXml = opened.xml;
  s.header = opened.header;
  s.originalDecrypted = opened.original;
  s.friendXml = friendXml;
  s.friendCity = friendCity;
  s.friends = friends;
  s.unban = unban;
  s.ownMeta = parseOwnMeta(opened.xml);
  s.stats = parseStats(opened.xml);
  s.profileUnlocked = cloakProfileUnlocked(parseProfileUnlocked(opened.xml));
  s.barn = barnInfo(opened.xml);
  s.log.push(`Reloaded mGameInfo from emulator`);
  return snapshot(s);
}

export type SavePayload = {
  token: string;
  sessionId: string;
  stats?: Record<string, string>;
  profile?: Record<string, string[]>;
  avatars?: string[];
  skins?: Record<string, string[]>;
  items?: Record<string, number>;
  decor?: string[];
  decorQty?: number;
  sticker?: string[];
  barnUpgrades?: number;
  barnItems?: Record<string, number>;
  regatta?: boolean;
  season?: boolean;
  unbanMode?: "inicial" | "completo" | "novo";
  decorFragments?: boolean;
  decorClone?: boolean;
  decorMaxAll?: boolean;
};

function mergeUnique(a: string[], b: string[]) {
  const set = new Set(a);
  for (const x of b) set.add(x);
  return [...set];
}

export function applySave(p: SavePayload) {
  const s = requireSession(p.sessionId, p.token);
  if (!s.rawXml) throw new Error("Load mGameInfo trước");
  const revealed = revealSave(p);
  const parts: string[] = [];

  // Apply compound operations first so every UI change is committed in one save.
  if (p.unbanMode) {
    if (!s.friendXml) throw new Error("FetchCity friend trước khi Unban");
    s.rawXml = applyDesban(s.rawXml, s.friendXml, p.unbanMode);
    s.unban = { mode: p.unbanMode, applied: true };
    parts.push(`unban-${p.unbanMode}`);
  }
  if (p.decorClone) {
    if (!s.friendXml) throw new Error("FetchCity friend trước khi Clone Decor");
    s.rawXml = cloneDecorOnly(s.rawXml, s.friendXml).xml;
    parts.push("decor-clone");
  }
  if (p.regatta) {
    s.rawXml = injectRegata(s.rawXml, 105, 135);
    s.regatta = { tasks: 105, score: 135 };
    parts.push("regatta-105x135");
  }
  if (p.season) {
    s.rawXml = injectSeason(s.rawXml, "1", "1002");
    s.season = { premium: true, score: 1002 };
    parts.push("season-pass");
  }

  if (Object.keys(revealed.stats).length) {
    s.stats = { ...s.stats, ...revealed.stats };
    s.rawXml = applyStatChanges(s.rawXml, s.stats);
    parts.push("stats");
  }
  if (Object.keys(revealed.profile).length) {
    for (const [g, ids] of Object.entries(revealed.profile)) s.profile[g] = mergeUnique(s.profile[g] ?? [], ids);
    s.rawXml = injectProfile(s.rawXml, revealed.profile);
    parts.push("profile");
  }
  if (revealed.avatars.length) {
    s.avatars = mergeUnique(s.avatars, revealed.avatars);
    s.rawXml = injectAvatars(s.rawXml, revealed.avatars);
    parts.push(`avatars(${revealed.avatars.length})`);
  }
  if (Object.keys(revealed.skins).length) {
    for (const [g, ids] of Object.entries(revealed.skins)) s.skins[g] = mergeUnique(s.skins[g] ?? [], ids);
    s.rawXml = injectSkins(s.rawXml, revealed.skins);
    parts.push("skins");
  }
  if (Object.keys(revealed.items).length) {
    let kinds = 0;
    for (const [itemId, raw] of Object.entries(revealed.items)) {
      const qty = Math.floor(Number(raw));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      s.items[itemId] = (s.items[itemId] ?? 0) + qty;
      kinds += 1;
    }
    if (kinds) {
      s.rawXml = injectItems(s.rawXml, revealed.items);
      parts.push(`items(${kinds})`);
    }
  }
  if (revealed.decor.length) {
    const decorQty = Number.isFinite(p.decorQty) && (p.decorQty ?? 0) > 0 ? Math.floor(p.decorQty ?? 10) : 10;
    s.rawXml = maxBuildingsStash(s.rawXml, revealed.decor, decorQty);
    s.decor = mergeUnique(s.decor, revealed.decor);
    parts.push(`decor(${revealed.decor.length})`);
  }
  if (p.decorMaxAll) {
    const allQty = Number.isFinite(p.decorQty) && (p.decorQty ?? 0) > 0 ? Math.floor(p.decorQty ?? 10) : 10;
    s.rawXml = maxBuildingsStash(s.rawXml, [], allQty);
    parts.push(`decor-max-all(${allQty})`);
  }
  if (p.decorFragments) {
    s.rawXml = maxFragments(s.rawXml);
    parts.push("decor-fragments");
  }
  if (p.sticker?.length) {
    s.rawXml = unlockEmoji(s.rawXml, p.sticker);
    parts.push(`stickers(${p.sticker.length})`);
  }
  if (p.barnUpgrades && p.barnUpgrades > 0) {
    const preset = BARN_CAPACITY.find((c) => c.upgrades === p.barnUpgrades);
    if (!preset) throw new Error("Invalid barn upgrades");
    s.barn.upgrades = preset.upgrades;
    s.barn.capacity = preset.capacity;
    s.rawXml = applyBarnCapacity(s.rawXml, p.barnUpgrades);
    parts.push(`barn(${preset.upgrades})`);
  }
  if (Object.keys(revealed.barnItems).length) {
    let n = 0;
    for (const [pid, raw] of Object.entries(revealed.barnItems)) {
      const qty = Math.floor(Number(raw));
      if (!Number.isFinite(qty) || qty < 0) continue;
      s.barn.items[pid] = qty;
      n += 1;
    }
    if (n) {
      s.rawXml = applyBarnItems(s.rawXml, revealed.barnItems);
      parts.push(`barn-items(${n})`);
    }
  }

  s.stats = parseStats(s.rawXml);
  s.profileUnlocked = cloakProfileUnlocked(parseProfileUnlocked(s.rawXml));
  s.barn = barnInfo(s.rawXml);
  if (!parts.length) throw new Error("Nothing selected");
  const malformed = findUnbalancedTag(s.rawXml);
  if (malformed) throw new Error(`Save XML không hợp lệ (${malformed}) — hủy để tránh hỏng file`);
  s.log.push(`Save applied: ${parts.join(", ")}`);
  return { ...snapshot(s), parts, xml: s.rawXml, fileB64: encodeSave(s) };
}

export function applyRegatta(token: string, sessionId: string) {
  const s = requireSession(sessionId, token);
  s.regatta = { tasks: 105, score: 135 };
  if (s.rawXml) s.rawXml = injectRegata(s.rawXml, 105, 135);
  s.log.push("Regatta 105×135 injected");
  return { ...snapshot(s), xml: s.rawXml, fileB64: encodeSave(s) };
}

export function applySeason(token: string, sessionId: string) {
  const s = requireSession(sessionId, token);
  s.season = { premium: true, score: 1002 };
  if (s.rawXml) s.rawXml = injectSeason(s.rawXml);
  s.log.push("Season Pass premium=1 score=1002");
  return { ...snapshot(s), xml: s.rawXml, fileB64: encodeSave(s) };
}

export function refreshBarn(token: string, sessionId: string) {
  const s = requireSession(sessionId, token);
  if (!s.rawXml) throw new Error("Load mGameInfo trước");
  s.barn = barnInfo(s.rawXml);
  s.log.push(`Barn refreshed: ${s.barn.upgrades ?? 0} upgrades, ${Object.keys(s.barn.items).length} items`);
  return snapshot(s);
}

export function loadFriends(token: string, sessionId: string) {
  const s = requireSession(sessionId, token);
  if (!s.rawXml) throw new Error("Load a real mGameInfo save before refreshing friends");
  s.friends = parseInvitedFriends(s.rawXml);
  s.log.push(`Friends refreshed: ${s.friends.length}`);
  return snapshot(s);
}

export async function fetchFriendCity(token: string, sessionId: string, cityId: string) {
  const s = requireSession(sessionId, token);
  if (!cityId.trim()) throw new Error("cityId required");
  if (!s.rawXml) throw new Error("Load mGameInfo trước khi FetchCity");
  const xml = await fetchCityXml(cityId.trim(), s.ownMeta.bver, s.ownMeta.fver);
  s.friendXml = xml;
  s.friendCity = cityId.trim();
  s.friendCards = readAnyVar(xml, STAT_ALIASES.crd!);
  s.log.push(`Friend city loaded successfully`);
  return snapshot(s);
}

export function applyUnban(token: string, sessionId: string, mode: "inicial" | "completo" | "novo") {
  const s = requireSession(sessionId, token);
  if (!s.friendXml) throw new Error("FetchCity friend trước khi restore");
  if (!s.rawXml) throw new Error("Load mGameInfo trước");
  s.rawXml = applyDesban(s.rawXml, s.friendXml, mode);
  const malformed = findUnbalancedTag(s.rawXml);
  if (malformed) throw new Error(`Unban tạo XML không hợp lệ (${malformed}) — hủy để tránh hỏng file`);
  s.stats = parseStats(s.rawXml);
  s.profileUnlocked = cloakProfileUnlocked(parseProfileUnlocked(s.rawXml));
  s.barn = barnInfo(s.rawXml);
  s.unban = { mode, applied: true };
  s.log.push(`Restore changes prepared`);
  return { ...snapshot(s), fileB64: encodeSave(s) };
}

export function attachFriendXml(token: string, sessionId: string, xml: string) {
  const s = requireSession(sessionId, token);
  const text = xml.replace(/^\uFEFF/, "");
  if (!text.includes("<")) throw new Error("File bạn không phải XML city");
  s.friendXml = text;
  s.friendCity = parseOwnMeta(text).cityId || "uploaded";
  s.friendCards = readAnyVar(text, STAT_ALIASES.crd!);
  s.log.push(`Friend XML uploaded (${text.length} bytes)`);
  return snapshot(s);
}

export function attachLocalInfo(token: string, sessionId: string, xml: string) {
  const s = requireSession(sessionId, token);
  const localMeta = parseOwnMeta(xml);
  const extra = parseLocalFriends(xml);
  // LocalInfo is authoritative for the active game's API version metadata.
  // Keep the currently loaded values only when LocalInfo does not expose them.
  s.ownMeta = {
    cityId: localMeta.cityId || s.ownMeta.cityId,
    bver: localMeta.bver || s.ownMeta.bver,
    fver: localMeta.fver || s.ownMeta.fver,
  };
  const byId = new Map(s.friends.map((f) => [f.id, f]));
  // LocalInfo is authoritative for real friends: replace request-only rows
  // with the friend's actual display name and level.
  for (const f of extra) byId.set(f.id, f);
  s.friends = [...byId.values()];
  s.log.push(`LocalInfo refreshed · ${s.friends.length} friends`);
  return snapshot(s);
}

export function attachLocalInfoBase64(token: string, sessionId: string, b64: string) {
  const xml = decodeLocalInfoBase64(b64);
  return attachLocalInfo(token, sessionId, xml);
}

export function applyDecorActions(
  token: string,
  sessionId: string,
  action: "stash" | "fragments" | "emoji" | "clone",
  ids: string[],
) {
  const s = requireSession(sessionId, token);
  if (!s.rawXml) throw new Error("Load mGameInfo trước");
  if (action === "stash") {
    const revealed = revealSave({ decor: ids });
    s.rawXml = maxBuildingsStash(s.rawXml, revealed.decor, 10);
    s.decor = mergeUnique(s.decor, revealed.decor);
    s.log.push(`Decor stash ${revealed.decor.length || "all visible"}`);
  } else if (action === "fragments") {
    s.rawXml = maxFragments(s.rawXml);
    s.log.push("Decor fragments max");
  } else if (action === "emoji") {
    s.rawXml = unlockEmoji(s.rawXml, ids.length ? ids : undefined);
    s.log.push(`Chat emoji ${ids.length ? ids.length : "all"}`);
  } else {
    if (!s.friendXml) throw new Error("FetchCity friend trước khi Clone Decor");
    s.rawXml = cloneDecorOnly(s.rawXml, s.friendXml).xml;
    s.log.push("Decor cloned from friend city");
  }
  s.profileUnlocked = cloakProfileUnlocked(parseProfileUnlocked(s.rawXml));
  return { ...snapshot(s), fileB64: encodeSave(s) };
}

function safeLogLine(line: string) {
  return String(line || "")
    .replace(/\bFVer\s*[:=]?\s*[0-9.]+/gi, "FVer hidden")
    .replace(/\bversion\s+[^/·|]+/gi, "version hidden")
    .replace(/\bcityId\s+[^/·|]+/gi, "cityId hidden")
    .replace(/https?:\/\/\S+/gi, "endpoint hidden");
}

export function snapshot(s: Session) {
  return {
    sessionId: s.id,
    kind: s.kind,
    hasXml: Boolean(s.rawXml),
    profileUnlocked: cloakProfileUnlocked(s.profileUnlocked),
    stats: cloakStats(s.stats),
    barn: {
      upgrades: s.barn.upgrades,
      capacity: s.barn.capacity,
      items: cloakBarnItems(s.barn.items),
    },
    season: s.season,
    regatta: s.regatta,
    friends: s.friends,
    friendCity: s.friendCity,
    friendCards: s.friendCards,
    unban: s.unban,
    log: s.log.slice(-12).map(safeLogLine),
  };
}
