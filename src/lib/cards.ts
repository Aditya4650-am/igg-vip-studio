import type { Group } from "./catalogs";

/** Card-collection groups (client side).
 *
 * 150 ids, canonical `card_01..card_09` then `card_10..card_150` — the exact
 * forms real cities write (single digits are zero-padded; unpadded lookalikes
 * never count toward a set). Grouped by tens for the picker; grouping is
 * presentational and does not mirror the game's `set_01..set_15`
 * compositions, which live in balance files outside any save. Row artwork
 * comes from `cardIconPath` below (5 pack arts, rotating).
 */
/** Card pack artwork (client side).
 *
 * The picker shows 150 individual cards in 15 presentational groups; the game
 * itself sells them in 5 coloured packs, so each card rotates across the five
 * pack arts: card N shows pack ((N-1) % 5) + 1. Drop the five files into
 * `public/cards/` as pack_1..pack_5.webp (paste order: purple, orange, green,
 * blue, pink); until they exist the rows keep the card glyph.
 */
const CARD_PACKS = Object.freeze([
  "/cards/pack_1.webp",
  "/cards/pack_2.webp",
  "/cards/pack_3.webp",
  "/cards/pack_4.webp",
  "/cards/pack_5.webp",
]);

export function cardNumber(id: string): number | null {  const m = /^card_0*(\d+)$/.exec(id.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 150 ? n : null;
}

/** Pack art URL for a card id. The file may not exist yet — callers must fall back. */
export function cardIconPath(id: string): string | null {
  const n = cardNumber(id);
  if (n === null) return null;
  return CARD_PACKS[(n - 1) % CARD_PACKS.length] ?? null;
}

export const CARD_GROUPS: readonly Group[] = Object.freeze(
  Array.from({ length: 15 }, (_, g) => {
    const lo = g * 10 + 1;
    const hi = g * 10 + 10;
    return {
      id: `cards-${String(g + 1).padStart(2, "0")}`,
      label: `Cards ${lo}–${hi}`,
      items: Array.from({ length: 10 }, (_, i) => {
        const n = lo + i;
        return { id: n < 10 ? `card_0${n}` : `card_${n}`, label: `Card ${n}` };
      }),
    };
  }),
);
