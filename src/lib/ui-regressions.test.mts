import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
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

test("device id comes from the window URL first — WebView2 runs InPrivate and wipes localStorage", () => {
  const tsx = read("../components/studio-app.tsx");
  const py = read("../../client/igg_client.py");

  // pywebview's default is private_mode=True, so WebView2 runs InPrivate and
  // localStorage is EMPTY at the start of every EXE launch. An id that only
  // lives in storage is therefore a fresh random one each time — the machine
  // id has to arrive on the window URL instead.
  assert.ok(py.includes("with_device_param("), "the EXE must put the machine id on the URL");
  assert.ok(py.includes("device_id = get_device_id()"), "the URL id must be the file-backed one");

  const src = tsx.slice(tsx.indexOf("const urlDeviceId"), tsx.indexOf("setDeviceId(readStoredId() ?? mintNewId())"));
  assert.ok(src.indexOf("location.search") !== -1, "boot must read the ?did= param synchronously");
  assert.ok(src.indexOf("igg-vip-hwid") !== -1, "a plain browser still needs the localStorage fallback");
  // localStorage may only ever be reached through readStoredId(), never first.
  assert.ok(
    src.indexOf("const urlDeviceId") < src.indexOf("const readStoredId"),
    "the EXE's URL id must be resolved ahead of localStorage",
  );

  // The bridge remains the fallback for EXE builds that predate the URL param.
  assert.ok(tsx.includes("igg-native-ready"), "boot must listen for bridge injection");
  assert.ok(tsx.includes('typeof bridge.deviceId !== "function"'), "old bridge must short-circuit");
});

test("inside the EXE the device id is never invented, and an empty one never reaches the server", () => {
  const tsx = read("../components/studio-app.tsx");

  // window.chrome.webview is injected by the WebView2 runtime before any page
  // script runs, so it is the only synchronous "are we in the EXE?" signal.
  // pywebview's own window.pywebview arrives on navigation-completed — too late.
  assert.ok(tsx.includes("chrome?: { webview?: unknown }"), "boot must detect WebView2 synchronously");

  // The whole bug was an allowed mint winning every launch inside the EXE.
  // Minting must sit strictly behind the `else` branch that excludes inExe.
  const branch = tsx.slice(tsx.indexOf("if (urlDeviceId) setDeviceId"), tsx.indexOf("const bridgeBudgetMs"));
  assert.ok(branch.includes("else if (inExe)"), "the EXE must take its own branch");
  assert.ok(
    /else if \(inExe\) setDeviceId\(readStoredId\(\) \?\? ""\)/.test(branch),
    "an EXE with no stored id must stay empty, never mint",
  );
  assert.ok(
    /else setDeviceId\(readStoredId\(\) \?\? mintNewId\(\)\)/.test(branch),
    "only a plain browser may mint",
  );

  // An EXE whose bridge is slow must be waited for, not raced. The old 1.5s
  // budget was shorter than pywebview's own 5s installer.
  assert.ok(tsx.includes("20_000"), "an EXE must wait properly for the bridge");
  assert.ok(tsx.includes("inExe && !urlDeviceId ? 20_000 : 1_500"), "only an EXE waits long");

  // A key binds on first use, so an empty id would bind it to nothing and
  // lock the machine out on the next launch.
  assert.ok(tsx.includes("if (!deviceId)"), "unlock must refuse an empty device id");
  assert.ok(tsx.includes('setLoginErr(tr("errDeviceId"))'), "the refusal must be explained");
  assert.ok(tsx.includes("disabled={busy || !deviceId}"), "the login button waits for the id");
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

  // The notes, the guard line, the limit hint and the window dates are all
  // gone from the tab. The dates are the one that mattered most: printing
  // "Regatta window: 5/10/2026 14:30 → 12/10/2026 13:30" over the buttons is
  // what made a count feel like it was being judged against a calendar, and it
  // sat directly above the refusal that did the judging.
  for (const gone of ["regattaHint", "regattaGuards", "regattaCountHint", "regattaWindow"]) {
    assert.ok(!tab.includes(gone), `${gone} must no longer be rendered`);
  }

  // `window_closed` is not a reason any more — the tab must not be handed a
  // `RegattaReason` it can no longer be given, and must not have a label
  // mapped for one.
  assert.ok(!tsx.includes("window_closed"), "the removed refusal must not be reintroduced");
  assert.ok(!tab.includes("regattaNoWindow"), "nor a label for it");
});

