import { createHmac } from "node:crypto";
import { AVATAR_CHUNK, AVATAR_MAX, avatarGroupId, type Group, type Item, type StatField } from "@/lib/catalogs";
import { RAW_ITEMS, RAW_PROFILE, RAW_SKINS, type RawGroup } from "./catalogs.data.server";
import { DECOR_STASH } from "./township/decor-stash.server";
import { SKINS_CATALOG } from "./township/skins-catalog.server";
import { CHAT_EMOJI_IDS } from "./township/chat-emoji.server";

type Kind = "profile" | "skin" | "item" | "decor" | "stat" | "barn" | "factory" | "train" | "island";

const PEPPER = Buffer.from("igg-vip-pub-id-v1");
const lookup = new Map<string, string>();

function pubId(kind: Kind, real: string) {
  const id = createHmac("sha256", PEPPER).update(`${kind}\0${real}`).digest("base64url").slice(0, 16);
  lookup.set(`${kind}:${id}`, real);
  return id;
}

function remapOne(kind: Kind, id: string) {
  return lookup.get(`${kind}:${id}`) ?? null;
}

const GROUP_META: Record<string, { label: string; emoji?: string }> = {
  Badges: { label: "Badges", emoji: "🏅" },
  ExpRanks: { label: "Titles / Ranks", emoji: "👑" },
  Frames: { label: "Frames", emoji: "🖼️" },
  Styles: { label: "Styles", emoji: "✨" },
  Themes: { label: "Themes", emoji: "🎨" },
  Fortress: { label: "Fortress", emoji: "🏰" },
  Pig: { label: "Pig", emoji: "🐷" },
  Cow: { label: "Cow", emoji: "🐮" },
  Train: { label: "Train", emoji: "🚂" },
  Ship: { label: "Ship", emoji: "🚢" },
  Airport: { label: "Airport", emoji: "🛫" },
  Harbor: { label: "Harbor", emoji: "⚓" },
  HelicopterPlace: { label: "Helicopter Pad", emoji: "🛟" },
  TrainStation: { label: "Station", emoji: "🚉" },
  Chicken: { label: "Chicken", emoji: "🐔" },
  Airplane: { label: "Airplane", emoji: "✈️" },
  Helicopter: { label: "Helicopter", emoji: "🚁" },
  Sheep: { label: "Sheep", emoji: "🐑" },
  Materials: { label: "Materials", emoji: "🧱" },
  Tools: { label: "Tools", emoji: "🔧" },
  "Match3 Boosts": { label: "Match-3 Boosts", emoji: "🎯" },
  Orders: { label: "Orders", emoji: "📦" },
  Gems: { label: "Gems", emoji: "💎" },
  Boosts: { label: "Boosts", emoji: "⚡" },
  Coupons: { label: "Coupons", emoji: "🎟️" },
};

function cloakGroup(kind: Kind, raw: RawGroup): Group {
  const meta = GROUP_META[raw.id] ?? { label: raw.id };
  return {
    id: raw.id,
    label: meta.label,
    emoji: meta.emoji,
    items: raw.items.map((it) => ({ id: pubId(kind, it.id), label: it.label })),
  };
}

