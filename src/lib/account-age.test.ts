import { strict as assert } from "node:assert";
import { test } from "node:test";

const { accountAgeInfo, ACCOUNT_MIN_DAYS, ACCOUNT_MIN_HOURS } = await import("./account-age.ts");
const { applyDesban, cloneDecorOnly } = await import("./server/township/desban.server.ts");

const NOW = Math.floor(Date.now() / 1000);
const H = 3600;
const xml = (vars: string[]) => ['<?xml version="1.0" encoding="utf-8"?>', "<Global>", ...vars, "</Global>"].join("");

// The banned save measured on 2026-10-02: an account created hours earlier,
// `DaysEnteredGame` still 0, wearing a city founded in 2012.
const YOUNG = xml([
  '<Var name="cityId" v="OWNCITY1" t="s"/>',
  '<Var name="levelup" v="1" t="i"/>',
  '<Var name="residents" v="500" t="i"/>',
  '<Var name="StartTutorialFinished" v="0" t="i"/>',
  '<Var name="DaysEnteredGame" v="0" t="i"/>',
  `<Var name="firstVisitTime" v="${NOW - 3 * H}" t="i"/>`,
  '<SeasonTicket id="800" premium="0" score="0" startTime="1500000000" endTime="4102444800" theme="summer"/>',
  '<Version version="35.1.0" FVer="3510"/>',
  '<AWS cityId="OWNCITY1"/>',
]);

// The clean city measured the same day: two days entered, first seen 53 h ago.
const ESTABLISHED = xml([
  '<Var name="cityId" v="OWNCITY1" t="s"/>',
  '<Var name="levelup" v="1" t="i"/>',
  '<Var name="residents" v="500" t="i"/>',
  '<Var name="StartTutorialFinished" v="0" t="i"/>',
  '<Var name="DaysEnteredGame" v="2" t="i"/>',
  `<Var name="firstVisitTime" v="${NOW - 53 * H}" t="i"/>`,
  '<SeasonTicket id="800" premium="0" score="0" startTime="1500000000" endTime="4102444800" theme="summer"/>',
  '<Version version="35.1.0" FVer="3510"/>',
  '<AWS cityId="OWNCITY1"/>',
]);

// A friend's city: older than ours by every measure. If a restore ever started
// copying these, an hours-old account would be able to lie about its own age.
const DONOR = xml([
  '<Var name="cityId" v="DONORCITY" t="s"/>',
  '<Var name="levelup" v="42" t="i"/>',
  '<Var name="residents" v="9000" t="i"/>',
  '<Var name="StartTutorialFinished" v="1" t="i"/>',
  '<Var name="DaysEnteredGame" v="16" t="i"/>',
  '<Var name="firstVisitTime" v="1784030667" t="i"/>',
]);

test("account age: the two thresholds are what the record was measured at", () => {
  assert.equal(ACCOUNT_MIN_DAYS, 1, "every banned save on file read 0 days entered, every clean one 2+");
  assert.equal(ACCOUNT_MIN_HOURS, 24, "a day is the boundary the install-age record straddles");
});

test("account age: the banned shape is reported as too young, by the day counter", () => {
  const a = accountAgeInfo(YOUNG);
  assert.equal(a.fresh, true, "0 days entered has to warn");
  assert.equal(a.why, "days", "the day counter is the primary signal");
  assert.equal(a.days, 0);
  assert.ok(a.hours !== null && a.hours < 24 && a.hours >= 0, `hours should be ~3, got ${a.hours}`);
});

test("account age: the established city passes without a warning", () => {
  const a = accountAgeInfo(ESTABLISHED);
  assert.deepEqual(
    { fresh: a.fresh, why: a.why, days: a.days },
    { fresh: false, why: null, days: 2 },
    "the city that already does everything in co-op chat must not warn",
  );
  assert.ok(a.hours !== null && a.hours >= 53, `first visit should be ~53 h ago, got ${a.hours}`);
});

test("account age: a recent first visit never overrides a day counter that exists", () => {
  // `current.xml` is a proven-clean city whose install was already 25.8 h old
  // while its `firstVisitTime` reads only 7 h back — the game refreshes that
  // field. OR-ing the two signals warned on a city that has never been banned,
  // which is how a warning earns itself an ignore button.
  const a = accountAgeInfo(
    xml(['<Var name="DaysEnteredGame" v="1" t="i"/>', `<Var name="firstVisitTime" v="${NOW - 7 * H}" t="i"/>`]),
  );
  assert.equal(a.fresh, false, "a clean city must never warn");
  assert.equal(a.why, null);
  assert.equal(a.hours, 7, "the number is still reported, just not acted on");
});

test("account age: a save that tracks neither field gains no warning of its own", () => {
  const a = accountAgeInfo(xml(['<Var name="cityId" v="X" t="s"/>']));
  assert.deepEqual(a, { days: null, hours: null, fresh: false, why: null });
  assert.deepEqual(accountAgeInfo(""), { days: null, hours: null, fresh: false, why: null });
});

test("account age: with no day counter, a first visit under a day ago still warns", () => {
  const a = accountAgeInfo(xml([`<Var name="firstVisitTime" v="${NOW - 5 * H}" t="i"/>`]));
  assert.equal(a.fresh, true);
  assert.equal(a.why, "hours", "hours is the fallback, not the first choice");
  assert.equal(a.days, null);
});

test("account age: attribute order does not decide whether the fields are read", () => {
  const a = accountAgeInfo(xml([`<Var v="0" t="i" name="DaysEnteredGame"/>`]));
  assert.equal(a.fresh, true, "v before name is a shape real saves use");
  assert.equal(a.days, 0);
});

test("account age: a restore never carries the friend's age onto our account", () => {
  // The warning is only worth anything if the copy cannot quietly "fix" it.
  // `DaysEnteredGame` and `firstVisitTime` are the account's own, so they must
  // come out of every mode exactly as they went in — measured on the real
  // banned save, where they read 0 and its donor's 16.
  for (const mode of ["inicial", "completo", "novo"] as const) {
    const restored = applyDesban(YOUNG, DONOR, mode);
    const out = cloneDecorOnly(restored, DONOR).xml;
    const a = accountAgeInfo(out);
    assert.equal(a.days, 0, `${mode}: DaysEnteredGame must stay ours (0), the friend has 16`);
    assert.equal(
      /<Var\b[^>]*name="firstVisitTime"[^>]*\bv="1784030667"/.test(out),
      false,
      `${mode}: the friend's firstVisitTime must never land in our save`,
    );
    assert.equal(a.fresh, true, `${mode}: the warning must survive the copy it is warning about`);
  }
});
