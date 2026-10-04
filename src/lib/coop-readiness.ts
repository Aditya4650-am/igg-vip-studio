/**
 * Is this save ready for first co-op contact — join, chat, stickers.
 * Browser-safe: no fs, no server imports (mirrors `regatta.ts`).
 *
 * Every check reads something the save declares about itself, and every one
 * is tied to a measured ban file — nothing here is a guess about Playrix:
 *
 * - `name`: the roster shows `townName`. The join-alone ban wore the donor's
 *   personal name; a missing name is nothing to display under at all.
 * - `stickers`: sending a sticker the account does not own bans (measured on
 *   a save with no `UnlockedChatEmoji` at all). The envelope rule is the
 *   shape gate's: n ids sit in exactly `1 + 2n` comma parts (`,a,,b,`).
 * - `tutorial`: `WaitForFirstSow` / `WaitForArrowOnFreeField` at `1` means
 *   the tutorial is still open — every join-era banned save on file carries
 *   at least one of them, every clean save carries neither.
 * - `age`: a proven-fresh account (`DaysEnteredGame` 0, or hours under the
 *   threshold with no day counter) joining instantly is the shape 13/14/16
 *   share. Unknown age passes: no data, no rule.
 * - `counters`: a lifetime counter with nothing behind it (`RegataTasksCompleted`
 *   over no records and no board, `FullCardCollections` over zero rows) is the
 *   file the tutorial-task ban arrived in. A live board with no records yet
 *   runs no tutorial and stays clean, so board rows count as backing too. The
 *   push gates refuse a newly created split; this reports it.
 *
 * Device standing is deliberately NOT a check: no file can carry its own ban
 * record, so the UI states that beside the list instead of scoring it.
 *
 * This is a checklist, never a gate — like the account-age readout, it tells
 * the user when the account is ready rather than blocking the push.
 */
import { accountAgeInfo } from "./account-age";

export type CoopCheckKey = "name" | "stickers" | "tutorial" | "age" | "counters";

export type CoopCheck = {
  key: CoopCheckKey;
  ok: boolean;
};

export type CoopReadiness = {
  ready: boolean;
  checks: CoopCheck[];
};

function varValue(xml: string, name: string): string | null {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = xml.match(new RegExp(`<Var\\b[^>]*?\\bname="${n}"[^>]*?\\bv="([^"]*)"`, "i"));
  if (a) return a[1]!;
  const b = xml.match(new RegExp(`<Var\\b[^>]*?\\bv="([^"]*)"[^>]*?\\bname="${n}"`, "i"));
  return b ? b[1]! : null;
}

function varInt(xml: string, name: string): number {
  const v = varValue(xml, name);
  return v != null && /^\d+$/.test(v) ? Number(v) : 0;
}

export function coopReadiness(xml: string): CoopReadiness {
  const checks: CoopCheck[] = [];
  if (!xml) return { ready: false, checks };

  const town = varValue(xml, "townName");
  checks.push({ key: "name", ok: town != null && town !== "" });

  const emoji = varValue(xml, "UnlockedChatEmoji") ?? "";
  const parts = emoji.split(",");
  const ids = parts.filter((t) => t.trim() !== "");
  checks.push({ key: "stickers", ok: ids.length > 0 && parts.length === 2 * ids.length + 1 });

  const tutOpen = (nm: string) => varValue(xml, nm) === "1";
  checks.push({ key: "tutorial", ok: !tutOpen("WaitForFirstSow") && !tutOpen("WaitForArrowOnFreeField") });

  checks.push({ key: "age", ok: !accountAgeInfo(xml).fresh });

  // A live board with no records yet runs no tutorial and stays clean
  // (`mGameInfo.current-18.xml`: 12 offers, 21 takes), so backing means
  // records *or* board rows — the same definition the restore and the push
  // gate share. (Mirrored here rather than imported: this module ships to
  // the browser, which cannot import server files.)
  const boarded = /<MyOldTask[\s>/]/i.test(xml) || /<(FreeTask|TakenTask)[\s>/]/i.test(xml);
  // Both halves or neither. The rule above only caught the counter with no
  // board behind it (`mGameInfo.current-14.xml`); the mirror shape is the one
  // `mGameInfo.current-22.xml` was banned with — a live 12-offer/18-taken
  // board while `RegataTasksCompleted` is absent, so the game runs the
  // first-timer regatta flow on a city claiming years of history. Measured on
  // the 21 saves on file: every clean save has both, and flagging the split
  // catches that save while raising no key on any of them.
  const regattaOk = (varInt(xml, "RegataTasksCompleted") === 0) === !boarded;
  const cardsOk =
    varInt(xml, "FullCardCollections") === 0 || /<DataElem\b[^>]*\bname="cardId"/i.test(xml);
  checks.push({ key: "counters", ok: regattaOk && cardsOk });

  return { ready: checks.every((c) => c.ok), checks };
}
