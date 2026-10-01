/**
 * How established the **account behind this save** is, read only from fields
 * the save declares about itself. Browser-safe: no fs, no server imports.
 *
 * Why this exists, and what it is measured on. Reported on 2026-10-02 after a
 * full copy ended in an instant ban on the first barn request in co-op chat —
 * while the same actions on the day-old copy were fine. Diffing the two saves
 * showed every identity field (`cityId`, `deviceId`, `gameId`,
 * `TermsAcceptTime`) was the account's *own*, so the copy had not leaked
 * anyone's identity: the file simply described a **brand-new account wearing a
 * 14-year-old city**.
 *
 * All five saves we hold, read with `accountAgeInfo`:
 *
 * | save | outcome | `DaysEnteredGame` |
 * | --- | --- | --- |
 * | `current.xml`   | clean  | 1 |
 * | `current-2.xml` | clean  | 1 |
 * | `current-7.xml` | clean  | 2 |
 * | `current-3.xml` | banned | 0 |
 * | `current-8.xml` | banned | 0 |
 *
 * **5/5 separation on `DaysEnteredGame` alone.** It is deliberately the only
 * thing that can raise the warning on its own, because a restore does not
 * copy it (measured: the banned save reads 0 while its donor reads 16), so it
 * keeps describing *this* account whatever a copy brings in.
 *
 * `firstVisitTime` is reported for context but is **not** a trigger when the
 * day counter exists: measured, it reads 7 h on `current.xml`, a city whose
 * install was already 25.8 h old — so it tracks something the game refreshes
 * (a launch or an update), not the birth of the account. Using it as a second
 * OR-condition flagged a proven-clean city, which is exactly the false alarm
 * that makes a warning worth ignoring. It only acts as a fallback for a save
 * that declares no `DaysEnteredGame` at all.
 *
 * This is a **warning, never a gate**. It cannot say whether Playrix will
 * act; it can only say the account has not counted a single day, which is the
 * one thing about the ban we could actually measure.
 */

/** `DaysEnteredGame` below this means the account has never counted a day. */
export const ACCOUNT_MIN_DAYS = 1;

/** Hours since `firstVisitTime` below this counts as "just created" — but only
 *  when the save declares no `DaysEnteredGame` to ask instead. */
export const ACCOUNT_MIN_HOURS = 24;

export type AccountAgeInfo = {
  /** `DaysEnteredGame`, or null when the save never tracked it. */
  days: number | null;
  /** Whole hours since `firstVisitTime`, or null when absent or unreadable. */
  hours: number | null;
  /** True when either signal says the account is younger than a day. */
  fresh: boolean;
  /** Which signal fired, so the message can name it. */
  why: "days" | "hours" | null;
};

const NOT_YOUNG: AccountAgeInfo = { days: null, hours: null, fresh: false, why: null };

const int = (v: string | undefined) =>
  v != null && /^-?\d+$/.test(v) ? Number(v) : null;

/**
 * Reads the two fields in one pass. Attribute order varies between builds, so
 * each `<Var>` tag is matched once and `name` / `v` pulled out of it rather
 * than assuming one comes before the other.
 */
export function accountAgeInfo(xml: string): AccountAgeInfo {
  if (!xml) return NOT_YOUNG;
  let days: number | null = null;
  let first: number | null = null;
  for (const tag of xml.match(/<Var\b[^>]*\/?>/g) ?? []) {
    const n = /\bname="([^"]*)"/.exec(tag)?.[1];
    if (n !== "DaysEnteredGame" && n !== "firstVisitTime") continue;
    const v = int(/\bv="([^"]*)"/.exec(tag)?.[1]);
    if (v == null) continue;
    if (n === "DaysEnteredGame") days = v;
    else first = v;
  }
  if (days == null && first == null) return NOT_YOUNG;

  // Reported for context only. `firstVisitTime` is refreshed by the game —
  // measured at 7 h on a city whose install was already 25.8 h old — so it
  // must not be allowed to fire while the day counter exists; see the 5/5
  // table at the top of this file.
  const raw =
    first && first > 0 ? Math.floor((Date.now() / 1000 - first) / 3600) : null;
  const whole = raw != null && Number.isFinite(raw) && raw >= 0 ? raw : null;

  // `DaysEnteredGame` is the only signal allowed to decide on its own. It is
  // the one the banned/clean split is 5/5 on, and a restore never copies it.
  if (days != null) {
    const young = days < ACCOUNT_MIN_DAYS;
    return { days, hours: whole, fresh: young, why: young ? "days" : null };
  }
  // A save that never tracked the counter falls back to the timestamp, where
  // "no rule" must not quietly become "no warning".
  const young = whole != null && whole < ACCOUNT_MIN_HOURS;
  return { days, hours: whole, fresh: young, why: young ? "hours" : null };
}
