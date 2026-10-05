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

test("the regatta button is pressable on sight and never explains a refusal in place", () => {
  const tsx = read("../components/studio-app.tsx");
  const tab = tsx.slice(tsx.indexOf('{tab === "regatta" &&'), tsx.indexOf('{tab === "barn" &&'));
  assert.ok(tab.length > 0, "could not locate the regatta tab markup");

  // snapshot() cannot know which number the user is about to pick, so
  // `regattaInfo.reason` is decided for the default 12. It must never reach
  // the tab at all — not to grey the button out, not anywhere.
  assert.ok(!tab.includes("session.regattaInfo.reason"), "the button must not read the default-batch reason");

  // The count no longer gates anything: type a number, press the button, done.
  // A greyed-out button with a paragraph of prose underneath it is exactly
  // what was asked to go, so nothing may re-introduce either half.
  assert.ok(!tab.includes('regattaState !== "ok"'), "the button must not be gated on the count-aware state");
  assert.ok(!tab.includes("REGATTA_WHY_KEY"), "no refusal is spelled out under the button");
  assert.ok(/disabled=\{busy \|\| pendingRegatta\}/.test(tab), "only a push already in flight may disable it");

  // The notes, the guard line and the limit hint are all gone from the tab.
  for (const gone of ["regattaHint", "regattaGuards", "regattaCountHint"]) {
    assert.ok(!tab.includes(gone), `${gone} must no longer be rendered`);
  }
});

test("regatta spacing still follows the save's own daily quota, but the tab prints no limit", () => {
  // The quota is the game's own number — it lives in the save as
  // `<Var name="TaskQuota">` and it is what spaces one completion from the
  // next, so a batch never collapses a day's worth of tasks into one pile.
  // That arithmetic is untouched. What went away is the badge that printed
  // the quota *as* a limit and the prose around it.
  const tsx = read("../components/studio-app.tsx");
  const tab = tsx.slice(tsx.indexOf('{tab === "regatta" &&'), tsx.indexOf('{tab === "barn" &&'));
  assert.ok(!tab.includes("session.regattaInfo.quota"), "the tab must not print the quota as a limit");
  assert.ok(!tab.includes("regattaDay"), "no daily-limit badge may come back");

  // The decision still has to be taken with that same quota, or the batch the
  // button queues and the batch the server writes drift apart.
  const reason = tsx.slice(tsx.indexOf("const regattaState"), tsx.indexOf("const tool ="));
  assert.ok(/quota:\s*session\.regattaInfo\.quota/.test(reason), "regattaReason must be given the save's quota");

  // No placeholder may reach the user once the hints are gone.
  assert.ok(!tab.includes("{day}"), "no raw {day} placeholder may be rendered");
  assert.ok(!tab.includes("{max}"), "no raw {max} placeholder may be rendered");
});

