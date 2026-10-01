import { requireToken } from "./license.server";
import { accountAgeInfo } from "../account-age";
import {
  decryptStream,
  postProcessDecrypt,
} from "./township/crypto.server";
import { applyStatChanges, parseStats, readAnyVar, STAT_ALIASES } from "./township/vars.server";
import { shellErrorMessage } from "./township/save-decode.server";
import { findUnbalancedTag } from "./township/xml-edit.server";
import { applyBarnCapacity, applyBarnItems, barnInfo, ensureBarnCapacity } from "./township/barn.server";
import { assertRegattaSafe, injectAvatars, injectItems, injectProfile, injectRegata, injectSeason, injectSkins, injectUpgradeLevels, inspectRegatta, parseProfileUnlocked, upgradeMaxLevel, discoverUpgrades, REGATTA_DEFAULT_TASKS, REGATTA_MAX_TASKS, UPGRADE_REF_CAP } from "./township/inject.server";
import { grantArtifacts } from "./township/museum.server";
import { assertCardCollectionsSafe, grantCards, countOwnedCards, friendsList, inspectCards, sendCards, type CardSend } from "./township/cards.server";
import { assertProgressionsSafe, assertSaveShapeSafe, stripUnknownAvatars } from "./township/save-shape.server";
import { completeZoo, discoverZoo, type ZooPaddock } from "./township/zoo.server";
import {
  backupFreshStartState,
  restoreFreshStartState,
  verifyFreshStartState,
  wipeFreshStartPlan,
} from "./township/freshstart.server";

