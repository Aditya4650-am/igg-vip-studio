/**
 * The *shape* half of the push gate: invariants a real Township save holds,
 * checked on every push, refused only when this tool is what broke them.
 *
 * Why a diff and not an absolute rule — a save can arrive already odd (an id a
 * newer build added, a list a different client wrote) and refusing that would
 * block the user's own file for something this tool never touched. That is
 * exactly the failure mode the first identity guard had: it counted a
 * friend-reference as identity theft and refused a clean copy. So every rule
 * here produces a *key*, `saveShapeProblems()` collects the keys a document
 * breaks, and `assertSaveShapeSafe()` refuses only keys that are **new**. A
 * key the save already had on arrival is never a reason to refuse, which is
 * also what keeps every existing feature working: an untouched block keeps
 * the same keys it arrived with.
 *
 * Every rule below was measured against real saves before being written here
 * (17 files, 6 of them genuinely fetched). Two candidate rules were dropped
 * because the measurement contradicted them, and they are recorded here so
 * nobody re-adds them:
 *
 * - **duplicate `<Var name>` is NOT an invariant** — real saves hold 0 to 35
 *   duplicated var names each (`FinishReason` x5, `startTimex2`). A "no
 *   duplicate names" rule would have refused every genuine save.
 * - **`t="s"` is a real type** — it appears once in 43,788 vars, so a rule
 *   about invented var types would have been guesswork. The type rule that
 *   *is* provable is the one below: `t="i"` holding a non-integer, which the
 *   game's loader rejects along with the whole save.
 *
 * Reasons are Vietnamese like the other gates; the reason **keys** are the
 * grep-able part (`avatar-id-out-of-range`, `chat-emoji-shape`, `upgrade-slx`,
 * `var-int`), the same convention as the card and regatta gates.
 */
import { AVATAR_MAX } from "../../catalogs";
import { RAW_PROFILE } from "../catalogs.data.server";
import { WHUDUP_XOR } from "./barn.server";
import { CHAT_EMOJI_IDS } from "./chat-emoji.server";
import { readVar } from "./vars.server";
import { attrValue, findUnbalancedTag } from "./xml-edit.server";

/**
 * Avatar ids every genuine save carries *past* the artwork range. Measured on
 * 17 saves: all 17 hold `Unlocked_ava1390` and `Unlocked_ava1391`, and those
 * two are the only ids any of them carries above 398 — the only exception
 * being saves this tool itself had written with the old ceiling of 500.
 */
const AVATAR_REAL_EXTRA: ReadonlySet<number> = new Set([1390, 1391]);

/** `slx` is not a checksum: it is `level` XOR this. Measured 241/241 rows on 12 saves. */
const UPGRADE_XOR = 32162029;

/** `<DataElem>` field -> the `RAW_PROFILE` group its ids are validated against. */
const PROFILE_FIELDS: Readonly<Record<string, string>> = {
  UnlockedBadges: "Badges",
  UnlockedExpRanks: "ExpRanks",
  UnlockedFrames: "Frames",
  UnlockedStyles: "Styles",
  UnlockedThemes: "Themes",
  UnlockedTitles: "ExpRanks",
};

const PROFILE_IDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  RAW_PROFILE.map((g) => [g.id, new Set(g.items.map((i) => i.id))]),
);

const CHAT_EMOJI_SET: ReadonlySet<string> = new Set(CHAT_EMOJI_IDS);

const splitList = (v: string): string[] => v.split(",").map((s) => s.trim()).filter(Boolean);

/** `st1,st2` -> `,st1,,st2,` — the form every real save writes. */
const canonicalEmoji = (ids: string[]): string => (ids.length ? `,${ids.join(",,")},` : "");

/**
 * Is this an avatar id the game itself can hold?
 *
 * 1..`AVATAR_MAX` (398 — the highest any genuine fetch reaches), plus the two
 * extra ids every save carries. Anything else in `399..1389` or above 1391 is
 * a shape no city on the server has.
 */
