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
  // Old EXE builds without deviceId must resolve immediately, never hang.
  assert.ok(tsx.includes('typeof bridge.deviceId !== "function"'), "old bridge must short-circuit");
});

test("every launch stops at the login screen, never auto-unlocks", () => {
  const tsx = read("../components/studio-app.tsx");
  assert.ok(!tsx.includes("autoLogin"), "no auto-login path may remain");
  assert.ok(!tsx.includes("loadSavedKey()"), "boot must not read the saved key");
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

test("the regatta button answers for the count on screen, not the default batch", () => {
  const tsx = read("../components/studio-app.tsx");
  const tab = tsx.slice(tsx.indexOf('{tab === "regatta" &&'), tsx.indexOf('{tab === "barn" &&'));
  assert.ok(tab.length > 0, "could not locate the regatta tab markup");

  // snapshot() cannot know which number the user is about to pick, so
  // `regattaInfo.reason` is decided for the default 12. Reading it straight
  // into `disabled` is what let a save holding 12 show a dead button with the
  // count raised to 15, and a save holding 5 show a live button with the count
  // dropped to 3 — a push the server then refused.
  assert.ok(!tab.includes("session.regattaInfo.reason"), "the button must not read the default-batch reason");
  assert.ok(tab.includes('regattaState !== "ok"'), "the button must gate on the count-aware state");
  assert.ok(tsx.includes("regattaReason("), "the tab must re-run the server's own reason helper");

  // A greyed-out button with a badge two panels above it reads as "broken".
  // The refusal is now spelled out where the user is actually looking.
  assert.ok(tab.includes("REGATTA_WHY_KEY"), "the disabled button must explain itself in place");

  const i18n = read("i18n.ts");
  for (const key of ["regattaWhyNoRegatta", "regattaWhyNoTemplate", "regattaWhyWindow", "regattaWhyFull"]) {
    const m = new RegExp(`\\b${key}:\\s*"([^"]*)"`).exec(i18n);
    assert.ok(m, `${key} must exist in the dictionary`);
    assert.ok(m[1].length > 20, `${key} must say what to do, got: ${m[1]}`);
  }
  assert.ok(/\bregattaWhyFull:\s*"[^"]*\{count\}[^"]*\{max\}/.test(i18n), "regattaWhyFull must name the count and the ceiling");
});

test("the regatta tab shows the save's own daily quota, not a hardcoded number", () => {
  // The game itself reads out the limit — "Today's Tasks: 4/17", "Quota resets
  // in: 11h 10m" — and it lives in the save as `<Var name="TaskQuota">`. A
  // badge that hid it (or worse, printed a constant) would leave the user
  // unable to see why a batch of 40 was fine on one save and refused on
  // another with the same window.
  const tsx = read("../components/studio-app.tsx");
  const tab = tsx.slice(tsx.indexOf('{tab === "regatta" &&'), tsx.indexOf('{tab === "barn" &&'));
  assert.ok(tab.includes("session.regattaInfo.quota"), "the tab must read the quota the save states");

  // The decision the button makes has to be taken with that same quota, or
  // "pressable" and "will succeed" drift apart again.
  const reason = tsx.slice(tsx.indexOf("const regattaState"), tsx.indexOf("const tool ="));
  assert.ok(/quota:\s*session\.regattaInfo\.quota/.test(reason), "regattaReason must be given the save's quota");

  // Every string that talks about the number has to interpolate it rather than
  // leave a raw `{day}` in front of the user.
  const i18n = read("i18n.ts");
  for (const key of ["regattaDay", "regattaDayTip", "regattaCountHint", "regattaWhyWindow"]) {
    assert.ok(new RegExp(`\\b${key}:`).test(i18n), `${key} must exist in the dictionary`);
  }
  const raw = (tab.match(/\{day\}/g) ?? []).length;
  const substituted = (tab.match(/\.replace\("\{day\}"/g) ?? []).length;
  assert.equal(raw, substituted, "every {day} in the tab must be substituted before it is rendered");
  assert.ok(substituted >= 2, "both the hint and the refusal must carry the save's quota");
});

test("the send panel takes a ticked batch, not one card per press", () => {
  // Reported as "not like this 1 card send": choosing a card from a dropdown
  // and pressing Add, thirty times over. The panel now lights the cards it is
  // about to send and queues them in one press — while staying inside the
  // ceiling the server enforces, because a batch above it is refused and the
  // whole push is rolled back.
  const tsx = read("../components/studio-app.tsx");
  const tab = tsx.slice(tsx.indexOf('{tab === "cards" &&'), tsx.indexOf('{tab === "zoo" &&'));
  assert.ok(tab.length > 0, "could not locate the cards tab markup");

  // the one-card dropdown is gone...
  assert.ok(!tab.includes("setSendCard"), "the single-card picker must be gone");
  assert.ok(!tab.includes("sendableIds.includes(sendCard)"), "no dropdown choosing one card at a time");

  // ...replaced by a ticked grid over everything this push could send
  assert.ok(tab.includes("checked={sendSel.has(id)}"), "the picker must be tickable");
  assert.ok(tab.includes("setSendSel(new Set(sendableIds))"), "select all must light every sendable card");
  assert.ok(/queueSend\(sendFresh\(sendPicked\)\)/.test(tab), "one press must queue the whole selection");
  assert.ok(/\{tr\("sendAdd"\)\} \(\{sendPickedCount\}\)/.test(tab), "the button must show how many it will add");

  // One press still means one entry per (card, friend): anything already
  // queued to this recipient is not counted or written a second time.
  assert.ok(tab.includes("sendFresh("), "cards already queued to this friend must not be queued again");

  // The ceiling has to be the server's own number, not a guess in the UI, or
  // "send every card I have" queues 151 and the server refuses all 151.
  assert.ok(tab.includes("CARD_SEND_MAX_PER_RUN"), "the button must count against the shared ceiling");
  assert.match(
    read("cards.ts"),
    /export const CARD_SEND_MAX_PER_RUN = 150/,
    "the ceiling lives in the browser-safe module",
  );
  const server = read("server/township/cards.server.ts");
  assert.ok(/export \{ CARD_SEND_MAX_PER_RUN \}/.test(server), "the server must re-export that same number");
  assert.ok(!/export const CARD_SEND_MAX_PER_RUN/.test(server), "a second definition would drift from the first");

  // A disabled button that says nothing reads as broken — same lesson as the
  // regatta tab, where the refusal is spelled out where the user is looking.
  const i18n = read("i18n.ts");
  for (const key of ["sendPickHint", "sendCapNote"]) {
    assert.ok(new RegExp(`\\b${key}:`).test(i18n), `${key} must exist in the dictionary`);
  }
  assert.ok(/\bsendCapNote:\s*"[^"]*\{count\}/.test(i18n), "sendCapNote must name the ceiling");
  assert.ok(tab.includes('tr("sendCapNote")'), "an over-cap selection must say why it cannot be queued");
});

test("the age warning is shown where the copy happens, and never gates it", () => {
  const tab = read("../components/studio-app.tsx");
  const i18n = read("i18n.ts");
  const server = read("server/studio.server.ts");

  // The account's own age is the one thing on file that separates every clean
  // save from every banned one, so it has to be read where the push is
  // pressed rather than only inside a test.
  assert.ok(
    /accountAge:\s*accountAgeInfo\(/.test(server),
    "the snapshot must expose the account's age to the tab",
  );

  assert.ok(tab.includes("session.accountAge"), "the tab must read it");
  assert.ok(/\bfresh\b/.test(tab), "the warning is keyed on `fresh`");

  // Twice: above the restore buttons, and above the copy section — the two
  // places a full copy is actually queued.
  const shown = tab.match(/tr\("acctFresh(?:Hours)?"\)/g) ?? [];
  assert.ok(shown.length >= 2, `the warning must appear at both copy points, found ${shown.length}`);

  for (const key of ["acctFresh", "acctFreshHours"]) {
    assert.ok(new RegExp(`\\b${key}:`).test(i18n), `${key} must exist in the dictionary`);
  }
  assert.ok(/\bacctFresh:\s*"[^"]*\{d\}/.test(i18n), "acctFresh must name the day count");
  assert.ok(/\bacctFreshHours:\s*"[^"]*\{h\}/.test(i18n), "acctFreshHours must name the hours");

  // A warning that disables the button is a gate by another name, and the
  // block was explicitly declined: push stays available.
  assert.ok(
    !/disabled=\{[^}]*accountAge/.test(tab),
    "the account's age must not gate the push",
  );
});