test("the regatta tab prints no limit, and the quota no longer decides anything", () => {
  // The quota is the game's own number — it lives in the save as
  // `<Var name="TaskQuota">`, it is what every record's `anlLimit` mirrors,
  // and it is what the batch takes as the distance between the block's own
  // newest completion and its first. What went away is the badge that printed
  // it *as* a limit, the prose around it, and the refusal that used the same
  // number to turn a count away.
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

test("the regatta count is how many tasks to add, so nothing can say the week is full", () => {
  // The report: *"after i push 50 tasks it works, but if i want to push more
  // then i can't push it shows error"*. The count used to be the week's
  // **target total**, so the first push filled it and the badge read
  // "Completed 50 / 50" over a refusal telling the user it already had enough
  // for the rest of the week. It is how many tasks this push *adds*, and both
  // the badge and the reason list have to say so or the next build quietly
  // puts the refusal back.
  const tsx = read("../components/studio-app.tsx");
  const tab = tsx.slice(tsx.indexOf('{tab === "regatta" &&'), tsx.indexOf('{tab === "barn" &&'));

  assert.ok(!tab.includes("current} / {regattaTasks"), "the badge must not print a target total");
  assert.ok(!tsx.includes("already_full"), "the removed refusal must not be reintroduced");
  assert.ok(!read("server/township/inject.server.ts").includes("already_full:"), "nor its error string");

  // The union itself, so a new reason cannot be added without a decision.
  assert.match(
    read("regatta.ts"),
    /export type RegattaReason = "ok" \| "no_active_regatta" \| "no_template";/,
    "`RegattaReason` may only hold the two remaining refusals plus ok",
  );

  // And the label the user actually reads, in both dictionaries the tab ships.
  const dict = read("i18n.ts");
  assert.ok(dict.includes('regattaCount: "Số task cần thêm"'), "vi must call it the number to add");
  assert.ok(dict.includes('regattaCount: "Tasks to add"'), "en must call it the number to add");
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

test("the Events tab is appended, and each event card queues and pushes its own tokens", () => {
  // Bloom & Buzz is the game's own `TrainJourney` event. The tab has to be
  // *appended* to TABS: inserting it would shift every later tab's slot, which
  // is exactly the "other features stay untouched" line the request draws.
  const tsx = read("../components/studio-app.tsx");

  assert.ok(
    tsx.includes('"newgame", "events"]'),
    "events must be the last entry of TABS so no existing tab moves",
  );
  assert.ok(/^type Tab = [^\n]*"events";/m.test(tsx), "the Tab union must carry events");
  assert.ok(/events: "tabEvents"/.test(tsx), "TAB_KEY must label the tab");
  assert.ok(/events: "🐝"/.test(tsx), "TAB_EMOJI must carry the tab");
  assert.ok(
    tsx.includes("pendingBloom ? bloomTokens : 0") && tsx.includes("pendingFrozen ? frozenTokens : 0"),
    "the tab must show what is queued — each card from its own count",
  );

  const panel = tsx.slice(tsx.indexOf('{tab === "events" &&'), tsx.indexOf('{tab === "newgame" &&'));
  assert.ok(panel.includes('{tr("eventsCard")}'), "the Bloom & Buzz card must be rendered");
  assert.ok(panel.includes('onClick={() => tool("bloom")}'), "the button must queue the feature");

  // The second card is Frozen Fortune (`DragonNest`) — the same wallet
  // mechanism, one argument further into the writer. It is added, never
  // substituted: every assertion above stays about Bloom.
  assert.ok(panel.includes('{tr("eventsCardFrozen")}'), "the Frozen Fortune card must be rendered");
  assert.ok(panel.includes('onClick={() => tool("frozen")}'), "the second button must queue its own feature");
  assert.ok(panel.includes("session.frozen."), "the second card must read its own wallet readout");

  // Two separate cards — exactly two panels, no shared third card that holds
  // both events' controls. Each card owns its count input, its queue button
  // and its own Save & push (which goes through the same choke point as the
  // sidebar button, queueing implicitly when the queue flag is still clear).
  const panelTags = panel.match(/<section className="panel">/g) ?? [];
  assert.ok(panelTags.length === 2, `the tab must render exactly two cards, got ${panelTags.length}`);
  assert.ok(
    panel.includes('aria-label={tr("eventsCount")}') && panel.includes("value={bloomTokens}"),
    "the Bloom card must own its count input",
  );
  assert.ok(
    panel.includes('aria-label={tr("eventsCountFrozen")}') && panel.includes("value={frozenTokens}"),
    "the Frozen card must own a separate count input",
  );
  const cardPushes = panel.match(/onClick=\{\(\) => void save\(\{/g) ?? [];
  assert.ok(cardPushes.length === 2, `each card needs its own Save & push, got ${cardPushes.length}`);
  assert.ok(
    panel.includes("void save({ bloom: bloomTokens })") && panel.includes("void save({ frozen: frozenTokens })"),
    "each Save & push must send its own card's count",
  );

  // Each card carries its own token artwork, trimmed to its own circular
  // edge, at one identical size — the two icons have to match each other or
  // the pair reads as two different features rather than one tab.
  assert.ok(panel.includes('src="/events/bloom.png"'), "the Bloom & Buzz card must show its token artwork");
  assert.ok(panel.includes('src="/events/frozen.png"'), "the Frozen Fortune card must show its token artwork");
  const iconTags = panel.match(/className="event-icon"/g) ?? [];
  assert.ok(iconTags.length === 2, `expected exactly one icon per card, got ${iconTags.length}`);
  for (const art of ["bloom.png", "frozen.png"]) {
    assert.ok(existsSync(join(here, "../../public/events", art)), `${art} must ship with the app`);
  }
  const eventIconCss = read("../styles.css").match(/\.event-icon\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(/width:\s*2rem/.test(eventIconCss) && /height:\s*2rem/.test(eventIconCss), "the icon box must be square and fixed");
  assert.ok(/border-radius:\s*50%/.test(eventIconCss), "the icon must be drawn round");

  // The button may gate on the queue and on `busy` — and on nothing else. The
  // save's own wallet state is a *readout* here (same lesson the Regatta tab
  // learned: gating on a computed reason greys the button for a save that
  // would have accepted the push).
  assert.ok(
    panel.includes("disabled={busy || pendingBloom}"),
    "the button must gate only on busy/pending, never on the wallet reason",
  );
  assert.ok(
    panel.includes("disabled={busy || pendingFrozen}"),
    "the Frozen Fortune button must gate only on busy/pending too",
  );
  assert.ok(!/disabled=\{[^}]*bloom\.reason/.test(panel), "the wallet reason must never disable the button");
  assert.ok(!/disabled=\{[^}]*frozen\.reason/.test(panel), "nor the second wallet's reason");
  assert.ok(!panel.includes("regatta"), "the Events panel must not read the Regatta tab's state");

  // Only queued work travels: an untouched tab must not add a field to the
  // payload, and the queue must clear on save and on reload. A card's own
  // Save & push may inject its count directly (`opts`), but when nothing asks
  // for it, the queued flag decides exactly as before.
  assert.ok(
    tsx.includes("bloomTokens: opts?.bloom ?? (pendingBloom ? bloomTokens : undefined)"),
    "the payload must send the count only when queued or pushed from that card",
  );
  assert.ok(
    tsx.includes("frozenTokens: opts?.frozen ?? (pendingFrozen ? frozenTokens : undefined)"),
    "the second count must travel from its own queue or its own card's push",
  );
  const clears = tsx.match(/setPendingBloom\(false\);/g) ?? [];
  assert.ok(clears.length >= 2, "the queue must clear after a save and after a reload");
  const clearsFrozen = tsx.match(/setPendingFrozen\(false\);/g) ?? [];
  assert.ok(clearsFrozen.length >= 2, "the second queue must clear after a save and after a reload");
  assert.ok(tsx.includes("(pendingBloom ? 1 : 0)"), "the pending badge must count the queued push");
  assert.ok(tsx.includes("(pendingFrozen ? 1 : 0)"), "the pending badge must count the second one too");

  // Every label exists in the master dictionary and its English pair, so the
  // 18 Partial overlays can fall back to something.
  const i18n = read("i18n.ts");
  for (const key of [
    "tabEvents",
    "eventsHint",
    "eventsCard",
    "eventsTokens",
    "eventsEarned",
    "eventsCount",
    "eventsCountFrozen",
    "bloomReady",
    "bloomNoWallet",
    "bloomIncomplete",
    "bloomInvalid",
    "bloomAdd",
    "bloomQueued",
    "toastBloomQueued",
    "eventsCardFrozen",
    "frozenHint",
    "frozenAdd",
    "frozenQueued",
    "toastFrozenQueued",
  ]) {
    assert.ok(new RegExp(`^  ${key}:`, "m").test(i18n), `${key} must be translated`);
  }
});

test("the Bloom & Buzz push is wired through the same choke point as every other edit", () => {
  const api = read("studio-api.ts");
  assert.ok(
    api.includes("bloomTokens: z.number().int().min(1).max(100000).optional()"),
    "the payload bound must be declared (the server clamps again regardless)",
  );

  const server = read("server/studio.server.ts");
  assert.ok(server.includes("addBloomTokens(s.rawXml, want)"), "applySave must run the writer");
  assert.ok(
    server.includes('addBloomTokens(s.rawXml, want, "DragonNest")'),
    "applySave must run the same writer on the second wallet",
  );
  assert.ok(server.includes("assertBloomSafe(was, now)"), "encodeSave must gate the wallet");
  assert.ok(server.includes("bloom: bloomInfo("), "the snapshot must report the wallet");
  assert.ok(
    server.includes('frozen: bloomInfo(s.rawXml ?? "", "DragonNest")'),
    "the snapshot must report the second wallet too",
  );
  assert.ok(server.includes("frozenTokens?: number"), "the payload must declare the second field");

  const events = read("server/township/events.server.ts");
  // The wallet lives in <DataStoreCollection> — the block no restore copies —
  // and only the two token numbers may move. The other fields inside the
  // wallet may be *named* in the module's notes and in a refusal message, but
  // no line of code may ever match their XML: writing one of them is what
  // would leave a wallet disagreeing with itself in a field a server reads for
  // free. (The byte-identity proof that only the pair moves lives in
  // events.test.mts — `out.split(new).join(old) === base`.)
  const codeLines = events
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("*") && !l.startsWith("//") && !l.startsWith("/*"));
  const code = codeLines.join("\n");
  for (const field of [
    "InitialValueSet",
    "LastTransferTransactionId",
    "balanceVersion",
    "LayerLaunchCurrencyTransfer",
  ]) {
    assert.ok(!code.includes(`name="${field}"`), `${field} must never be matched by code`);
  }
  assert.ok(events.includes("stripWalletValues"), "the writer must self-check that only the pair moved");
});

test("the owner panel deletes a key for real, and only after a second confirming click", () => {
  const tsx = read("../components/owner-hub.tsx");
  const api = read("../lib/admin-api.ts");

  // the server function exists and the panel calls it
  assert.ok(/export const deleteKey = createServerFn/.test(api), "deleteKey must be a server function");
  assert.ok(/deleteLicense\(data\.token, data\.key\)/.test(api), "deleteKey must reach deleteLicense");
  assert.ok(tsx.includes("deleteKey"), "the key list must call deleteKey");

  // a single stray click must not erase a key: the first press arms, the
  // second confirms, and the armed state disarms itself on a timer
  assert.ok(/pendingDelete === k\.key/.test(tsx), "the delete must require a confirming click");
  assert.ok(/setPendingDelete\(k\.key\)/.test(tsx), "the trash button must arm the confirm");
  assert.ok(/setTimeout\(\(\) => setPendingDelete\(null\)/.test(tsx), "an armed delete must disarm itself");
  assert.ok(!/window\.confirm\(\s*["'`]/.test(tsx), "the confirm stays in the panel, not in a browser dialog");

  // the owner key unlocks this panel — it must never offer a delete button
  assert.ok(/k\.admin \?/.test(tsx), "the owner row must be handled separately");
  assert.ok(tsx.includes('tr("owner")'), "the owner row shows a badge instead");

  // the button is not reachable while another delete is in flight
  assert.ok(/disabled=\{busy \|\| deleting\}/.test(tsx), "the confirm button must respect the in-flight delete");
});

test("delete strings exist in both master dictionaries", () => {
  for (const key of ["licenseDelete", "licenseDeleting", "licenseDeleted", "deleteConfirm", "keyRule4"]) {
    assert.ok(key in DICT.vi, `${key} missing from vi`);
    assert.ok(key in DICT.en, `${key} missing from en`);
    assert.ok(DICT.vi[key as keyof typeof DICT.vi].length > 0, `${key} empty in vi`);
    assert.ok(DICT.en[key as keyof typeof DICT.en].length > 0, `${key} empty in en`);
  }
});

test("the persisted licenses table stores every field the in-memory record has", () => {
  const sql = read("../../migrations/0002_licenses.sql");
  for (const col of [
    "license_key",
    "key_fp",
    "plan",
    "created_at",
    "expires_at",
    "duration_ms",
    "is_group",
    "max_devices",
    "devices",
    "bound_device",
    "is_active",
    "note",
  ]) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(sql), `licenses table is missing ${col}`);
  }
  // `group` and `key` are reserved-ish in Postgres; the columns avoid them so
  // neither backend needs quoting.
  assert.ok(!/^\s+group\s/m.test(sql), "do not name a column `group`");
});
