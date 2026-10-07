/** Per-animal piece requirements, inventoried from a complete zoo save.
 * Key: paddock type -> member name -> pieces at completion. Falls back
 * per name, then to the global observed maximum. Never hand-written. */
export const ZOO_REQUIREMENTS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  "paddock_WhiteOwl": Object.freeze({ "Bamby": 10, "Baxter": 15, "Hazel": 30, "Nibbles": 30 }),
  "paddock_anteater": Object.freeze({ "Grimble": 30, "Mickey": 10, "Pepper": 30, "Twinkles": 15 }),
  "paddock_arcticfox": Object.freeze({ "Haley": 15, "Nibbles": 30, "Trixie": 30 }),
  "paddock_armadillo": Object.freeze({ "Bananas": 10, "Baxter": 30, "Daisy": 30 }),
  "paddock_bear": Object.freeze({ "Bamby": 30, "Genie": 15, "Max": 30 }),
  "paddock_beaver": Object.freeze({ "Alfie": 15, "Kisa": 30, "Libby": 10, "Nibbles": 30 }),
  "paddock_boar": Object.freeze({ "Amber": 15, "Ellie": 30, "Hector": 10, "Herbie": 30 }),
  "paddock_camel": Object.freeze({ "Alvin": 30, "Debbie": 10, "Grimble": 15, "Libby": 30 }),
  "paddock_crane": Object.freeze({ "Amber": 30, "Bananas": 30, "Baxter": 15, "Daisy": 10 }),
  "paddock_crocodile": Object.freeze({ "Allie": 10, "Poco": 30, "Roo": 15, "Trixie": 30 }),
  "paddock_deer": Object.freeze({ "Ellie": 15, "Fluffy": 30, "Grimble": 10, "Roo": 30 }),
  "paddock_eagle": Object.freeze({ "Amber": 15, "Bananas": 10, "Herbie": 30, "Sunshine": 30 }),
  "paddock_elephant": Object.freeze({ "Bamby": 10, "Hazel": 30, "Poco": 30, "Snoopy": 15 }),
  "paddock_fennec": Object.freeze({ "Alamo": 30, "Doodles": 10, "Fluffy": 30, "Pepper": 15 }),
  "paddock_flamingo": Object.freeze({ "Doodles": 10, "Fluffy": 30, "Lucky": 15, "Scooby": 30 }),
  "paddock_gazelle": Object.freeze({ "Alvin": 10, "Kisa": 30, "Mickey": 30, "Twinkles": 15 }),
  "paddock_girrafe": Object.freeze({ "Daisy": 30, "Lucky": 15, "Roo": 30 }),
  "paddock_gorilla": Object.freeze({ "Haley": 30, "Hector": 15, "Herbie": 30, "Sunshine": 10 }),
  "paddock_hippo": Object.freeze({ "Alamo": 15, "Debbie": 10, "Genie": 30, "Lex": 30 }),
  "paddock_kangaroo": Object.freeze({ "Fluffy": 10, "Poco": 15, "Rosco": 30, "Smiley": 30 }),
  "paddock_koala": Object.freeze({ "Allie": 10, "Amber": 30, "Mickey": 15, "Poco": 30 }),
  "paddock_laski": Object.freeze({ "Alfie": 15, "Meesha": 10, "Snoopy": 30, "Trixie": 30 }),
  "paddock_lion": Object.freeze({ "Fluffy": 15, "Hazel": 30, "Roo": 10, "Rosco": 30 }),
  "paddock_llama": Object.freeze({ "Doodles": 10, "Fluffy": 30, "Hazel": 15, "Hector": 30 }),
  "paddock_lynx": Object.freeze({ "Haley": 30, "Meesha": 10, "Nibbles": 15, "Scooby": 30 }),
  "paddock_monkey": Object.freeze({ "Hector": 30, "Libby": 30, "Max": 15, "Twinkles": 10 }),
  "paddock_muskOx": Object.freeze({ "Allie": 30, "Daisy": 15, "Max": 10, "Scooby": 30 }),
  "paddock_ostrich": Object.freeze({ "Daisy": 15, "Ellie": 30, "Roo": 10, "Snoopy": 30 }),
  "paddock_panda": Object.freeze({ "Allie": 10, "Amber": 30, "Ollie": 30, "Scooby": 15 }),
  "paddock_panther": Object.freeze({ "Amber": 30, "Roo": 30, "Scooby": 10, "Twinkles": 15 }),
  "paddock_parrot": Object.freeze({ "Bamby": 30, "Bananas": 10, "Poco": 30, "Sunshine": 15 }),
  "paddock_peacock": Object.freeze({ "Bananas": 15, "Mickey": 30, "Smiley": 10, "Trixie": 30 }),
  "paddock_pelican": Object.freeze({ "Doodles": 10, "Fluffy": 15, "Haley": 30, "Snoopy": 30 }),
  "paddock_penguin": Object.freeze({ "Doodles": 15, "Genie": 30, "Max": 30, "Trixie": 10 }),
  "paddock_platypus": Object.freeze({ "Allie": 30, "Fluffy": 10, "Hector": 15, "Nibbles": 30 }),
  "paddock_polar_bear": Object.freeze({ "Daisy": 30, "Genie": 10, "Roo": 30 }),
  "paddock_polarwolf": Object.freeze({ "Baxter": 10, "Goofy": 30, "Libby": 15, "Sunshine": 30 }),
  "paddock_porcupine": Object.freeze({ "Daisy": 30, "Doodles": 10, "Hector": 30, "Trixie": 15 }),
  "paddock_raccoon": Object.freeze({ "Alvin": 10, "Debbie": 30, "Doodles": 30, "Fluffy": 15 }),
  "paddock_redPanda": Object.freeze({ "Alvin": 10, "Doodles": 30, "Hazel": 30, "Smiley": 15 }),
  "paddock_rhino": Object.freeze({ "Haley": 30, "Meesha": 10, "Rosco": 30, "Scooby": 15 }),
  "paddock_seal": Object.freeze({ "Haley": 15, "Max": 30, "Roo": 10, "Trixie": 30 }),
  "paddock_skunk": Object.freeze({ "Alamo": 10, "Baxter": 30, "Debbie": 30, "Sunshine": 15 }),
  "paddock_snow_monkey": Object.freeze({ "Amber": 15, "Haley": 30, "Lex": 10, "Nibbles": 30 }),
  "paddock_tapir": Object.freeze({ "Bamby": 30, "Bananas": 10, "Max": 30, "Twinkles": 15 }),
  "paddock_tiger": Object.freeze({ "Bamby": 10, "Lex": 15, "Rosco": 30, "Smiley": 30 }),
  "paddock_toucan": Object.freeze({ "Alamo": 30, "Hazel": 30, "Hector": 15 }),
  "paddock_turtle": Object.freeze({ "Genie": 30, "Nibbles": 15, "Roo": 30, "Roxy": 10 }),
  "paddock_walrus": Object.freeze({ "Grimble": 30, "Haley": 15, "Kisa": 30, "Scooby": 10 }),
  "paddock_zebra": Object.freeze({ "Genie": 10, "Kisa": 30, "Ollie": 30 }),
});
export const ZOO_NAME_FALLBACK: Readonly<Record<string, number>> = Object.freeze({
  "Alamo": 30, "Alfie": 15, "Allie": 30, "Alvin": 30, "Amber": 30, "Bamby": 30, "Bananas": 30, "Baxter": 30, "Daisy": 30, "Debbie": 30, "Doodles": 30, "Ellie": 30, "Fluffy": 30, "Genie": 30, "Goofy": 30, "Grimble": 30, "Haley": 30, "Hazel": 30, "Hector": 30, "Herbie": 30, "Kisa": 30, "Lex": 30, "Libby": 30, "Lucky": 15, "Max": 30, "Meesha": 10, "Mickey": 30, "Nibbles": 30, "Ollie": 30, "Pepper": 30, "Poco": 30, "Roo": 30, "Rosco": 30, "Roxy": 10, "Scooby": 30, "Smiley": 30, "Snoopy": 30, "Sunshine": 30, "Trixie": 30, "Twinkles": 15,
});
export const ZOO_GLOBAL_MAX = 30;