export function isRealAvatarId(id: number): boolean {
  if (!Number.isInteger(id) || id < 1) return false;
  return id <= AVATAR_MAX || AVATAR_REAL_EXTRA.has(id);
}

/**
 * Drop `Unlocked_avaN` vars the game has never issued, so they leave with
 * this load instead of waiting for the push gate to refuse them.
 *
 * This removes only ids `isRealAvatarId()` rejects — the fake `399..500` an
 * earlier build wrote after raising `AVATAR_MAX` with no evidence. Avatars
 * `350..398` are **kept**: they have no artwork file in the repo but the game
 * really has them (a genuine fetch holds `Unlocked_ava398`), so deleting them
 * would take away avatars that work. The var is removed whole and its
 * neighbours are untouched; when there is nothing to remove the input string
 * comes back byte-identical.
 */
export function stripUnknownAvatars(xml: string): { xml: string; removed: number[] } {
  const removed: number[] = [];
  const out = xml.replace(/<Var\b(?=[^>]*\bname="Unlocked_ava(\d+)")[^>]*>\s*/gi, (tag, n: string) => {
    const id = Number(n);
    if (isRealAvatarId(id)) return tag;
    if (!removed.includes(id)) removed.push(id);
    return "";
  });
  return { xml: removed.length ? out : xml, removed };
}

/**
 * Every invariant key this document breaks. Keys are stable and granular
 * enough to diff (`avatar-id-out-of-range:431`, not "an avatar is wrong"), so
 * a save that already broke one of them arrives without refusing.
 */
export function saveShapeProblems(xml: string, donor?: string | null): string[] {
  return shapeProblems(xml, donorIds(donor));
}

/**
 * Ids the *donor* save itself carries — the friend's city FetchCity just
 * downloaded, which is a real file Playrix is serving right now.
 *
 * Two rules below answer a question about the world: "does a real city hold
 * this id?". A catalog can only ever answer it for the ids it has measured,
 * and a Lv1089 friend proved the catalogs are not finished: their save holds
 * three badges, three frames and two styles `RAW_PROFILE` has never seen, plus
 * a `desc` sticker. Copying that profile block is exactly what *Restore full
 * city* is for, so refusing it made the whole Unban tab unusable against a
 * high-level friend while the same ids sat happily in a live city.
 *
 * The donor is therefore authoritative for these two rules only. Structural
 * rules — sticker delimiters, avatar range, `slx`, `t="i"`, tag balance — stay
 * unconditional, because those describe how the file is *written* and a bug
 * there is ours regardless of where the bytes came from.
 */
type DonorIds = {
  emoji: ReadonlySet<string>;
  profile: ReadonlyMap<string, ReadonlySet<string>>;
};

function donorIds(donor: string | null | undefined): DonorIds | null {
  if (!donor) return null;
  const emoji = new Set<string>();
  const emojiTag = /<Var\b(?=[^>]*\bname="UnlockedChatEmoji")[^>]*>/i.exec(donor);
  if (emojiTag) for (const id of splitList(attrValue(emojiTag[0], "v") ?? "")) emoji.add(id);

  const profile = new Map<string, ReadonlySet<string>>();
  for (const field of Object.keys(PROFILE_FIELDS)) {
    const tag = new RegExp(`<DataElem\\b(?=[^>]*\\bname="${field}")[^>]*>`, "i").exec(donor);
    if (!tag) continue;
    const ids = splitList(attrValue(tag[0], "value") ?? "");
    if (ids.length) profile.set(field, new Set(ids));
  }
  return { emoji, profile };
}

