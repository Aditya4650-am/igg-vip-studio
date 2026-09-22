/** Museum artifact catalogue (client side).
 *
 * Ids mirror the server's authoritative set: a decoded mGameInfo whose
 * ArtInfo holds 354 distinct ids (a1..a365 except the exclusions below).
 * Artwork covers 340 of them (`public/artifacts/aN.webp`); the 14 without
 * art get distinct emoji so no two buttons share a face and none falls back
 * to the star placeholder.
 */

const EXCLUDED = new Set([340, 346, 348, 350, 351, 354, 356, 358, 359, 361, 364]);

export const MUSEUM_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 365 }, (_, i) => i + 1)
    .filter((n) => !EXCLUDED.has(n))
    .map((n) => `a${n}`),
);

const NO_ART = [
  "a86", "a137", "a300", "a325", "a347", "a349", "a352",
  "a353", "a355", "a357", "a360", "a362", "a363", "a365",
] as const;

const NO_ART_SET: ReadonlySet<string> = new Set(NO_ART);

const MUSEUM_EMOJIS = [
  "🏺", "🏛️", "🗿", "⚱️", "👑", "🗡️", "🛡️",
  "🏆", "🎭", "📜", "⚖️", "🔱", "🕰️", "💎",
] as const;

function parseId(id: string): number | null {
  const m = /^a(\d+)$/.exec(id.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!MUSEUM_IDS.includes(`a${n}`)) return null;
  return n;
}

export function museumLabel(id: string): string {
  const n = parseId(id);
  return n == null ? id : `Artifact ${n}`;
}

/** Artwork URL for the 340 shipped pieces, `null` for the 14 without art. */
export function artifactIconPath(id: string): string | null {
  const n = parseId(id);
  if (n == null || NO_ART_SET.has(`a${n}`)) return null;
  return `/artifacts/a${n}.webp`;
}

/** Distinct face per art-less artifact, `null` when artwork exists. */
export function artifactEmoji(id: string): string | null {
  const n = parseId(id);
  if (n == null) return null;
  const idx = NO_ART.indexOf(`a${n}` as (typeof NO_ART)[number]);
  if (idx < 0) return null;
  return MUSEUM_EMOJIS[idx] ?? null;
}
