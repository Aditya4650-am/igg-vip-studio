/**
 * Card-collections grants (`DataStoreCollection > CardCollections`).
 *
 * Real progress is the `OwnedCards` array of
 * `<DataElem type="dataStore">` entries
 * (`cardId`, `generatedCount`, `inStockCount`, `isNew`, `maxInStockCount`).
 * The flat `FullCardCollections` counter is display-only — the game does not
 * read it, so writing it reports success while changing nothing in game.
 *
 * Canonical ids are `card_01..card_09` then `card_10..card_150`: every real
 * city writes single digits zero-padded (no real city ever held unpadded
 * `card_1..card_9` — those rows are tool-created lookalikes the game keeps
 * but never counts toward a set). Inputs in either form are normalized to
 * canonical, and stale unpadded lookalikes are removed when their canonical
 * twin is granted.
 */

export const CARD_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 150 }, (_, i) => {
    const n = i + 1;
    return n < 10 ? `card_0${n}` : `card_${n}`;
  }),
);

const KNOWN: ReadonlySet<string> = new Set(CARD_IDS);

/** Normalize `card_6`/`card_06` (any padding) to the canonical id, or null. */
function canonical(id: string): string | null {
  const m = /^card_0*(\d+)$/.exec(id.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 150) return null;
  return n < 10 ? `card_0${n}` : `card_${n}`;
}

function ownedCardsSpan(doc: string): [number, number] | null {
  const open =
    doc.match(/<DataElem\b[^>]*\bname="OwnedCards"[^>]*\btype="array"[^>]*>/i) ??
    doc.match(/<DataElem\b[^>]*\btype="array"[^>]*\bname="OwnedCards"[^>]*>/i);
  if (!open || open.index === undefined) return null;
  if (/\/>\s*$/.test(open[0])) return null;
  let depth = 1;
  let pos = open.index + open[0].length;
  const openEnd = pos;
  while (depth > 0 && pos < doc.length) {
    const rest = doc.slice(pos);
    const o = rest.search(/<DataElem\b/i);
    const c = rest.search(/<\/DataElem\s*>/i);
    if (c < 0) return null;
    if (o >= 0 && o < c) {
      const abs = pos + o;
      const gt = doc.indexOf(">", abs);
      if (gt >= 0 && doc[gt - 1] !== "/") depth++;
      pos = gt >= 0 ? gt + 1 : abs + 9;
    } else {
      const absC = pos + c;
      depth--;
      if (depth === 0) return [openEnd, absC];
      pos = absC + 11;
    }
  }
  return null;
}

function fieldValue(entry: string, name: string): string | null {
  return entry.match(new RegExp(`<DataElem\\b[^>]*\\bname="${name}"[^>]*\\bvalue="([^"]*)"`, "i"))?.[1] ?? null;
}

function setField(entry: string, name: string, value: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return entry.replace(
    new RegExp(`(<DataElem\\b[^>]*\\bname="${esc}"[^>]*\\bvalue=")[^"]*(")`, "i"),
    `$1${value}$2`,
  );
}

function setDocInt(doc: string, name: string, value: number): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return doc.replace(
    new RegExp(`(<DataElem\\b[^>]*\\bname="${esc}"[^>]*\\bvalue=")\\d+(")`, "i"),
    `$1${value}$2`,
  );
}

function docInt(doc: string, name: string): number | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = doc.match(new RegExp(`<DataElem\\b[^>]*\\bname="${esc}"[^>]*\\bvalue="(\\d+)"`, "i"));
  return m ? Number(m[1]) : null;
}

/**
 * Ensure every selected card is owned (`inStockCount >= 1`, `isNew` set),
 * inserting absent entries from the known set only. Inputs in either padding
 * form normalize to canonical. Stale unpadded lookalikes (`card_6` next to
 * `card_06`) are removed when their canonical twin is granted. Counters
 * beyond that — and every other attribute — are preserved. Returns
 * `changed: 0` when nothing would move so the caller reports a real no-op.
 */
