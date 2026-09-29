export type Item = { id: string; label: string };
export type Group = { id: string; label: string; emoji?: string; items: Item[] };
export type StatField = { id: string; key?: string; emoji: string; labelEn: string; labelVi: string };

// The game allows selecting avatars up to 398; only 1..349 ship with artwork.
//
// 398 is the ceiling, not a guess — four independent sources agree:
//   * every genuinely fetched save tops out at 398, and the only ids past it
//     are 1390/1391, which *every* save already carries;
//   * a save holding a complete collection has exactly 400 vars —
//     1..398 + 1390 + 1391 — in several unrelated files;
//   * the reference tool unlocks exactly `range(1, 399)`;
//   * `AVATAR_EMOJIS` is sized for the 49 slots past the artwork (398-349).
// A commit once raised this to 500 "matching the current game version" while
// leaving the comment above it at 398; nothing in any save or tool ever
// showed 399..500, and writing them puts 102 vars in the save that no city
// the server has seen contains.
export const AVATAR_MAX = 398;
export const AVATAR_ICON_MAX = 349;
export const AVATAR_CHUNK = 50;

export function avatarNumber(n: number | string): number | null {
  if (typeof n === "number") return Number.isFinite(n) ? Math.floor(n) : null;
  const m = /^\s*(\d+)\s*$/.exec(String(n));
  return m ? Number(m[1]) : null;
}

export function avatarIconPath(n: number | string) {
  const num = avatarNumber(n);
  if (num === null || num < 1 || num > AVATAR_ICON_MAX) return null;
  return `/avatars/ava${num}.webp`;
}

/** Distinct faces for the avatars past the artwork, so they never repeat. */
export const AVATAR_EMOJIS = [
  "🧑", "👦", "👧", "👨", "👩", "🧓", "👴", "👵", "👶", "🧒",
  "👮", "🕵️", "💂", "👷", "🤴", "👸", "🧙", "🧚", "🧜", "🧝",
  "🦸", "🦹", "🤶", "🎅", "🧛", "🧟", "👽", "👾", "🤖", "🎃",
  "😺", "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾", "🐵",
  "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
] as const;

export function avatarEmoji(n: number | string) {
  const num = avatarNumber(n);
  if (num === null || num < 1) return null;
  const idx = (num - AVATAR_ICON_MAX - 1) % AVATAR_EMOJIS.length;
  return AVATAR_EMOJIS[(idx + AVATAR_EMOJIS.length) % AVATAR_EMOJIS.length]!;
}

export function avatarGroupId(n: number) {
  const s = Math.floor((n - 1) / AVATAR_CHUNK) * AVATAR_CHUNK + 1;
  const e = Math.min(s + AVATAR_CHUNK - 1, AVATAR_MAX);
  return `ava_${s}_${e}`;
}

export function avatarsInRange(from: number, to: number) {
  const a = Math.max(1, Math.min(AVATAR_MAX, Math.floor(from)));
  const b = Math.max(1, Math.min(AVATAR_MAX, Math.floor(to)));
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const byGroup: Record<string, string[]> = {};
  for (let n = lo; n <= hi; n++) {
    const g = avatarGroupId(n);
    (byGroup[g] ??= []).push(String(n));
  }
  return { lo, hi, byGroup, count: hi - lo + 1 };
}
