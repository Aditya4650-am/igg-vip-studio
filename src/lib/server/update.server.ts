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

export function getRelease(token: string): AppRelease {
  requireToken(token);
  return { ...current };
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
