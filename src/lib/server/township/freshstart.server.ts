/**
 * Fresh-start ("New Game") helpers for a city-banned account.
 *
 * File operations only: this module validates pulled bytes, parses the
 * city id + level out of them, and tracks the backup on the session. It
 * never edits save XML. ADB itself lives in the desktop client — the UI
 * pulls/pushes/deletes through the native bridge, and these functions
 * validate + track state around those calls.
 */

import { decodeContainer } from "./save-decode.server";

export type FreshBackupMeta = {
  serial: string;
  cityPath: string;
  localPath: string;
  oldCityId: string;
  oldLevel: number;
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
  localPath: string;
  cityB64: string;
  localB64: string;
};

const B64_MAX = 24_000_000;

function mustCityBytes(label: string, b64: string): Buffer {
  if (!b64 || b64.length > B64_MAX) throw new Error(`${label} is invalid`);
  const buf = Buffer.from(String(b64), "base64");
  if (!buf.length) throw new Error(`${label} is empty`);
  // Same shell-error guard as pull: a failed remote command still exits 0
  // and puts its stderr on stdout, so error text must never pass as a file.
  // The city file is always plain XML.
  const head = buf.subarray(0, 256).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (!head.startsWith("<")) throw new Error(`${label} is not a save file`);
  return buf;
}

function mustLoginBytes(label: string, b64: string): Buffer {
  if (!b64 || b64.length > B64_MAX) throw new Error(`${label} is invalid`);
  const buf = Buffer.from(String(b64), "base64");
  if (!buf.length) throw new Error(`${label} is empty`);
  // mLocalInfo ships wrapped in one of several containers (see
  // save-decode.server.ts), so plain "<" is sufficient but not required —
  // anything undecodable that isn't XML is still rejected as shell text.
  const head = buf.subarray(0, 256).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<") || decodeContainer(buf)) return buf;
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

function requireBackup(s: FreshSession): { cityB64: string; localB64: string; meta: FreshBackupMeta } {
  if (!s.freshBackupCity || !s.freshBackupLocal || !s.freshBackupMeta) {
    throw new Error("Backup first");
  }
  return { cityB64: s.freshBackupCity, localB64: s.freshBackupLocal, meta: s.freshBackupMeta };
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
  const localPath = requireDevicePath("Login file", input.localPath);
  const cityBuf = mustCityBytes("City file", input.cityB64);
  mustLoginBytes("Login file", input.localB64);
  const xmlText = textOf(cityBuf);
  const oldCityId = parseCityId(xmlText);
  if (!oldCityId) throw new Error("Backup invalid: no city id");
  const oldLevel = parseLevel(xmlText);
  s.freshBackupCity = input.cityB64;
  s.freshBackupLocal = input.localB64;
  s.freshBackupMeta = { serial, cityPath, localPath, oldCityId, oldLevel };
  return { oldCityId, oldLevel, backedUp: true as const };
}

export function wipeFreshStartPlan(s: FreshSession) {
  const b = requireBackup(s);
  return { serial: b.meta.serial, paths: [b.meta.cityPath, b.meta.localPath], ready: true as const };
}

export function verifyFreshStartState(s: FreshSession, cityB64: string) {
  const b = requireBackup(s);
  const buf = mustCityBytes("Fresh city file", cityB64);
  const xmlText = textOf(buf);
  const newCityId = parseCityId(xmlText);
  if (!newCityId) throw new Error("Fresh city has no id");
  if (newCityId === b.meta.oldCityId) throw new Error("Same city — wipe did not happen");
  const level = parseLevel(xmlText);
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
  };
}
