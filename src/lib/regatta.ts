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
 * The ceiling on **one batch** — a safety rail, not a rule about regattas.
 *
 * It used to be 73, the largest completed week ever recorded in the corpus,
 * and it was presented to the user as "the maximum". That number is gone as a
 * policy: the field takes whatever is typed. What remains is a bound large
 * enough that a typo cannot ask the injector to emit a million records and
 * hang the session — nobody has ever needed more than a handful of hundred.
 *
 * The daily spacing below is a different thing and still carries weight: it
 * bounds how dense one *day* may become, which is what stops a batch from
 * collapsing into the fabricator's single-day pile. The busiest day in any
 * real week on file is 12.
 */
export const REGATTA_MAX_TASKS = 9999;
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

/**
 * Why a save cannot receive regatta tasks. `ok` means it can.
 *
 * `window_closed` used to be in this union. It refused a batch when the count
 * did not fit between the block's own `startTime` and *now* at the save's daily
 * spacing — which on day one of a week is only a couple of tasks, so a save
 * whose regatta had opened that afternoon rejected 20 with "the regatta window
 * is too short". That was arithmetic about how much of the week had passed, not
 * a rule the game states, and it read as a broken button. The batch now spreads
 * over whatever span the block still has and never refuses on it.
 */
export type RegattaReason = "ok" | "no_active_regatta" | "no_template" | "already_full";

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
  // No further check. The batch is placed across the span the block has between
  // its own start and now, so whatever fits in that span is what gets written;
  // there is no separate "will the count fit at this spacing" question left to
  // answer, which is why the tab can no longer disagree with the push.
  return "ok";
}
