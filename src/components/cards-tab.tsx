import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Dict } from "@/lib/i18n";
import { cardsLoadInfo, cardsSend, cardsCheckInbox, cardsFetchState } from "@/lib/card-api";
import type { CardAccountView, SendOutcome } from "@/lib/server/township/cardsend.server";
import {
  INBOX_BOX_CAP,
  INBOX_SAFE,
  cardIdOf,
  cardNumber,
  confirmedCount,
  deliveryCheck,
  estimateBoxes,
  missingCardNumbers,
  sortCardsNumerically,
  type CardSnapshot,
} from "@/lib/cards-delivery";

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
 *
 * Delivery is guaranteed, not just attempted: a receiver's inbox holds only
 * 100 boxes (the 101st evicts the oldest, permanently), so sends go out in
 * *numeric* order and in cap-aware waves — the run reads the friend's save
 * for their current box footprint, holds a wave back whenever it would risk
 * the cap, waits for the receiver to collect, and finally confirms every card
 * from their save, resending only what is provably lost. Cards the friend
 * already holds from us are skipped, so re-running resumes instead of
 * duplicating.
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

/**
 * Wave pacing, all measured against the proven 100-box cap: read cadence
 * while the run silently holds for inbox headroom (backing off to a minute
 * on a long hold), and how long the final confirmation polls before it
 * reports "awaiting collection".
 */
const WAIT_POLL_STEPS = [
  6_000, 6_000, 6_000, 6_000, 6_000, 12_000, 12_000, 12_000, 20_000, 30_000, 30_000, 60_000,
];
const CONFIRM_POLL_MS = 8_000;
const CONFIRM_WAIT_MS = 3 * 60_000;
const CONFIRM_ATTEMPTS = 2;
const MAX_READ_FAILS = 8;
const READ_RETRY_DELAY_MS = 700;
/**
 * How many boxes one `checkInbox` read can list — must match the server's
 * `raws.slice(-60)` in `cardsend.server.ts`. Above that count the live list
 * is a window, so "not visible" stops proving "not delivered" and the verify
 * pass reports awaiting instead of resending (a resend could duplicate).
 */
const INBOX_LIST_MAX = 60;

/** One own-inbox read: the uncapped box count plus the card ids it lists. */
type LiveRead = { ok: true; total: number; cards: number[] } | { ok: false; error: string };

