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

/**
 * The ceiling is what a **real** week can show is valid, not a guess.
 *
 * 73 is the largest completed week ever recorded in the corpus; the weeks
 * measurable directly off the saves on file are 36, spread over 5 days. 105
 * exists only in the old fabricator's output — and its tell was never the
 * weekly count but that all 105 landed on **one calendar day**.
 *
 * Which is why the weekly number is the weaker of the two rails here. A
 * 10-task batch is what actually got an account banned, and it went down for
 * *shape* — a score that out-ran its own history, a `ver="0"`, a completed id
 * still sitting on the offer list — not for being too big. `REGATTA_MAX_PER_DAY`
 * below is the rail that carries the weight: it bounds how dense one day may
 * become, which is what stops a week's worth of tasks from collapsing into the
 * fabricator's single-day pile.
 */
export const REGATTA_MAX_TASKS = 73;
export const REGATTA_DEFAULT_TASKS = 12;

/**
 * How many completions may land in one rolling day.
 *
 * 17 is not this repo's guess — it is **the game's own daily quota**, read off
 * the live client: *"Your Tasks — Today's Tasks: 4/17"* with *"Quota resets in:
 * 11h 10m"* underneath, i.e. a per-24h count the server keeps. The same number
 * is already sitting in the save as `<Var name="TaskQuota">`, and it is the
 * block's **own** copy that decides here: measured equal to every record's
 * `anlLimit` on 5/5 real saves (9, 11, 13, 17, 17) — so a save at quota 9 is
 * held to 9 and one at 17 to 17, rather than every player being judged by one
 * hardcoded figure. 17 doubles as the ceiling: no save on file has ever asked
 * for more, so a block claiming 30 is clamped instead of believed.
 *
 * It is this rail, not `REGATTA_MAX_TASKS`, that carries the weight. A 10-task
 * batch is what actually got an account banned, and it went down for *shape* —
 * a score that out-ran its own history, a `ver="0"`, a completed id still on
 * the offer list — not for being too big. The fabricator's tell was never its
 * weekly 105 but that all 105 landed on **one calendar day**; the busiest day
 * in any real week on file is 12.
 */
export const REGATTA_MAX_PER_DAY = 17;

/**
 * The block's stated `TaskQuota`, reduced to a value the game has actually
 * shown. A save that states none (or a malformed one) falls back to the full
 * daily limit, so the refusal path never becomes "no quota, no tasks".
 */
export function regattaDailyQuota(quota: number | null | undefined): number {
  const q = Math.floor(Number(quota));
  if (!Number.isFinite(q) || q < 1) return REGATTA_MAX_PER_DAY;
  return Math.min(q, REGATTA_MAX_PER_DAY);
}

/**
 * Seconds between two completions when the daily quota is `quota`.
 *
 * `floor(86400 / q) + 1`, deliberately **not** `ceil`. With spacing `s` any
 * rolling 86400-second window holds at most `floor(86400 / s) + 1` points, and
 * only `s > 86400 / q` brings that down to `q` — `ceil(86400 / q)` sits exactly
 * on the boundary and lets one window hold `q + 1`.
 *
 * A real block can legitimately show more than its quota inside a rolling day
 * (the corpus tops out at 21 against a quota of 11), because the game's reset
 * sits off the UTC day and a rolling window can straddle two of them. This
 * spacing is therefore the conservative half of that envelope: a batch written
 * through it never reaches the quota in any 24h at all, whatever the reset
 * time — and it is 6.6x under the fabricator's 105-in-one-day.
 */
export function regattaMinGap(quota: number = REGATTA_MAX_PER_DAY): number {
  return Math.floor(86400 / regattaDailyQuota(quota)) + 1;
}

/** Spacing for a save that states no `TaskQuota` of its own. */
export const REGATTA_MIN_GAP = regattaMinGap();

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
 * The first and last timestamp a batch may use. `hi` sits a minute short of
 * "now" (or of the window's end) so every completion is safely in the past;
 * `lo` covers 35% of the elapsed window; and the pair has to leave the batch
 * `minGap` per task, which is what keeps a day's density inside this save's
 * own `TaskQuota`.
 *
 * `lastDone` is the newest completion **already** sitting in the block. A
 * second push used to compute its range from the window alone, so it re-issued
 * a completion time *lower* than the push before it and the block stopped
 * being ordered — measured at 1 out-of-order record per second push, against
 * 0 in every block of the corpus, where `realEndTime` is non-decreasing in
 * document order on all of them (35/35, 14/14, 104/104). Anchoring `lo` past
 * the last one makes that impossible rather than merely unlikely.
 */
export function regattaBounds(
  win: RegattaWindow,
  now: number,
  lastDone = 0,
  minGap: number = REGATTA_MIN_GAP,
): { hi: number; lo: number } {
  const hi = Math.min(win.end, now) - 60;
  let lo = win.start + Math.floor((hi - win.start) * 0.35);
  if (lastDone > 0) lo = Math.max(lo, lastDone + minGap);
  return { hi, lo };
}

/**
 * The single answer to "can this save take `nTasks` more tasks right now?".
 *
 * `injectRegata` throws in exactly this order for exactly these conditions, so
 * `reason === "ok"` is the server's own precondition for not refusing.
 *
 * `state.quota` is this save's own `TaskQuota` (already clamped). It feeds the
 * spacing both this function and the injector use, so a save at quota 9 gets
 * the wider gap here *and* there — the tab can never show a batch that the
 * server then refuses, or vice versa.
 */
export function regattaReason(
  state: { window: RegattaWindow | null; templates: number; current: number; lastDone?: number; quota?: number },
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
  // `need - 1` gaps is exactly how `injectRegata` spaces the batch, so this
  // condition and the one it throws on are the same arithmetic rather than two
  // approximations of each other. `need` is >= 1 here, so a single task always
  // fits and a range with no room left at all still refuses.
  const minGap = regattaMinGap(state.quota);
  const { hi, lo } = regattaBounds(win, now, state.lastDone ?? 0, minGap);
  if (hi - win.start < 600 || hi - lo < (want - state.current - 1) * minGap) return "window_closed";
  return "ok";
}
