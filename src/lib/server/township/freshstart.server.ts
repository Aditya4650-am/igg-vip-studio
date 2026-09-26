/**
 * Fresh-start ("New Game") helpers for a city-banned account.
 *
 * File operations only: this module validates pulled bytes, parses the
 * city id + level out of them, and tracks the backup on the session. It
 * never edits save XML. ADB itself lives in the desktop client — the UI
 * pulls/pushes/deletes through the native bridge, and these functions
 * validate + track state around those calls.
 */

import { decodeContainer, extractXml } from "./save-decode.server";

export type FreshBackupMeta = {
  serial: string;
  cityPath: string;
  /** Null when the install never created a login file — backup still works. */
  localPath: string | null;
  oldCityId: string;
  oldLevel: number;
  hasLoginBackup: boolean;
};

/** Minimal session shape: the real Session satisfies this structurally. */
export type FreshSession = {
  id: string;
  freshBackupCity?: string | null;
  freshBackupLocal?: string | null;
  freshBackupMeta?: FreshBackupMeta | null;
};

export type FreshBackupInput = {
  serial: string;
  cityPath: string;
  /** Optional: some installs never create mLocalInfo.xml. */
  localPath?: string | null;
  cityB64: string;
  localB64?: string | null;
};

const B64_MAX = 24_000_000;

/**
 * Decode any container wrapper (x79, x54, x53, x7d, gzip, PLXE, or plain XML)
 * and return the raw XML text. Rejects shell-error text that ADB merges into stdout.
 */
function decodeToXml(label: string, b64: string): string {
  if (!b64 || b64.length > B64_MAX) throw new Error(`${label} is invalid`);
  const buf = Buffer.from(String(b64), "base64");
  if (!buf.length) throw new Error(`${label} is empty`);

  // Shell-error guard first (same as save-decode.shellErrorMessage): diagnostics
  // are plain text; real containers have NUL/control bytes.
  const head = buf.subarray(0, 512);
  let isShellText = true;
  for (const b of head) {
    if (b === 0) { isShellText = false; break; }
    if (b < 9 || (b > 13 && b < 32)) { isShellText = false; break; }
  }
  if (isShellText) {
    const text = head.toString("utf8").replace(/^\uFEFF/, "");
    if (!text.trimStart().startsWith("<")) {
      throw new Error(`${label} is not a save file (looks like shell output)`);
    }
  }

  // Try container decode first (handles x79, x54, x53, x7d, gzip, PLXE).
  const decoded = decodeContainer(buf);
  const xml = decoded ? extractXml(decoded) : extractXml(buf);
  if (!xml) throw new Error(`${label}: could not extract XML from container`);
  return xml;
}

function parseCityId(xmlText: string): string {
  // 1) AWS tag - multiple possible attribute names (game uses different ones across builds)
  const aws = xmlText.match(/<AWS\b([^>]*)>/i)?.[1] ?? "";
  for (const attr of ["cityId", "city_id", "fromId", "id", "SaveId", "userId", "UserId", "PlayerId"]) {
    const m = aws.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i"));
    if (m?.[1]?.trim()) return m[1].trim();
  }

  // 2) Version tag (some builds put it here)
  const ver = xmlText.match(/<Version\b([^>]*?)\/?>/i)?.[1] ?? "";
  for (const attr of ["cityId", "city_id", "fromId", "id", "SaveId", "userId", "UserId", "PlayerId"]) {
    const m = ver.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i"));
    if (m?.[1]?.trim()) return m[1].trim();
  }

  // 3) Var elements - multiple possible variable names the game uses for the city/player id
  const varNames = ["cityId", "SaveId", "userId", "UserId", "PlayerId", "city_id", "fromId", "id"];
  for (const name of varNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m1 = xmlText.match(new RegExp(`<Var\\b[^>]*\\bname="${escaped}"[^>]*\\bv="([^"]*)"`, "i"));
    if (m1?.[1]?.trim()) return m1[1].trim();
    const m2 = xmlText.match(new RegExp(`<Var\\b[^>]*\\bv="([^"]*)"[^>]*\\bname="${escaped}"`, "i"));
    if (m2?.[1]?.trim()) return m2[1].trim();
  }

  // 4) Last resort: any attribute that looks like a city id in the first 2KB (covers weird layouts)
  const head = xmlText.slice(0, 2048);
  const loose = head.match(/\b(?:city[_-]?id|save[_-]?id|player[_-]?id|user[_-]?id|from[_-]?id)\s*=\s*"([A-Za-z0-9_-]{4,})"/i);
  if (loose?.[1]?.trim()) return loose[1].trim();

  return "";
}