function shapeProblems(xml: string, known: DonorIds | null): string[] {
  const out = new Set<string>();

  // A tag-unclosed document makes the game discard progress, which from the
  // user's side is the feature silently doing nothing.
  if (findUnbalancedTag(xml)) out.add("xml-unbalanced");

  // ---- avatars --------------------------------------------------------
  if (xml.includes("Unlocked_ava")) {
    const gClose = xml.lastIndexOf("</Global>");
    for (const m of xml.matchAll(/<Var\b(?=[^>]*\bname="Unlocked_ava(\d+)")[^>]*>/gi)) {
      const n = m[1]!;
      if (!isRealAvatarId(Number(n))) out.add(`avatar-id-out-of-range:${n}`);
      // Past </Global> the game never reads the var: well-formed XML that
      // produces a green tick and changes nothing in game.
      if (gClose >= 0 && m.index > gClose) out.add(`avatar-var-outside-global:${n}`);
    }
  }

  // ---- chat stickers ---------------------------------------------------
  const emojiTag = /<Var\b(?=[^>]*\bname="UnlockedChatEmoji")[^>]*>/i.exec(xml);
  if (emojiTag) {
    const v = attrValue(emojiTag[0], "v") ?? "";
    const ids = splitList(v);
    // Every real save writes `,st1,,st2,` — one wrapped comma each end, double
    // separator between ids. An extra trailing comma is one more entry than
    // any city on the server holds.
    if (v !== "" && v !== canonicalEmoji(ids)) out.add("chat-emoji-shape");
    for (const id of ids) {
      if (CHAT_EMOJI_SET.has(id) || known?.emoji.has(id)) continue;
      out.add(`chat-emoji-unknown:${id}`);
    }
  }

  // ---- profile lists ----------------------------------------------------
  for (const [field, group] of Object.entries(PROFILE_FIELDS)) {
    if (!xml.includes(`name="${field}"`)) continue;
    const tag = new RegExp(`<DataElem\\b(?=[^>]*\\bname="${field}")[^>]*>`, "i").exec(xml);
    if (!tag) continue;
    const v = attrValue(tag[0], "value") ?? "";
    const ids = splitList(v);
    // Real saves hold a plain `a,b,c`: no wrapping, no empty slots.
    if (v !== ids.join(",")) out.add(`profile-shape:${field}`);
    const catalog = PROFILE_IDS.get(group);
    if (catalog) {
      const fromDonor = known?.profile.get(field);
      for (const id of ids) {
        if (catalog.has(id) || fromDonor?.has(id)) continue;
        out.add(`profile-unknown:${field}:${id}`);
      }
    }
  }

  // ---- the profile stores themselves appear exactly once -----------------
  // A second `<DataElem>` for the same field leaves the game reading whichever
  // copy it finds first, so the other is silently dead — and `Configs` is
  // searched for *after* the `PlayerProfile` open tag, so a stray one elsewhere
  // is enough to send a write to the wrong store. Measured: 6/6 real saves
  // hold exactly one `PlayerProfile`, one `Configs` and one of each list.
  for (const name of ["PlayerProfile", "Configs", ...Object.keys(PROFILE_FIELDS)]) {
    let n = 0;
    for (const _ of xml.matchAll(new RegExp(`<DataElem\\b[^>]*\\bname="${name}"[^>]*>`, "gi"))) n++;
    if (n > 1) out.add(`profile-store-dup:${name}`);
  }

  // ---- <Upgrade> level / slx --------------------------------------------
  // Bumping `level` without `slx` writes a save that disagrees with itself in
  // a field the game reads for free; both are always rewritten together.
  if (xml.includes('slx="')) {
    for (const m of xml.matchAll(
      /<([A-Za-z][\w.-]*)\b(?=[^>]*\blevel="(-?\d+)")(?=[^>]*\bslx="(-?\d+)")[^>]*>/g,
    )) {
      if (((Number(m[2]) ^ UPGRADE_XOR) >>> 0) !== (Number(m[3]) >>> 0)) {
        out.add(`upgrade-slx:${m[1]}:${attrValue(m[0], "id") ?? ""}`);
      }
    }
  }

  // ---- <BuildingsStash> rows are unique ------------------------------------
  // The decor feature only ever appends ids the stash does not already hold
  // (`maxBuildingsStash` collects `seen` first), so a repeated `id` means
  // something else duplicated a row. Measured 6/6 real saves: no repeats, in
  // stashes ranging from 6 to 1049 rows.
  const stash = /<BuildingsStash\b[^>]*>([\s\S]*?)<\/BuildingsStash\s*>/i.exec(xml);
  if (stash?.[1]) {
    const seen = new Set<string>();
    for (const m of stash[1].matchAll(/<Building\b[^>]*\bid="([^"]*)"/gi)) {
      const id = m[1]!;
      if (seen.has(id)) out.add(`stash-dup-id:${id}`);
      seen.add(id);
    }
  }

  // ---- integer-typed vars ------------------------------------------------
  // `t="i"` holding anything but digits makes the loader reject the whole
  // save. `writeVar` only ever picks `t="i"` for a numeric value, so this
  // fires on the other way in: replacing the value of a var that already had
  // `t="i"` (a scrubbed id, say) while leaving its type alone.
  for (const m of xml.matchAll(/<Var\b(?=[^>]*\bname="([^"]*)")(?=[^>]*\bt="i")[^>]*>/g)) {
    const v = attrValue(m[0], "v");
    if (v !== null && v !== "" && !/^-?\d+$/.test(v)) out.add(`var-int:${m[1]}`);
  }

  // ---- the warehouse "duplicate" actually duplicates ---------------------
  // `WHUdup` is `WareHouseCashUpgrade` masked with a fixed key; the name is
  // the whole spec. Measured on the corpus: the relation holds on 5 of 6
  // saves, and the one file it fails on is `mGameInfo.current.xml`, this
  // tool's own earlier output. Under *either* reading of which of the two
  // numbers the game follows, a duplicate that does not match its original is
  // a save disagreeing with itself in a field a server reads for free.
  const whu = readVar(xml, "WareHouseCashUpgrade");
  const dup = readVar(xml, "WHUdup");
  if (whu !== null && dup !== null && /^-?\d+$/.test(whu) && /^-?\d+$/.test(dup)) {
    if (((Number(dup) ^ WHUDUP_XOR) >>> 0) !== (Number(whu) >>> 0)) out.add("whudup-mismatch");
  }

  // ---- <SeasonTicket> carries its window ---------------------------------
  // A ticket is a window onto a running season: 5/5 saves that have one carry
  // `startTime` and `endTime` beside `id`, `theme` and ~25 more attributes.
  // The only bare `<SeasonTicket premium="1" score="1002"/>` ever produced was
  // this tool's, written on a save with no season at all — a card no season on
  // the server can claim. A save with no ticket at all is *not* a problem:
  // absence is a state the game itself writes between seasons.
  const season = /<SeasonTicket\b[^>]*>/i.exec(xml);
  if (season && (!attrValue(season[0], "startTime") || !attrValue(season[0], "endTime"))) {
    out.add("season-ticket-bare");
  }

  // A `<Skins>` holding `<type>` rows and none of the `<item>` rows was
  // considered as a rule and then dropped: measured on the corpus it can only
  // be produced by this tool's from-scratch writer, which runs on a save that
  // has *no* Skins store at all — so there were no equipped skins to lose and
  // nothing the block contradicts. It is unobserved (0 of 6 saves) rather than
  // wrong, unlike an unknown id, and keeping it made the Skins tab unable to
  // ever run on the one save shape that needs it. `injectSkins` merging into a
  // store that already has items — the shape every real save has — still
  // leaves those items in place, untouched.

  // ---- GivingOffersDeferred is a `name:qty` list --------------------------
  // Every save carrying the var holds it empty (3/3) and no save on file has a
  // populated one, so the only thing that can honestly be asserted is that
  // what we wrote parses as the pairs the writer emits. A value the game
  // cannot parse would take the whole save down with it, rather than quietly
  // granting nothing.
  const offers = /<Var\b(?=[^>]*\bname="GivingOffersDeferred")[^>]*\bv="([^"]*)"/i.exec(xml)
    ?? /<Var\b(?=[^>]*\bv="([^"]*)")[^>]*\bname="GivingOffersDeferred"/i.exec(xml);
  const offersValue = offers ? (offers[1] ?? "") : null;
  if (offersValue) {
    if (offersValue.split(",").some((seg) => !/^[^:,\s]+:\d+$/.test(seg.trim()))) out.add("offers-shape");
  }

  return [...out];
}

