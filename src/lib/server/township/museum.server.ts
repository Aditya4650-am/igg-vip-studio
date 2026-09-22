import { insertInsideRoot } from "./xml-edit.server";

// Museum artifacts live in `<ArtInfo><aInfo i='{"id":"aN","count":C,"met":M,...}'/>…`.
// The id set below is the Authoritative list taken from a decoded mGameInfo
// whose ArtInfo holds 354 distinct ids (a1..a365 except the 11 below, which
// that save never contained). Ids outside this set are dropped, never
// invented — an unknown id is ignored by the game, which would read as a
// silent partial success.
const EXCLUDED = new Set([340, 346, 348, 350, 351, 354, 356, 358, 359, 361, 364]);

export const MUSEUM_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 365 }, (_, i) => i + 1)
    .filter((n) => !EXCLUDED.has(n))
    .map((n) => `a${n}`),
);

const KNOWN = new Set(MUSEUM_IDS);

/** Highest `count` the reference save contains — the ceiling, never exceeded. */
export const MUSEUM_MAX_COUNT = 3;

/**
 * Complete artifacts: `met` to 1 and `count` up to the save's own max (3),
 * rewriting the two values in place so `date`/`ind` survive byte-identical.
 * Ids absent from ArtInfo are appended inside the block from the known set
 * only. Returns `changed: 0` when nothing would move so the caller can
 * report a real no-op instead of a silent success.
 */
export function grantArtifacts(xml: string, ids: string[]) {
  let text = xml;
  const wanted = [...new Set(ids.map((id) => id.trim()))].filter((id) => KNOWN.has(id));
  if (!wanted.length) return { xml: text, changed: 0, target: MUSEUM_MAX_COUNT };
  const open = text.match(/<ArtInfo\b[^>]*>/i);
  if (!open) {
    text = insertInsideRoot(text, "<ArtInfo></ArtInfo>");
  } else if (/\/>\s*$/.test(open[0])) {
    text = text.replace(open[0], open[0].replace(/\/>\s*$/, ">") + "</ArtInfo>");
  }
  let changed = 0;
  for (const id of wanted) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tag = text.match(new RegExp(`<aInfo\\b[^>]*"id":"${esc}"[^>]*>`, "i"));
    if (!tag) {
      const now = `${Math.floor(Date.now() / 1000)}.0`;
      const insert = `<aInfo i='{"id":"${id}","count":${MUSEUM_MAX_COUNT},"met":1,"date":${now},"ind":1}'/>`;
      const close = text.match(/<\/ArtInfo\s*>/i);
      if (!close) continue;
      text = text.slice(0, close.index) + insert + text.slice(close.index);
      changed += 1;
      continue;
    }
    const whole = tag[0]!;
    if (tag.index === undefined) continue;
    const count = whole.match(/"count":(\d+)/i)?.[1];
    const met = whole.match(/"met":(\d+)/i)?.[1];
    if (count === undefined || met === undefined) continue;
    let next = whole;
    let moved = false;
    if (Number(count) < MUSEUM_MAX_COUNT) {
      next = next.replace(/("count":)\d+/i, `$1${MUSEUM_MAX_COUNT}`);
      moved = true;
    }
    if (Number(met) !== 1) {
      next = next.replace(/("met":)\d+/i, "$11");
      moved = true;
    }
    if (!moved) continue;
    text = text.slice(0, tag.index) + next + text.slice(tag.index + whole.length);
    changed += 1;
  }
  return { xml: text, changed, target: MUSEUM_MAX_COUNT };
}