test("the copy is never gated, and no age banner is drawn over it", () => {
  const tab = read("../components/studio-app.tsx");
  const server = read("server/studio.server.ts");

  // The account's age is still measured and exposed — it is the one field on
  // file that separates every clean save from every banned one — but the
  // banner was explicitly asked to be removed on 2026-10-02: a nag above the
  // buttons was not what the user wanted, so the tab must not draw one.
  assert.ok(
    /accountAge:\s*accountAgeInfo\(/.test(server),
    "the snapshot must keep exposing the account's age",
  );
  assert.ok(
    !tab.includes("session.accountAge"),
    "the tab must not render an account-age banner",
  );
  assert.ok(
    !tab.includes("acctFresh"),
    "the age banner copy must not be used anywhere",
  );
  assert.ok(
    !/acctFresh/.test(read("i18n.ts")),
    "the banner strings are gone with it",
  );

  // The block was explicitly declined, and stays declined: push is available
  // whatever the account's age.
  assert.ok(
    !/disabled=\{[^}]*accountAge/.test(tab),
    "the account's age must not gate the push",
  );
});

test("the copy is staged like the reference tool: one push per stage, in order", () => {
  const tab = read("../components/studio-app.tsx");
  const dict = read("i18n.ts");

  // No one-shot path is left in the copy section. The reference tool
  // (`twndesban2`, ETAPA 1/2/3) never transplants a town in one push: each
  // stage force-stops the game and re-pulls mGameInfo.xml first, so every edit
  // lands on a save the game has already accepted. Every banned save on file
  // is the opposite shape — a whole city pushed onto an account that had never
  // finished a tutorial or synced once.
  assert.ok(
    /onCopy:\s*\(k:\s*"decor"\s*\|\s*"stage1"\s*\|\s*"stage2"\s*\|\s*"stage3"\)/.test(tab),
    "the copy section must expose three staged pushes, not a single full-city button",
  );
  assert.ok(
    !tab.includes('onCopy("city")'),
    "the one-shot complete-city path must be gone",
  );

  // The stages are the three restore modes, in the reference tool's order:
  // stats first, the town second, the advanced blocks last.
  assert.ok(
    /kind === "stage1"\s*\?\s*"inicial"\s*:\s*kind === "stage2"\s*\?\s*"completo"\s*:\s*"novo"/.test(tab),
    "stage 1/2/3 must map to inicial/completo/novo",
  );

  // A stage only counts as done once its own push succeeded, so a refused or
  // failed Save & push can never unlock the next one.
  assert.ok(
    /const unbanStage = pendingUnban === "inicial" \? 1 : pendingUnban === "completo" \? 2 : pendingUnban === "novo" \? 3 : 0;/.test(
      tab,
    ),
    "the stage is derived from the mode that was actually queued",
  );
  assert.ok(
    (tab.match(/if \(unbanStage\) setCopyStage\(/g) ?? []).length >= 2,
    "both push paths must advance the stage, and only after the push returns",
  );
  assert.ok(
    !/setCopyStage\(1\)|setCopyStage\(2\)|setCopyStage\(3\)/.test(tab),
    "the stage must never be advanced at queue time — only pushed",
  );

  // Each stage stays locked until the one before it has been pushed, and a new
  // donor starts the wizard over.
  assert.ok(
    /disabled=\{busy \|\| stage >= 1\}/.test(tab) &&
      /disabled=\{busy \|\| stage !== 1\}/.test(tab) &&
      /disabled=\{busy \|\| stage !== 2\}/.test(tab),
    "the three stage buttons must be gated on the stage that was actually pushed",
  );
  assert.ok(
    /setCopyStage\(0\)/.test(tab),
    "fetching a new donor must restart the wizard",
  );

  // The between-stage instructions are the part the reference tool states
  // outright ("Abra o jogo, complete o tutorial e libere o zoológico antes da
  // etapa 3"), so both halves of the dictionary carry them.
  for (const key of [
    "copyStageLead",
    "copyStage1",
    "copyStage2",
    "copyStage3",
    "copyStageHint1",
    "copyStageHint2",
    "copyStageDone",
    "copyStageNext",
    "copyStageQueued",
  ]) {
    assert.ok(
      new RegExp(`^  ${key}:`, "m").test(dict),
      `${key} must be translated`,
    );
  }
});

test("the new-account tab resets device identity before injecting", () => {
  // Reported as fresh accounts re-banned on first sync: the tab read the
  // Android ID at Backup and again at Verify but never changed it, so every
  // "new account" kept the old device's ids and the server re-linked the
  // fresh city to the old ban. The identity step must stay wired between the
  // two, verified, or a future cleanup deletes the only thing that breaks
  // the link.
  const tsx = read("../components/studio-app.tsx");
  assert.ok(tsx.includes("onFreshIdentity"), "the handler must exist");
  const handler = tsx.slice(tsx.indexOf("const onFreshIdentity"), tsx.indexOf("const onFreshIdentity") + 2500);
  assert.ok(handler.includes("resetAndroidId"), "Android ID must be reset");
  assert.ok(handler.includes("resetGsfId"), "GSF must go too (Android ID alone re-links)");
  assert.ok(handler.includes("readAndroidId"), "the new id must be verified by re-read");
  assert.ok(tsx.includes("freshIdentityBtn"), "the tab must offer the step");
  const i18n = read("i18n.ts");
  for (const key of ["freshIdentityBtn", "freshIdentityHint", "freshIdentityDoing", "freshIdentityDone"]) {
    assert.ok(new RegExp(`\\b${key}:`).test(i18n), `${key} must exist in the dictionary`);
  }
});