export type ZooMember = { key: string; name: string; status: number; pieces: number; required: number };
export type ZooPaddock = { paddock: string; members: ZooMember[] };

function requirement(paddock: string, name: string): number {
  return (
    ZOO_REQUIREMENTS[paddock]?.[name] ??
    ZOO_NAME_FALLBACK[name] ??
    ZOO_GLOBAL_MAX
  );
}

/** Locate the single-quoted Paddocks JSON attribute value span. */
function paddocksSpan(doc: string): { start: number; end: number; json: string } | null {
  const m = doc.match(/Paddocks='(\{[\s\S]*?\})'(?=\s*\/?>|\s+[A-Za-z_])/);
  if (!m || m.index === undefined || m[1] === undefined) return null;
  const start = m.index + m[0].indexOf(m[1]);
  return { start, end: start + m[1].length, json: m[1] };
}

/** Every paddock/member row in document order, with keys stable per session. */
export function discoverZoo(xml: string): ZooPaddock[] {
  const span = paddocksSpan(xml);
  if (!span) return [];
  let doc: { list?: { type?: string; members?: { name?: string; status?: number; piecesCount?: number }[] }[] };
  try {
    doc = JSON.parse(span.json);
  } catch {
    return [];
  }
  const out: ZooPaddock[] = [];
  for (const p of doc.list ?? []) {
    if (!p || typeof p.type !== "string") continue;
    const ptype: string = p.type;
    const members: ZooMember[] = [];
    (p.members ?? []).forEach((mb, i) => {
      const name: string = typeof mb?.name === "string" ? mb.name : "";
      if (!mb || !name) return;
      members.push({
        key: `${ptype}:${i}`,
        name,
        status: typeof mb.status === "number" ? mb.status : 0,
        pieces: typeof mb.piecesCount === "number" ? mb.piecesCount : 0,
        required: requirement(ptype, name),
      });
    });
    out.push({ paddock: ptype, members });
  }
  return out;
}

