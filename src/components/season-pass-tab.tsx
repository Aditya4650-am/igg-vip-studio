import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Dict } from "@/lib/i18n";
import type { SeasonPassSeason } from "@/lib/season-pass";

/**
 * Golden Pass tab — the current season plus every previous season this build
 * can still render.
 *
 * The previous list is data, not decoration: each button writes that season's
 * id/theme into the save's `<SeasonTicket>`, opens it at its full score, and
 * the game draws that season's own plaque and reward road from its installed
 * `SeasonTicketVSO<id>` pack. Seasons the client has no pack for are not
 * listed at all — a button that only changes a number and shows nothing in
 * game is exactly the kind of success report this project refuses to ship.
 */

export type SeasonPassOption = SeasonPassSeason & { current: boolean };

type Props = {
  season: { premium: boolean; score: number; id?: string | null; theme?: string | null };
  passes: SeasonPassOption[];
  pending: string | null;
  busy: boolean;
  onPick: (id: string) => void;
  tr: (k: keyof Dict) => string;
};

export function SeasonPassTab({ season, passes, pending, busy, onPick, tr }: Props) {
  const [sub, setSub] = useState<"current" | "previous">("previous");
  const current = passes.find((p) => p.current) ?? null;
  const previous = passes.filter((p) => !p.current);
  const list = sub === "current" ? (current ? [current] : []) : previous;

  return (
    <div className="season-pass">
      <div className="season-pass__head">
        <div>
          <p className="season-pass__eyebrow">{tr("seasonTab")}</p>
          <h3 className="season-pass__title">
            {current ? current.name : tr("seasonSubCurrent")}
          </h3>
          <p className="season-pass__meta">
            {current
              ? `${season.premium ? tr("seasonPrevActive") : "—"} · ${season.score}`
              : tr("seasonPrevNote")}
          </p>
        </div>
        <div className="season-pass__sub" role="tablist" aria-label={tr("seasonTab")}>
          <button
            type="button"
            role="tab"
            aria-selected={sub === "current"}
            className={cn("season-pass__sub-tab", sub === "current" && "is-on")}
            onClick={() => setSub("current")}
          >
            {tr("seasonSubCurrent")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sub === "previous"}
            className={cn("season-pass__sub-tab", sub === "previous" && "is-on")}
            onClick={() => setSub("previous")}
          >
            {tr("seasonSubPrevious")}
          </button>
        </div>
      </div>

      {sub === "previous" ? <p className="season-pass__hint">{tr("seasonPrevHint")}</p> : null}

      <div className="season-pass__grid">
        {list.map((p) => {
          const isPending = pending === p.id;
          const atMax = p.current && season.premium && season.score > 0;
          return (
            <div
              key={p.id}
              className={cn(
                "season-pass__card",
                p.current && "is-current",
                isPending && "is-pending",
              )}
            >
              <div className="season-pass__art">
                <img src={p.art} alt={p.name} draggable={false} />
              </div>
              <div className="season-pass__row">
                <span className="season-pass__season">Season {p.id}</span>
                {p.current ? <span className="season-pass__badge">{tr("seasonPrevActive")}</span> : null}
              </div>
              <button
                type="button"
                className={cn("season-pass__btn", isPending && "is-pending")}
                disabled={busy || atMax}
                onClick={() => onPick(p.id)}
              >
                {isPending ? tr("seasonPrevQueued") : atMax ? tr("seasonPrevActive") : tr("seasonPrevUnlock")}
              </button>
            </div>
          );
        })}
        {!list.length ? <p className="season-pass__empty">{tr("seasonPrevNote")}</p> : null}
      </div>
    </div>
  );
}
