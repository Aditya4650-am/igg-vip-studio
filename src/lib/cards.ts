import type { Group } from "./catalogs";

/** Card-collection groups (client side).
 *
 * 151 ids, canonical `card_01..card_09` then `card_10..card_151` — the exact
 * forms real cities write (single digits are zero-padded; unpadded lookalikes
 * never count toward a set). Grouped by tens for the picker; grouping is
 * presentational and does not mirror the game's `set_01..set_15`
 * compositions, which live in balance files outside any save. Row artwork
 * comes from `cardIconPath` below (5 pack arts, rotating).
 *
 * `card_151` is not padded further out of caution: a genuinely fetched city
 * holds `card_01..card_151` contiguous and no save has ever shown `card_152`.
 * The catalog stops where the evidence stops.
 */
/** Card pack artwork (client side).
 *
 * The picker shows 151 individual cards in 16 presentational groups; the game
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

/**
 * The catalog ceiling — must stay in step with `CARD_IDS` in
 * `cards.server.ts`, which is what the server actually grants and the push
 * gate actually validates. `cardNumber` uses it so the picker cannot show a
 * row the server would refuse to create.
 */
export const CARD_COUNT = 151;

export function cardNumber(id: string): number | null {
  const m = /^card_0*(\d+)$/.exec(id.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= CARD_COUNT ? n : null;
}

/** Pack art URL for a card id. The file may not exist yet — callers must fall back. */
export function cardIconPath(id: string): string | null {
  const n = cardNumber(id);
  if (n === null) return null;
  return CARD_PACKS[(n - 1) % CARD_PACKS.length] ?? null;
}

const CARD_GROUP_SIZE = 10;
export const CARD_GROUPS: readonly Group[] = Object.freeze(
  Array.from({ length: Math.ceil(CARD_COUNT / CARD_GROUP_SIZE) }, (_, g) => {
    const lo = g * CARD_GROUP_SIZE + 1;
    const hi = Math.min(lo + CARD_GROUP_SIZE - 1, CARD_COUNT);
    return {
      id: `cards-${String(g + 1).padStart(2, "0")}`,
      label: `Cards ${lo}–${hi}`,
      items: Array.from({ length: hi - lo + 1 }, (_, i) => {
        const n = lo + i;
        return { id: n < 10 ? `card_0${n}` : `card_${n}`, label: `Card ${n}` };
      }),
    };
  }),
);
