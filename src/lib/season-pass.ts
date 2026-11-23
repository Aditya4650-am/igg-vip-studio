/**
 * Golden Pass seasons this game build actually ships content for.
 *
 * The list is not a guess: each id below has its own `SeasonTicketVSO<id>`
 * resource pack installed on the device (`harvest_80`, `wildwest_81`,
 * `halloween_82`, `skiresort_83`, `christmas_84`). The pack is what the client
 * renders the pass from — a season without one shows a HUD timer but its window
 * refuses to open, which is what a fabricated id looked like in the live test.
 *
 * So this is the whole set the tool may offer. Adding an id the client has no
 * art for would create a dead button, which is worse than a shorter list.
 *
 * Pure and browser-safe: no fs, no server imports.
 */
export type SeasonPassSeason = {
  /** Season id, as written to `<SeasonTicket id>` and the VSO pack. */
  id: string;
  /** Theme slug, as written to `<SeasonTicket theme>` and the pack's assets folder. */
  theme: string;
  /** Full name the game shows on the pass plaque. */
  name: string;
  /** Short label for the button. */
  short: string;
  /** Cropped name plaque, shipped under `public/`. */
  art: string;
};

export const SEASON_PASSES: readonly SeasonPassSeason[] = [
  {
    id: "800",
    theme: "harvest_80",
    name: "Harvest Pass",
    short: "Harvest",
    art: "/game-icons/passes/pass-800.png",
  },
  {
    id: "810",
    theme: "wildwest_81",
    name: "Western Pass",
    short: "Western",
    art: "/game-icons/passes/pass-810.png",
  },
  {
    id: "820",
    theme: "halloween_82",
    name: "Halloween Pass",
    short: "Halloween",
    art: "/game-icons/passes/pass-820.png",
  },
  {
    id: "830",
    theme: "skiresort_83",
    name: "Alpine Pass",
    short: "Alpine",
    art: "/game-icons/passes/pass-830.png",
  },
  {
    id: "840",
    theme: "christmas_84",
    name: "Christmas Pass",
    short: "Christmas",
    art: "/game-icons/passes/pass-840.png",
  },
];

export function seasonPassById(id: string | number): SeasonPassSeason | null {
  const key = String(id).trim();
  return SEASON_PASSES.find((s) => s.id === key) ?? null;
}