const STAT_INTERNAL: { id: string; emoji: string; labelEn: string; labelVi: string }[] = [
  { id: "tca", emoji: "💎", labelEn: "T-Cash", labelVi: "T-Cash" },
  { id: "coi", emoji: "🪙", labelEn: "Coins", labelVi: "Xu" },
  { id: "lvl", emoji: "⭐", labelEn: "Level", labelVi: "Cấp" },
  { id: "dat", emoji: "📅", labelEn: "Start Date", labelVi: "Ngày bắt đầu" },
  { id: "win", emoji: "🏆", labelEn: "1st Place Wins", labelVi: "Số lần hạng 1" },
  { id: "liv", emoji: "❤️", labelEn: "Lives Sent", labelVi: "Mạng gửi" },
  { id: "reg", emoji: "🏁", labelEn: "Regatta", labelVi: "Regata" },
  { id: "hlp", emoji: "🤝", labelEn: "Help", labelVi: "Giúp đỡ" },
  { id: "exp", emoji: "⚡", labelEn: "Energy", labelVi: "Năng lượng" },
  { id: "key", emoji: "🔑", labelEn: "Keys", labelVi: "Chìa" },
  { id: "m3l", emoji: "🎯", labelEn: "Match-3 Level", labelVi: "Cấp Match-3" },
  { id: "match3Life", emoji: "🎮", labelEn: "Match-3 Lives", labelVi: "Mạng Match-3" },
  { id: "residents", emoji: "🏠", labelEn: "Residents", labelVi: "Dân số" },
  { id: "spentCash", emoji: "💸", labelEn: "Spent T-Cash", labelVi: "Đã tiêu $" },
  { id: "earnedCash", emoji: "💵", labelEn: "Earned T-Cash", labelVi: "Kiếm $" },
  { id: "EarnedCoins", emoji: "💰", labelEn: "Earned Coins", labelVi: "Kiếm xu" },
  { id: "wheatCounter", emoji: "🌾", labelEn: "Wheat", labelVi: "Lúa" },
  { id: "plowFieldsAchiev", emoji: "🚜", labelEn: "Fields Plowed", labelVi: "Ruộng đã cày" },
  { id: "defaultOrdersCount", emoji: "📦", labelEn: "Orders", labelVi: "Đơn hàng" },
  { id: "mineCounter", emoji: "⛏️", labelEn: "Mine", labelVi: "Mỏ" },
  { id: "timeInGame", emoji: "⏱️", labelEn: "Time in Game", labelVi: "Giờ chơi" },
  { id: "WareHouseCashUpgrade", emoji: "🏬", labelEn: "Warehouse Cash Upgrade", labelVi: "Nâng cấp kho $" },
  { id: "WHUdup", emoji: "🏬", labelEn: "Barn Capacity Code", labelVi: "Mã sức chứa kho" },
  { id: "Match3Lives_infTime", emoji: "♾️", labelEn: "Match-3 Infinite Lives", labelVi: "Match-3 mạng vô hạn" },
];

const BARN_INTERNAL: { id: string; label: string }[] = [
  { id: "wheat", label: "Wheat" },
  { id: "corn", label: "Corn" },
  { id: "carrot", label: "Carrot" },
  { id: "sugarcane", label: "Sugarcane" },
  { id: "milk", label: "Milk" },
  { id: "egg", label: "Egg" },
  { id: "wool", label: "Wool" },
  { id: "bread", label: "Bread" },
  { id: "cookie", label: "Cookie" },
  { id: "butter", label: "Butter" },
  { id: "cheese", label: "Cheese" },
  { id: "cotton", label: "Cotton" },
  { id: "fabric", label: "Fabric" },
  { id: "coat", label: "Coat" },
  { id: "paper", label: "Paper" },
  { id: "paint", label: "Paint" },
  { id: "clover", label: "Clover" },
  { id: "honey", label: "Honey" },
];

export const BARN_CAPACITY: { upgrades: number; capacity: number }[] = [
  { upgrades: 100, capacity: 5085 },
  { upgrades: 250, capacity: 16335 },
  { upgrades: 500, capacity: 35085 },
  { upgrades: 1000, capacity: 72585 },
  { upgrades: 2500, capacity: 185085 },
  { upgrades: 5000, capacity: 372585 },
  { upgrades: 8000, capacity: 597585 },
  { upgrades: 10000, capacity: 747585 },
];

function avatarGroups(): Group[] {
  const out: Group[] = [];
  for (let s = 1; s <= AVATAR_MAX; s += AVATAR_CHUNK) {
    const e = Math.min(s + AVATAR_CHUNK - 1, AVATAR_MAX);
    out.push({
      id: avatarGroupId(s),
      label: `Ava ${s}–${e}`,
      items: Array.from({ length: e - s + 1 }, (_, i) => {
        const n = s + i;
        return { id: String(n), label: `ava${n}` };
      }),
    });
  }
  return out;
}