/**
 * The shape half of the push gate. Runs on every push but returns immediately
 * on a straight string compare, so a feature that never touched any of these
 * blocks costs one comparison.
 *
 * Refuses only keys that are **new** — the ones this edit introduced — so an
 * oddity the save arrived with stays pushable. That is what lets the gate be
 * strict about what the tool writes without ever holding a user's own file
 * hostage for something it did not do.
 *
 * `donor` is the friend city this session fetched, when there is one. It is
 * consulted *only* by the two "does a real city hold this id" rules (see
 * `donorIds`), so a restore can carry a high-level friend's profile and
 * stickers across while an id the Profile tab invented is still refused.
 */
export function assertSaveShapeSafe(loaded: string, pushed: string, donor?: string | null) {
  if (loaded === pushed) return;

  const known = donorIds(donor);
  const after = shapeProblems(pushed, known);
  if (!after.length) return;

  const before = new Set(shapeProblems(loaded, known));
  const broken = after.filter((k) => !before.has(k));
  if (!broken.length) return;

  throw new Error(
    `Không đẩy file lên máy: save bị hỏng sau khi sửa (${broken.slice(0, 6).join(", ")}` +
      `${broken.length > 6 ? `, +${broken.length - 6}` : ""}). ` +
      "Thành phố thật chưa từng cho kết quả này, nên server Playrix có thể coi save của bạn là gian lận.",
  );
}

