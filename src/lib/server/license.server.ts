import { createHmac } from "node:crypto";
import { fingerprintKey, openToken, sealToken, deviceWrapKey } from "./crypto.server";
import {
  deleteLicenseRow,
  licensesPersisted,
  loadLicenseRowsBounded,
  saveLicenseRow,
} from "./license-store.server";

export type Plan = "trial" | "week" | "month" | "year" | "lifetime" | "custom";

export type License = {
  key: string;
  fp: string;
  plan: Plan;
  createdAt: number;
  expiresAt: number;
  durationMs: number;
  group: boolean;
  maxDevices: number;
  devices: string[];
  boundDevice: string | null;
  active: boolean;
  admin: boolean;
  note: string;
};

export type LicenseSnap = {
  plan: Plan;
  group: boolean;
  lifetime: boolean;
  expiresAt: number;
  remainingMs: number;
  maxDevices: number;
  status: "active" | "expired" | "revoked";
  admin: boolean;
};

export type LicenseRecord = LicenseSnap & {
  key: string;
  boundDevice: string | null;
  devices: string[];
  note: string;
  createdAt: number;
};

const MS = {
  trial: 30 * 60 * 1000,
  week: 7 * 86400000,
  month: 30 * 86400000,
  year: 365 * 86400000,
  lifetime: 0,
};

const byFp = new Map<string, License>();
const byKey = new Map<string, string>();
const feedback: { at: number; deviceId: string; remainingMs: number; lifetime: boolean; message: string }[] = [];

function now() {
  return Date.now();
}

function norm(key: string) {
  return key.trim();
}

function uglyKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () => Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `IGG-${group()}-${group()}-${group()}-${group()}`;
}

function stableBoundKey(deviceId: string) {
  const secret = (process.env.IGG_VIP_MASTER?.trim() || "igg-vip-dev-placeholder");
  const raw = createHmac("sha256", secret).update(`license-bound:${deviceId.trim().toUpperCase()}`).digest("hex").toUpperCase();
  return `IGG-${raw.slice(0,5)}-${raw.slice(5,10)}-${raw.slice(10,15)}-${raw.slice(15,20)}`;
}

function durationFor(plan: Plan, days?: number, hours?: number) {
  if (plan === "lifetime") return 0;
  if (plan === "custom") {
    const d = Math.max(0, Number(days) || 0);
    const h = Math.max(0, Number(hours) || 0);
    const ms = d * 86400000 + h * 3600000;
    if (ms <= 0) throw new Error("Custom duration must be > 0");
    return ms;
  }
  return MS[plan];
}

function remainingOf(lic: License) {
  if (!lic.active) return 0;
  if (lic.expiresAt === 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, lic.expiresAt - now());
}

function statusOf(lic: License): LicenseSnap["status"] {
  if (!lic.active) return "revoked";
  if (lic.expiresAt && now() >= lic.expiresAt) return "expired";
  return "active";
}

function publicSnap(lic: License): LicenseSnap {
  const rem = remainingOf(lic);
  return {
    plan: lic.plan,
    group: lic.group,
    lifetime: lic.expiresAt === 0,
    expiresAt: lic.expiresAt,
    remainingMs: Number.isFinite(rem) ? rem : 0,
    maxDevices: lic.maxDevices,
    status: statusOf(lic),
    admin: lic.admin,
  };
}

function adminSnap(lic: License): LicenseRecord {
  return {
    ...publicSnap(lic),
    key: lic.key,
    boundDevice: lic.boundDevice,
    devices: [...lic.devices],
    note: lic.note,
    createdAt: lic.createdAt,
  };
}

function put(lic: License) {
  byFp.set(lic.fp, lic);
  byKey.set(lic.key.toLowerCase(), lic.fp);
}

function makeLic(partial: Omit<License, "fp">): License {
  return { ...partial, fp: fingerprintKey(partial.key) };
}

function ownerKey() {
  const env = process.env.IGG_VIP_OWNER?.trim();
  if (env && env.length >= 12) return env;
  return "IGG-OWNER-PREVIEW";
}

function seed() {
  const t0 = now();
  put(
    makeLic({
      key: ownerKey(),
      plan: "lifetime",
      createdAt: t0,
      expiresAt: 0,
      durationMs: 0,
      group: true,
      maxDevices: 99,
      devices: [],
      boundDevice: null,
      active: true,
      admin: true,
      note: "Owner",
    }),
  );
}
seed();

/** A copy that can be handed back to `put()` if the database write fails. */
function snapshot(lic: License): License {
  return { ...lic, devices: [...lic.devices] };
}

/** Forget a key entirely — the in-memory half of a delete. */
function drop(lic: License) {
  byFp.delete(lic.fp);
  const k = lic.key.toLowerCase();
  if (byKey.get(k) === lic.fp) byKey.delete(k);
}

/**
 * Write one key to the durable store. The owner key is never stored: it is
 * re-seeded from IGG_VIP_OWNER on every boot, it cannot be deleted, and there
 * is no reason to keep another copy of it in a database.
 */