import {
  applyDesban,
  cloneDecorOnly,
  cloneTownLayout,
  declaredIds,
  fetchCityXml,
  isTownUnchanged,
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
  BARN_PRODUCT_IDS,
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
  /** The save text exactly as loaded, before any edit — the undo source. */
  loadedXml: string | null;
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
  zoo: ZooPaddock[];
  season: { premium: boolean; score: number };
  regatta: { tasks: number; score: number } | null;
  friends: Friend[];
  friendCity: string | null;
  unban: { mode: string | null; applied: boolean };
  freshBackupCity?: string | null;
  freshBackupLocal?: string | null;
  freshBackupExtra?: Record<string, string> | null;
  freshBackupMeta?: {
    serial: string;
    cityPath: string;
    localPath: string;
    extraPaths: string[];
    oldCityId: string;
    oldLevel: number;
    oldAndroidId: string;
    oldGsfId: string;
  } | null;
  freshVerified?: { newCityId: string; newAndroidId: string } | null;
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

/**
 * The save as it was loaded, before any edits. This is the undo path for an
 * edit that turns out to be unwelcome on the device: the container bytes are
 * kept on the session, so the user can write the original file straight back.
 */
export function exportOriginal(token: string, sessionId: string) {
  const s = requireSession(sessionId, token);
  // Two save shapes reach here. An encrypted/compressed pull keeps the raw
  // container in `originalDecrypted`. A plain-XML save (already decoded, or
  // loaded from LocalInfo) has no container, so the untouched XML text is the
  // original — that is exactly the bytes `encodeSave` would have written.
  const buf = s.originalDecrypted ?? (s.loadedXml ? Buffer.from(s.loadedXml, "utf8") : null);
  if (!buf) throw new Error("Chưa có save gốc để sao lưu");
  return { fileB64: buf.toString("base64") };
}

/**
 * The session XML exactly as it stands now (edits included), as a plain-XML
 * download. Diagnostics/export only — never written back automatically.
 */
export function exportCurrent(token: string, sessionId: string) {
  const s = requireSession(sessionId, token);
  if (!s.rawXml) throw new Error("Chưa có save để xuất");
  return { fileB64: Buffer.from(s.rawXml.replace(/^\uFEFF/, ""), "utf8").toString("base64") };
}

export function listDevices() {
  return [] as { id: string; label: string }[];
}

/**
 * The last gate before any file leaves for the device. Every feature ends up
 * in `encodeSave`, so putting the identity check here is what makes the
 * promise apply to *all* of them instead of to whichever one happens to
 * remember.
 *
 * A save must keep declaring the identity it was loaded with: its cityId, its
 * device, and the user id its own records are attributed to. Anything else in
 * there belongs to someone else, and Playrix rejects that on upload — an
 * instant ban rather than a cosmetic bug. Everything is compared against the
 * save as it was loaded, so a marker our own file already carried (a teammate
 * in the roster, say) is never mistaken for one a feature just imported.
 */
export function assertPushSafe(s: Session) {
  const was = s.loadedXml?.replace(/^\uFEFF/, "");
  const now = s.rawXml?.replace(/^\uFEFF/, "");
  if (!was || !now || was === now) return;

  const problems: string[] = [];

  const wasOwner = parseOwnMeta(was).cityId;
  const nowOwner = parseOwnMeta(now).cityId;
  if (wasOwner && nowOwner && nowOwner !== wasOwner) problems.push(`cityId ${wasOwner} → ${nowOwner}`);

  const hadDevices = new Set([...was.matchAll(/<Var\s+name="deviceId"\s+v="([^"]*)"/gi)].map((m) => m[1]!));
  for (const [, d] of now.matchAll(/<Var\s+name="deviceId"\s+v="([^"]*)"/gi)) {
    if (d && !hadDevices.has(d)) problems.push(`deviceId ${d}`);
  }

  const hadUsers = new Set([...was.matchAll(/\buser="([^"]*)"/gi)].map((m) => m[1]!));
  const ours = declaredIds(was);
  for (const [, u] of now.matchAll(/\buser="([^"]*)"/gi)) {
    // Ids this save claims for itself count as ours: a record rewritten to
    // point at us is ours even when it carried no user= of its own before.
    if (u && !hadUsers.has(u) && !ours.has(u)) problems.push(`user id ${u}`);
  }

  const mpWas = (was.match(/name="mainPlayer"/gi) ?? []).length;
  const mpNow = (now.match(/name="mainPlayer"/gi) ?? []).length;
  if (mpNow > mpWas) problems.push(`mainPlayer +${mpNow - mpWas}`);

  const friendId = s.friendXml ? parseOwnMeta(s.friendXml).cityId : "";
  if (friendId && !ours.has(friendId)) {
    const a = was.split(friendId).length - 1;
    const b = now.split(friendId).length - 1;
    if (b > a) problems.push(`thành phố của bạn cũ ${friendId} (+${b - a})`);
  }

  if (problems.length) {
    throw new Error(
      `Không đẩy file lên máy — save đang mang danh tính của người khác: ${problems.join(", ")}. ` +
        "Đây chính là nguyên nhân gây khóa tài khoản Playrix tức thì.",
    );
  }
}

function encodeSave(s: Session): string | null {
  if (!s.rawXml) return null;
  assertPushSafe(s);
  // Same choke point, for the card half: a feature that leaves an invariant
  // the game's own saves never break is refused here rather than on device.
  // Both gates compare against the save as it was loaded, so a city that
  // already looked odd on arrival is never blocked for that same reason.
  if (s.loadedXml) {
    const was = s.loadedXml.replace(/^\uFEFF/, "");
    const now = s.rawXml.replace(/^\uFEFF/, "");
    // Same choke point, for the card half: a feature that leaves an invariant
    // the game's own saves never break is refused here rather than on device.
    // Both gates compare against the save as it was loaded, so a city that
    // already looked odd on arrival is never blocked for that same reason.
    assertCardCollectionsSafe(was, now);
    // And the shape half — avatars, sticker list, profile lists, <Upgrade>
    // level/slx, `t="i"` vars and tag balance. Same loaded-vs-pushed rule, so
    // it refuses only what *this* edit introduced: an oddity the save arrived
    // with keeps its key on both sides and stays pushable. Because it lives
    // here rather than in one feature, every path that ends in a push — stats,
    // inject, unban, skins, upgrades, cards, profile, season, regatta — is
    // covered without each having to remember.
    //
    // `s.friendXml` goes along with it: a restore copies the friend's profile
    // block and sticker list verbatim, and a high-level friend carries ids no
    // catalog has measured yet. Those are the donor's own game data, not
    // something this tool made up — refusing them made *Restore full city*
    // fail against every friend richer than the catalog.
    assertSaveShapeSafe(was, now, s.friendXml);
    // And the progression half: the lifetime regatta counter and the
    // factory/train/island levels only ever rise in game, so a push that walks
    // one backwards is refused here rather than on device. The donor rides
    // along because a restore legitimately replaces our counter with the
    // friend's own — but only their exact value is excused, not any drop.
    assertProgressionsSafe(was, now, s.friendXml);
    // Regatta's own half: a completed task is a field-by-field record the
    // game reads on upload, so the batch is checked against every invariant a
    // real save holds before any of it can leave. Same loaded-vs-pushed rule —
    // an old injector's fingerprints the save arrived with never block it, but
    // a batch written here must be indistinguishable from game data.
    assertRegattaSafe(was, now);
  }
  // v1.15 client behavior: after Load/Decode and edits, the payload sent to
  // the desktop is the decoded XML itself. The desktop writes those bytes
  // directly to /data/data/<package>/saves/mGameInfo.xml (and .bak).
  // Encryption/container handling is intentionally NOT applied here.
  const xml = Buffer.from(s.rawXml.replace(/^\uFEFF/, ""), "utf8");
  return xml.toString("base64");
}

/**
 * `encodeSave` for the paths that edit `s.rawXml` directly instead of going
 * through `applySave`.
 *
 * The push gates run inside `encodeSave` and they may refuse. Rolling back is
 * not optional: `assertSaveShapeSafe` compares against the save as it was
 * loaded, so a rejected edit left in `s.rawXml` makes *every* later push of
 * that session refuse too — the feature would stay broken until the session is
 * reloaded, which is the "stuck" state `applySave`'s rollback exists to avoid.
 * The success line is dropped as well, so the log never claims something the
 * file did not get.
 */
function encodeOrRollback(s: Session, note: string, rollback: () => void): string | null {
  const logLen = s.log.length;
  try {
    return encodeSave(s);
  } catch (e) {
    rollback();
    s.log.length = logLen;
    s.log.push(note);
    throw e;
  }
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
    // Drop avatar vars no city on the server can hold — the fake `399..500`
    // an earlier build wrote after raising `AVATAR_MAX` without evidence — from
    // the *working* copy only. `originalDecrypted` and `loadedXml` stay
    // byte-exact, so Backup still returns the file exactly as it arrived.
    const cleaned = stripUnknownAvatars(opened.xml);
    const avatarNote = cleaned.removed.length
      ? `Removed ${cleaned.removed.length} avatar id(s) no real city has: ${
          [...cleaned.removed].sort((a, b) => a - b).slice(0, 8).join(", ")
        }${cleaned.removed.length > 8 ? ", …" : ""}`
      : null;
    const stats = parseStats(opened.xml);
    const barn = barnInfo(opened.xml);
    const friends = parseInvitedFriends(opened.xml);
    const ownMeta = parseOwnMeta(opened.xml);
    const s: Session = {
      id: sessionId,
      token,
      kind: opened.kind,
      device,
      rawXml: cleaned.xml,
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
      loadedXml: opened.xml.replace(/^\uFEFF/, ""),
      barn,
      zoo: discoverZoo(opened.xml),
      season: { premium: /premium="1"/i.test(opened.xml), score: Number(opened.xml.match(/SeasonTicket[^>]*score="(\d+)"/i)?.[1] ?? 0) },
      regatta: null,
      friends,
      friendCity: null,
      unban: { mode: null, applied: false },
      log: [
        "Save loaded",
        ...(avatarNote ? [avatarNote] : []),
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
  // Same load-time avatar cleanup as `connectLoad`: the working copy drops ids
  // the game never issued, while `originalDecrypted`/`loadedXml` stay exact.
  s.rawXml = stripUnknownAvatars(opened.xml).xml;
  s.header = opened.header;
  s.originalDecrypted = opened.original;
  s.loadedXml = opened.xml.replace(/^\uFEFF/, "");
  s.friendXml = friendXml;
  s.friendCity = friendCity;
  s.friends = friends;
  s.unban = unban;
  s.ownMeta = parseOwnMeta(opened.xml);
  s.stats = parseStats(opened.xml);
  s.profileUnlocked = cloakProfileUnlocked(parseProfileUnlocked(opened.xml));
  s.barn = barnInfo(opened.xml);
  s.zoo = discoverZoo(opened.xml);
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
  museum?: string[];
  cards?: Record<string, number>;
  /** Queued card sends — one (card, friend) pair each, validated against the
   * save's own `FriendsList` and `OwnedCards` on the server. */
  cardSends?: CardSend[];
  zoo?: string[];
  barnUpgrades?: number;
  barnItems?: Record<string, number>;
  regatta?: boolean;
  /** How many completed tasks the Regatta tab should reach. Clamped to
   *  [1, REGATTA_MAX_TASKS] on the server, never trusted from the client. */
  regattaTasks?: number;
  season?: boolean;
  unbanMode?: "inicial" | "completo" | "novo";
  decorFragments?: boolean;
  decorClone?: boolean;
  townClone?: boolean;
  decorMaxAll?: boolean;
  upgrades?: {
    factory?: Record<string, number>;
    train?: Record<string, number>;
    island?: Record<string, number>;
  };
};

function mergeUnique(a: string[], b: string[]) {
  const set = new Set(a);
  for (const x of b) set.add(x);
  return [...set];
}

/**
 * Everything `applySave` can rewrite, captured as one unit.
 *
 * The `prevXml` held inside the function only ever restored `rawXml` on the
 * *push-gate* refusal at the very end. A writer that **throws** instead —
 * "Không có thẻ nào thay đổi", "Không có hiện vật nào thay đổi", "Không thấy
 * Zoo", "Invalid barn upgrades", an unbalanced document — escaped the function
 * with every earlier queued edit still sitting in the session, so the user was
 * told the batch failed while the restore/clone they had queued was left in
 * place and applied a second time on the next Save & push. That is the same
 * bug `applyRegatta` was fixed for, one level up: it is not specific to any
 * feature, so the fix is not either.
 *
 * `profile` / `skins` / `items` / `barn` are copied one level deep because
 * those writers assign *into* them (`s.barn.upgrades = …`, `s.profile[g] = …`)
 * rather than replacing the object; the rest are only ever reassigned.
 */
const keepEdits = (s: Session) => ({
  rawXml: s.rawXml,
  unban: s.unban,
  regatta: s.regatta,
  stats: s.stats,
  profile: { ...s.profile },
  avatars: s.avatars,
  skins: { ...s.skins },
  items: { ...s.items },
  decor: s.decor,
  season: s.season,
  barn: { ...s.barn },
});

type Edits = ReturnType<typeof keepEdits>;

const restoreEdits = (s: Session, keep: Edits) => {
  s.rawXml = keep.rawXml;
  s.unban = keep.unban;
  s.regatta = keep.regatta;
  s.stats = keep.stats;
  s.profile = keep.profile;
  s.avatars = keep.avatars;
  s.skins = keep.skins;
  s.items = keep.items;
  s.decor = keep.decor;
  s.season = keep.season;
  s.barn = keep.barn;
};

export function applySave(p: SavePayload) {
  // Snapshotted before anything runs, so every exit — a thrown refusal as well
  // as a gate refusal — lands back on the file the session arrived holding.
  // `s.log` is deliberately not restored: the "rejected" line it may already
  // have pushed is the one honest record of what happened.
  const keep = keepEdits(requireSession(p.sessionId, p.token));
  try {
    return applySaveEdits(p);
  } catch (e) {
    restoreEdits(requireSession(p.sessionId, p.token), keep);
    throw e;
  }
}

function applySaveEdits(p: SavePayload) {
  const s = requireSession(p.sessionId, p.token);
  if (!s.rawXml) throw new Error("Load mGameInfo trước");
  const revealed = revealSave(p);
  const parts: string[] = [];
  // Kept so an edit the push gate later refuses can be undone: the session
  // must never be left holding a save that can never be written to the device.
  const prevXml = s.rawXml;
  const prevUnban = s.unban;
  const prevRegatta = s.regatta;

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
  if (p.townClone) {
    if (!s.friendXml) throw new Error("FetchCity bạn trước khi Clone bố cục thành phố");
    try {
      s.rawXml = cloneTownLayout(s.rawXml, s.friendXml).xml;
    } catch (e) {
      // `completo` / `novo` already clone this same donor's TownGround and
      // Buildings earlier in the very same batch (the loop at the top of
      // `applyDesban`), so by the time the dedicated clone runs the town is
      // byte for byte the donor's — and it refuses with "nothing changed",
      // aborting the whole *full city + decorations + town* batch. The town
      // the user asked for is already in place, so that one refusal is a
      // false alarm; every other failure ("this file is not a city", a
      // foreign identity) still stops the batch.
      const restoreAlreadyClonedTheTown = !!p.unbanMode && p.unbanMode !== "inicial";
      if (!(restoreAlreadyClonedTheTown && isTownUnchanged(e))) throw e;
    }
    parts.push("town-clone");
  }
  if (p.regatta) {
    const want = Math.max(
      1,
      Math.min(REGATTA_MAX_TASKS, Math.floor(Number(p.regattaTasks ?? REGATTA_DEFAULT_TASKS) || REGATTA_DEFAULT_TASKS)),
    );
    try {
      s.rawXml = injectRegata(s.rawXml, want);
    } catch (e) {
      // A refusal must leave the session exactly as it was. Earlier queued
      // edits (a restore, a clone) have already touched s.rawXml by this
      // point, and leaving them in while reporting a failure would mean the
      // next Save & push applies them a second time.
      s.rawXml = prevXml;
      s.unban = prevUnban;
      s.regatta = prevRegatta;
      throw e;
    }
    const st = inspectRegatta(s.rawXml);
    s.regatta = { tasks: st.current, score: st.avgScore };
    parts.push(`regatta-${want}`);
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
    // Surface soft caps so a clamped value is never a silent surprise: the
    // console shows what was asked versus what the anti-ban bands allowed.
    const got = parseStats(s.rawXml);
    for (const fid of ["tca", "coi"] as const) {
      const want = (s.stats[fid] ?? "").trim();
      const have = (got[fid] ?? "").trim();
      if (want && have && /^-?\d+$/.test(want) && Number(want) > Number(have)) {
        s.log.push(`Soft cap (anti-ban): ${fid} ${want} → ${have}`);
      }
    }
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
  if (revealed.museum.length) {
    const r = grantArtifacts(s.rawXml, revealed.museum);
    if (!r.changed) {
      throw new Error(
        `Không có hiện vật nào thay đổi — tất cả đã đạt ${r.target} bản sao và đã mở khóa`,
      );
    }
    s.rawXml = r.xml;
    parts.push(`museum(${r.changed})`);
  }
  if (Object.keys(revealed.cards).length) {
    const r = grantCards(s.rawXml, revealed.cards);
    if (!r.changed) {
      throw new Error(
        `Không có thẻ nào thay đổi — tất cả đã có đủ số lượng`,
      );
    }
    s.rawXml = r.xml;
    parts.push(`cards(${r.changed})`);
  }
  if (p.cardSends?.length) {
    try {
      const r = sendCards(s.rawXml, p.cardSends);
      s.rawXml = r.xml;
      parts.push(`card-sends(${r.changed})`);
    } catch (e) {
      // Same rule as the regatta refusal: a refusal rolls the whole batch
      // back rather than leaving the card grant already applied behind an
      // error the next push would apply a second time.
      s.rawXml = prevXml;
      s.unban = prevUnban;
      s.regatta = prevRegatta;
      throw e;
    }
  }
  if (revealed.zoo.length) {
    const r = completeZoo(s.rawXml, revealed.zoo);
    if (!r.changed) {
      throw new Error(
        `Không có con vật nào thay đổi — tất cả đã hoàn thành`,
      );
    }
    s.rawXml = r.xml;
    parts.push(`zoo(${r.changed})`);
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
    const validUpdates: Record<string, number> = {};
    
    for (const [pid, raw] of Object.entries(revealed.barnItems)) {
      const qty = Math.floor(Number(raw));
      if (!Number.isFinite(qty) || qty < 0) continue;
      
      // VALIDATE: Only allow known barn product IDs
      if (BARN_PRODUCT_IDS.has(pid)) {
        validUpdates[pid] = qty;
        n += 1;
      }
    }
    
    if (n > 0) {
      // Apply items
      s.rawXml = applyBarnItems(s.rawXml, validUpdates);
      
      // AUTO-UPGRADE capacity to fit total
      const totalItems = Object.values(validUpdates).reduce((sum, q) => sum + q, 0);
      s.rawXml = ensureBarnCapacity(s.rawXml, totalItems);
      
      parts.push(`barn-items(${n})`);
    }
  }

  // Factory / Train / Island upgrades
  if (p.upgrades) {
    const up = p.upgrades;
    if (up.factory && Object.keys(up.factory).length) {
      const ids = Object.keys(revealed.upgrades?.factory ?? {});
      const target = Math.max(...Object.values(up.factory), 0);
      if (!ids.length) throw new Error("Phiên ánh xạ đã hết hạn — hãy Kết nối lại rồi thử lại");
      if (target > 0) {
        const r = injectUpgradeLevels(s.rawXml, "Factory", ids, target);
        if (!r.changed) throw new Error("Không có xưởng nào thay đổi");
        s.rawXml = r.xml;
        parts.push(`factory(${r.changed})`);
      }
    }
    if (up.train && Object.keys(up.train).length) {
      const ids = Object.keys(revealed.upgrades?.train ?? {});
      const target = Math.max(...Object.values(up.train), 0);
      if (!ids.length) throw new Error("Phiên ánh xạ đã hết hạn — hãy Kết nối lại rồi thử lại");
      if (target > 0) {
        const r = injectUpgradeLevels(s.rawXml, "Train", ids, target);
        if (!r.changed) throw new Error("Không có tàu hỏa nào thay đổi");
        s.rawXml = r.xml;
        parts.push(`train(${r.changed})`);
      }
    }
    if (up.island && Object.keys(up.island).length) {
      const ids = Object.keys(revealed.upgrades?.island ?? {});
      const target = Math.max(...Object.values(up.island), 0);
      if (!ids.length) throw new Error("Phiên ánh xạ đã hết hạn — hãy Kết nối lại rồi thử lại");
      if (target > 0) {
        const r = injectUpgradeLevels(s.rawXml, "Island", ids, target);
        if (!r.changed) throw new Error("Không có đảo nào thay đổi");
        s.rawXml = r.xml;
        parts.push(`island(${r.changed})`);
      }
    }
  }

  s.stats = parseStats(s.rawXml);
  s.profileUnlocked = cloakProfileUnlocked(parseProfileUnlocked(s.rawXml));
  s.barn = barnInfo(s.rawXml);
  s.zoo = discoverZoo(s.rawXml);
  if (!parts.length) throw new Error("Nothing selected");
  const malformed = findUnbalancedTag(s.rawXml);
  if (malformed) throw new Error(`Save XML không hợp lệ (${malformed}) — hủy để tránh hỏng file`);
  let fileB64: string | null;
  try {
    fileB64 = encodeSave(s);
  } catch (e) {
    // The push gate refused this file. Undo the edit and leave the log clean
    // so the session stays usable instead of failing the same way forever.
    s.rawXml = prevXml;
    s.log.push(`Save rejected by identity gate: ${parts.join(", ")}`);
    throw e;
  }
  s.log.push(`Save applied: ${parts.join(", ")}`);
  return { ...snapshot(s), parts, xml: s.rawXml, fileB64 };
}

export function applyRegatta(token: string, sessionId: string) {
  // One path only: the tab, this helper and every guard rail (identity gate,
  // XML balance, rollback) go through applySave.
  return applySave({ token, sessionId, regatta: true });}

export function applySeason(token: string, sessionId: string) {
  const s = requireSession(sessionId, token);
  const prevXml = s.rawXml;
  const prevSeason = s.season;
  // Assigned *after* the injector returns: `injectSeason` refuses to invent a
  // ticket, and the session must not claim a season it never wrote.
  if (s.rawXml) s.rawXml = injectSeason(s.rawXml);
  s.season = { premium: true, score: 1002 };
  // Logged after the gates accept, like `applySave`, so a refusal leaves no
  // line behind claiming the season was applied to a file that was rolled back.
  const fileB64 = encodeOrRollback(s, "Season rejected by push gate", () => {
    s.rawXml = prevXml;
    s.season = prevSeason;
  });
  s.log.push("Season Pass premium=1 score=1002");
  return { ...snapshot(s), xml: s.rawXml, fileB64 };
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
  s.log.push(`Friend city loaded successfully`);
  return snapshot(s);
}

export function applyUnban(token: string, sessionId: string, mode: "inicial" | "completo" | "novo") {
  const s = requireSession(sessionId, token);
  if (!s.friendXml) throw new Error("FetchCity friend trước khi restore");
  if (!s.rawXml) throw new Error("Load mGameInfo trước");
  const prev = {
    xml: s.rawXml,
    stats: s.stats,
    profileUnlocked: s.profileUnlocked,
    barn: s.barn,
    zoo: s.zoo,
    unban: s.unban,
  };
  const rollback = () => {
    s.rawXml = prev.xml;
    s.stats = prev.stats;
    s.profileUnlocked = prev.profileUnlocked;
    s.barn = prev.barn;
    s.zoo = prev.zoo;
    s.unban = prev.unban;
  };
  s.rawXml = applyDesban(s.rawXml, s.friendXml, mode);
  const malformed = findUnbalancedTag(s.rawXml);
  // A malformed result must not be left in place either: `rawXml` has already
  // been rewritten, so the next push would send an edit that was reported as
  // cancelled. Same reasoning as `applySave`'s rollback.
  if (malformed) {
    rollback();
    throw new Error(`Unban tạo XML không hợp lệ (${malformed}) — hủy để tránh hỏng file`);
  }
  s.stats = parseStats(s.rawXml);
  s.profileUnlocked = cloakProfileUnlocked(parseProfileUnlocked(s.rawXml));
  s.barn = barnInfo(s.rawXml);
  s.zoo = discoverZoo(s.rawXml);
  s.unban = { mode, applied: true };
  s.log.push(`Restore changes prepared`);
  return { ...snapshot(s), fileB64: encodeOrRollback(s, "Restore rejected by push gate", rollback) };
}

export function attachFriendXml(token: string, sessionId: string, xml: string) {
  const s = requireSession(sessionId, token);
  const text = xml.replace(/^\uFEFF/, "");
  if (!text.includes("<")) throw new Error("File bạn không phải XML city");
  s.friendXml = text;
  s.friendCity = parseOwnMeta(text).cityId || "uploaded";
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
  const prev = { xml: s.rawXml, decor: s.decor, profileUnlocked: s.profileUnlocked };
  const rollback = () => {
    s.rawXml = prev.xml;
    s.decor = prev.decor;
    s.profileUnlocked = prev.profileUnlocked;
  };
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
  return { ...snapshot(s), fileB64: encodeOrRollback(s, "Decor rejected by push gate", rollback) };
}

/**
 * Fresh-start ("New Account") wrappers. Device file traffic stays in the UI
 * via the native bridge; these only validate, track the backup on the
 * session, and verify the fresh city. applySave and snapshot are untouched.
 */
export function backupFreshStart(
  sessionId: string,
  token: string,
  input: {
    serial: string;
    cityPath: string;
    localPath: string;
    cityB64: string;
    localB64: string;
    extraFiles?: { path: string; b64: string }[];
    androidId?: string;
    gsfId?: string;
  },
) {
  const s = requireSession(sessionId, token);
  return backupFreshStartState(s, input);
}

export function wipeFreshStart(sessionId: string, token: string) {
  const s = requireSession(sessionId, token);
  return wipeFreshStartPlan(s);
}

export function verifyFreshStart(
  sessionId: string,
  token: string,
  input: { cityB64: string; androidId?: string; gsfAndroidId?: string },
) {
  const s = requireSession(sessionId, token);
  return verifyFreshStartState(s, input);
}

export function restoreFreshStart(sessionId: string, token: string) {
  const s = requireSession(sessionId, token);
  const backup = restoreFreshStartState(s);
  return { ...snapshot(s), backup };
}

function safeLogLine(line: string) {
  return String(line || "")
    .replace(/\bFVer\s*[:=]?\s*[0-9.]+/gi, "FVer hidden")
    .replace(/\bversion\s+[^/·|]+/gi, "version hidden")
    .replace(/\bcityId\s+[^/·|]+/gi, "cityId hidden")
    .replace(/https?:\/\/\S+/gi, "endpoint hidden");
}

export function snapshot(s: Session) {
  const factoryMax = s.rawXml ? upgradeMaxLevel(s.rawXml, "Factory") : 0;
  const trainMax = s.rawXml ? upgradeMaxLevel(s.rawXml, "Train") : 0;
  const islandMax = s.rawXml ? upgradeMaxLevel(s.rawXml, "Island") : 0;
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
    regattaInfo: inspectRegatta(s.rawXml ?? ""),
    zoo: s.zoo,
    cardsOwned: countOwnedCards(s.rawXml ?? ""),
    cardsInfo: inspectCards(s.rawXml ?? ""),
    cardFriends: friendsList(s.rawXml ?? ""),
    friends: s.friends,
    friendCity: s.friendCity,
    unban: s.unban,
    factoryMax: factoryMax || undefined,
    trainMax: trainMax || undefined,
    islandMax: islandMax || undefined,
    upgradeCaps: { factory: UPGRADE_REF_CAP.Factory, train: UPGRADE_REF_CAP.Train, island: UPGRADE_REF_CAP.Island },
    accountAge: accountAgeInfo(s.rawXml ?? ""),
    log: s.log.slice(-12).map(safeLogLine),
  };
}