/** First `<Var name=… v="…">` read as an integer, or `null` when absent. */
function readCounter(xml: string, name: string): number | null {
  const m = new RegExp(`<Var\\b(?=[^>]*\\bname="${name}")[^>]*\\bv="(-?\\d+)"`).exec(xml);
  return m ? Number(m[1]) : null;
}

/**
 * City level — `levelup`, falling back to `level` for saves that name it that
 * way (`sanitizeStatChanges` reads both, so this does too). The pattern is
 * anchored on a closing quote, so `level` never matches `levelup`.
 */
function readLevel(xml: string): number | null {
  return readCounter(xml, "levelup") ?? readCounter(xml, "level");
}

/**
 * Every `<Upgrade>` family row keyed `tag:id` -> `level`.
 *
 * The rows are matched exactly the way `upgrade-slx` matches them: a tag
 * carrying both `level` and `slx`, which is this family and nothing else in a
 * real save. A row with no `id` cannot be identified across two documents, so
 * it is skipped rather than keyed on a name every row would share.
 */
function upgradeLevels(xml: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!xml.includes('slx="')) return out;
  for (const m of xml.matchAll(
    /<([A-Za-z][\w.-]*)\b(?=[^>]*\blevel="(-?\d+)")(?=[^>]*\bslx="-?\d+")[^>]*>/g,
  )) {
    const id = attrValue(m[0], "id");
    if (!id) continue;
    out.set(`${m[1]}:${id}`, Number(m[2]));
  }
  return out;
}