async function persist(lic: License) {
  if (lic.admin) return;
  await saveLicenseRow({
    licenseKey: lic.key,
    keyFp: lic.fp,
    plan: lic.plan,
    createdAt: lic.createdAt,
    expiresAt: lic.expiresAt,
    durationMs: lic.durationMs,
    isGroup: lic.group,
    maxDevices: lic.maxDevices,
    devices: [...lic.devices],
    boundDevice: lic.boundDevice,
    isActive: lic.active,
    note: lic.note,
  });
}

/**
 * Undo an in-memory change after the store rejected it, then rethrow.
 *
 * Annotated `never` so the compiler knows execution stops here: the callers
 * fall through to a success return otherwise, and reporting an issue that the
 * database refused is exactly the false success this exists to prevent.
 */
function rollback(lic: License, before: License | null, action: string): never {
  if (before) {
    put(before);
    throw new Error(`${action} — the key was left as it was.`);
  }
  // never stored, and in the new-key path never published to the Maps either
  drop(lic);
  throw new Error(`${action} — no key was created.`);
}

/**
 * Boot-time hydration of the in-memory cache from the database.
 *
 * Runs as a top-level await, which is the point: ESM blocks every importer
 * until this module finishes evaluating, so no request can reach
 * `verifyLicenseKey()` before the stored keys are loaded. A lazy or
 * fire-and-forget load would leave a window after every restart in which a
 * client's perfectly good key answers "Invalid key" — the exact failure this
 * table exists to remove.
 *
 * A failure here must not stop the server: the owner key still seeds from
 * memory, so the Control panel stays reachable and the problem is visible
 * rather than a blank page.
 */
async function hydrateLicenses(): Promise<void> {
  if (!licensesPersisted()) return;
  try {
    const rows = await loadLicenseRowsBounded();
    for (const r of rows) {
      if (r.licenseKey === ownerKey()) continue; // never shadow the owner key
      put(
        makeLic({
          key: r.licenseKey,
          plan: r.plan as Plan,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          durationMs: r.durationMs,
          group: r.isGroup,
          maxDevices: r.maxDevices,
          devices: r.devices,
          boundDevice: r.boundDevice,
          active: r.isActive,
          admin: false,
          note: r.note,
        }),
      );
    }
  } catch (err) {
    console.error(
      "[license] could not load stored keys — starting with none for this boot:",
      err instanceof Error ? err.message : err,
    );
  }
}
await hydrateLicenses();

function findLicense(key: string) {
  const k = norm(key);
  if (!k) return null;
  const fp = byKey.get(k.toLowerCase());
  if (fp) return byFp.get(fp) ?? null;
  return byFp.get(fingerprintKey(k)) ?? null;
}

export function verifyLicenseKey(key: string, deviceId: string) {
  const lic = findLicense(key);
  if (!lic) throw new Error("Invalid key");
  if (!lic.active) throw new Error("Key revoked");
  const st = statusOf(lic);
  if (st === "expired") throw new Error("Key expired — restore to add time");
  const dev = deviceId.trim().toUpperCase();
  if (!dev) throw new Error("Device id required");
  if (lic.group) {
    if (!lic.devices.includes(dev)) {
      if (lic.devices.length >= lic.maxDevices) throw new Error("Group key is full");
      lic.devices.push(dev);
    }
  } else {
    if (lic.boundDevice && lic.boundDevice !== dev) {
      throw new Error("Key locked to another device");
    }
    if (!lic.boundDevice) {
      lic.boundDevice = dev;
      lic.devices = [dev];
    }
  }
  const token = sealToken({ keyFp: lic.fp, deviceId: dev });
  return { ok: true as const, token, deviceId: dev, license: publicSnap(lic) };
}

export function requireToken(token: string, deviceId?: string) {
  const payload = openToken(token);
  const lic = byFp.get(payload.k);
  if (!lic || statusOf(lic) !== "active") throw new Error("License expired");
  if (payload.bind !== deviceWrapKey(payload.d)) throw new Error("Not licensed");
  if (deviceId && payload.d !== deviceId.trim().toUpperCase()) {
    throw new Error("Token/device mismatch");
  }
  if (lic.group) {
    if (!lic.devices.includes(payload.d)) throw new Error("Device not on this key");
  } else if (lic.boundDevice && lic.boundDevice !== payload.d) {
    throw new Error("Key locked to another device");
  }
  return { token: payload, license: lic, snap: publicSnap(lic) };
}

export function licenseStatus(token: string) {
  const { snap } = requireToken(token);
  return snap;
}

