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
import { CHAT_EMOJI_IDS } from "./chat-emoji.server";
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
export function saveShapeProblems(xml: string): string[] {
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
    for (const id of ids) if (!CHAT_EMOJI_SET.has(id)) out.add(`chat-emoji-unknown:${id}`);
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
    const known = PROFILE_IDS.get(group);
    if (known) for (const id of ids) if (!known.has(id)) out.add(`profile-unknown:${field}:${id}`);
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

  // ---- integer-typed vars ------------------------------------------------
  // `t="i"` holding anything but digits makes the loader reject the whole
  // save. `writeVar` only ever picks `t="i"` for a numeric value, so this
  // fires on the other way in: replacing the value of a var that already had
  // `t="i"` (a scrubbed id, say) while leaving its type alone.
  for (const m of xml.matchAll(/<Var\b(?=[^>]*\bname="([^"]*)")(?=[^>]*\bt="i")[^>]*>/g)) {
    const v = attrValue(m[0], "v");
    if (v !== null && v !== "" && !/^-?\d+$/.test(v)) out.add(`var-int:${m[1]}`);
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
 */
export function assertSaveShapeSafe(loaded: string, pushed: string) {
  if (loaded === pushed) return;

  const after = saveShapeProblems(pushed);
  if (!after.length) return;

  const before = new Set(saveShapeProblems(loaded));
  const broken = after.filter((k) => !before.has(k));
  if (!broken.length) return;

  throw new Error(
    `Không đẩy file lên máy: save bị hỏng sau khi sửa (${broken.slice(0, 6).join(", ")}` +
      `${broken.length > 6 ? `, +${broken.length - 6}` : ""}). ` +
      "Thành phố thật chưa từng cho kết quả này, nên server Playrix có thể coi save của bạn là gian lận.",
  );
}
