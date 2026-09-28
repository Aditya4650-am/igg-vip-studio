/**
 * Fresh-start ("New Account") helpers for a city-banned account.
 *
 * A ban outlives the two city files: login/account state lives in
 * `shared_prefs/` + `databases/`, the device keeps its Android ID, and cloud
 * backup can resurrect the banned city. So this flow backs up EVERYTHING
 * (city + login + discovered extras), wipes the full set, resets the Android
 * ID, and verifies the relaunched game minted a genuinely new level-1 city
 * under a new device id — with one-click restore when anything looks wrong.
 *
 * File operations only: validates pulled bytes, parses ids, tracks the
 * backup on the session. ADB itself lives in the desktop client — the UI
 * pulls/pushes/deletes/reads through the native bridge; these functions
 * validate + track state around those calls. Never edits save XML.
 */

import { decodeContainer, shellErrorMessage } from "./save-decode.server";
import { decryptStream, postProcessDecrypt } from "./crypto.server";

export type FreshBackupMeta = {
  serial: string;
  cityPath: string;
  localPath: string;
  extraPaths: string[];
  oldCityId: string;
  oldLevel: number;
  oldAndroidId: string;
  oldGsfId: string;
};

/** Minimal session shape: the real Session satisfies this structurally. */
export type FreshSession = {
  id: string;
  freshBackupCity?: string | null;
  freshBackupLocal?: string | null;
  freshBackupExtra?: Record<string, string> | null;
  freshBackupMeta?: FreshBackupMeta | null;
  freshVerified?: { newCityId: string; newAndroidId: string } | null;
};

export type FreshBackupInput = {
  serial: string;
  cityPath: string;
  localPath: string;
  cityB64: string;
  localB64: string;
  extraFiles?: { path: string; b64: string }[];
  androidId?: string;
  gsfId?: string;
};

export type FreshVerifyInput = {
  cityB64: string;
  androidId?: string;
  gsfAndroidId?: string;
};

const B64_MAX = 24_000_000;

function shellText(buf: Buffer): string {
  return buf.subarray(0, 256).toString("utf8").replace(/^\uFEFF/, "").trimStart();
}

function mustCityBytes(label: string, b64: string): Buffer {
  if (!b64 || b64.length > B64_MAX) throw new Error(`${label} is invalid`);
  const buf = Buffer.from(String(b64), "base64");
  if (!buf.length) throw new Error(`${label} is empty`);
  // Same shell-error guard as pull: a failed remote command still exits 0
  // and puts its stderr on stdout, so error text must never pass as a file.
  if (shellErrorMessage(buf)) throw new Error(`${label} is not a save file`);
  if (!buf.length) throw new Error(`${label} is empty`);
  return buf;
}

/**
 * Open a pulled city file exactly like a session load does: plain XML passes
 * through, Township container variants (0x79/0x54/0x53/0x7d/gzip/PLXE) are
 * unwrapped. The device usually stores the wrapped form while exports are
 * plain XML — rejecting the wrapped form is what broke backup on real
 * devices with "City file is not a save file".
 */
function openCityXml(label: string, b64: string): string {
  const buf = mustCityBytes(label, b64);
  const head = shellText(buf);
  if (head.startsWith("<")) return textOf(buf);
  if (buf.length < 64) throw new Error(`${label} is not a save file`);
  let dec: Buffer;
  try {
    dec = decryptStream(buf);
  } catch {
    throw new Error(`${label} is not a save file`);
  }
  const { xml, kind } = postProcessDecrypt(dec);
  if (kind === "raw") throw new Error(`${label} is not a save file`);
  return xml.toString("utf8").replace(/^\uFEFF/, "");
}

function mustLoginBytes(label: string, b64: string): Buffer {
  if (!b64 || b64.length > B64_MAX) throw new Error(`${label} is invalid`);
  const buf = Buffer.from(String(b64), "base64");
  if (!buf.length) throw new Error(`${label} is empty`);
  // mLocalInfo ships wrapped in one of several containers (see
  // save-decode.server.ts), so plain "<" is sufficient but not required —
  // anything undecodable that isn't XML is still rejected as shell text.
  if (shellText(buf).startsWith("<") || decodeContainer(buf)) return buf;
  throw new Error(`${label} is not a save file`);
}

function mustExtraBytes(label: string, b64: string): Buffer {
  if (!b64 || b64.length > B64_MAX) throw new Error(`${label} is invalid`);
  const buf = Buffer.from(String(b64), "base64");
  if (!buf.length) throw new Error(`${label} is empty`);
  // Extras are shared_prefs XML, SQLite databases, or containers — never
  // shell chatter. Accept known magics only.
  const head = shellText(buf);
  if (head.startsWith("<")) return buf;
  if (buf.subarray(0, 16).toString("ascii").startsWith("SQLite format 3")) return buf;
  if (decodeContainer(buf)) return buf;
  throw new Error(`${label} is not a save file`);
}

function parseCityId(xmlText: string): string {
  const aws = xmlText.match(/<AWS\b([^>]*)>/i)?.[1] ?? "";
  const fromAws = aws.match(/\bcityId="([^"]*)"/i)?.[1] ?? "";
  if (fromAws) return fromAws;
  return (
    xmlText.match(/<Var\b[^>]*?\bname="cityId"[^>]*?\bv="([^"]*)"/i)?.[1] ??
    xmlText.match(/<Var\b[^>]*?\bv="([^"]*)"[^>]*?\bname="cityId"/i)?.[1] ??
    ""
  );
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

