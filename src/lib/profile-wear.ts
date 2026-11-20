/**
 * The name a profile frame is *worn* under, out of the Frames catalog.
 *
 * A save holds two different things for frames:
 *
 * - `<DataElem name="UnlockedFrames">` — the base64 ids the account owns
 *   (`VFBKNx5FUig9Gy0tFgIwCCM=,…`), which is what the Profile tab unlocks;
 * - `<Var name="MyFrame" v="frame_12"/>` — the **name** the account is wearing,
 *   measured in real saves as `frame_04`, `frame_08`, `frame_12`.
 *
 * Unlocking an id never changes what is worn, so a frame pushed by the tool
 * appears in the game's list but nothing on the profile moves until `MyFrame`
 * is set. That is the whole reason this module exists.
 *
 * The numbered labels carry their own name (`Frame 12` -> `frame_12`). The
 * catalog's newer frames are labelled by event name instead (`Penguin`), so
 * they fall back to their position in the list, which is the game's own
 * numbering (`Penguin` is the 18th frame -> `frame_18`).
 */
export function frameWearName(label: string, index: number): string {
  const numbered = /^Frame\s+(\d+)$/.exec(label.trim());
  if (numbered?.[1]) return `frame_${numbered[1]}`;
  return `frame_${index + 1}`;
}

/** The name form a save may carry in `MyFrame`. */
export function isFrameWearName(value: string): boolean {
  return /^frame_\d{1,3}$/.test(value.trim());
}