const PROFILE: Group[] = RAW_PROFILE.filter((g) => g.id !== "Themes").map((g) => cloakGroup("profile", g));
const SKIN_LABELS = new Map<string, string>();
for (const g of RAW_SKINS) for (const it of g.items) SKIN_LABELS.set(it.id, it.label);

function skinLabel(id: string) {
  const known = SKIN_LABELS.get(id);
  if (known) return known;
  const raw = id.replace(/^Skin_/, "").replace(/_/g, " ");
  return raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
}

const SKINS: Group[] = Object.entries(SKINS_CATALOG).map(([id, available]) => ({
  id,
  label: GROUP_META[id]?.label ?? id,
  emoji: GROUP_META[id]?.emoji,
  items: available.split("|").filter(Boolean).map((sid) => ({ id: pubId("skin", sid), label: skinLabel(sid) })),
}));
const ITEMS: Group[] = RAW_ITEMS.map((g) => cloakGroup("item", g));
const AVATARS: Group[] = avatarGroups();
const DECOR: Item[] = DECOR_STASH.map((it) => ({ id: pubId("decor", it.id), label: it.label }));
const EMOJI: Item[] = CHAT_EMOJI_IDS.map((id) => ({
  id,
  label: id.startsWith("sp")
    ? `Special Sticker ${id.slice(2)}`
    : id.startsWith("st")
      ? `Sticker ${id.slice(2)}`
      : id.startsWith("v")
        ? `VIP Sticker ${id.slice(1)}`
        : `Sticker ${id}`,
}));
const FIELDS: StatField[] = STAT_INTERNAL.map((f) => ({
  ...f,
  key: f.id,
  id: pubId("stat", f.id),
}));
const BARN_PRODUCTS: Item[] = BARN_INTERNAL.map((p) => ({
  id: p.id,
  label: p.label,
}));

// Pre-warm the public-id lookup at module load time. The app runs in a server
// process where requests must not depend on a previous catalog request having
// populated the in-memory map.
for (const g of RAW_PROFILE) for (const it of g.items) pubId("profile", it.id);
for (const g of RAW_SKINS) for (const it of g.items) pubId("skin", it.id);
for (const g of RAW_ITEMS) for (const it of g.items) pubId("item", it.id);
for (const it of DECOR_STASH) pubId("decor", it.id);
for (const f of STAT_INTERNAL) pubId("stat", f.id);
for (const p of BARN_INTERNAL) pubId("barn", p.id);

export function publicCatalogs() {
  return {
    profile: PROFILE,
    avatars: AVATARS,
    skins: SKINS,
    items: ITEMS,
    decor: DECOR,
    emoji: EMOJI,
    fields: FIELDS,
    barnCapacity: BARN_CAPACITY,
    barnProducts: BARN_PRODUCTS,
    avatarMax: AVATAR_MAX,
  };
}

function remapRecord<T>(kind: Kind, rec: Record<string, T> | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (!rec) return out;
  for (const [k, v] of Object.entries(rec)) {
    const real = remapOne(kind, k);
    if (real) out[real] = v;
  }
  return out;
}

// Upgrade rows (Factory / Train / Island) are cloaked like every other real
// game id: the client only ever sees HMAC public ids, and `revealSave` maps the
// selection back. The label is derived from the id because the save carries no
// display name for these rows.
//
// The three kinds share one shape, so they share one code path. `factory` is
// kept as the public id namespace for Factory rows so existing saves and any
// cached client state keep resolving.
export type UpgradeKindPublic = "factory" | "train" | "island";

export function cloakUpgrades(kind: UpgradeKindPublic, rows: { id: string; level: number }[]) {
  return rows.map((r) => ({
    id: pubId(kind, r.id),
    label: upgradeLabel(kind, r.id),
    level: r.level,
  }));
}

