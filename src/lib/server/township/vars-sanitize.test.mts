import { strict as assert } from "node:assert";
import { test } from "node:test";

import { applyStatChanges } from "./vars.server.ts";

const xmlAt = (level: number) =>
  `<root><Global><Var name="levelup" v="${level}" t="i"/><Var name="moneyCash" v="10" t="i"/><Var name="money" v="100" t="i"/></Global></root>`;

// The Data Center has no limit. `sanitizeStatChanges` used to clamp `tca` and
// `coi` to a level band, so typing 999999 on a low-level city silently wrote
// 3000. These tests exist to fail if that rewrite comes back.

test("tca is written exactly as typed, at every level", () => {
  for (const level of [1, 10, 30, 60, 80]) {
    const out = applyStatChanges(xmlAt(level), { tca: "999999" });
    assert.match(
      out,
      /<Var\b[^>]*\bname="moneyCash"[^>]*\bv="999999"/,
      `level ${level} must keep the requested T-cash`,
    );
  }
});

test("coi is written exactly as typed, at every level", () => {
  for (const level of [1, 10, 30, 60, 80]) {
    const out = applyStatChanges(xmlAt(level), { coi: "9999999" });
    assert.match(
      out,
      /<Var\b[^>]*\bname="money"[^>]*\bv="9999999"/,
      `level ${level} must keep the requested coins`,
    );
  }
});

test("a value below the old band still lands unchanged", () => {
  assert.match(applyStatChanges(xmlAt(10), { tca: "2500" }), /name="moneyCash"[^>]*\bv="2500"/);
  assert.match(applyStatChanges(xmlAt(30), { coi: "5000" }), /name="money"[^>]*\bv="5000"/);
});

test("empty fields are still skipped rather than wiping a counter", () => {
  // No clamping, but also no accidental deletion: an untouched field must
  // survive a push that simply did not name it. Anything non-numeric that *is*
  // named is written straight through — the `var-int` rule in the shape gate
  // is what refuses to push a value like that onto a counter, and that gate is
  // untouched by this change.
  const out = applyStatChanges(xmlAt(10), { tca: "", lvl: "999", win: "5" });
  assert.match(out, /name="moneyCash"[^>]*\bv="10"/, "an empty field must not overwrite");
  assert.match(out, /name="levelup"[^>]*\bv="999"/);
  assert.match(out, /name="FirstAttemptM3Levels"[^>]*\bv="5"/);
});
