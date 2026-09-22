import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LANGS, DICT } from "./i18n";

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

test("factory and train/island tabs are gone", () => {
  const tsx = read("../components/studio-app.tsx");
  for (const tab of ['"factory"', '"upgrades"', "tabFactory", "tabUpgrades", "factoryHint", "trainMax", "islandMax"]) {
    assert.ok(!tsx.includes(tab), `studio-app must not reference ${tab}`);
  }
  const keys = ["tabFactory", "factoryHint", "tabUpgrades", "trainMax", "islandMax", "trainNone", "islandNone"] as const;
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.equal((DICT[lang.id] as Record<string, unknown>)[key], undefined, `${lang.id}.${key} must be removed`);
    }
  }
  const src = read("server/studio.server.ts");
  assert.ok(!src.includes("factories"), "studio.server must not expose factories");
  assert.ok(!src.includes("trainMax"), "studio.server must not expose trainMax");
  assert.ok(!src.includes("islandMax"), "studio.server must not expose islandMax");
});
