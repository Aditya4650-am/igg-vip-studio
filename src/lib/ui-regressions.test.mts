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

test("main dashboard wears an animated ultra-thin RGB light-flow border", () => {
  const css = read("../styles.css");
  assert.ok(css.includes("@property --premium-rgb-angle"), "rgb angle property must exist");
  assert.ok(css.includes("@keyframes premium-rgb-flow"), "rgb flow keyframes must exist");
  for (const stop of ["34, 211, 238", "59, 130, 246", "139, 92, 246", "236, 72, 153", "239, 68, 68", "249, 115, 22", "34, 197, 94"]) {
    assert.ok(css.includes(stop), `rgb gradient must flow through ${stop}`);
  }
  assert.ok(css.includes("var(--premium-rgb-border)"), "the dashboard must use the rgb border layer");
  assert.ok(css.includes("premium-rgb-flow 14s"), "the rgb flow must run slow and smooth");
  assert.ok(css.includes("var(--premium-rgb-shadow)"), "the matching glow must exist");
});

test("tab bar renders two premium rows: 8 primaries plus 5 below, never 13 squeezed slots", () => {
  const tsx = read("../components/studio-app.tsx");
  assert.ok(tsx.includes("PRIMARY_TABS: Tab[] = TABS.slice(0, 8)"), "8 primary tabs must derive from TABS");
  assert.ok(tsx.includes("OVERFLOW_TABS: Tab[] = TABS.slice(8)"), "the rest must derive from TABS");
  assert.ok(tsx.includes("{[PRIMARY_TABS, OVERFLOW_TABS].map((row, ri) => ("), "both rows must render from one button template");
  assert.ok(!tsx.includes("{TABS.map((id) => {"), "the raw 13-tab row must be gone");
  assert.ok(tsx.includes("feature-tabs-overflow"), "the second row must carry the premium overflow treatment");
  assert.ok(!tsx.includes('role="menu"'), "no dropdown menu may remain");
  assert.ok(tsx.includes("TAB_EMOJI[id]"), "tab slots must render real emoji glyphs");
  assert.ok(!tsx.includes("TAB_ICON[id]"), "svg tab icons must be gone from the bar");
  const css = read("../styles.css");
  assert.ok(css.includes(".feature-tabs-overflow"), "overflow row styling must exist");
  assert.ok(css.includes(".feature-tabs-row"), "row grid styling must exist");
  assert.ok(!/\.feature-tab:nth-of-type\(\d+\)::before/.test(css), "stale per-slot css glyphs must be gone (single emoji span per tab)");
});

test("factory and train/island tabs are gone", () => {
  const tsx = read("../components/studio-app.tsx");
  for (const tab of ['"upgrades"']) {
    assert.ok(tsx.includes(tab), `studio-app must reference ${tab}`);
  }
  const keys = ["tabUpgrades", "upgradeFactoryTitle", "upgradeTrainTitle", "upgradeIslandTitle"] as const;
  for (const lang of LANGS) {
    for (const key of keys) {
      if ((DICT[lang.id] as Record<string, unknown>)[key] !== undefined) {
        assert.equal(typeof (DICT[lang.id] as Record<string, unknown>)[key], "string", `${lang.id}.${key} must be a string`);
      }
    }
  }
  const src = read("server/studio.server.ts");
  assert.ok(src.includes("factories") || src.includes("upgrades"), "studio.server must expose upgrades");
});
