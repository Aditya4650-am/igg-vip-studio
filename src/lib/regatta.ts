/**
 * The regatta batch decision, shared by the server and the Regatta tab.
 *
 * `snapshot()` has no idea which batch size the user is about to pick, so it
 * reports `inspectRegatta` for the **default** 12. The tab used to take that
 * answer straight to its `disabled` prop, which let the button disagree with
 * the push that follows it:
 *
 *   - save holding 12 tasks, user raises the count to 15 -> badge says
 *     "already has enough", button dead, even though 15 would have worked;
 *   - save holding 5 tasks, user drops the count to 3    -> badge says ready,
 *     button live, and `injectRegata` then throws `already_full`.
 *
 * Both cases read to the user as "the button is broken". The tab now re-runs
 * `regattaReason` with the number it is actually going to send, and the server
 * runs the very same function, so "pressable" and "will succeed" are one
 * decision rather than two that can drift apart.
 *
 * Pure and browser-safe on purpose: no fs, no server imports, so
 * `studio-app.tsx` can bundle it.
 *
 * The safety rules themselves are unchanged — see `injectRegata` for *why*
 * each floor exists.
 */

/** A strong player clears roughly 15 tasks in a week. Past that a batch stops
 *  looking like play and starts looking like a tool, so 15 is a hard ceiling. */
export const REGATTA_MAX_TASKS = 15;
export const REGATTA_DEFAULT_TASKS = 12;

/** Why a save cannot receive regatta tasks. `ok` means it can. */
export type RegattaReason = "ok" | "no_active_regatta" | "no_template" | "window_closed" | "already_full";

/** The `<Regata>` window: `startTime` / `endTime` read off the block. */
export interface RegattaWindow {
  start: number;
  end: number;
}

/** The clamp every batch goes through, server and UI alike. */
export function regattaWant(nTasks: number): number {
  return Math.max(1, Math.min(REGATTA_MAX_TASKS, Math.floor(Number(nTasks) || 0)));
}

/**
 * First and last timestamp a batch may use. `hi` sits a minute short of "now"
 * (or of the window's end) so every completion is safely in the past, `lo`
 * covers 35% of the elapsed window, and the pair must leave the batch a minute
 * per task.
 */
export function regattaBounds(win: RegattaWindow, now: number): { hi: number; lo: number } {
  const hi = Math.min(win.end, now) - 60;
  const lo = win.start + Math.floor((hi - win.start) * 0.35);
  return { hi, lo };
}

/**
 * The single answer to "can this save take `nTasks` more tasks right now?".
 *
 * `injectRegata` throws in exactly this order for exactly these conditions, so
 * `reason === "ok"` is the server's own precondition for not refusing.
 */
export function regattaReason(
  state: { window: RegattaWindow | null; templates: number; current: number },
  nTasks: number = REGATTA_DEFAULT_TASKS,
  now: number = Math.floor(Date.now() / 1000),
): RegattaReason {
  const win = state.window;
  // No block, no parseable window, or a week that has not started / is over:
  // all the same answer, because writing tasks into any of them is what a
  // server checks for first.
  if (!win || now < win.start || now > win.end) return "no_active_regatta";
  if (!state.templates) return "no_template";
  const want = regattaWant(nTasks);
  if (want <= state.current) return "already_full";
  const { hi, lo } = regattaBounds(win, now);
  if (hi - win.start < 600 || hi - lo < (want - state.current) * 60) return "window_closed";
  return "ok";
}