type Phase = "sending" | "confirming";
type WaveResult = "done" | "stop";
/** What one friend's run knows about their save at any moment. */
type RunState = {
  /** Latest parsed snapshot, null while their save has never been readable. */
  snap: CardSnapshot | null;
  /** Our successful sends that are not in their save yet (live inbox). */
  unmerged: number;
  /** Their save moved during this run — they are online and collecting. */
  activity: boolean;
  /** Consecutive failed reads; MAX_READ_FAILS gates one warn per streak. */
  readFails: number;
};

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
  const [acct, setAcct] = useState<(CardAccountView & { cardIds: readonly string[] }) | null>(null);
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
  /**
   * Per-friend send history for this page session: the timestamps of every
   * successful send. It is what makes a re-run resume instead of duplicate,
   * and what separates "still in transit" from "lost" during confirmation.
   */
  const historyRef = useRef(new Map<string, Map<number, number[]>>());
  const [progress, setProgress] = useState({
    done: 0,
    total: 0,
    sent: 0,
    rejected: 0,
    errors: 0,
    retried: 0,
    resent: 0,
    confirmed: 0,
    awaiting: 0,
    phase: "sending" as Phase,
  });
  /** Wall-clock verdict of the last finished run — drives the completion
   *  banner and the toast; null while no run has finished yet. */
  const [finished, setFinished] = useState<null | {
    ok: boolean;
    stopped: boolean;
    sent: number;
    rejected: number;
    errors: number;
    retried: number;
    resent: number;
    confirmed: number;
    awaiting: number;
    total: number;
    seconds: number;
  }>(null);
  /** The self-run's success popup — set only when every planned card went
   *  out; closes on OK or the scrim, never blocks the run itself. */
  const [selfPopup, setSelfPopup] = useState<null | {
    sent: number;
    total: number;
    confirmed: number;
    seconds: number;
  }>(null);
  const [log, setLog] = useState<LogLine[]>([]);

  const [inbox, setInbox] = useState<InboxState | null>(null);
  const [inboxBusy, setInboxBusy] = useState(false);

  /** The own-album analysis behind the "Collect for myself" panel: what the
   *  album holds, what is already on its way, and the exact gap left. */
  const [self, setSelf] = useState<{
    owned: number;
    waiting: number;
    live: number;
    pending: number;
    missing: number[];
    error: string | null;
  } | null>(null);
  const [selfBusy, setSelfBusy] = useState(false);

  const pushLog = (kind: LogLine["kind"], text: string) => {
    const line = { id: logIdRef.current++, kind, text };
    setLog((prev) => {
      const next = prev.length >= LOG_MAX ? prev.slice(prev.length - (LOG_MAX - 1)) : prev.slice();
      next.push(line);
      return next;
    });
  };

  /** The session history of sends to one friend, created on first use. */
  const historyFor = (key: string) => {
    const existing = historyRef.current.get(key);
    if (existing) return existing;
    const fresh = new Map<number, number[]>();
    historyRef.current.set(key, fresh);
    return fresh;
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
      pushLog(
        "info",
        `LocalInfo ✓ ${next.cityId} · ${next.friends.length} friends${next.checkError ? ` · ${next.checkError}` : ` · ${next.name || "?"} lvl ${next.level}`}`,
      );
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
    if (
      acct?.cityId === id ||
      manual.some((m) => m.id === id) ||
      acct?.friends.some((f) => f.id === id)
    ) {
      setManualId("");
      return;
    }
    setManual((prev) => [...prev, { id, name: id, level: 0 }]);
    setFriendSel((prev) => new Set(prev).add(`id:${id}`));
    setManualId("");
  };

  const selectedFriends = useMemo(() => {
    const list = [...(acct?.friends ?? [])].map((f) => ({ ...f, key: f.id }));
    for (const m of manual)
      list.push({ id: m.id, name: m.name, level: m.level, key: `id:${m.id}` });
    return list.filter((f) => friendSel.has(f.key));
  }, [acct, manual, friendSel]);

  /** Numeric order — card_02 before card_11 before card_100 — so an
   *  unexpected prune can never take the high cards out first. */
  const selectedCards = useMemo(() => sortCardsNumerically([...cardSel]), [cardSel]);

  const total = selectedFriends.length * selectedCards.length * qty;
  const estSec = Math.ceil((total * (delayMs + 450)) / 1000);
  /** Sent everything, but collection/confirmation is still pending on the receiver. */
  const finishedGood = !!finished && finished.ok;

  const startSend = async () => {
    if (!acct || running || total === 0) return;
    stopRef.current = false;
    setStop(false);
    setRunning(true);
    setProgress({
      done: 0,
      total,
      sent: 0,
      rejected: 0,
      errors: 0,
      retried: 0,
      resent: 0,
      confirmed: 0,
      awaiting: 0,
      phase: "sending",
    });
    setFinished(null);
    setLog([]);
    const t0 = Date.now();
    const runStart = Date.now();
    pushLog(
      "info",
      `${total} planned → ${selectedFriends.length} friend(s) × ${selectedCards.length} card(s) × ${qty} · delay ${delayMs}ms · waves ≤ ${INBOX_SAFE} of ${INBOX_BOX_CAP} boxes`,
    );

    // Tallies the banner reads — adjusted (never estimated) as skips and
    // deferrals surface, so the final counts are the truth.
    let runTotal = total;
    let sent = 0;
    let rejected = 0;
    let errors = 0;
    let retried = 0;
    let resent = 0;
    let confirmed = 0;
    let awaiting = 0;
    let done = 0;
    let abort = false;

    const flush = (phase: Phase) =>
      setProgress({
        done,
        total: runTotal,
        sent,
        rejected,
        errors,
        retried,
        resent,
        confirmed,
        awaiting,
        phase,
      });

    const readState = async (cityId: string) => {
      try {
        return await cardsFetchState({ data: { token, sessionId, cityId } });
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    };

    /** Their save is the floor for "in transit": anything already in it was collected. */
    const syncHistory = (hist: Map<number, number[]>, snap: CardSnapshot) => {
      for (const key of Object.keys(snap.fromUs)) {
        const n = Number(key);
        const have = snap.fromUs[n] ?? 0;
        if (have > (hist.get(n)?.length ?? 0)) hist.set(n, new Array<number>(have).fill(0));
      }
    };

    /** Our sends that are still only in the live inbox, not in their save. */
    const unmergedOf = (hist: Map<number, number[]>, snap: CardSnapshot | null) => {
      let un = 0;
      for (const [n, times] of hist) {
        un += Math.max(0, times.length - (snap ? (snap.fromUs[n] ?? 0) : 0));
      }
      return un;
    };

    const latestSend = (hist: Map<number, number[]>) => {
      let last = 0;
      for (const times of hist.values()) for (const t of times) if (t > last) last = t;
      return last;
    };

    /** Any movement in their save means the receiver is online and collecting. */
    const noteSnapshot = (st: RunState, prev: CardSnapshot | null, next: CardSnapshot) => {
      if (!prev) return;
      if (
        prev.updAt !== next.updAt ||
        prev.pendingTotal !== next.pendingTotal ||
        prev.maxBoxTime !== next.maxBoxTime ||
        prev.albumUnique !== next.albumUnique
      ) {
        st.activity = true;
      }
    };

    /**
     * Send `queue` (card numbers, numeric order) in cap-aware waves: never
     * push the estimated footprint past INBOX_SAFE. While there is no
     * headroom the run holds silently — no notice, no deadline, no pause —
     * polling the friend's save in the background and resuming by itself
     * the moment their game has collected enough room.
     */
    const sendWaves = async (
      f: { name: string },
      cityId: string,
      queue: number[],
      hist: Map<number, number[]>,
      st: RunState,
      kind: "plan" | "resend",
    ): Promise<WaveResult> => {
      let qi = 0;

      while (qi < queue.length) {
        if (stopRef.current) return "stop";
        const room = INBOX_SAFE - estimateBoxes(st.snap, st.unmerged, Date.now());

        if (room <= 0) {
          // Silent hold: poll until their save shows headroom, however long
          // that takes. Nothing is logged per wait — one warn per failing
          // read streak only — and the run never gives up or pauses.
          let step = 0;
          for (;;) {
            if (stopRef.current) return "stop";
            await sleep(WAIT_POLL_STEPS[Math.min(step, WAIT_POLL_STEPS.length - 1)]);
            step++;
            const r = await readState(cityId);
            if (r.ok) {
              st.readFails = 0;
              noteSnapshot(st, st.snap, r.snap);
              st.snap = r.snap;
              syncHistory(hist, r.snap);
              st.unmerged = unmergedOf(hist, r.snap);
              if (INBOX_SAFE - estimateBoxes(st.snap, st.unmerged, Date.now()) > 0) break;
            } else if (++st.readFails === MAX_READ_FAILS) {
              pushLog("warn", `${tr("cardsVerifyFail")} — ${f.name}: ${r.error}`);
            }
          }
          continue;
        }

        const batch = Math.min(room, queue.length - qi);
        for (let k = 0; k < batch; k++) {
          if (stopRef.current) return "stop";
          const n = queue[qi]!;
          const cardId = cardIdOf(n);
          try {
            const r: SendOutcome = await cardsSend({
              data: { token, sessionId, toCityId: cityId, cardId },
            });
            if (kind === "plan") done++;
            retried += r.retried;
            if (r.status === "sent") {
              if (kind === "plan") sent++;
              else resent++;
              const times = hist.get(n) ?? [];
              times.push(Date.now());
              hist.set(n, times);
              st.unmerged++;
              pushLog(
                "ok",
                `${kind === "plan" ? "✓" : "⟳"} ${f.name} · ${cardId}${qty > 1 ? ` #${times.length}` : ""}${r.retried ? ` (retry ×${r.retried})` : ""}`,
              );
            } else if (r.status === "rejected") {
              if (kind === "plan") rejected++;
              pushLog("bad", `✗ ${f.name} · ${cardId} — rejected (id không tồn tại)`);
            } else {
              if (kind === "plan") errors++;
              pushLog("bad", `✗ ${f.name} · ${cardId} — ${r.detail ?? `HTTP ${r.http ?? "?"}`}`);
              if (r.http === 401) {
                abort = true;
                pushLog("warn", tr("cardsAuthAbort"));
                return "stop";
              }
            }
          } catch (e) {
            if (kind === "plan") done++;
            errors++;
            const m = e instanceof Error ? e.message : String(e);
            pushLog("bad", `✗ ${f.name} · ${cardId} — ${m.slice(0, 140)}`);
          }
          qi++;
          flush("sending");
          await sleep(delayMs);
        }
      }
      return "done";
    };

    /**
     * Prove delivery from the friend's save, resend only what is *provably*
     * missing, and tally confirmed vs awaiting. The proof is a save that
     * absorbed a batch after our latest send — without it, "not in the save"
     * would mean in-transit, not lost, and resending would double-deliver.
     */
    const confirmFriend = async (
      f: { name: string },
      cityId: string,
      hist: Map<number, number[]>,
      st: RunState,
      expected: Record<number, number>,
      expectedTotal: number,
      allowPoll: boolean,
    ) => {
      const tally = (snap: CardSnapshot | null) => {
        const have = confirmedCount(expected, snap ? snap.fromUs : {});
        confirmed += have;
        awaiting += expectedTotal - have;
        if (have >= expectedTotal) {
          pushLog("ok", `${tr("cardsConfirmed")} — ${f.name}: ${have}/${expectedTotal}`);
        } else {
          pushLog("info", `${tr("cardsAwaiting")} — ${f.name}: ${have}/${expectedTotal}`);
        }
      };

      if (!st.snap) {
        awaiting += expectedTotal;
        pushLog("info", `${tr("cardsAwaiting")} — ${f.name} · ${tr("cardsVerifyFail")}`);
        return;
      }
      // Everything already sits in their save — nothing left to wait for.
      if (confirmedCount(expected, st.snap.fromUs) >= expectedTotal) {
        confirmed += expectedTotal;
        pushLog("ok", `${tr("cardsConfirmed")} — ${f.name}: ${expectedTotal}/${expectedTotal}`);
        return;
      }
      // One fresh read before deciding: a run that never had to wait has not
      // looked at their save since before the sends, and this single read is
      // what turns "probably delivered" into proof — their save absorbing the
      // boxes is both the confirmation and the sign that they are online.
      if (allowPoll) {
        const r = await readState(cityId);
        if (r.ok) {
          noteSnapshot(st, st.snap, r.snap);
          st.snap = r.snap;
          syncHistory(hist, r.snap);
          st.unmerged = unmergedOf(hist, r.snap);
          st.readFails = 0;
          if (confirmedCount(expected, r.snap.fromUs) >= expectedTotal) {
            confirmed += expectedTotal;
            pushLog("ok", `${tr("cardsConfirmed")} — ${f.name}: ${expectedTotal}/${expectedTotal}`);
            return;
          }
        }
      }
      // Their save never moved during the run: they are offline, so polling
      // would only stall the finish — report and let the next run confirm.
      if (!st.activity || !allowPoll) {
        tally(st.snap);
        return;
      }

      flush("confirming");
      pushLog("info", `${tr("cardsConfirming")} — ${f.name}`);

      const timesByCard = (h: Map<number, number[]>) => {
        const out: Record<number, readonly number[]> = {};
        for (const [n, times] of h) out[n] = times;
        return out;
      };

      for (let attempt = 0; attempt <= CONFIRM_ATTEMPTS; attempt++) {
        if (stopRef.current) return;
        const deadline = Date.now() + CONFIRM_WAIT_MS;
        let fails = 0;
        let proof = false;
        while (Date.now() < deadline && !proof) {
          if (stopRef.current) return;
          await sleep(CONFIRM_POLL_MS);
          const r = await readState(cityId);
          if (!r.ok) {
            if (++fails >= 3) break;
            continue;
          }
          fails = 0;
          st.readFails = 0;
          noteSnapshot(st, st.snap, r.snap);
          st.snap = r.snap;
          syncHistory(hist, r.snap);
          st.unmerged = unmergedOf(hist, r.snap);
          proof = r.snap.maxBoxTime * 1000 >= Math.max(runStart, latestSend(hist));
        }
        if (stopRef.current) return;
        if (!proof || !st.snap) break;

        const since = Math.max(runStart, latestSend(hist));
        const check = deliveryCheck(expected, st.snap, timesByCard(hist), since);
        const missing = Object.keys(check.missing)
          .map(Number)
          .sort((a, b) => a - b);
        if (missing.length === 0) break;
        if (attempt === CONFIRM_ATTEMPTS) break;

        const resendQueue: number[] = [];
        for (const n of missing) {
          for (let i = 0; i < (check.missing[n] ?? 0); i++) resendQueue.push(n);
        }
        pushLog(
          "warn",
          `${f.name}: ${resendQueue.length} ${tr("cardsResend")} — ${resendQueue.slice(0, 6).map(cardIdOf).join(" ")}${resendQueue.length > 6 ? " …" : ""}`,
        );
        const res = await sendWaves(f, cityId, resendQueue, hist, st, "resend");
        if (res === "stop") return;
      }
      tally(st.snap);
    };

    for (const f of selectedFriends) {
      const cityId = f.id.replace(/^id:/, "");
      const hist = historyFor(f.key);
      if (stopRef.current) {
        abort = true;
        break;
      }
      flush("sending");

      // ── baseline: their box footprint + what they already hold from us
      const st: RunState = { snap: null, unmerged: 0, activity: false, readFails: 0 };
      let baseErr: string | null = null;
      for (let i = 0; i < 2 && !st.snap; i++) {
        if (i) await sleep(READ_RETRY_DELAY_MS);
        const r = await readState(cityId);
        if (r.ok) {
          st.snap = r.snap;
          syncHistory(hist, r.snap);
          st.unmerged = unmergedOf(hist, r.snap);
        } else {
          st.readFails++;
          baseErr = r.error;
        }
      }
      if (!st.snap && baseErr) {
        pushLog("warn", `${tr("cardsVerifyFail")} — ${f.name}: ${baseErr}`);
      }
      if (stopRef.current) {
        abort = true;
        break;
      }

      // ── plan: exact per-card gaps — a re-run resumes instead of duplicating
      const expected: Record<number, number> = {};
      const plan = new Map<number, number>();
      for (const cardId of selectedCards) {
        const n = cardNumber(cardId);
        expected[n] = qty;
        const held = Math.max(hist.get(n)?.length ?? 0, st.snap ? (st.snap.fromUs[n] ?? 0) : 0);
        const gap = qty - Math.min(qty, held);
        if (gap > 0) plan.set(n, (plan.get(n) ?? 0) + gap);
      }
      const expectedTotal = selectedCards.length * qty;
      const planned = [...plan.values()].reduce((a, b) => a + b, 0);
      const skipped = expectedTotal - planned;
      if (skipped > 0) {
        runTotal -= skipped;
        pushLog("info", `${f.name}: ${skipped} ${tr("cardsAlready")} · ${planned} to send`);
      }

      const queue: number[] = [];
      for (const n of [...plan.keys()].sort((a, b) => a - b)) {
        for (let i = 0; i < (plan.get(n) ?? 0); i++) queue.push(n);
      }

      // Sync the badge to the adjusted totals before the first send — a run
      // that has to hold straight away would otherwise show the pre-skip
      // total until it eventually sends or finishes.
      flush("sending");
      const wave = queue.length > 0 ? await sendWaves(f, cityId, queue, hist, st, "plan") : "done";
      if (wave === "stop" || stopRef.current) {
        abort = true;
        break;
      }

      // ── confirm: prove the cards landed, resend only what is provably gone.
      // The wave only ever ends "done" here (stop breaks above), so confirm
      // may always take its fresh read and poll for proof.
      await confirmFriend(f, cityId, hist, st, expected, expectedTotal, true);
      if (stopRef.current) {
        abort = true;
        break;
      }
    }

    flush("sending");
    pushLog(
      abort && stopRef.current ? "warn" : errors > 0 ? "warn" : "ok",
      `${tr("cardsDone")}: ✓ ${sent} · ✗ ${rejected} · ⚠ ${errors}${retried ? ` · ⟳ ${retried}` : ""}${resent ? ` · +⟳ ${resent}` : ""} · ✓✓ ${confirmed} · ⏳ ${awaiting}`,
    );

    // The professional sign-off: a wall-clock verdict for the banner, and a
    // toast so the finish is noticed even when the log scrolled away.
    const seconds = Math.max(1, Math.round((Date.now() - t0) / 1000));
    const ok = !abort && sent === runTotal && rejected === 0 && errors === 0;
    setFinished({
      ok,
      stopped: abort,
      sent,
      rejected,
      errors,
      retried,
      resent,
      confirmed,
      awaiting,
      total: runTotal,
      seconds,
    });
    const desc = `${sent}/${runTotal} ✓ · ${rejected} ✗ · ${errors} ⚠${retried ? ` · ⟳${retried}` : ""}${resent ? ` · +⟳${resent}` : ""} · ✓✓${confirmed}${awaiting ? ` · ⏳${awaiting}` : ""} · ${seconds}s`;
    // A finished run is a success whenever every planned card went out —
    // receipts still in flight (⏳) are reported in the counts, never as a
    // pause or a warning.
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
      setInbox({
        name: acct.name,
        level: acct.level,
        boxes: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setInboxBusy(false);
    }
  };

  /** Read our own save + our own live inbox and compute the exact gap:
   *  what the album lacks that is not already waiting to be collected. */
  const analyzeSelf = async () => {
    if (!acct || running || selfBusy) return;
    setSelfBusy(true);
    try {
      const [sr, lr] = await Promise.all([
        cardsFetchState({ data: { token, sessionId, cityId: acct.cityId } }),
        cardsCheckInbox({ data: { token, sessionId } })
          .then((r) => ({ ok: true as const, r }))
          .catch((e) => ({
            ok: false as const,
            error: e instanceof Error ? e.message : String(e),
          })),
      ]);
      if (!sr.ok) throw new Error(sr.error);
      // Waiting = boxes still pending in the save ∪ cards sitting live in the
      // inbox. Either way the card is on its way: never plan it twice.
      const waiting = new Set<number>();
      for (const b of sr.snap.boxes) if (b.card !== null && !b.applied) waiting.add(b.card);
      if (lr.ok) {
        for (const b of lr.r.boxes) {
          const n = cardNumber(b.card ?? "");
          if (n > 0) waiting.add(n);
        }
      }
      const all = acct.cardIds.map(cardNumber).filter((n) => n > 0);
      const missing = missingCardNumbers(all, sr.snap.ownedIds, [...waiting]);
      setSelf({
        owned: sr.snap.albumUnique,
        waiting: waiting.size,
        live: lr.ok ? lr.r.total : 0,
        pending: sr.snap.pendingTotal,
        missing,
        error: lr.ok ? null : lr.error,
      });
      // The stats line stays clean — a failed live read is already shown
      // by the panel itself (⚠ under the numbers), never as a log notice.
      pushLog(
        "info",
        `${tr("cardsSelfAlbum")} ${sr.snap.albumUnique}/${all.length} · ${tr("cardsSelfWaiting")} ${waiting.size} · ${tr("cardsSelfMissing")} ${missing.length}`,
      );
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setSelf({ owned: 0, waiting: 0, live: 0, pending: 0, missing: [], error: m });
      pushLog("bad", m);
    } finally {
      setSelfBusy(false);
    }
  };

  /**
   * Collect for myself: send every missing card to this same account through
   * the proven SendBox loop — same physics as the friend run (numeric order,
   * delay ≥800ms, 403 retry, a stop button that stops), with two upgrades of
   * its own: it runs straight through with no wave hold and no inbox notice
   * mid-run, while the plan itself never exceeds the inbox's safe line — the
   * 101st box in a full inbox evicts the oldest, which would destroy the
   * cards this run just delivered, so whatever does not fit is named once at
   * the end (collect in game, run again). A fully successful run opens the
   * completion popup. `CheckCity` reads our
   * *own* live inbox, so delivery is proven the moment the box appears
   * there. The game then absorbs the boxes itself — album, counters,
   * set completions and set rewards all happen in the client, exactly like a
   * gift from a friend.
   */
  const startSelf = async () => {
    if (!acct || running) return;
    const cityId = acct.cityId;
    const all = acct.cardIds.map(cardNumber).filter((n) => n > 0);

    stopRef.current = false;
    setStop(false);
    setRunning(true);
    setProgress({
      done: 0,
      total: 0,
      sent: 0,
      rejected: 0,
      errors: 0,
      retried: 0,
      resent: 0,
      confirmed: 0,
      awaiting: 0,
      phase: "sending",
    });
    setFinished(null);
    setSelfPopup(null);
    setLog([]);
    const t0 = Date.now();

    // Tallies the banner reads — every count is an observed outcome, never
    // an estimate (rejected/error sends are never confirmed or resent).
    let runTotal = 0;
    let sent = 0;
    let rejected = 0;
    let errors = 0;
    let retried = 0;
    let resent = 0;
    let confirmed = 0;
    let awaiting = 0;
    let done = 0;
    let abort = false;
    /** Card numbers that answered "sent" this run — what verify reads back. */
    const sentList: number[] = [];
    /** Cards left for a later pass: over the safe line now, or skipped by a
     *  resend that would have evicted something instead of filling it. */
    let deferred = 0;

    const flush = (phase: Phase) =>
      setProgress({
        done,
        total: runTotal,
        sent,
        rejected,
        errors,
        retried,
        resent,
        confirmed,
        awaiting,
        phase,
      });

    const readState = async () => {
      try {
        return await cardsFetchState({ data: { token, sessionId, cityId } });
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    };
    const readLive = async (): Promise<LiveRead> => {
      try {
        const r = await cardsCheckInbox({ data: { token, sessionId } });
        const cards: number[] = [];
        for (const b of r.boxes) {
          const n = cardNumber(b.card ?? "");
          if (n > 0) cards.push(n);
        }
        return { ok: true, total: r.total, cards };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    /** The live view as the loop sees it — bumped per send, refreshed per read. */
    let liveOk = false;
    let liveTotal = 0;
    const liveCards = new Set<number>();
    const applyLive = (r: LiveRead) => {
      liveOk = r.ok;
      if (r.ok) {
        liveTotal = r.total;
        liveCards.clear();
        for (const n of r.cards) liveCards.add(n);
      }
    };

    // ── baseline: our save (album + absorbed boxes) and our own live inbox
    // (sent but not yet absorbed) — together they hold every card already
    // on the way, so none is planned twice. Each read is retried once and
    // then silently left out of the plan; a missing source never stops or
    // nags the run.
    let snap: CardSnapshot | null = null;
    for (let i = 0; i < 2 && !snap; i++) {
      if (i) await sleep(READ_RETRY_DELAY_MS);
      const r = await readState();
      if (r.ok) snap = r.snap;
      else if (i) pushLog("warn", `${tr("cardsVerifyFail")} — ${r.error}`);
    }
    for (let i = 0; i < 2 && !liveOk; i++) {
      if (i) await sleep(READ_RETRY_DELAY_MS);
      applyLive(await readLive());
    }

    // ── plan from the fresh reads; the Analyze click is only the fallback
    // when the save cannot be read at all.
    let queue: number[];
    if (snap) {
      const waiting = new Set<number>();
      for (const b of snap.boxes) if (b.card !== null && !b.applied) waiting.add(b.card);
      if (liveOk) for (const n of liveCards) waiting.add(n);
      queue = missingCardNumbers(all, snap.ownedIds, [...waiting]);
      const skipped = Math.max(0, (self?.missing.length ?? 0) - queue.length);
      if (skipped > 0) pushLog("info", `${skipped} ${tr("cardsAlready")}`);
    } else {
      queue = [...(self?.missing ?? [])].sort((a, b) => a - b);
      if (queue.length > 0) pushLog("warn", tr("cardsVerifyFail"));
    }
    if (queue.length === 0) {
      // Nothing left to plan. Say which of the two truths this is: the
      // album itself is full, or the rest of the cards is already sitting
      // in the inbox waiting for the game to collect them.
      const ownedNow = snap ? snap.ownedIds.length : (self?.owned ?? all.length);
      const gap = Math.max(0, all.length - ownedNow);
      const line = gap > 0 ? `${gap} ${tr("cardsSelfInbox")}` : tr("cardsSelfNone");
      pushLog(gap > 0 ? "info" : "ok", line);
      if (gap > 0) toast(line);
      else toast.success(tr("cardsSelfNone"));
      setRunning(false);
      setStop(false);
      void analyzeSelf();
      return;
    }

    // ── prune guard: the inbox holds INBOX_BOX_CAP boxes — the 101st
    // insert evicts the oldest down to 50, destroying cards this run just
    // delivered. Only the safe headroom goes out (a slice decided before
    // the first send, so the loop itself still runs straight through with
    // no hold and no notice); the remainder is reported once at the end.
    const usedNow = (snap?.pendingTotal ?? 0) + (liveOk ? liveTotal : 0);
    const budget = Math.max(0, INBOX_SAFE - usedNow);
    if (budget === 0) {
      pushLog("warn", tr("cardsSelfFullRun"));
      toast(tr("cardsSelfFullRun"));
      setRunning(false);
      setStop(false);
      void analyzeSelf();
      return;
    }
    deferred = Math.max(0, queue.length - budget);
    if (deferred > 0) {
      queue = queue.slice(0, budget);
      pushLog("info", `${deferred} ${tr("cardsSelfLeft")}`);
    }
    runTotal = queue.length;
    flush("sending");
    pushLog(
      "info",
      `${queue.length} → ${cityId} · delay ${delayMs}ms · ${tr("cardsSelfTitle")}`,
    );

    // ── straight send: every planned card, one after another, no wave cap
    // and no inbox hold — the plan above already stops at the safe line,
    // and this loop only stops on Stop or an auth failure.
    let qi = 0;
    while (!abort && qi < queue.length) {
      if (stopRef.current) {
        abort = true;
        break;
      }
      const n = queue[qi]!;
      const cardId = cardIdOf(n);
      try {
        const r: SendOutcome = await cardsSend({
          data: { token, sessionId, toCityId: cityId, cardId },
        });
        done++;
        retried += r.retried;
        if (r.status === "sent") {
          sent++;
          sentList.push(n);
          // The box is in the live inbox the moment SendBox answers.
          if (liveOk) liveTotal++;
          pushLog("ok", `✓ ${cityId} · ${cardId}${r.retried ? ` (retry ×${r.retried})` : ""}`);
        } else if (r.status === "rejected") {
          rejected++;
          pushLog("bad", `✗ ${cardId} — rejected (id không tồn tại)`);
        } else {
          errors++;
          pushLog("bad", `✗ ${cardId} — ${r.detail ?? `HTTP ${r.http ?? "?"}`}`);
          if (r.http === 401) {
            abort = true;
            pushLog("warn", tr("cardsAuthAbort"));
            break;
          }
        }
      } catch (e) {
        done++;
        errors++;
        const m = e instanceof Error ? e.message : String(e);
        pushLog("bad", `✗ ${cardId} — ${m.slice(0, 140)}`);
      }
      qi++;
      flush("sending");
      await sleep(delayMs);
    }

    // ── verify: for our own account the live inbox is readable, so delivery
    // is proven by the box simply being there (the same array the game's
    // inbox renders) — save absorption is the second, independent source.
    // Absence only proves "missing" when both reads cover everything; then
    // and only then does anything get resent, so a resend can never duplicate.
    if (!abort && sentList.length > 0) {
      flush("confirming");
      await sleep(CONFIRM_POLL_MS);
      for (let attempt = 0; attempt <= CONFIRM_ATTEMPTS && !stopRef.current; attempt++) {
        const [sr, lr] = await Promise.all([readState(), readLive()]);
        if (sr.ok) snap = sr.snap;
        applyLive(lr);
        const exact = sr.ok && liveOk && liveTotal <= INBOX_LIST_MAX;
        const missingNow: number[] = [];
        let have = 0;
        for (const n of sentList) {
          if (liveCards.has(n) || (snap && (snap.fromUs[n] ?? 0) > 0)) have++;
          else if (exact) missingNow.push(n);
        }
        confirmed = have;
        awaiting = sentList.length - have;
        if (missingNow.length === 0 || attempt === CONFIRM_ATTEMPTS) break;
        // A provably lost box is resent silently — the final summary line
        // already reports it as "+⟳ N", so no mid-run notice is needed.
        // A resend is an insert like any other: it stops at the safe line
        // too, or it would evict a card instead of filling the gap.
        const room = Math.max(
          0,
          INBOX_SAFE - ((snap?.pendingTotal ?? 0) + (liveOk ? liveTotal : 0)),
        );
        const resendQ = missingNow.slice(0, room);
        if (resendQ.length < missingNow.length) {
          deferred += missingNow.length - resendQ.length;
        }
        for (const n of resendQ) {
          if (stopRef.current) break;
          const cardId = cardIdOf(n);
          try {
            const r: SendOutcome = await cardsSend({
              data: { token, sessionId, toCityId: cityId, cardId },
            });
            retried += r.retried;
            if (r.status === "sent") {
              resent++;
              if (liveOk) liveTotal++;
              pushLog("ok", `⟳ ${cityId} · ${cardId}`);
            } else if (r.status === "error" && r.http === 401) {
              abort = true;
              pushLog("warn", tr("cardsAuthAbort"));
              break;
            } else {
              pushLog("bad", `✗ ${cardId} — ${r.detail ?? `HTTP ${r.http ?? "?"}`}`);
            }
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            pushLog("bad", `✗ ${cardId} — ${m.slice(0, 140)}`);
          }
          flush("confirming");
          await sleep(delayMs);
        }
        if (abort) break;
        if (attempt < CONFIRM_ATTEMPTS) await sleep(CONFIRM_POLL_MS);
      }
      // No log line here: the progress bar already sits at 100%, the final
      // summary carries ✓✓/⏳, and the popup below is the run's verdict.
    }

    flush("sending");
    pushLog(
      abort && stopRef.current ? "warn" : errors > 0 ? "warn" : "ok",
      `${tr("cardsDone")}: ✓ ${sent} · ✗ ${rejected} · ⚠ ${errors}${retried ? ` · ⟳ ${retried}` : ""}${resent ? ` · +⟳ ${resent}` : ""} · ✓✓ ${confirmed} · ⏳ ${awaiting}${deferred ? ` · ⏭ ${deferred}` : ""}`,
    );

    // The wall-clock verdict for the banner, the toast and the popup — a
    // run is a success whenever every planned card went out, receipts
    // included; only a success with nothing deferred earns the completion
    // dialog (a capped pass is honest about the cards still to come).
    const seconds = Math.max(1, Math.round((Date.now() - t0) / 1000));
    const ok = !abort && sent === runTotal && rejected === 0 && errors === 0;
    setFinished({
      ok,
      stopped: abort,
      sent,
      rejected,
      errors,
      retried,
      resent,
      confirmed,
      awaiting,
      total: runTotal,
      seconds,
    });
    const allDone = ok && deferred === 0;
    if (allDone) setSelfPopup({ sent, total: runTotal, confirmed, seconds });
    const desc = `${sent}/${runTotal} ✓ · ${rejected} ✗ · ${errors} ⚠${retried ? ` · ⟳ ${retried}` : ""}${resent ? ` · +⟳ ${resent}` : ""} · ✓✓${confirmed}${awaiting ? ` · ⏳ ${awaiting}` : ""}${deferred ? ` · ${deferred} ${tr("cardsSelfLeft")}` : ""} · ${seconds}s`;
    if (allDone) {
      toast.success(tr("cardsComplete"), { description: desc });
    } else if (ok) {
      toast(tr("cardsSelfPartial"), { description: desc });
    } else {
      toast(abort ? tr("cardsStopped") : tr("cardsComplete"), { description: desc });
    }

    setRunning(false);
    setStop(false);
    // Re-read the album so the panel shows the world as it is now: the sent
    // cards sit in the inbox waiting, and after the game collects them the
    // next Analyze shows them owned.
    void analyzeSelf();
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
    for (const m of manual)
      list.push({ id: m.id, name: m.name, level: m.level, key: `id:${m.id}` });
    const needle = q.trim().toLowerCase();
    return needle
      ? list.filter(
          (f) => f.name.toLowerCase().includes(needle) || f.id.toLowerCase().includes(needle),
        )
      : list;
  }, [acct, manual, q]);

  return (
    <div className="space-y-4">
      {/* ── hero: identity, live status, refresh / inbox ────────── */}
      <section className="panel relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-purple/20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-28 -left-16 size-56 rounded-full bg-cyan/10 blur-3xl"
        />
        <div className="relative flex flex-wrap items-start gap-4">
          <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-purple to-cyan text-2xl shadow-[0_10px_30px_rgba(124,58,237,0.4)]">
            🎴
          </div>
          <div className="min-w-0 flex-1">
            <p className="kicker text-[10px]">{tr("cardsSendTitle")}</p>
            <h3 className="mt-0.5 text-base font-bold tracking-tight">
              {tr("cardsCards")} · SendBox
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {acct ? (
              <span
                className={cn(
                  "state-badge inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-medium",
                  acct.checkError ? "border-amber/40 bg-amber/10 text-amber" : "state-badge--ready",
                )}
              >
                {acct.checkError ? `⚠ ${acct.checkError}` : `✓ ${tr("cardsTokenOk")}`}
              </span>
            ) : null}
            <Button size="sm" variant="ghost" disabled={loading} onClick={refresh}>
              {loading ? tr("cardsLoading") : tr("cardsRefresh")}
            </Button>
            <Button size="sm" variant="purple" disabled={loading || inboxBusy} onClick={checkInbox}>
              {inboxBusy ? "…" : tr("cardsInbox")}
            </Button>
          </div>
        </div>
        {acct ? (
          <div className="relative mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
            <span
              className="flex size-9 items-center justify-center rounded-full text-sm font-bold text-white ring-2 ring-white/10"
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
            <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs text-muted tabular-nums">
              {tr("cardsFriends")}: {acct.friends.length}
            </span>
          </div>
        ) : (
          <div className="relative mt-4 flex flex-wrap items-center gap-3 border-t border-white/5 pt-3">
            <p className="text-xs text-muted">{tr("cardsLoadFirst")}</p>
            <Button size="sm" variant="purple" disabled={loading} onClick={refresh}>
              {loading ? tr("cardsLoading") : tr("cardsRefresh")}
            </Button>
          </div>
        )}
        {err ? <p className="relative mt-2 text-xs text-amber">⚠ {err}</p> : null}
        {inbox ? (
          <div className="relative mt-3 rounded-xl border border-white/5 bg-black/30 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="kicker text-[10px]">{tr("cardsInbox")}</span>
              <span className="state-badge rounded-full bg-purple/15 px-2 py-0.5 text-[11px] text-purple tabular-nums">
                {inbox.boxes.length}
              </span>
              {inbox.error ? <span className="text-xs text-amber">⚠ {inbox.error}</span> : null}
            </div>
            {inbox.boxes.length === 0 && !inbox.error ? (
              <p className="text-xs text-muted">{tr("cardsInboxEmpty")}</p>
            ) : (
              <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                {inbox.boxes.map((b, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs text-muted transition-colors hover:bg-white/5"
                  >
                    <span>{b.type.includes("card") ? "🎴" : "🎁"}</span>
                    <span className="rounded bg-input px-1.5 py-0.5 font-mono text-[11px] text-fg">
                      {b.card ?? b.type}
                    </span>
                    {b.from ? <span>← {b.from}</span> : null}
                    {b.from ? null : <span className="flex-1" />}
                    {b.time ? (
                      <span className="ml-auto tabular-nums opacity-70">{b.time}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>

      {/* ── live numbers: exactly what this push will do ────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="stat-card flex items-center gap-3 rounded-xl border p-3.5" data-tone="1">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/5 text-lg shadow-hairline">
            👥
          </span>
          <div className="min-w-0">
            <p className="text-lg font-bold leading-none tabular-nums">
              {friendSel.size}
              <span className="text-xs font-medium text-muted">/{acct?.friends.length ?? 0}</span>
            </p>
            <p className="stat-title mt-1.5 truncate text-[10px]">{tr("cardsFriends")}</p>
          </div>
        </div>
        <div className="stat-card flex items-center gap-3 rounded-xl border p-3.5" data-tone="2">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/5 text-lg shadow-hairline">
            🃏
          </span>
          <div className="min-w-0">
            <p className="text-lg font-bold leading-none tabular-nums">
              {cardSel.size}
              <span className="text-xs font-medium text-muted">/{acct?.cardIds.length ?? 0}</span>
            </p>
            <p className="stat-title mt-1.5 truncate text-[10px]">{tr("cardsCards")}</p>
          </div>
        </div>
        <div className="stat-card flex items-center gap-3 rounded-xl border p-3.5" data-tone="3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/5 text-lg shadow-hairline">
            ✈️
          </span>
          <div className="min-w-0">
            <p className="text-lg font-bold leading-none tabular-nums">
              {total}
              <span className="text-xs font-medium text-muted">~{estSec}s</span>
            </p>
            <p className="stat-title mt-1.5 truncate text-[10px]">{tr("cardsEstimate")}</p>
          </div>
        </div>
        <div className="stat-card flex items-center gap-3 rounded-xl border p-3.5" data-tone="4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/5 text-lg shadow-hairline">
            🔁
          </span>
          <div className="min-w-0">
            <p className="text-lg font-bold leading-none tabular-nums">{qty}×</p>
            <p className="stat-title mt-1.5 truncate text-[10px]">{tr("cardsQty")}</p>
          </div>
        </div>
      </div>

      {/* ── collect for myself: close the gap to 151/151 ─────────── */}
      <section className="panel">
        <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
          🎴 {tr("cardsSelfTitle")}
          {running ? (
            <span className="state-badge ml-auto animate-pulse rounded-full bg-cyan/15 px-2.5 py-1 text-[11px] text-cyan">
              {stop ? `🛑 ${tr("cardsStopping")}` : `● ${tr("cardsRunning")}`}
            </span>
          ) : null}
        </h3>

        {self ? (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs tabular-nums">
            <span className="state-badge rounded-full bg-purple/15 px-2 py-0.5 text-purple">
              {tr("cardsSelfAlbum")}: {self.owned}/{acct?.cardIds.length ?? 0}
            </span>
            <span className="state-badge rounded-full bg-input px-2 py-0.5 text-muted">
              {tr("cardsSelfWaiting")}: {self.waiting}
            </span>
            <span className="state-badge rounded-full bg-input px-2 py-0.5 text-muted">
              {tr("cardsSelfLive")}: {self.live}
            </span>
            <span className="state-badge rounded-full bg-amber/15 px-2 py-0.5 text-amber">
              {tr("cardsSelfMissing")}: {self.missing.length}
            </span>
            {self.missing.length > 0 ? (
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                {self.missing.map((n) => cardIdOf(n)).join(" ")}
              </span>
            ) : (acct?.cardIds.length ?? 0) - self.owned > 0 ? (
              <span className="text-amber">
                📥 {(acct?.cardIds.length ?? 0) - self.owned} {tr("cardsSelfInbox")}
              </span>
            ) : (
              <span className="text-ok">✓ {tr("cardsSelfNone")}</span>
            )}
          </div>
        ) : null}
        {self?.error ? <p className="mb-3 text-xs text-amber">⚠ {self.error}</p> : null}
        {self && self.pending + self.live >= INBOX_SAFE ? (
          <p className="mb-3 text-xs text-amber">
            ⚠ {self.pending + self.live}/{INBOX_BOX_CAP} · {tr("cardsSelfFull")}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" disabled={!acct || running || selfBusy} onClick={analyzeSelf}>
            {selfBusy ? "…" : `🔍 ${tr("cardsSelfAnalyze")}`}
          </Button>
          <Button
            variant="success"
            disabled={!acct || running || !self || self.missing.length === 0}
            onClick={startSelf}
          >
            {running
              ? tr("cardsRunning")
              : `🎴 ${tr("cardsSelfRun")} · ${self?.missing.length ?? 0}`}
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
          {self && self.missing.length > 0 ? (
            <span className="state-badge rounded-full bg-input px-3 py-1.5 text-xs font-medium text-muted tabular-nums">
              {tr("cardsEstimate")}: {self.missing.length} · ~
              {Math.ceil((self.missing.length * (delayMs + 450)) / 1000)}s
            </span>
          ) : null}
        </div>
      </section>

      {/* ── friends + catalog, side by side on wide screens ──────── */}
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="panel flex flex-col">
          <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
            👥 {tr("cardsFriends")}
            <span className="state-badge ml-auto rounded-full bg-purple/15 px-2 py-0.5 text-[11px] text-purple tabular-nums">
              {friendSel.size}
            </span>
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
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/10 py-7 text-center">
              <span className="empty-state-icon text-2xl">👥</span>
              <p className="text-xs text-muted">
                {acct ? tr("cardsNoFriends") : tr("cardsLoadFirst")}
              </p>
            </div>
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
              {visibleFriends.map((f) => {
                const on = friendSel.has(f.key);
                return (
                  <li key={f.key}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleFriend(f.key)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all duration-150 ease-smooth",
                        on
                          ? "border-purple/55 bg-gradient-to-r from-purple/20 to-purple/5 shadow-[0_0_0_1px_rgba(124,58,237,0.25),0_0_16px_rgba(124,58,237,0.1)]"
                          : "border-white/5 bg-white/[0.02] hover:-translate-y-px hover:border-cyan/30 hover:bg-input",
                      )}
                    >
                      <span
                        className="flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ring-2 ring-white/10"
                        style={{ background: avatarColor(f.id) }}
                      >
                        {f.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.name}</span>
                      <span className="shrink-0 text-xs text-muted tabular-nums">
                        lvl {f.level || "?"}
                      </span>
                      <span className="hidden shrink-0 font-mono text-xs text-muted sm:inline">
                        {f.id}
                      </span>
                      <span
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded text-[10px] font-bold",
                          on
                            ? "bg-purple text-white shadow-[0_0_8px_rgba(124,58,237,0.5)]"
                            : "bg-input text-transparent",
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
        <section className="panel flex flex-col">
          <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
            🃏 {tr("cardsCards")}
            <span className="state-badge ml-auto rounded-full bg-amber/15 px-2 py-0.5 text-[11px] text-amber tabular-nums">
              {cardSel.size}
            </span>
          </h3>
          <p className="mb-2 text-xs text-muted">{tr("cardsCardsHint")}</p>
          {/* All groups at once — 10 cards per group, every card its own button.
              Ticking is the only selection mechanic: the send loop reads cardSel
              and nothing else, so exactly the ticked cards go out. */}
          <div className="max-h-[26rem] space-y-2.5 overflow-y-auto pr-1">
            {cardGroups.map(([s, ids]) => {
              const allOn = ids.every((id) => cardSel.has(id));
              const onCount = ids.filter((id) => cardSel.has(id)).length;
              const pct = ids.length ? Math.round((onCount / ids.length) * 100) : 0;
              return (
                <div
                  key={s}
                  className="stat-card rounded-xl border p-2.5"
                  data-tone={String(((s - 1) % 7) + 1)}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <button
                      type="button"
                      aria-pressed={allOn}
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
                        "rounded-lg border px-2 py-1 font-mono text-[11px] font-bold transition-all duration-150 ease-smooth",
                        allOn
                          ? "border-amber/50 bg-amber/15 text-amber shadow-amber-ring"
                          : "border-white/10 bg-black/30 text-muted hover:border-purple/40 hover:text-fg",
                      )}
                    >
                      set_{String(s).padStart(2, "0")}
                    </button>
                    <span className="text-[10px] font-semibold text-muted tabular-nums">
                      {onCount}/{ids.length}
                    </span>
                    <div className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-black/50">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-purple to-cyan transition-[width] duration-200"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-10">
                    {ids.map((id) => {
                      const on = cardSel.has(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleCard(id)}
                          title={id}
                          className={cn(
                            "relative rounded-lg border py-2 font-mono text-xs font-semibold tabular-nums transition-all duration-150 ease-smooth",
                            on
                              ? "border-purple/60 bg-gradient-to-b from-purple/30 to-purple/10 text-amber shadow-[0_0_0_1px_rgba(167,139,250,0.3),0_0_14px_rgba(167,139,250,0.2)]"
                              : "border-white/5 bg-black/25 text-muted hover:-translate-y-px hover:border-cyan/40 hover:bg-cyan/5 hover:text-fg",
                          )}
                        >
                          {id.split("_")[1]}
                          {on ? (
                            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber shadow-[0_0_6px_#f59e0b]" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCardSel(new Set(acct?.cardIds ?? []))}
            >
              {tr("selectAll")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCardSel(new Set())}>
              {tr("clear")}
            </Button>
            <span className="ml-auto text-[11px] text-muted tabular-nums">
              {cardSel.size}/{acct?.cardIds.length ?? 0}
            </span>
          </div>
        </section>
      </div>

      {/* ── send ────────────────────────────────────────────────── */}
      <section className="panel">
        <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
          ✈️ {tr("cardsSendTitle")}
          {running ? (
            <span className="state-badge ml-auto animate-pulse rounded-full bg-cyan/15 px-2.5 py-1 text-[11px] text-cyan">
              {stop ? `🛑 ${tr("cardsStopping")}` : `● ${tr("cardsRunning")}`}
            </span>
          ) : null}
        </h3>
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <div>
            <label className="kicker mb-1.5 block">{tr("cardsQty")}</label>
            <div className="flex items-center gap-1.5">
              {QTY_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={qty === n}
                  onClick={() => setQty(n)}
                  className={cn(
                    "rounded-lg border px-2.5 py-1.5 text-xs font-semibold tabular-nums transition-all duration-150 ease-smooth",
                    qty === n
                      ? "border-purple/55 bg-purple/25 text-purple shadow-purple"
                      : "border-white/5 bg-input text-muted hover:-translate-y-px hover:border-purple/30 hover:text-fg",
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
            <label className="kicker mb-1.5 block">{tr("cardsDelay")}</label>
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
          <span className="state-badge self-end rounded-full bg-input px-3 py-1.5 text-xs font-medium text-muted tabular-nums">
            {tr("cardsEstimate")}: {total} · ~{estSec}s
          </span>
          <div className="ml-auto flex items-center gap-2">
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
        </div>

        {progress.total > 0 ? (
          <div className="mt-4 rounded-xl border border-white/5 bg-black/25 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs tabular-nums">
              <span className="state-badge rounded-full bg-input px-2 py-0.5 text-muted">
                {progress.done}/{progress.total}
              </span>
              <span className="state-badge rounded-full bg-input px-2 py-0.5 text-ok">
                ✓ {progress.sent}
              </span>
              <span className="state-badge rounded-full bg-input px-2 py-0.5 text-danger">
                ✗ {progress.rejected}
              </span>
              <span className="state-badge rounded-full bg-input px-2 py-0.5 text-amber">
                ⚠ {progress.errors}
              </span>
              {progress.retried > 0 ? (
                <span className="state-badge rounded-full bg-input px-2 py-0.5 text-cyan">
                  ⟳ {progress.retried}
                </span>
              ) : null}
              {running && progress.phase === "confirming" ? (
                <span className="state-badge animate-pulse rounded-full bg-cyan/15 px-2 py-0.5 text-cyan">
                  🔍 {tr("cardsConfirming")}
                </span>
              ) : null}
              {progress.resent > 0 ? (
                <span className="state-badge rounded-full bg-cyan/15 px-2 py-0.5 text-cyan">
                  ⟳ {progress.resent}
                </span>
              ) : null}
              {progress.confirmed > 0 ? (
                <span className="state-badge rounded-full bg-ok/15 px-2 py-0.5 text-ok">
                  ✓✓ {progress.confirmed}
                </span>
              ) : null}
              {progress.awaiting > 0 ? (
                <span className="state-badge rounded-full bg-input px-2 py-0.5 text-muted">
                  ⏳ {progress.awaiting}
                </span>
              ) : null}
              <span className="ml-auto text-xs font-bold text-cyan tabular-nums">
                {progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-black/50 shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-purple to-cyan transition-[width] duration-200 shadow-[0_0_10px_rgba(56,189,248,0.35)]"
                style={{
                  width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        ) : null}

        {/* Completion banner — the run's verdict at a glance once the loop
            ends (every card sent — receipts confirmed or still arriving —
            or the run stopped). Never shows mid-run. */}
        {!running && finished ? (
          <div
            className={cn(
              "mt-3 flex items-center gap-3 rounded-lg border px-3.5 py-3",
              finishedGood ? "border-ok/50 bg-ok/10" : "border-amber/50 bg-amber/10",
            )}
          >
            <span className="text-2xl">{finished.stopped ? "⏹️" : "🎉"}</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {finished.stopped ? tr("cardsStopped") : tr("cardsComplete")}
              </p>
              <p className="text-xs tabular-nums text-muted">
                {finished.sent}/{finished.total} ✓ · {finished.rejected} ✗ · {finished.errors} ⚠
                {finished.retried ? ` · ⟳ ${finished.retried}` : ""}
                {finished.resent ? ` · +⟳ ${finished.resent}` : ""}
                {finished.confirmed ? ` · ✓✓ ${finished.confirmed}` : ""}
                {finished.awaiting ? ` · ⏳ ${finished.awaiting}` : ""} · {finished.seconds}s
              </p>
            </div>
            <span
              className={cn(
                "ml-auto rounded-full px-2.5 py-1 text-xs font-bold tabular-nums",
                finishedGood ? "bg-ok/20 text-ok" : "bg-amber/20 text-amber",
              )}
            >
              {Math.round((finished.sent / Math.max(1, finished.total)) * 100)}%
            </span>
          </div>
        ) : null}

        {log.length > 0 ? (
          <div className="mt-3 overflow-hidden rounded-xl border border-white/5 bg-[#0a0f1c]">
            <div className="max-h-52 space-y-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
              {log
                .slice()
                .reverse()
                .map((l) => (
                  <div key={l.id} className="flex items-start gap-2">
                    <span
                      className={cn(
                        "mt-1 size-1.5 shrink-0 rounded-full",
                        l.kind === "ok" && "bg-ok shadow-[0_0_6px_rgba(52,211,153,0.7)]",
                        l.kind === "bad" && "bg-danger shadow-[0_0_6px_rgba(244,63,94,0.7)]",
                        l.kind === "warn" && "bg-amber shadow-[0_0_6px_rgba(245,158,11,0.7)]",
                        l.kind === "info" && "bg-muted/60",
                      )}
                    />
                    <span
                      className={cn(
                        l.kind === "ok" && "text-ok",
                        l.kind === "bad" && "text-danger",
                        l.kind === "warn" && "text-amber",
                        l.kind === "info" && "text-muted",
                      )}
                    >
                      {l.text}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        ) : null}

        {/* Completion popup — the self-run's "all sent" moment: opens only
            when every planned card went out (banner/summary still cover
            every other ending), closes on OK or the scrim. Fixed positioning
            lets it float over the whole studio. */}
        {selfPopup ? (
          <div className="fixed inset-0 z-50 grid place-items-center p-4">
            <button
              type="button"
              aria-label={tr("cardsSelfPopupOk")}
              className="absolute inset-0 cursor-default bg-black/65 backdrop-blur-[2px]"
              onClick={() => setSelfPopup(null)}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label={tr("cardsSelfPopupTitle")}
              className="relative w-full max-w-sm rounded-2xl border border-ok/40 bg-card p-6 text-center shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
            >
              <div className="mx-auto mb-3 grid size-14 place-items-center rounded-full bg-ok/15 text-3xl shadow-[0_0_24px_rgba(52,211,153,0.35)]">
                🎉
              </div>
              <h4 className="text-lg font-bold">{tr("cardsSelfPopupTitle")}</h4>
              <p className="mt-1 text-sm text-muted tabular-nums">
                {selfPopup.sent}/{selfPopup.total} ✓{selfPopup.confirmed ? ` · ✓✓ ${selfPopup.confirmed}` : ""} ·{" "}
                {selfPopup.seconds}s
              </p>
              <Button variant="success" className="mt-5 w-full" onClick={() => setSelfPopup(null)}>
                {tr("cardsSelfPopupOk")}
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