function requireBackup(s: FreshSession): {
  cityB64: string;
  localB64: string;
  extra: Record<string, string>;
  meta: FreshBackupMeta;
} {
  if (!s.freshBackupCity || !s.freshBackupLocal || !s.freshBackupMeta) {
    throw new Error("Backup first");
  }
  return {
    cityB64: s.freshBackupCity,
    localB64: s.freshBackupLocal,
    extra: s.freshBackupExtra ?? {},
    meta: s.freshBackupMeta,
  };
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

function cleanAndroidId(v: string | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

/**
 * Extra-file triage by basename. Transient SQLite journals (`-shm`/`-wal`/
 * `-journal`) are memory-mapped scratch state: backing them up is pointless
 * and restoring them over a fresh database risks corruption — but they MUST
 * be wiped, because a stale WAL can resurrect pre-wipe rows. Google
 * telemetry files (`com.google.*`) regenerate on next sync; same treatment.
 * Everything else is backed up byte-for-byte.
 */
function extraKeep(basename: string): boolean {
  const b = basename.toLowerCase();
  if (b.endsWith("-shm") || b.endsWith("-wal") || b.endsWith("-journal")) return false;
  if (b.startsWith("com.google.") || b.startsWith("com.google.android.")) return false;
  return true;
}

export function backupFreshStartState(s: FreshSession, input: FreshBackupInput) {
  const serial = requireSerial(input.serial);
  const cityPath = requireDevicePath("City file", input.cityPath);
  const localPath = requireDevicePath("Login file", input.localPath);
  mustLoginBytes("Login file", input.localB64);
  const xmlText = openCityXml("City file", input.cityB64);
  const oldCityId = parseCityId(xmlText);
  if (!oldCityId) throw new Error("Backup invalid: no city id");
  const oldLevel = parseLevel(xmlText);
  const extraPaths: string[] = [];
  const extra: Record<string, string> = {};
  let skippedCount = 0;
  for (const f of input.extraFiles ?? []) {
    const p = requireDevicePath("Extra file", f.path);
    if (p === cityPath || p === localPath || extraPaths.includes(p)) {
      throw new Error(`Extra file duplicates a backup path: ${p}`);
    }
    extraPaths.push(p);
    const base = p.split("/").pop() ?? p;
    if (!extraKeep(base)) {
      skippedCount += 1;
      continue;
    }
    mustExtraBytes(`Extra file ${p}`, f.b64);
    extra[p] = f.b64;
  }
  s.freshBackupCity = input.cityB64;
  s.freshBackupLocal = input.localB64;
  s.freshBackupExtra = extra;
  s.freshBackupMeta = {
    serial,
    cityPath,
    localPath,
    extraPaths,
    oldCityId,
    oldLevel,
    oldAndroidId: cleanAndroidId(input.androidId),
    oldGsfId: cleanAndroidId(input.gsfId),
  };
  s.freshVerified = null;
  return { oldCityId, oldLevel, extraCount: extraPaths.length - skippedCount, skippedCount, backedUp: true as const };
}

export function wipeFreshStartPlan(s: FreshSession) {
  const b = requireBackup(s);
  return {
    serial: b.meta.serial,
    paths: [b.meta.cityPath, b.meta.localPath, ...b.meta.extraPaths],
    ready: true as const,
  };
}

export function verifyFreshStartState(s: FreshSession, input: FreshVerifyInput) {
  const b = requireBackup(s);
  const xmlText = openCityXml("Fresh city file", input.cityB64);
  const newCityId = parseCityId(xmlText);
  if (!newCityId) throw new Error("Fresh city has no id");
  if (newCityId === b.meta.oldCityId) throw new Error("Same city — wipe did not take effect, or cloud/account restore brought it back");
  const level = parseLevel(xmlText);
  if (level !== 1) throw new Error("Not level 1");
  const newAndroidId = cleanAndroidId(input.androidId);
  const newGsfId = cleanAndroidId(input.gsfAndroidId);
  const androidChanged = Boolean(b.meta.oldAndroidId && newAndroidId && newAndroidId !== b.meta.oldAndroidId);
  const gsfChanged = Boolean(b.meta.oldGsfId && newGsfId && newGsfId !== b.meta.oldGsfId);
  // A new city under an unchanged device identity gets re-linked to the ban,
  // so pass when EITHER hardware id moved. Refuse only when both are known
  // and neither moved — and say exactly which id is stuck, so the toast is
  // a diagnosis, not a dead end.
  const androidStuck = Boolean(b.meta.oldAndroidId && newAndroidId && newAndroidId === b.meta.oldAndroidId);
  const gsfStuck = Boolean(b.meta.oldGsfId && newGsfId && newGsfId === b.meta.oldGsfId);
  const short = (v: string) => (v ? `${v.slice(0, 8)}…` : "unknown");
  if (!androidChanged && !gsfChanged && (androidStuck || gsfStuck || b.meta.oldAndroidId)) {
    const gsfPart =
      b.meta.oldGsfId || newGsfId
        ? `, GSF ${short(b.meta.oldGsfId)}=${short(newGsfId)}${gsfStuck ? " (stuck)" : ""}`
        : "";
    throw new Error(
      `Device identity unchanged — Android ${short(b.meta.oldAndroidId)}=${short(newAndroidId)}${androidStuck ? " (stuck)" : ""}${gsfPart} — the ban will follow the new city`,
    );
  }
  s.freshVerified = { newCityId, newAndroidId };
  return {
    newCityId,
    level: 1 as const,
    androidReset: androidChanged,
    gsfReset: gsfChanged,
    clean: true as const,
  };
}

export function restoreFreshStartState(s: FreshSession) {
  const b = requireBackup(s);
  return {
    cityB64: b.cityB64,
    localB64: b.localB64,
    extra: b.extra,
    cityPath: b.meta.cityPath,
    localPath: b.meta.localPath,
    serial: b.meta.serial,
  };
}
