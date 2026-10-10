import type { Sql } from "@/lib/db";

/**
 * Durable storage for license keys.
 *
 * `license.server.ts` keeps keys in two in-memory Maps so that
 * `verifyLicenseKey()` and `requireToken()` stay synchronous — every caller in
 * the request path relies on that. This module is the write-through store
 * behind those Maps: what is here survives a process restart, and what is
 * deleted here stays deleted.
 *
 * Storage is Postgres only. That is a deliberate choice, not an oversight:
 * Render's free plan has **no persistent disk**, so a local JSON file would be
 * wiped on every cold start and would silently fail at the one thing it was
 * added for. A database is the only storage that survives a redeploy there.
 * Without `DATABASE_URL` the app falls back to the in-memory PGLite, which has
 * the same lifetime as the Maps themselves, so writing to it would be motion
 * without effect — persistence is therefore switched off entirely and
 * behaviour is exactly what it was before this module existed.
 *
 * Every function here is a no-op unless `LICENSE_STORE === "postgres"`.
 *
 * `@/lib/db` is imported **lazily**, inside the functions, and the switch is
 * read straight off the environment. Importing it at module scope would run its
 * PGLite bootstrap on load, and that bootstrap uses `import.meta.glob`, which
 * only exists under Vite — so a plain `node --test` process would die with
 * `glob is not a function` on a module that, with no DATABASE_URL, was never
 * going to touch a database at all.
 */

// Same predicate db.ts uses to pick Neon over PGLite, so the two can never
// disagree about whether a real database is configured.
export const LICENSE_STORE: "postgres" | "memory" =
  typeof process !== "undefined" && process.env.DATABASE_URL?.trim() ? "postgres" : "memory";

export const licensesPersisted = () => LICENSE_STORE === "postgres";

/** The shared SQL client, loaded only when there is a database to talk to. */
async function getSql(): Promise<Sql> {
  const { getSql: open } = await import("@/lib/db");
  return open();
}

/** One persisted license. Mirrors the `licenses` table in migrations/0002. */
export type LicenseRow = {
  licenseKey: string;
  keyFp: string;
  plan: string;
  createdAt: number;
  expiresAt: number;
  durationMs: number;
  isGroup: boolean;
  maxDevices: number;
  devices: string[];
  boundDevice: string | null;
  isActive: boolean;
  note: string;
};

/** Never let a dead database stop the server from booting with a usable owner key. */
const LOAD_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Every stored key, for hydrating the in-memory cache at boot. */
export async function loadLicenseRows(): Promise<LicenseRow[]> {
  if (!licensesPersisted()) return [];
  const sql = await getSql();
  const rows = await sql.query<{
    license_key: string;
    key_fp: string;
    plan: string;
    created_at: number;
    expires_at: number;
    duration_ms: number;
    is_group: boolean;
    max_devices: number;
    devices: unknown;
    bound_device: string | null;
    is_active: boolean;
    note: string;
  }>("select * from licenses");
  return rows.map((r) => ({
    licenseKey: r.license_key,
    keyFp: r.key_fp,
    plan: r.plan,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    durationMs: Number(r.duration_ms),
    isGroup: Boolean(r.is_group),
    maxDevices: Number(r.max_devices),
    // jsonb comes back as an array already; guard so a stray string cannot
    // hydrate a key whose `devices` is a string and break the group check.
    devices: Array.isArray(r.devices) ? r.devices.map(String) : [],
    boundDevice: r.bound_device ?? null,
    isActive: Boolean(r.is_active),
    note: r.note ?? "",
  }));
}

/** Boot-time load, bounded so an unreachable database cannot hang startup. */
export async function loadLicenseRowsBounded(): Promise<LicenseRow[]> {
  if (!licensesPersisted()) return [];
  return withTimeout(loadLicenseRows(), LOAD_TIMEOUT_MS, "license load");
}

/** Insert or update one key. Runs before the in-memory copy is committed. */
export async function saveLicenseRow(row: LicenseRow): Promise<void> {
  if (!licensesPersisted()) return;
  const sql = await getSql();
  await sql.query(
    `insert into licenses
       (license_key, key_fp, plan, created_at, expires_at, duration_ms,
        is_group, max_devices, devices, bound_device, is_active, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
     on conflict (license_key) do update set
       key_fp = excluded.key_fp,
       plan = excluded.plan,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at,
       duration_ms = excluded.duration_ms,
       is_group = excluded.is_group,
       max_devices = excluded.max_devices,
       devices = excluded.devices,
       bound_device = excluded.bound_device,
       is_active = excluded.is_active,
       note = excluded.note`,
    [
      row.licenseKey,
      row.keyFp,
      row.plan,
      row.createdAt,
      row.expiresAt,
      row.durationMs,
      row.isGroup,
      row.maxDevices,
      JSON.stringify(row.devices),
      row.boundDevice,
      row.isActive,
      row.note,
    ],
  );
}

/**
 * Permanently remove one key. Deleting the row is what makes the delete
 * survive a restart — the boot-time load can only hydrate rows that exist.
 */
export async function deleteLicenseRow(licenseKey: string): Promise<void> {
  if (!licensesPersisted()) return;
  const sql = await getSql();
  await sql.query("delete from licenses where license_key = $1", [licenseKey]);
}
