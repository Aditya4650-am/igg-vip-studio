import { readVar, writeVar } from "./vars.server";
import { BARN_PRODUCT_IDS } from "../catalogs.server";

export const BARN_CAPACITY_MAP: Record<number, number> = {
  100: 5085,
  250: 16335,
  500: 35085,
  1000: 72585,
  2500: 185085,
  5000: 372585,
  8000: 597585,
  10000: 747585,
};

const WHUDUP_XOR = 0x1eadabcc;

const PREFIX = [
  "action", "unlocked", "match3", "m3", "cmm", "season", "tutorial",
  "friend", "clan", "quest", "ticket", "boost", "skin", "avatar",
  "profile", "building", "decor", "emoji", "sticker", "regatta",
  "order", "offer", "gift", "badge", "frame", "style", "exp", "rank",
  "help", "invite", "request", "chat", "mail", "daily", "event",
  "pass", "sale", "saleoff", "facebook", "session", "sessions",
  "ignore", "show", "hint", "popup", "notif", "promo", "ads",
  "rate", "review", "login", "subs", "fan", "contest", "race",
];
const EXACT = new Set(["taken", "time", "level", "stars", "coin", "coins", "cash", "gold", "xp", "exp", "energy", "heart", "hearts"]);
const SUBSTR = ["_show", "show_", "ignore", "facebook", "contest", "session", "action_", "cmm_", "match3", "saleoff", "event", "tutorial"];

function isProductCounter(name: string) {
  if (!name) return false;
  const base = name.toLowerCase().endsWith("counter") ? name.slice(0, -7) : name;
  const low = base.toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(base)) return false;
  // Opaque mixed-case / randomized identifiers are not warehouse product keys.
  if (/[A-Z]/.test(base) || /\d{4,}/.test(base)) return false;
  if (EXACT.has(low)) return false;
  if (PREFIX.some((p) => low.startsWith(p))) return false;
  if (SUBSTR.some((s) => low.includes(s))) return false;
  return true;
}

export function barnUpgradesFromWhudup(raw: string | null) {
  if (!raw?.trim()) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return null;
  return n ^ WHUDUP_XOR;
}

export function listBarnItems(xml: string): Record<string, number> {
  const items: Record<string, number> = {};
  // Genuine stock the heuristic rejects (camelCase ingots like BronzeBullion)
  // is still recognized when the id sits in the shipped product catalog.
  // Anything else unknown stays excluded, so counters the game never reads
  // as stock (orders, quests, shows) cannot leak into the barn.
  const known = (name: string) => {
    if (isProductCounter(name)) return true;
    const pid = name.endsWith("Counter") ? name.slice(0, -7) : name;
    return BARN_PRODUCT_IDS.has(pid);
  };
  const reA = /<Var\b[^>]*\bname="([A-Za-z0-9_]+Counter)"[^>]*\bv="(-?\d+)"/gi;
  const reB = /<Var\b[^>]*\bv="(-?\d+)"[^>]*\bname="([A-Za-z0-9_]+Counter)"/gi;
  for (const m of xml.matchAll(reA)) {
    if (!known(m[1]!)) continue;
    const pid = m[1]!.slice(0, -7);
    items[pid] = Number(m[2]);
  }
  for (const m of xml.matchAll(reB)) {
    if (!known(m[2]!)) continue;
    const pid = m[2]!.slice(0, -7);
    if (items[pid] === undefined) items[pid] = Number(m[1]);
  }
  return items;
}

export function barnInfo(xml: string) {
  const capRaw = readVar(xml, "WareHouseCashUpgrade");
  const whu = readVar(xml, "WHUdup");
  const upgrades = barnUpgradesFromWhudup(whu);
  const capacity = capRaw && Number.isFinite(Number(capRaw)) ? Number(capRaw) : null;
  return { upgrades, capacity, items: listBarnItems(xml) };
}

export function applyBarnCapacity(xml: string, upgrades: number) {
  if (!(upgrades in BARN_CAPACITY_MAP)) throw new Error("Invalid barn upgrades");
  const capacity = BARN_CAPACITY_MAP[upgrades]!;
  const whudup = upgrades ^ WHUDUP_XOR;
  let text = writeVar(xml, "WareHouseCashUpgrade", String(capacity));
  text = writeVar(text, "WHUdup", String(whudup));
  return text;
}

export function applyBarnItems(xml: string, updates: Record<string, number>) {
  let text = xml;
  for (const [pid, qty] of Object.entries(updates)) {
    if (!Number.isFinite(qty) || qty < 0) continue;
    let name = pid.endsWith("Counter") ? pid : `${pid}Counter`;
    if (name.endsWith("CounterCounter")) name = name.slice(0, -7);
    text = writeVar(text, name, String(Math.floor(qty)));
  }
  return text;
}
