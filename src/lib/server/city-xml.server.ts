const STAT_TAGS: Record<string, string[]> = {
  tca: ["tca", "TCash", "Cash", "Diamonds", "Diamond"],
  coi: ["coi", "Coins", "Gold", "Money", "Coin"],
  lvl: ["lvl", "Level", "ExpLevel"],
  dat: ["dat", "StartDate", "RegisterDate"],
  win: ["win", "FirstWins", "Wins"],
  liv: ["liv", "LivesSent"],
  reg: ["reg", "Regatta"],
  hlp: ["hlp", "Help"],
  crd: ["crd", "Cards"],
  exp: ["exp", "Energy"],
  key: ["key", "Keys"],
  m3l: ["m3l", "Match3Level"],
  match3Life: ["match3Life", "Match3Lives"],
  residents: ["residents", "Population"],
};

const BARN_TAGS: Record<string, string[]> = {
  wheat: ["wheat", "Wheat"],
  corn: ["corn", "Corn"],
  carrot: ["carrot", "Carrot"],
  sugarcane: ["sugarcane", "Sugarcane"],
  milk: ["milk", "Milk"],
  egg: ["egg", "Egg"],
  wool: ["wool", "Wool"],
  bread: ["bread", "Bread"],
  cookie: ["cookie", "Cookie"],
  butter: ["butter", "Butter"],
  cheese: ["cheese", "Cheese"],
  cotton: ["cotton", "Cotton"],
  fabric: ["fabric", "Fabric"],
  coat: ["coat", "Coat"],
  paper: ["paper", "Paper"],
  paint: ["paint", "Paint"],
  clover: ["clover", "Clover"],
  honey: ["honey", "Honey"],
};

export type ParsedCity = {
  stats: Record<string, string>;
  barn: { upgrades: number | null; capacity: number | null; items: Record<string, number> };
  friends: { id: string; name: string; level: number; type: "friend" | "request" }[];
  season: { premium: boolean; score: number };
  xml: string;
};

function readTag(xml: string, names: string[]): string | null {
  for (const n of names) {
    const re = new RegExp(`<(${n})>([^<]*)</\\1>`, "i");
    const m = xml.match(re);
    if (m) return m[2]!.trim();
  }
  return null;
}

function upsertTag(xml: string, names: string[], value: string): string {
  for (const n of names) {
    const re = new RegExp(`<(${n})>[^<]*</\\1>`, "i");
    if (re.test(xml)) return xml.replace(re, `<$1>${value}</$1>`);
  }
  const primary = names[0]!;
  const insert = `<${primary}>${value}</${primary}>\n`;
  if (/<\/[^>]+>\s*$/.test(xml)) return xml.replace(/<\/[^>]+>\s*$/, `${insert}$&`);
  return `${xml}\n${insert}`;
}

function decodeMaybe(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) return raw;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.trim().startsWith("<")) return decoded;
  } catch {
    /* keep */
  }
  throw new Error("File city không phải XML — file mã hóa cần tool giải mã riêng, server không giả lập city");
}

export function parseCityXml(raw: string): ParsedCity {
  const xml = decodeMaybe(raw);
  const stats: Record<string, string> = {};
  for (const [id, names] of Object.entries(STAT_TAGS)) {
    const v = readTag(xml, names);
    if (v) stats[id] = v;
  }
  const items: Record<string, number> = {};
  for (const [id, names] of Object.entries(BARN_TAGS)) {
    const v = readTag(xml, names);
    if (v && Number.isFinite(Number(v))) items[id] = Number(v);
  }
  const upgradesRaw = readTag(xml, ["BarnUpgrades", "barnUpgrades", "WarehouseLevel"]);
  const upgrades = upgradesRaw && Number.isFinite(Number(upgradesRaw)) ? Number(upgradesRaw) : null;
  const friends: ParsedCity["friends"] = [];
  const fr = xml.matchAll(/<(?:Friend|friend)[^>]*\bid=["']([^"']+)["'][^>]*(?:\bname=["']([^"']*)["'])?[^>]*(?:\blevel=["'](\d+)["'])?[^>]*\/?>/gi);
  for (const m of fr) {
    friends.push({ id: m[1]!, name: m[2] || m[1]!, level: Number(m[3] || 0), type: "friend" });
  }
  const premium = /<(?:Premium|premium|SeasonPremium)>\s*[1ty]/i.test(xml);
  const score = Number(readTag(xml, ["SeasonScore", "seasonScore"]) || 0);
  if (!Object.keys(stats).length && !friends.length && !xml.includes("<")) {
    throw new Error("XML city trống");
  }
  return {
    stats,
    barn: { upgrades, capacity: null, items },
    friends,
    season: { premium, score },
    xml,
  };
}

export function patchCityXml(
  xml: string,
  patch: {
    stats?: Record<string, string>;
    barnUpgrades?: number;
    barnItems?: Record<string, number>;
    season?: { premium: boolean; score: number };
    regatta?: { tasks: number; score: number };
  },
): string {
  let out = xml;
  if (patch.stats) {
    for (const [id, value] of Object.entries(patch.stats)) {
      const names = STAT_TAGS[id];
      if (!names || value === undefined) continue;
      out = upsertTag(out, names, value);
    }
  }
  if (patch.barnUpgrades) out = upsertTag(out, ["BarnUpgrades", "barnUpgrades"], String(patch.barnUpgrades));
  if (patch.barnItems) {
    for (const [id, qty] of Object.entries(patch.barnItems)) {
      const names = BARN_TAGS[id];
      if (!names) continue;
      out = upsertTag(out, names, String(qty));
    }
  }
  if (patch.season) {
    out = upsertTag(out, ["Premium", "SeasonPremium"], patch.season.premium ? "1" : "0");
    out = upsertTag(out, ["SeasonScore"], String(patch.season.score));
  }
  if (patch.regatta) {
    out = upsertTag(out, ["RegattaTasks"], String(patch.regatta.tasks));
    out = upsertTag(out, ["RegattaScore"], String(patch.regatta.score));
  }
  return out;
}