export async function issueLicense(
  token: string,
  p: {
    plan: Plan;
    customKey?: string;
    days?: number;
    hours?: number;
    group?: boolean;
    maxDevices?: number;
    note?: string;
    bindDevice?: string;
  },
) {
  const { license: actor } = requireToken(token);
  if (!actor.admin) throw new Error("Admin key required");
  const durationMs = durationFor(p.plan, p.days, p.hours);
  const bound = p.bindDevice?.trim().toUpperCase() || "";
  let key = norm(p.customKey ?? "");

  // A normal single-device license is stable for the machine: re-issuing a
  // license for the same bound device reuses the old key instead of minting a
  // second random key. This also makes "create again" behave like a renewal.
  if (!p.group && !key && bound) {
    const existing = [...byFp.values()].find((lic) => !lic.group && lic.boundDevice === bound);
    if (existing) {
      const before = snapshot(existing);
      existing.active = true;
      existing.plan = p.plan;
      if (durationMs === 0) {
        existing.expiresAt = 0;
        existing.durationMs = 0;
        existing.plan = "lifetime";
      } else if (existing.expiresAt !== 0) {
        const base = Math.max(now(), existing.expiresAt);
        existing.expiresAt = base + durationMs;
        existing.durationMs += durationMs;
      }
      if (p.note !== undefined) existing.note = String(p.note).trim();
      try {
        await persist(existing);
      } catch {
        rollback(existing, before, "Could not store the renewed key");
      }
      return adminSnap(existing);
    }
  }

  if (!key) key = bound ? stableBoundKey(bound) : uglyKey();
  if (findLicense(key)) throw new Error("Key already exists");
  const t0 = now();
  const lic = makeLic({
    key,
    plan: p.plan,
    createdAt: t0,
    expiresAt: durationMs === 0 ? 0 : t0 + durationMs,
    durationMs,
    group: Boolean(p.group),
    maxDevices: p.group ? Math.max(2, Math.floor(Number(p.maxDevices) || 5)) : 1,
    devices: [],
    boundDevice: p.group ? null : p.bindDevice?.trim().toUpperCase() || null,
    active: true,
    admin: false,
    note: (p.note ?? "").trim(),
  });
  if (lic.boundDevice) lic.devices = [lic.boundDevice];
  // Store before publishing: a key that exists only in memory would look
  // issued to the owner and then disappear on the next restart.
  try {
    await persist(lic);
  } catch {
    rollback(lic, null, "Could not store the new key");
  }
  put(lic);
  return adminSnap(lic);
}

export async function restoreLicense(
  token: string,
  p: { key: string; plan?: Plan; days?: number; hours?: number },
) {
  const { license: actor } = requireToken(token);
  if (!actor.admin) throw new Error("Admin key required");
  const lic = findLicense(p.key);
  if (!lic) throw new Error("Unknown key");
  const before = snapshot(lic);
  const plan = p.plan ?? lic.plan;
  const add = durationFor(plan === "custom" ? "custom" : plan, p.days, p.hours);
  lic.active = true;
  lic.plan = plan;
  if (add === 0) {
    lic.expiresAt = 0;
    lic.durationMs = 0;
    lic.plan = "lifetime";
  } else if (lic.expiresAt === 0) {
    /* lifetime stays lifetime */
  } else {
    const base = Math.max(now(), lic.expiresAt);
    lic.expiresAt = base + add;
    lic.durationMs += add;
  }
  try {
    await persist(lic);
  } catch {
    rollback(lic, before, "Could not store the restored key");
  }
  return adminSnap(lic);
}

/**
 * Permanently delete a key.
 *
 * This is a delete, not a revocation: the record is removed outright so the
 * string stops resolving at all. A client who pastes it gets "Invalid key"
 * from `verifyLicenseKey`, and every session already unlocked with it dies on
 * its next call to `requireToken` — which looks up the same missing record.
 *
 * The row is removed from the database BEFORE the in-memory copy, so a failed
 * write leaves a key that is still listed and still unlockable and the owner
 * can simply retry. The other order would leave the worst of both: gone from
 * the panel, still opening the client.
 *
 * The owner key cannot be deleted — it would lock the Control panel until the
 * next restart, and it is re-seeded from IGG_VIP_OWNER anyway.
 */
export async function deleteLicense(token: string, key: string) {
  const { license: actor } = requireToken(token);
  if (!actor.admin) throw new Error("Admin key required");
  const lic = findLicense(key);
  if (!lic) throw new Error("Unknown key");
  if (lic.admin) throw new Error("The owner key cannot be deleted");
  await deleteLicenseRow(lic.key);
  drop(lic);
  return { ok: true as const, key: lic.key };
}

export function listLicenses(token: string) {
  const { license: actor } = requireToken(token);
  if (!actor.admin) throw new Error("Admin key required");
  return [...byFp.values()].map(adminSnap).sort((a, b) => b.createdAt - a.createdAt);
}

export function submitFeedback(token: string, message: string) {
  const { token: tkn, snap: s } = requireToken(token);
  const text = message.trim();
  if (text.length < 2) throw new Error("Write a short message");
  feedback.push({
    at: now(),
    deviceId: tkn.d,
    remainingMs: s.lifetime ? 0 : s.remainingMs,
    lifetime: s.lifetime,
    message: text.slice(0, 2000),
  });
  return { ok: true as const, remainingMs: s.remainingMs, lifetime: s.lifetime, count: feedback.length };
}

export function listFeedback(token: string) {
  const { license: actor } = requireToken(token);
  if (!actor.admin) throw new Error("Admin key required");
  return feedback.slice(-50).reverse();
}