export function grantCards(xml: string, ids: string[]) {
  let text = xml;
  const wanted = [...new Set(ids.map((id) => canonical(id)).filter((x): x is string => Boolean(x)))];
  if (!wanted.length) return { xml: text, changed: 0 };
  // No CardCollections block means the event never opened on this save —
  // inventing the whole structure risks a corrupt session, so refuse with a
  // useful error instead of guessing.
  if (!/name="CardCollections"/i.test(text)) {
    throw new Error("Save chưa mở sự kiện Card Collections — mở bộ sưu tập trong game rồi Load lại");
  }
  const span = ownedCardsSpan(text);
  if (!span) {
    throw new Error("Không đọc được OwnedCards trong save — Load lại rồi thử lại");
  }
  let changed = 0;
  for (const id of wanted) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const region = text.slice(span[0], span[1]);
    const m = region.match(new RegExp(`<DataElem\\b[^>]*\\bname="cardId"[^>]*\\bvalue="${esc}"[^>]*>`, "i"));
    if (!m || m.index === undefined) {
      const insert =
        `<DataElem type="dataStore">` +
        `<DataElem name="cardId" type="string" value="${id}"/>` +
        `<DataElem name="generatedCount" type="int" value="1"/>` +
        `<DataElem name="inStockCount" type="int" value="1"/>` +
        `<DataElem name="isNew" type="bool" value="true"/>` +
        `<DataElem name="maxInStockCount" type="int" value="1"/>` +
        `</DataElem>`;
      text = text.slice(0, span[1]) + insert + text.slice(span[1]);
      span[1] += insert.length;
      changed += 1;
    } else {
      // Entry bounds: up to the next card entry (or the array end), so field
      // edits cannot bleed into a neighbouring card.
      const rest = region.slice(m.index);
      const nextCard = rest.slice(m[0].length).search(/<DataElem\b[^>]*\bname="cardId"/i);
      const end = nextCard < 0 ? region.length : m.index + m[0].length + nextCard;
      let entry = region.slice(m.index, end);
      const stock = Number(fieldValue(entry, "inStockCount") ?? "0");
      const maxStock = Number(fieldValue(entry, "maxInStockCount") ?? "0");
      const isNew = fieldValue(entry, "isNew");
      let moved = false;
      if (stock < 1) {
        entry = setField(entry, "inStockCount", "1");
        moved = true;
      }
      if (maxStock < 1) {
        entry = setField(entry, "maxInStockCount", "1");
        moved = true;
      }
      if (isNew !== "true") {
        entry = setField(entry, "isNew", "true");
        moved = true;
      }
      if (moved) {
        text = text.slice(0, span[0] + m.index) + entry + text.slice(span[0] + end);
        span[1] += entry.length - (end - m.index);
        changed += 1;
      }
    }
    // Drop the unpadded lookalike the old build wrote (`card_6` next to the
    // canonical `card_06`). The close quote keeps `card_06` itself safe. The
    // splice covers exactly one entry (one non-self-closing opener, one
    // closer); anything else aborts the cleanup rather than risking the doc.
    const num = Number(id.split("_")[1]);
    if (num < 10) {
      const twin = `card_${num}`;
      const tesc = twin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const region2 = text.slice(span[0], span[1]);
      const tm = region2.match(new RegExp(`<DataElem\\b[^>]*\\bname="cardId"[^>]*\\bvalue="${tesc}"[^>]*>`, "i"));
      if (tm && tm.index !== undefined) {
        const cardAbs = span[0] + tm.index;
        const entryStart = text.lastIndexOf("<DataElem", cardAbs - 1);
        const afterTag = cardAbs + tm[0].length;
        const closer = /<\/DataElem\s*>/.exec(text.slice(afterTag, span[1]));
        if (entryStart >= span[0] && closer && !/<\/DataElem/i.test(text.slice(entryStart, cardAbs))) {
          const entryEnd = afterTag + closer.index + closer[0].length;
          const cut = text.slice(entryStart, entryEnd);
          const opens = (cut.match(/<DataElem\b/g) ?? []).length;
          const selfClose = (cut.match(/<DataElem\b[^>]*\/>/g) ?? []).length;
          const closes = (cut.match(/<\/DataElem/g) ?? []).length;
          if (opens - selfClose === 1 && closes === 1) {
            text = text.slice(0, entryStart) + text.slice(entryEnd);
            span[1] -= entryEnd - entryStart;
            changed += 1;
          }
        }
      }
    }
  }
  if (changed) {
    // Keep the analytics counters consistent with what the save now holds —
    // only ever raised, never lowered. Both are ints the game itself
    // writes; gifts, tokens and set state are never touched.
    const after = ownedCardsSpan(text);
    if (after) {
      const distinct = new Set(
        [...text.slice(after[0], after[1]).matchAll(/<DataElem\b[^>]*\bname="cardId"[^>]*\bvalue="([^"]*)"/gi)].map((x) => x[1]),
      ).size;
      const unique = docInt(text, "trackedUniqueCollectedCards");
      if (unique !== null && distinct > unique) {
        text = setDocInt(text, "trackedUniqueCollectedCards", distinct);
      }
      const max = docInt(text, "trackedMaxCollectedCards");
      if (max !== null && distinct > max) {
        text = setDocInt(text, "trackedMaxCollectedCards", distinct);
      }
    }
  }
  return { xml: text, changed };
}
