import { strict as assert } from "node:assert";
import { test } from "node:test";

import { applyStatChanges, sanitizeStatChanges } from "./vars.server.ts";

const xmlAt = (level: number) =>
  `<root><Global><Var name="levelup" v="${level}" t="i"/><Var name="moneyCash" v="10" t="i"/><Var name="money" v="100" t="i"/></Global></root>`;

test("tca is capped by level band", () => {
  assert.equal(sanitizeStatChanges(xmlAt(10), { tca: "999999" }).tca, "3000");
  assert.equal(sanitizeStatChanges(xmlAt(30), { tca: "999999" }).tca, "8000");
  assert.equal(sanitizeStatChanges(xmlAt(60), { tca: "999999" }).tca, "30000");
  assert.equal(sanitizeStatChanges(xmlAt(80), { tca: "999999" }).tca, "50000");
  assert.equal(sanitizeStatChanges(xmlAt(10), { tca: "2500" }).tca, "2500");
});

test("coi is capped by level band", () => {
  assert.equal(sanitizeStatChanges(xmlAt(10), { coi: "9999999" }).coi, "200000");
  assert.equal(sanitizeStatChanges(xmlAt(30), { coi: "9999999" }).coi, "1000000");
  assert.equal(sanitizeStatChanges(xmlAt(60), { coi: "99999999" }).coi, "5000000");
  assert.equal(sanitizeStatChanges(xmlAt(30), { coi: "5000" }).coi, "5000");
});

test("sanitize leaves other fields, empties, and garbage alone", () => {
  const out = sanitizeStatChanges(xmlAt(10), { tca: "", coi: "abc", lvl: "999", win: "5" });
  assert.equal(out.tca, "");
  assert.equal(out.coi, "abc");
  assert.equal(out.lvl, "999");
  assert.equal(out.win, "5");
});

test("applyStatChanges writes the capped value, not the requested one", () => {
  const out = applyStatChanges(xmlAt(10), { tca: "999999" });
  assert.match(out, /<Var\b[^>]*\bname="moneyCash"[^>]*\bv="3000"/);
  assert.ok(!out.includes('v="999999"'));
});
