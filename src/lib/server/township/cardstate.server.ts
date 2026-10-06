/**
 * Read a friend's save for the Cards tab's delivery check.
 *
 * The send loop needs to know three things about a receiver that `SendBox`
 * cannot tell us: what their inbox currently holds (the 100-box cap is the
 * one thing that can destroy a delivery), what they already hold from us, and
 * whether their save has moved since our last wave — i.e. whether they have
 * opened the game to collect. All three live in their save, and FetchCity
 * reads any city's save by id, so this module is the transport: one process
 * per read (`scripts/township/card_state.py`, the additive sibling of
 * `fetch_city.py` that keeps `updAt`), then `parseCardSnapshot` in
 * `cards-delivery.ts` turns the XML into the counts the loop acts on.
 *
 * Failures are returned, never thrown: an unreadable save makes the loop
 * conservative (the STALE_BACKLOG_RESERVE estimate) instead of blind.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cardSessionMeta } from "./cardsend.server";
import { parseCardSnapshot, type CardSnapshot } from "../../cards-delivery";

export type CardStateResult = { ok: true; snap: CardSnapshot } | { ok: false; error: string };

/** One FetchCity round trip: spawn, read, decode, parse. */
const READ_TIMEOUT_MS = 90_000;

function scriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "scripts/township/card_state.py"),
    join(here, "../../../../scripts/township/card_state.py"),
    join(here, "../../../scripts/township/card_state.py"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

type StateReply = { ok: boolean; xml_b64?: string; updAt?: number; error?: string };

function runStateScript(cityId: string, bver: string, fver: string): Promise<StateReply> {
  const script = scriptPath();
  const candidates = [process.env.PYTHON_BIN, "python3", "python"].filter(Boolean) as string[];

  return new Promise((resolve, reject) => {
    let index = 0;
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message.slice(0, 300)));
    };

    const runNext = () => {
      if (settled) return;
      const bin = candidates[index++];
      if (!bin) {
        fail("Cards: Python không chạy được trên server (thiếu python3/python)");
        return;
      }

      let out = "";
      let timedOut = false;
      const py = spawn(bin, [script, cityId, bver, fver], {
        cwd: dirname(script),
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      const killTimer = setTimeout(() => {
        timedOut = true;
        py.kill();
      }, READ_TIMEOUT_MS);

      py.stdout.setEncoding("utf8");
      py.stdout.on("data", (d) => {
        out += d;
      });
      py.stderr.on("data", () => {
        /* diagnostics only — the JSON on stdout is the contract */
      });

      py.on("error", () => {
        clearTimeout(killTimer);
        runNext();
      });

      py.on("close", (code) => {
        clearTimeout(killTimer);
        if (settled) return;
        if (timedOut) {
          fail("Cards: đọc save quá hạn — máy chủ không trả lời");
          return;
        }
        const lines = out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i]!.startsWith("{")) continue;
          try {
            const parsed = JSON.parse(lines[i]!) as StateReply;
            if (typeof parsed.ok !== "boolean") continue;
            settled = true;
            resolve(parsed);
            return;
          } catch {
            /* keep looking for an earlier JSON line */
          }
        }
        fail(
          `Cards: Python lỗi ${code ?? "?"} — ${lines.join(" ").slice(0, 200) || "không có đầu ra"}`,
        );
      });
    };

    runNext();
  });
}

/**
 * Fetch `cityId`'s save and parse the delivery-relevant state out of it.
 * `sessionId` supplies the sender's game versions and own cityId (for box
 * attribution); no token is involved — FetchCity is a by-id read.
 */
export async function fetchCardState(sessionId: string, cityId: string): Promise<CardStateResult> {
  const meta = cardSessionMeta(sessionId);
  if (!meta) {
    return { ok: false, error: "Cards: chưa nạp LocalInfo — bấm Refresh trước." };
  }
  if (!/^[A-Za-z0-9]{4,24}$/.test(cityId)) {
    return { ok: false, error: `id không hợp lệ (${cityId})` };
  }
  if (!meta.bver || !meta.fver) {
    return { ok: false, error: "Thiếu version game (bver/FVer) — mở Township rồi Refresh." };
  }

  try {
    const reply = await runStateScript(cityId, meta.bver, meta.fver);
    if (!reply.ok || !reply.xml_b64) {
      return { ok: false, error: reply.error ?? "FetchCity không có dữ liệu" };
    }
    const xml = Buffer.from(reply.xml_b64, "base64").toString("utf8");
    const snap = parseCardSnapshot(xml, { ourCityId: meta.cityId, updAt: reply.updAt ?? 0 });
    return { ok: true, snap };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
