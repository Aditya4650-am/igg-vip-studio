import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LANGS, DICT, type Dict } from "./i18n";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

test("avatar wells render square artwork, not circles", () => {
  const css = read("../styles.css");
  const blocks = [...css.matchAll(/\.chip-asset-avatar(?:\s+\.chip-asset-img)?\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(blocks.length >= 2, "expected both the base and .app-root avatar well rules");

  for (const block of blocks) {
    assert.ok(
      !/border-radius:\s*999px/.test(block),
      `avatar well must not be a circle:\n${block}`,
    );
  }

  const img = blocks.filter((b) => b.includes(".chip-asset-img"));
  for (const block of img) {
    // square artwork must be shown whole; cover would crop it to a circle
    assert.ok(/object-fit:\s*contain/.test(block), `avatar image must not crop the artwork:\n${block}`);
  }
});

test("data center cards show the real PNG and drop the decorative glyph", () => {
  const tsx = read("../components/studio-app.tsx");
  const card = tsx.slice(tsx.indexOf('{tab === "data" &&'), tsx.indexOf('{tab === "profile" &&'));
  assert.ok(card.length > 0, "could not locate the data center tab markup");

  // the real artwork stays...
  assert.ok(card.includes("stat-asset-img"), "the real PNG icon must still render");
  assert.ok(card.includes("iconForStat"), "stat cards must still resolve real PNG artwork");

  // ...and the decorative svg that sat between the PNG and the label is gone
  assert.ok(!card.includes("stat-icon"), "the decorative stat glyph must not come back");
  assert.ok(!/statIcon\(/.test(card), "no decorative stat icon resolver in the data center");
});

test("factory tab strings exist in every shipped language", () => {
  // The tab was added with only vi/en populated, which left it half-English in
  // the other 18 languages. Guard the whole set so adding a language (or a new
  // factory string) cannot silently reintroduce that.
  const keys = [
    "tabFactory", "factoryHint", "factoryMax", "factoryMaxAll", "factoryAt",
    "factorySelected", "factoryNone", "factoryCapped", "factoryBackup",
    "factoryBackupHint", "factoryBackupDone",
  ] as const satisfies readonly (keyof Dict)[];
  for (const lang of LANGS) {
    for (const key of keys) {
      const value = DICT[lang.id][key];
      assert.ok(value, `${lang.id}.${key} is missing`);
      assert.equal(typeof value, "string", `${lang.id}.${key} must be a string`);
    }
  }
});

test("factory strings are actually translated, not English fallbacks", () => {
  // A copy-pasted English string would still satisfy the presence check above,
  // so compare the tab label against English for the non-English dictionaries.
  // id is allowed to match: "Pabrik"/"Factories" — assert the ones that differ.
  const untranslated = LANGS.filter((l) => l.id !== "en" && l.id !== "vi")
    .filter((l) => DICT[l.id].tabFactory === DICT.en.tabFactory);
  assert.deepEqual(untranslated.map((l) => l.id), [], "these still read as English");
});

test("the capped hint keeps its {max} placeholder in every language", () => {
  // The UI fills it with .replace("{max}", …); a translation that drops the
  // token would render the sentence with no number in it.
  for (const lang of LANGS) {
    assert.match(
      DICT[lang.id].factoryCapped,
      /\{max\}/,
      `${lang.id}.factoryCapped lost its {max} placeholder`,
    );
  }
});
