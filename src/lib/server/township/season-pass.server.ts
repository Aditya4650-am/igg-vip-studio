import { SEASON_PASSES, seasonPassById, type SeasonPassSeason } from "@/lib/season-pass";
import { attrValue } from "./xml-edit.server";
import { readVar, writeVar } from "./vars.server";

/**
 * Golden Pass season swap.
 *
 * Measured live on a real device: a `<SeasonTicket>` block is a *window onto a
 * season*, and the client renders it from that season's own `SeasonTicketVSO<id>`
 * resource pack. Rewriting the ticket's `id` / `packageId` / `theme` to another
 * season that has a pack installed swaps the pass in game — the plaque, the
 * reward road and the activation banner all change — while a season without a
 * pack keeps the HUD timer but its window refuses to open (790/760/730 tested:
 * dead). So the catalog is exactly the seasons this build ships content for.
 *
 * The block is edited by string replacement, never parsed: the roads
 * (`<FreeRoad>` / `<PremiumRoad>`) and their ~67 `<Stage>` entries stay byte
 * identical, and only the ticket's own attributes move.
 */
export type SeasonPassState = {
  id: string | null;
  theme: string | null;
  premium: boolean;
  score: number;
  /** Highest stage score in the block — the value that opens the whole track. */
  maxScore: number;
  start: number | null;
  end: number | null;
  live: boolean;
  startedIds: string[];
};

const TICKET_OPEN = /<SeasonTicket\b([^>]*?)(\/?)>/i;

function attrAttrs(attrs: string, name: string, value: string) {
  const rx = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s/>]+)`, "i");
  if (rx.test(attrs)) return attrs.replace(rx, (m) => m.replace(/=\s*["']?[^"'\s/>]+["']?/, `="${value}"`));
  const trimmed = attrs.replace(/\s+$/, "");
  return `${trimmed} ${name}="${value}"`;
}

function stageScores(block: string): number[] {
  const out: number[] = [];
  for (const m of block.matchAll(/<Stage\b[^>]*\bscore\s*=\s*"(-?\d+)"/gi)) out.push(Number(m[1]));
  return out;
}

export function readSeasonPassState(xml: string, now = Math.floor(Date.now() / 1000)): SeasonPassState {
  const m = TICKET_OPEN.exec(xml);
  const started = (readVar(xml, "SeasonTicketStartedIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!m) {
    return { id: null, theme: null, premium: false, score: 0, maxScore: 0, start: null, end: null, live: false, startedIds: started };
  }
  const attrs = m[1] ?? "";
  const close = xml.indexOf("</SeasonTicket>", (m.index ?? 0) + m[0].length);
  const block = close >= 0 ? xml.slice(m.index ?? 0, close + 15) : m[0];
  const scores = stageScores(block);
  const start = Number(attrValue(attrs, "startTime") ?? NaN);
  const end = Number(attrValue(attrs, "endTime") ?? NaN);
  return {
    id: attrValue(attrs, "id"),
    theme: attrValue(attrs, "theme"),
    premium: attrValue(attrs, "premium") === "1",
    score: Number(attrValue(attrs, "score") ?? 0),
    maxScore: scores.length ? Math.max(...scores) : 0,
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
    live: Number.isFinite(start) && Number.isFinite(end) && start <= now && now <= end,
    startedIds: started,
  };
}

/**
 * Point the save's Golden Pass at `seasonId` and open it at maximum.
 *
 * Refuses rather than reporting a success the game would discard:
 *  - a season outside the catalog (no content → dead window in game);
 *  - a save with no season ticket at all (the game has never run a season there,
 *    so there is no road to rewrite and no window to anchor to);
 *  - a request that is already satisfied (same id, premium, full score), because
 *    a button that changes nothing reads as a broken button.
 */
export function swapSeasonPass(xml: string, seasonId: string, now = Math.floor(Date.now() / 1000)): string {
  const season: SeasonPassSeason | null = seasonPassById(seasonId);
  if (!season) {
    throw new Error(
      `Mùa ${seasonId} không có dữ liệu trong bản game này — chỉ mở được các mùa đã có gói SeasonTicketVSO.`,
    );
  }
  const m = TICKET_OPEN.exec(xml);
  if (!m || m.index === undefined) {
    throw new Error(
      "Save chưa có SeasonTicket — thành phố này chưa chạy mùa nào nên không có thẻ mùa để đổi. " +
        "Mở Season Pass trong game một lần rồi Load lại.",
    );
  }
  if (m[2] === "/") {
    throw new Error("SeasonTicket trong save là thẻ rỗng, không có đường thưởng để mở.");
  }
  const close = xml.indexOf("</SeasonTicket>", m.index + m[0].length);
  if (close < 0) throw new Error("SeasonTicket trong save bị thiếu thẻ đóng.");
  const block = xml.slice(m.index, close + "</SeasonTicket>".length);

  const state = readSeasonPassState(xml, now);
  const maxScore = state.maxScore > 0 ? state.maxScore : 1002;
  if (state.id === season.id && state.premium && state.score >= maxScore) {
    throw new Error(`Mùa ${season.name} đã mở sẵn ở mức tối đa.`);
  }

  let attrs = m[1] ?? "";
  attrs = attrAttrs(attrs, "id", season.id);
  attrs = attrAttrs(attrs, "packageId", season.id);
  attrs = attrAttrs(attrs, "theme", season.theme);
  attrs = attrAttrs(attrs, "premium", "1");
  attrs = attrAttrs(attrs, "score", String(maxScore));
  // A closed window cannot be entered: a week that has ended has no day left to
  // claim on. The current ticket's own window is kept whenever it is still live;
  // otherwise one is placed around now, with the block's own length preserved.
  if (!state.live) {
    const length = state.start && state.end && state.end > state.start ? state.end - state.start : 14 * 86400;
    attrs = attrAttrs(attrs, "startTime", String(now - 3600));
    attrs = attrAttrs(attrs, "endTime", String(now - 3600 + Math.max(86400, length)));
    attrs = attrAttrs(attrs, "fullEnded", "0");
  }

  const openTag = `<SeasonTicket${attrs}>`;
  let out = xml.slice(0, m.index) + openTag + block.slice(m[0].length) + xml.slice(close + "</SeasonTicket>".length);

  // The center names the season it is showing; the started list is a history and
  // may only grow — dropping an id we did start is the same dangling record the
  // restore path refuses to invent.
  out = out.replace(/<SeasonTicketCenter\b([^>]*)>/i, (all, inner: string) =>
    /lastId\s*=\s*"/i.test(inner)
      ? `<SeasonTicketCenter${inner.replace(/lastId\s*=\s*"[^"]*"/i, `lastId="${season.id}"`)}>`
      : `<SeasonTicketCenter${inner} lastId="${season.id}">`,
  );
  const ids = state.startedIds.includes(season.id) ? state.startedIds : [...state.startedIds, season.id];
  if (ids.length) out = writeVar(out, "SeasonTicketStartedIds", ids.join(","));
  return out;
}

/** The catalog entries this save may offer, with the active one marked. */
export function seasonPassOptions(xml: string) {
  const state = readSeasonPassState(xml);
  return SEASON_PASSES.map((s) => ({
    id: s.id,
    name: s.name,
    short: s.short,
    theme: s.theme,
    art: s.art,
    current: state.id === s.id,
  }));
}
