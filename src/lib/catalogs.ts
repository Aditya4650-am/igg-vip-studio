export type Item = { id: string; label: string };
export type Group = { id: string; label: string; emoji?: string; items: Item[] };
export type StatField = { id: string; key?: string; emoji: string; labelEn: string; labelVi: string };

export const AVATAR_MAX = 398;
export const AVATAR_CHUNK = 50;

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
