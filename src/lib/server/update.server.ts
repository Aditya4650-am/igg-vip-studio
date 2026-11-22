import { requireToken } from "./license.server";

export type AppRelease = {
  version: string;
  notes: string;
  publishedAt: number;
  downloadUrl: string;
  sha256: string;
};

const envRelease = () => ({
  downloadUrl: (process.env.CLIENT_UPDATE_URL ?? "").trim(),
  sha256: (process.env.CLIENT_UPDATE_SHA256 ?? "").trim().toLowerCase(),
});

let current: AppRelease = {
  version: "1.15.0",
  notes: "Studio hiện tại — Data, Kho, Avatars kéo khoảng, Unban All, Feedback kèm thời hạn key.",
  publishedAt: Date.now(),
  ...envRelease(),
};

/**
 * Latest published client, so shipped EXEs update themselves instead of being
 * rebuilt and handed out again.
 *
 * The repo is public, so the release API is read directly: tag → version,
 * asset → download URL, and GitHub's own `digest` → the SHA-256 the client
 * verifies before swapping. Cached for ten minutes; a failed lookup keeps the
 * baked release instead of blocking sign-in. `CLIENT_UPDATE_URL` /
 * `CLIENT_UPDATE_SHA256` still win when set, and an admin `publishRelease`
 * still overrides everything for the rest of the process.
 */
const GH_REPO = "Aditya4650-am/igg-vip-studio";

type GhRelease = {
  tag_name?: string;
  body?: string;
  assets?: { name?: string; browser_download_url?: string; digest?: string }[];
};

let ghCache: { at: number; value: AppRelease | null } = { at: 0, value: null };

async function githubRelease(): Promise<AppRelease | null> {
  if (Date.now() - ghCache.at < 10 * 60_000) return ghCache.value;
  let out: AppRelease | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "igg-vip-studio" },
    });
    if (res.ok) {
      const j = (await res.json()) as GhRelease;
      const version = String(j.tag_name ?? "").replace(/^v/i, "");
      const asset =
        j.assets?.find((a) => /\.zip$/i.test(a.name ?? "")) ??
        j.assets?.find((a) => /\.exe$/i.test(a.name ?? ""));
      const url = String(asset?.browser_download_url ?? "");
      const sha = String(asset?.digest ?? "").replace(/^sha256:/i, "").toLowerCase();
      const notes =
        String(j.body ?? "")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !/^sha-?256/i.test(l))
          ?.slice(0, 200) ?? "Feature update";
      if (/^\d+\.\d+\.\d+$/.test(version) && /^https:\/\//.test(url) && /^[a-f0-9]{64}$/.test(sha)) {
        out = { version, notes, publishedAt: Date.now(), downloadUrl: url, sha256: sha };
      }
    }
  } catch {
    /* offline or rate-limited: keep the baked default */
  }
  ghCache = { at: Date.now(), value: out };
  return out;
}

export async function getRelease(token: string): Promise<AppRelease> {
  requireToken(token);
  // A configured or admin-published release is authoritative.
  if (current.downloadUrl && current.sha256) return { ...current };
  const gh = await githubRelease();
  return gh ? { ...gh } : { ...current };
}

export function publishRelease(
  token: string,
  p: { version: string; notes: string; downloadUrl?: string; sha256?: string },
): AppRelease {
  const { license } = requireToken(token);
  if (!license.admin) throw new Error("Admin key required");
  const version = p.version.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Version must look like 1.17.0");
  if (version === current.version) throw new Error("Bump the version first");
  const notes = p.notes.trim().slice(0, 400) || "Feature update";
  const downloadUrl = (p.downloadUrl?.trim() || envRelease().downloadUrl);
  const sha256 = (p.sha256?.trim().toLowerCase() || envRelease().sha256);
  if (!downloadUrl || !sha256) throw new Error("Download URL and SHA-256 are required for Client auto-update");
  let u: URL;
  try { u = new URL(downloadUrl); } catch { throw new Error("Download URL is invalid"); }
  if (u.protocol !== "https:") throw new Error("Download URL must use HTTPS");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("SHA-256 must be 64 hexadecimal characters");
  current = { version, notes, publishedAt: Date.now(), downloadUrl: u.toString(), sha256 };
  return { ...current };
}
