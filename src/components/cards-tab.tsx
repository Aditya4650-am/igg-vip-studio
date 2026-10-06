import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Dict } from "@/lib/i18n";
import { cardsLoadInfo, cardsSend, cardsCheckInbox } from "@/lib/card-api";
import type { CardAccountView, SendOutcome } from "@/lib/server/township/cardsend.server";

/**
 * The Cards tab — send collection cards to friends through the game's live
 * SendBox API. Purely additive: it owns its own state, reads LocalInfo through
 * the same native bridge the rest of the studio uses, and drives one send per
 * API call so the progress and the log are the truth, not an estimate.
 *
 * Flow: Refresh (pull LocalInfo → token/roster) → tick cards → tick friends →
 * SEND. Quantity is per card & per friend (bulk 10/20/30+ beyond the game's
 * in-UI 3/day), a delay keeps the anti-abuse 403 away, and 403s that do occur
 * are retried server-side and shown as "retried", never as lost sends.
 */

type Bridge = {
  pullLocalInfo?: (serial: string) => Promise<{ b64: string; file?: string; size?: number }>;
};

function bridge(): Bridge | undefined {
  return (window as unknown as { iggNative?: Bridge }).iggNative;
}

type LogLine = { id: number; kind: "ok" | "bad" | "warn" | "info"; text: string };

type InboxState = {
  name: string;
  level: number;
  boxes: { type: string; card?: string; from?: string; time?: string }[];
  error: string | null;
};