function parseLevel(xmlText: string): number {
  const v =
    xmlText.match(/<Var\b[^>]*?\bname="levelup"[^>]*?\bv="([^"]*)"/i)?.[1] ??
    xmlText.match(/<Var\b[^>]*?\bv="([^"]*)"[^>]*?\bname="levelup"/i)?.[1] ??
    "";
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function textOf(buf: Buffer): string {
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

function requireBackup(s: FreshSession): { cityB64: string; localB64: string | null; meta: FreshBackupMeta } {
  if (!s.freshBackupCity || !s.freshBackupMeta) {
    throw new Error("Backup first");
  }
  return { cityB64: s.freshBackupCity, localB64: s.freshBackupLocal ?? null, meta: s.freshBackupMeta };
}

function requireSerial(serial: string): string {
  const v = String(serial || "").trim();
  if (!v) throw new Error("Device serial required");
  return v;
}

function requireDevicePath(label: string, p: string): string {
  const v = String(p || "").trim();
  if (!v || !v.startsWith("/")) throw new Error(`${label} path is invalid`);
  return v;
}

export function backupFreshStartState(s: FreshSession, input: FreshBackupInput) {
  const serial = requireSerial(input.serial);
  const cityPath = requireDevicePath("City file", input.cityPath);
  const cityXml = decodeToXml("City file", input.cityB64);
  // mLocalInfo is optional — some installs never create it (the app's connect
  // flow already treats it as optional). Backup proceeds on the city file
  // alone; wipe/restore then touch only what was actually backed up.
  let localPath: string | null = null;
  let hasLoginBackup = false;
  const rawLocalPath = String(input.localPath ?? "").trim();
  const rawLocalB64 = String(input.localB64 ?? "");
  if (rawLocalPath && rawLocalB64) {
    localPath = requireDevicePath("Login file", rawLocalPath);
    decodeToXml("Login file", rawLocalB64); // validate only
    hasLoginBackup = true;
  }
  const oldCityId = parseCityId(cityXml);
  if (!oldCityId) throw new Error("Backup invalid: no city id");
  const oldLevel = parseLevel(cityXml);
  s.freshBackupCity = input.cityB64;
  s.freshBackupLocal = hasLoginBackup ? rawLocalB64 : null;
  s.freshBackupMeta = { serial, cityPath, localPath, oldCityId, oldLevel, hasLoginBackup };
  return { oldCityId, oldLevel, backedUp: true as const, hasLoginBackup };
}

export function wipeFreshStartPlan(s: FreshSession) {
  const b = requireBackup(s);
  const paths = b.meta.localPath ? [b.meta.cityPath, b.meta.localPath] : [b.meta.cityPath];
  return { serial: b.meta.serial, paths, ready: true as const };
}

export function verifyFreshStartState(s: FreshSession, cityB64: string) {
  const b = requireBackup(s);
  const cityXml = decodeToXml("Fresh city file", cityB64);
  const newCityId = parseCityId(cityXml);
  if (!newCityId) throw new Error("Fresh city has no id");
  if (newCityId === b.meta.oldCityId) throw new Error("Same city — wipe did not happen");
  const level = parseLevel(cityXml);
  if (level !== 1) throw new Error("Not level 1");
  return { newCityId, level: 1 as const, clean: true as const };
}

export function restoreFreshStartState(s: FreshSession) {
  const b = requireBackup(s);
  return {
    cityB64: b.cityB64,
    localB64: b.localB64,
    cityPath: b.meta.cityPath,
    localPath: b.meta.localPath,
    serial: b.meta.serial,
    hasLoginBackup: b.meta.hasLoginBackup,
  };
}
