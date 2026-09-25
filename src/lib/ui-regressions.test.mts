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
  assert.ok(css.includes(".app-root .app-main::after"), "the rgb edge must ride on app-main::after like the login card");
  assert.ok(css.includes("mask-composite: exclude"), "the edge must be masked to the border ring");
  for (const stop of ["#22d3ee", "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#f97316", "#22c55e"]) {
    assert.ok(css.includes(stop), `rgb edge must flow through ${stop}`);
  }
  assert.ok(css.includes("premium-rgb-flow 9s"), "the rgb flow must run smooth and continuous");
  assert.ok(!css.includes("var(--premium-rgb-border)"), "no dead rgb layer vars may remain");
});

test("sidebar shell and login card share the same rgb comet ring", () => {
  const css = read("../styles.css");
  for (const sel of [".app-sidebar::after", ".app-main::after"]) {
    assert.ok(css.includes(sel), `rgb ring must exist on ${sel}`);
  }
  for (const sel of [".device-selector-card::after", ".sidebar-tools::after", ".sidebar-log > div::after"]) {
    assert.ok(!css.includes(sel), `inner ${sel} must stay calm (gold flow, no rgb ring)`);
  }
  const logins = css.match(/\.login-card::after\s*\{[^}]*\}/g) ?? [];
  assert.equal(logins.length, 2, "both login-card border rules must exist");
  for (const block of logins) {
    assert.ok(block.includes("#22d3ee"), "login border must flow rgb cyan");
    assert.ok(!block.includes("#f59e0b") && !block.includes("#f0c76a"), "login border gold comet must be gone");
  }
});

test("device id waits for the native bridge instead of minting per launch", () => {
  const tsx = read("../components/studio-app.tsx");
  // The shell injects window.iggNative ~100ms after boot; a one-shot read
  // here would miss it every launch and mint a fresh random id instead.
  assert.ok(tsx.includes("igg-native-ready"), "boot must listen for bridge injection");
  assert.ok(tsx.includes("deviceReady"), "auto-login must wait for the settled id");
  assert.ok(tsx.includes("!deviceReady || token"), "auto-login gate must include readiness");
  // Old EXE builds without deviceId must resolve immediately, never hang.
  assert.ok(tsx.includes('typeof bridge.deviceId !== "function"'), "old bridge must short-circuit");
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