export function cloakFactories(rows: { id: string; level: number }[]) {
  return cloakUpgrades("factory", rows);
}

function revealUpgradeIds(kind: UpgradeKindPublic, ids: string[] | undefined) {
  return (ids ?? []).map((id) => remapOne(kind, id)).filter((x): x is string => Boolean(x));
}

export function revealFactoryIds(ids: string[] | undefined) {
  return revealUpgradeIds("factory", ids);
}

export function revealTrainIds(ids: string[] | undefined) {
  return revealUpgradeIds("train", ids);
}

export function revealIslandIds(ids: string[] | undefined) {
  return revealUpgradeIds("island", ids);
}

/**
 * `bagfactory` -> `Bagfactory`, `factory_music_instruments` -> `Music Instruments`.
 *
 * Train and Island rows carry a bare index (`1`, `i2`), which is not a name —
 * labelling them "1" and "I2" would read as a bug. They get "Train 1" and
 * "Island 2" instead. The prefix is per-kind because the ids overlap: Train
 * "1" and Island "i1" both strip to "1".
 */
export function upgradeLabel(kind: UpgradeKindPublic, id: string) {
  if (kind === "train") return `Train ${id}`;
  if (kind === "island") return `Island ${id.replace(/^i/i, "")}`;
  const bare = id.replace(/^factory_/i, "").replace(/factory$/i, "");
  const words = bare.replace(/[_-]+/g, " ").trim();
  if (!words) return id;
  return words
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function factoryLabel(id: string) {
  return upgradeLabel("factory", id);
}

function remapGroups(kind: Kind, rec: Record<string, string[]> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!rec) return out;
  for (const [g, ids] of Object.entries(rec)) {
    const mapped = ids.map((id) => remapOne(kind, id)).filter((x): x is string => Boolean(x));
    if (mapped.length) out[g] = mapped;
  }
  return out;
}

export function revealSave(p: {
  stats?: Record<string, string>;
  profile?: Record<string, string[]>;
  avatars?: string[];
  skins?: Record<string, string[]>;
  items?: Record<string, number>;
  decor?: string[];
  barnItems?: Record<string, number>;
  factories?: string[];
  trains?: string[];
  islands?: string[];
}) {
  return {
    stats: remapRecord("stat", p.stats),
    profile: remapGroups("profile", p.profile),
    avatars: (p.avatars ?? []).filter((id) => /^\d+$/.test(id)),
    skins: remapGroups("skin", p.skins),
    items: remapRecord("item", p.items),
    decor: (p.decor ?? []).map((id) => remapOne("decor", id)).filter((x): x is string => Boolean(x)),
    barnItems: p.barnItems ?? {},
    factories: revealFactoryIds(p.factories),
    trains: revealTrainIds(p.trains),
    islands: revealIslandIds(p.islands),
  };
}

export function cloakProfileUnlocked(unlocked: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [group, ids] of Object.entries(unlocked)) {
    const mapped = ids.map((id) => pubId("profile", id));
    if (mapped.length) out[group] = mapped;
  }
  return out;
}

export function cloakStats(stats: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of STAT_INTERNAL) {
    const pub = pubId("stat", f.id);
    if (stats[f.id] !== undefined) out[pub] = stats[f.id];
  }
  return out;
}

export function cloakBarnItems(items: Record<string, number>): Record<string, number> {
  // Barn product ids are intentionally kept as plaintext IDs. This matches the
  // v1.15 app, where the warehouse list is meant to show the actual product key
  // and not an opaque public id.
  return { ...items };
}

export function demoBarnItems(): Record<string, number> {
  const items: Record<string, number> = {};
  const seed = [48, 36, 22, 18, 40, 28, 16, 12, 9, 7, 6, 14, 8, 3, 11, 5, 20, 4];
  BARN_INTERNAL.forEach((p, i) => {
    items[p.id] = seed[i] ?? 10;
  });
  return items;
}