const QTY_PRESETS = [1, 10, 20, 30, 50] as const;
const DELAY_DEFAULT = 800;
const DELAY_MIN = 300;
const DELAY_MAX = 10_000;
const QTY_MAX = 99;
const LOG_MAX = 200;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 62% 44%)`;
}

function setOf(cardId: string) {
  const n = Number(cardId.split("_")[1]);
  return Math.floor((n - 1) / 10) + 1;
}

export function CardsTab({
  token,
  sessionId,
  device,
  tr,
}: {
  token: string;
  sessionId: string;
  device: string;
  tr: (k: keyof Dict) => string;
}) {
  const [acct, setAcct] = useState<
    (CardAccountView & { cardIds: readonly string[] }) | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [friendSel, setFriendSel] = useState<Set<string>>(new Set());
  const [cardSel, setCardSel] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState<{ id: string; name: string; level: number }[]>([]);
  const [manualId, setManualId] = useState("");
  const [q, setQ] = useState("");

  const [qty, setQty] = useState(1);
  const [delayMs, setDelayMs] = useState(DELAY_DEFAULT);

  const [running, setRunning] = useState(false);
  const [stop, setStop] = useState(false);
  const stopRef = useRef(false);
  const logIdRef = useRef(0);
  const [progress, setProgress] = useState({ done: 0, total: 0, sent: 0, rejected: 0, errors: 0, retried: 0 });
  /** Wall-clock verdict of the last finished run — drives the completion
   *  banner and the toast; null while no run has finished yet. */
  const [finished, setFinished] = useState<null | {
    ok: boolean;
    stopped: boolean;
    sent: number;
    rejected: number;
    errors: number;
    retried: number;
    total: number;
    seconds: number;
  }>(null);
  const [log, setLog] = useState<LogLine[]>([]);

  const [inbox, setInbox] = useState<InboxState | null>(null);
  const [inboxBusy, setInboxBusy] = useState(false);

  const pushLog = (kind: LogLine["kind"], text: string) => {
    const line = { id: logIdRef.current++, kind, text };
    setLog((prev) => {
      const next = prev.length >= LOG_MAX ? prev.slice(prev.length - (LOG_MAX - 1)) : prev.slice();
      next.push(line);
      return next;
    });
  };

  const refresh = async () => {
    if (!device) {
      setErr(tr("cardsNoDevice"));
      return;
    }
    const b = bridge();
    if (!b?.pullLocalInfo) {
      setErr(tr("cardsNoClient"));
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const li = await b.pullLocalInfo(device);
      const next = await cardsLoadInfo({ data: { token, sessionId, b64: li.b64 } });
      setAcct(next);
      // Keep already-ticked ids that still exist; drop stale ones.
      setFriendSel((prev) => {
        const alive = new Set(next.friends.map((f) => f.id));
        const s = new Set([...prev].filter((id) => alive.has(id) || id.startsWith("id:")));
        return s;
      });
      setCardSel((prev) => {
        const alive = new Set(next.cardIds);
        return new Set([...prev].filter((id) => alive.has(id)));
      });
      pushLog("info", `LocalInfo ✓ ${next.cityId} · ${next.friends.length} friends${next.checkError ? ` · ${next.checkError}` : ` · ${next.name || "?"} lvl ${next.level}`}`);
      if (next.checkError) setErr(next.checkError);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m);
      pushLog("bad", m);
    } finally {
      setLoading(false);
    }
  };

  const toggleFriend = (id: string) =>
    setFriendSel((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const toggleCard = (id: string) =>
    setCardSel((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const addManual = () => {
    const id = manualId.trim();
    if (!/^[A-Za-z0-9]{4,24}$/.test(id)) return;
    if (acct?.cityId === id || manual.some((m) => m.id === id) || acct?.friends.some((f) => f.id === id)) {
      setManualId("");
      return;
    }
    setManual((prev) => [...prev, { id, name: id, level: 0 }]);
    setFriendSel((prev) => new Set(prev).add(`id:${id}`));
    setManualId("");
  };

  const selectedFriends = useMemo(() => {
    const list = [...(acct?.friends ?? [])].map((f) => ({ ...f, key: f.id }));
    for (const m of manual) list.push({ id: m.id, name: m.name, level: m.level, key: `id:${m.id}` });
    return list.filter((f) => friendSel.has(f.key));
  }, [acct, manual, friendSel]);

  const selectedCards = useMemo(() => [...cardSel].sort(), [cardSel]);

  const total = selectedFriends.length * selectedCards.length * qty;
  const estSec = Math.ceil((total * (delayMs + 450)) / 1000);

  const startSend = async () => {
    if (!acct || running || total === 0) return;
    stopRef.current = false;
    setStop(false);
    setRunning(true);
    setProgress({ done: 0, total, sent: 0, rejected: 0, errors: 0, retried: 0 });
    setFinished(null);
    setLog([]);
    const t0 = Date.now();
    pushLog("info", `${total} sends → ${selectedFriends.length} friend(s) × ${selectedCards.length} card(s) × ${qty} · delay ${delayMs}ms`);

    let sent = 0;
    let rejected = 0;
    let errors = 0;
    let retried = 0;
    let done = 0;
    let abort = false;

    outer: for (const f of selectedFriends) {
      for (const cardId of selectedCards) {
        for (let n = 0; n < qty; n++) {
          if (stopRef.current) {
            abort = true;
            break outer;
          }
          try {
            const r: SendOutcome = await cardsSend({
              data: { token, sessionId, toCityId: f.id.replace(/^id:/, ""), cardId },
            });
            done++;
            retried += r.retried;
            if (r.status === "sent") {
              sent++;
              pushLog("ok", `✓ ${f.name} · ${cardId}${qty > 1 ? ` #${n + 1}` : ""}${r.retried ? ` (retry ×${r.retried})` : ""}`);
            } else if (r.status === "rejected") {
              rejected++;
              pushLog("bad", `✗ ${f.name} · ${cardId} — rejected (id không tồn tại)`);
            } else {
              errors++;
              pushLog("bad", `✗ ${f.name} · ${cardId} — ${r.detail ?? `HTTP ${r.http ?? "?"}`}`);
              if (r.http === 401) {
                abort = true;
                pushLog("warn", tr("cardsAuthAbort"));
                break outer;
              }
            }
          } catch (e) {
            done++;
            errors++;
            const m = e instanceof Error ? e.message : String(e);
            pushLog("bad", `✗ ${f.name} · ${cardId} — ${m.slice(0, 140)}`);
          }
          setProgress({ done, total, sent, rejected, errors, retried });
          await sleep(delayMs);
        }
      }
    }

    setProgress({ done, total, sent, rejected, errors, retried });
    pushLog(
      abort && stopRef.current ? "warn" : errors > 0 ? "warn" : "ok",
      `${tr("cardsDone")}: ✓ ${sent} · ✗ ${rejected} · ⚠ ${errors}${retried ? ` · ⟳ ${retried}` : ""}`,
    );

    // The professional sign-off: a wall-clock verdict for the banner, and a
    // toast so the finish is noticed even when the log scrolled away.
    const seconds = Math.max(1, Math.round((Date.now() - t0) / 1000));
    const ok = !abort && sent === total && rejected === 0 && errors === 0;
    setFinished({ ok, stopped: abort, sent, rejected, errors, retried, total, seconds });
    const desc = `${sent}/${total} ✓ · ${rejected} ✗ · ${errors} ⚠${retried ? ` · ⟳ ${retried}` : ""} · ${seconds}s`;
    if (ok) {
      toast.success(tr("cardsComplete"), { description: desc });
    } else {
      toast(abort ? tr("cardsStopped") : tr("cardsComplete"), { description: desc });
    }

    setRunning(false);
    setStop(false);
  };

  const checkInbox = async () => {
    if (!acct || inboxBusy) return;
    setInboxBusy(true);
    try {
      const r = await cardsCheckInbox({ data: { token, sessionId } });
      setInbox(r);
    } catch (e) {
      setInbox({ name: acct.name, level: acct.level, boxes: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      setInboxBusy(false);
    }
  };

  /** Every group of exactly 10 cards, set_01 … set_16 — the whole catalog,
   *  all visible at once, each card its own tickable button. */
  const cardGroups = useMemo(() => {
    const groups = new Map<number, string[]>();
    for (const id of acct?.cardIds ?? []) {
      const s = setOf(id);
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s)!.push(id);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [acct]);
  const visibleFriends = useMemo(() => {
    const list = [...(acct?.friends ?? [])].map((f) => ({ ...f, key: f.id }));
    for (const m of manual) list.push({ id: m.id, name: m.name, level: m.level, key: `id:${m.id}` });
    const needle = q.trim().toLowerCase();
    return needle
      ? list.filter((f) => f.name.toLowerCase().includes(needle) || f.id.toLowerCase().includes(needle))
      : list;
  }, [acct, manual, q]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{tr("cardsHint")}</p>

      {/* ── account ─────────────────────────────────────────────── */}
      <section className="panel">
        <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
          🎴 {tr("cardsAccount")}
        </h3>
        {acct ? (
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="flex size-8 items-center justify-center rounded-full text-sm font-bold text-white"
              style={{ background: avatarColor(acct.cityId) }}
            >
              {(acct.name || "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="text-sm font-semibold">{acct.name || "?"}</span>
            <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs text-muted tabular-nums">
              lvl {acct.level || "?"}
            </span>
            <span className="state-badge rounded-full bg-input px-2.5 py-1 font-mono text-xs text-muted">
              {acct.cityId}
            </span>
            <span
              className={cn(
                "state-badge rounded-full px-2.5 py-1 text-xs font-medium",
                acct.checkError ? "bg-amber-deep/30 text-amber" : "state-badge--ready",
              )}
            >
              {acct.checkError ? `⚠ ${acct.checkError}` : `✓ ${tr("cardsTokenOk")}`}
            </span>
            <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs text-muted tabular-nums">
              {tr("cardsFriends")}: {acct.friends.length}
            </span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" disabled={loading} onClick={refresh}>
                {loading ? tr("cardsLoading") : tr("cardsRefresh")}
              </Button>
              <Button size="sm" variant="purple" disabled={loading || inboxBusy} onClick={checkInbox}>
                {inboxBusy ? "…" : tr("cardsInbox")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-muted">{tr("cardsLoadFirst")}</p>
            <Button size="sm" variant="purple" disabled={loading} onClick={refresh}>
              {loading ? tr("cardsLoading") : tr("cardsRefresh")}
            </Button>
          </div>
        )}
        {inbox ? (
          <div className="mt-3 rounded-md bg-input/60 p-2.5 text-xs">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="font-semibold">{tr("cardsInbox")}</span>
              <span className="state-badge rounded-full bg-card px-2 py-0.5 text-muted tabular-nums">
                {inbox.boxes.length}
              </span>
              {inbox.error ? <span className="text-amber">⚠ {inbox.error}</span> : null}
            </div>
            {inbox.boxes.length === 0 && !inbox.error ? (
              <p className="text-muted">{tr("cardsInboxEmpty")}</p>
            ) : (
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {inbox.boxes.map((b, i) => (
                  <li key={i} className="flex items-center gap-2 text-muted">
                    <span className="text-sm">{b.type.includes("card") ? "🎴" : "🎁"}</span>
                    <span className="font-mono">{b.card ?? b.type}</span>
                    {b.from ? <span>← {b.from}</span> : null}
                    {b.time ? <span className="tabular-nums opacity-60">{b.time}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {err ? <p className="mt-2 text-xs text-amber">⚠ {err}</p> : null}
      </section>

      {/* ── friends ─────────────────────────────────────────────── */}
      <section className="panel">
        <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
          👥 {tr("cardsFriends")}
          <span className="ml-1 font-mono normal-case opacity-70">({friendSel.size})</span>
        </h3>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            className="field min-w-40 flex-1"
            placeholder={tr("search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFriendSel(new Set(visibleFriends.map((f) => f.key)))}
          >
            {tr("selectAll")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFriendSel(new Set())}>
            {tr("clear")}
          </Button>
        </div>
        <div className="mb-2 flex gap-2">
          <input
            className="field flex-1 font-mono"
            placeholder={`${tr("cardsAddId")} — e.g. 5dv7F9pDuO`}
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addManual();
            }}
          />
          <Button size="sm" variant="tool" onClick={addManual}>
            {tr("cardsAdd")}
          </Button>
        </div>
        {visibleFriends.length === 0 ? (
          <p className="py-2 text-xs text-muted">{acct ? tr("cardsNoFriends") : tr("cardsLoadFirst")}</p>
        ) : (
          <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
            {visibleFriends.map((f) => {
              const on = friendSel.has(f.key);
              return (
                <li key={f.key}>
                  <button
                    type="button"
                    onClick={() => toggleFriend(f.key)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                      on ? "bg-purple/15 shadow-purple" : "hover:bg-card",
                    )}
                  >
                    <span
                      className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                      style={{ background: avatarColor(f.id) }}
                    >
                      {f.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                    <span className="text-xs text-muted tabular-nums">lvl {f.level || "?"}</span>
                    <span className="font-mono text-xs text-muted">{f.id}</span>
                    <span
                      className={cn(
                        "flex size-4 items-center justify-center rounded text-[10px] font-bold",
                        on ? "bg-purple text-white" : "bg-input text-transparent",
                      )}
                    >
                      ✓
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── cards ───────────────────────────────────────────────── */}
      <section className="panel">
        <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
          🃏 {tr("cardsCards")}
          <span className="ml-1 font-mono normal-case opacity-70">({cardSel.size})</span>
        </h3>
        <p className="mb-2 text-xs text-muted">{tr("cardsCardsHint")}</p>
        {/* All groups at once — 10 cards per group, every card its own button.
            Ticking is the only selection mechanic: the send loop reads cardSel
            and nothing else, so exactly the ticked cards go out. */}
        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {cardGroups.map(([s, ids]) => {
            const allOn = ids.every((id) => cardSel.has(id));
            const onCount = ids.filter((id) => cardSel.has(id)).length;
            return (
              <div key={s} className="rounded-md bg-input/40 p-2">
                <div className="mb-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setCardSel((prev) => {
                        const next = new Set(prev);
                        for (const id of ids) {
                          if (allOn) next.delete(id);
                          else next.add(id);
                        }
                        return next;
                      })
                    }
                    title={`${tr("cardsAllSet")} — set_${String(s).padStart(2, "0")}`}
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold transition-colors",
                      allOn
                        ? "bg-amber/20 text-amber shadow-amber-ring"
                        : "bg-card text-muted hover:text-fg",
                    )}
                  >
                    set_{String(s).padStart(2, "0")}
                  </button>
                  <span className="text-[10px] text-muted tabular-nums">
                    {onCount}/{ids.length}
                  </span>
                </div>
                <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-10">
                  {ids.map((id) => {
                    const on = cardSel.has(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggleCard(id)}
                        title={id}
                        className={cn(
                          "rounded-md py-1.5 font-mono text-xs font-semibold transition-colors",
                          on
                            ? "bg-amber/20 text-amber shadow-amber-ring"
                            : "bg-card text-muted hover:text-fg",
                        )}
                      >
                        {id.split("_")[1]}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setCardSel(new Set(acct?.cardIds ?? []))}>
            {tr("selectAll")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCardSel(new Set())}>
            {tr("clear")}
          </Button>
        </div>
      </section>

      {/* ── send ────────────────────────────────────────────────── */}
      <section className="panel">
        <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
          ✈️ {tr("cardsSendTitle")}
        </h3>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted">{tr("cardsQty")}</label>
            <div className="flex items-center gap-1.5">
              {QTY_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setQty(n)}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-xs font-semibold tabular-nums transition-colors",
                    qty === n ? "bg-purple/25 text-purple shadow-purple" : "bg-input text-muted hover:text-fg",
                  )}
                >
                  {n}
                </button>
              ))}
              <input
                className="field field-qty w-16 text-center"
                inputMode="numeric"
                aria-label={tr("cardsQty")}
                value={qty}
                onChange={(e) => {
                  const raw = Number(e.target.value.replace(/[^\d]/g, ""));
                  setQty(raw >= 1 ? Math.min(QTY_MAX, raw) : 1);
                }}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">{tr("cardsDelay")}</label>
            <div className="flex items-center gap-1.5">
              <input
                className="field field-qty w-20 text-center"
                inputMode="numeric"
                aria-label={tr("cardsDelay")}
                value={delayMs}
                onChange={(e) => {
                  const raw = Number(e.target.value.replace(/[^\d]/g, ""));
                  setDelayMs(raw >= DELAY_MIN ? Math.min(DELAY_MAX, raw) : DELAY_MIN);
                }}
              />
              <span className="text-xs text-muted">ms</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="success"
              disabled={running || loading || total === 0 || !acct}
              onClick={startSend}
            >
              {running ? tr("cardsRunning") : `✈ ${tr("cardsSend")} · ${total}`}
            </Button>
            <Button
              variant="danger"
              disabled={!running}
              onClick={() => {
                stopRef.current = true;
                setStop(true);
              }}
            >
              {stop ? tr("cardsStopping") : tr("cardsStop")}
            </Button>
          </div>
          <span className="text-xs text-muted tabular-nums">
            {tr("cardsEstimate")}: {total} · ~{estSec}s
          </span>
        </div>

        {progress.total > 0 ? (
          <div className="mt-3">
            <div className="mb-1.5 flex flex-wrap gap-2 text-xs tabular-nums">
              <span className="state-badge rounded-full bg-input px-2 py-0.5 text-muted">
                {progress.done}/{progress.total}
              </span>
              <span className="state-badge rounded-full bg-input px-2 py-0.5 text-ok">✓ {progress.sent}</span>
              <span className="state-badge rounded-full bg-input px-2 py-0.5 text-danger">✗ {progress.rejected}</span>
              <span className="state-badge rounded-full bg-input px-2 py-0.5 text-amber">⚠ {progress.errors}</span>
              {progress.retried > 0 ? (
                <span className="state-badge rounded-full bg-input px-2 py-0.5 text-cyan">⟳ {progress.retried}</span>
              ) : null}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-input">
              <div
                className="h-full rounded-full bg-gradient-to-r from-purple to-cyan transition-[width] duration-200"
                style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
              />
            </div>
          </div>
        ) : null}

        {/* Completion banner — the run's verdict at a glance once the loop
            ends (complete, stopped, or auth-aborted). Never shows mid-run. */}
        {!running && finished ? (
          <div
            className={cn(
              "mt-3 flex items-center gap-3 rounded-lg border px-3.5 py-3",
              finished.ok ? "border-ok/50 bg-ok/10" : "border-amber/50 bg-amber/10",
            )}
          >
            <span className="text-2xl">{finished.ok ? "🎉" : "⏹️"}</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {finished.stopped ? tr("cardsStopped") : tr("cardsComplete")}
              </p>
              <p className="text-xs tabular-nums text-muted">
                {finished.sent}/{finished.total} ✓ · {finished.rejected} ✗ · {finished.errors} ⚠
                {finished.retried ? ` · ⟳ ${finished.retried}` : ""} · {finished.seconds}s
              </p>
            </div>
            <span
              className={cn(
                "ml-auto rounded-full px-2.5 py-1 text-xs font-bold tabular-nums",
                finished.ok ? "bg-ok/20 text-ok" : "bg-amber/20 text-amber",
              )}
            >
              {Math.round((finished.sent / Math.max(1, finished.total)) * 100)}%
            </span>
          </div>
        ) : null}

        {log.length > 0 ? (
          <div className="mt-3 max-h-52 space-y-0.5 overflow-y-auto rounded-md bg-card/70 p-2 font-mono text-[11px] leading-relaxed">
            {log
              .slice()
              .reverse()
              .map((l) => (
                <div
                  key={l.id}
                  className={cn(
                    l.kind === "ok" && "text-ok",
                    l.kind === "bad" && "text-danger",
                    l.kind === "warn" && "text-amber",
                    l.kind === "info" && "text-muted",
                  )}
                >
                  {l.text}
                </div>
              ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
