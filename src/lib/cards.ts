import type { Group } from "./catalogs";

/** Card-collection groups (client side).
 *
 * 150 ids, `card_1..card_150` — the full range ever observed across real
 * cities. Grouped by tens for the picker; grouping is presentational and
 * does not mirror the game's `set_01..set_15` compositions, which live in
 * balance files outside any save. Artwork lands later like museum art did;
 * until then every button shows the card glyph.
 */
export const CARD_GROUPS: readonly Group[] = Object.freeze(
  Array.from({ length: 15 }, (_, g) => {
    const lo = g * 10 + 1;
    const hi = g * 10 + 10;
    return {
      id: `cards-${String(g + 1).padStart(2, "0")}`,
      label: `Cards ${lo}–${hi}`,
      items: Array.from({ length: 10 }, (_, i) => {
        const n = lo + i;
        return { id: `card_${n}`, label: `Card ${n}` };
      }),
    };
  }),
);