function stringifyAttr(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Complete zoo members: `status` to 3 and `piecesCount` up to the mapped
 * requirement — but only members the game itself marks incomplete
 * (`status !== 3`). A complete member holding fewer pieces than the mapped
 * maximum (duplicate names share one map entry) is left byte-identical:
 * rewriting it would overfill beyond what the game accepted.
 * The paddock's `count` is then recounted to the members at status 3 — the
 * invariant every real save keeps (`count` is the counter
 * `AnimalPaddock::AddAnimal` maintains and the number the family gift
 * reads): a stale one would leave the gift locked behind collected
 * portraits. `rewardCollected`, so the gift stays claimable, and every
 * other field survive untouched. The
 * attribute must roundtrip byte-identical when nothing changes — otherwise
 * the JSON dialect differs and we refuse rather than risk the document.
 * Returns `changed: 0` for the no-op report.
 */
export function completeZoo(xml: string, keys: string[]) {
  const text = xml;
  const wanted = new Set(keys.map((k) => k.trim()).filter(Boolean));
  if (!wanted.size) return { xml: text, changed: 0 };
  if (!/Paddocks='/i.test(text)) {
    throw new Error("Không thấy Zoo trong save — mở Zoo trong game rồi Load lại");
  }
  const span = paddocksSpan(text);
  if (!span) throw new Error("Không đọc được Paddocks trong save — Load lại rồi thử lại");
  let doc: { list?: { type?: string; count?: number; members?: Record<string, unknown>[] }[] };
  try {
    doc = JSON.parse(span.json);
  } catch {
    throw new Error("Paddocks không đọc được — Load lại rồi thử lại");
  }
  // Roundtrip guard: untouched serialization must equal the stored bytes, or
  // our writer speaks a different JSON dialect than the game.
  if (stringifyAttr(doc) !== span.json) {
    throw new Error("Định dạng Paddocks lạ — hủy để tránh hỏng file");
  }
  let changed = 0;
  for (const p of doc.list ?? []) {
    const ptype: string = typeof p?.type === "string" ? p.type : "";
    if (!p || !ptype || !Array.isArray(p.members)) continue;
    let completedHere = 0;
    p.members.forEach((mb: Record<string, unknown>, i: number) => {
      if (!mb || typeof mb !== "object") return;
      if (!wanted.has(`${ptype}:${i}`)) return;
      if (mb["status"] === 3) return;
      const req = requirement(ptype, String(mb["name"] ?? ""));
      mb["status"] = 3;
      const pieces = typeof mb["piecesCount"] === "number" ? mb["piecesCount"] : 0;
      if (pieces < req) {
        mb["piecesCount"] = req;
      }
      changed += 1;
      completedHere += 1;
    });
    // Paddocks we did not complete keep every byte, stale `count` included.
    if (completedHere) {
      const collected = p.members.filter((m) => m && m["status"] === 3).length;
      if (p.count !== collected) p.count = collected;
    }
  }
  if (!changed) return { xml: text, changed: 0 };
  const next = stringifyAttr(doc);
  if (next.includes("'")) {
    throw new Error("Tên con vật chứa dấu nháy — hủy để tránh hỏng file");
  }
  return { xml: text.slice(0, span.start) + next + text.slice(span.end), changed };
}