/**
 * Fields a real save only ever moves **upwards**, refused when this push is
 * what moved one down.
 *
 * Unlike the key-diff above, this one is naturally a pair: a regression only
 * exists *between* two documents, so it is compared directly against the save
 * as it was loaded. Three rules, all measured:
 *
 * - `regata-tasks-completed-lower` — `RegataTasksCompleted` is a lifetime
 *   counter (136 .. 44911 across the corpus) and the Stats tab exposes it as
 *   `reg`, so a typed number can walk it backwards. The one legitimate way for
 *   it to fall is a restore, which copies the friend's whole counter verbatim
 *   via `INICIAL_VARS`; that is excused **only** when the pushed value is
 *   exactly the donor's, never merely because a donor was fetched.
 * - `upgrade-level-lower:<tag>:<id>` — factory, train and island levels only
 *   rise in game. `<Upgrade>` is in no restore block list, so nothing but the
 *   Factories tab can move it and there is no legitimate drop to excuse.
 * - `level-up-without-experience:<a>-><b>` — `levelup` is derived from the
 *   cumulative `experience`, so the pair only makes sense when both come from
 *   the same account: every game-written save in the corpus rises together
 *   (30 -> 172109, 999 -> 2436381253, 1089 -> 3370037992), and the only two
 *   files under the level-30 floor of ~171k are both ones this tool produced
 *   (66 -> 3138, 250 -> 984). The one legitimate way to reach it is a restore,
 *   which moves the level and deliberately leaves the XP alone — excused **only**
 *   when the pushed level is exactly the donor's, never merely because a donor
 *   was fetched.
 *
 * Recorded so nobody re-litigates it: a build that produced this pair on every
 * push (`ab46f0b`) ran without a ban. So the pair is a real inconsistency a
 * server *can* read, but it is not what a ban has been traced to — the measured
 * suspect was `experience` being copied at all (see `INICIAL_VARS`). Keep the
 * rule as a consistency check; do not use it to justify copying the XP again.
 */
export function progressionProblems(
  loaded: string,
  pushed: string,
  donor?: string | null,
): string[] {
  const out: string[] = [];

  const before = readCounter(loaded, "RegataTasksCompleted");
  const after = readCounter(pushed, "RegataTasksCompleted");
  if (before !== null && (after === null || after < before)) {
    const donorValue = donor ? readCounter(donor, "RegataTasksCompleted") : null;
    const excused = after !== null && donorValue !== null && after === donorValue;
    if (!excused) {
      out.push(`regata-tasks-completed-lower:${before}->${after === null ? "gone" : after}`);
    }
  }

  const was = upgradeLevels(loaded);
  if (was.size) {
    for (const [key, level] of upgradeLevels(pushed)) {
      const prev = was.get(key);
      if (prev !== undefined && level < prev) out.push(`upgrade-level-lower:${key}:${prev}->${level}`);
    }
  }

  // The level/XP pair: only compared when the save actually carries both, so a
  // save that never tracked `experience` gains no rule of its own.
  //
  // A restore legitimately produces this shape and always did: `experience` is
  // deliberately not copied (see the note above `INICIAL_VARS`), so the level
  // follows the friend while the XP stays ours. That is excused the same way
  // `regata-tasks-completed-lower` is — only when the pushed level is exactly
  // the donor's own level, i.e. the number demonstrably came from the copy.
  // Hand-typing a level the donor never had is still refused with a friend
  // fetched, so fetching a friend excuses nothing on its own.
  const lvlBefore = readLevel(loaded);
  const lvlAfter = readLevel(pushed);
  const xpBefore = readCounter(loaded, "experience");
  const xpAfter = readCounter(pushed, "experience");
  if (
    lvlBefore !== null &&
    lvlAfter !== null &&
    xpBefore !== null &&
    xpAfter !== null &&
    lvlAfter > lvlBefore &&
    xpAfter <= xpBefore
  ) {
    const donorLevel = donor ? readLevel(donor) : null;
    const fromCopy = donorLevel !== null && lvlAfter === donorLevel;
    if (!fromCopy) out.push(`level-up-without-experience:${lvlBefore}->${lvlAfter}`);
  }

  return out;
}

/**
 * Push gate for the counters above. Runs beside the other gates in
 * `encodeSave`, so every path that ends in a push is covered.
 */
export function assertProgressionsSafe(loaded: string, pushed: string, donor?: string | null) {
  if (loaded === pushed) return;
  const bad = progressionProblems(loaded, pushed, donor);
  if (!bad.length) return;
  throw new Error(
    `Không đẩy file lên máy: save sau khi sửa mang một chỉ số mà thành phố thật không bao giờ ` +
      `cho (${bad.join(", ")}). ` +
      "Server Playrix đọc được các trường này ngay khi bạn đồng bộ, nên có thể coi save của bạn là gian lận.",
  );
}
