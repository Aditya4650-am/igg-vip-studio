import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type SVGProps } from "react";
import {
  ChevronDown,
  LoaderCircle,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { OwnerHub } from "@/components/owner-hub";
import { cn } from "@/lib/utils";
import { LANGS, isLang, t, type Lang, type Dict } from "@/lib/i18n";
import { isDeviceId, mintDeviceId, normalizeDeviceId } from "@/lib/device-id";
import { AVATAR_MAX, avatarEmoji, avatarGroupId, avatarIconPath, avatarsInRange, type Group, type Item } from "@/lib/catalogs";
import { MUSEUM_IDS, artifactEmoji, artifactIconPath, museumLabel } from "@/lib/museum";
import { iconForBarn, iconForDecorLabel, iconForGem, iconForGroup, iconForItemLabel, iconForProfileLabel, iconForSkin, iconForStat, iconForSticker, iconForUpgradeLabel, iconForZoo } from "@/lib/game-icon-map";
import { REGATTA_MAX_TASKS, REGATTA_DEFAULT_TASKS, regattaReason, type RegattaReason } from "@/lib/regatta";
import { BLOOM_TOKENS_DEFAULT, BLOOM_TOKENS_MAX } from "@/lib/events";
import {
  connectLoad,
  fetchCity,
  getCatalogs,
  getRelease,
  refreshFriends,
  refreshOwn,
  refreshBarn,
  saveAll,
  exportCurrent,
  applyUnban,
  sendFeedback,
  verifyLicense,
  attachFriendCity,
  attachLocal,
  backupFreshStart,
  verifyFreshStart,
  restoreFreshStart,
} from "@/lib/studio-api";

type Tab = "data" | "profile" | "avatars" | "skins" | "unban" | "decor" | "sticker" | "items" | "regatta" | "barn" | "museum" | "zoo" | "upgrades" | "newgame" | "events";
type SessionSnap = Awaited<ReturnType<typeof connectLoad>>;
type Catalogs = Awaited<ReturnType<typeof getCatalogs>>;
type UnbanMode = "inicial" | "completo" | "novo";
type LicenseSnap = Awaited<ReturnType<typeof verifyLicense>>["license"];
type Sheet = "none" | "feedback";

type NativeBridge = {
  devices: () => Promise<{ id: string; label: string }[]>;
  forceStop: (serial: string) => Promise<{ ok: boolean; package: string }>;
  pull: (serial: string) => Promise<{ b64: string; file: string }>;
  pullLocalInfo: (serial: string) => Promise<{ b64: string; file: string; package: string }>;
  push: (serial: string, b64: string, options?: { alreadyStopped?: boolean; restart?: boolean }) => Promise<{ ok: boolean }>;
  version: () => Promise<string>;
  installUpdate: (release: { version: string; notes?: string; downloadUrl: string; sha256: string }) => Promise<{ ok: boolean; version?: string; reason?: string }>;
  deviceId?: () => Promise<string>;
  loadSavedKey: () => Promise<string>;
  saveKey: (key: string) => Promise<{ ok: boolean }>;
  clearSavedKey: () => Promise<{ ok: boolean }>;
  wipeFiles?: (serial: string, paths: string[]) => Promise<{ ok: boolean; wiped?: string[]; error?: string }>;
  pmClear?: (serial: string) => Promise<{ ok: boolean; package?: string; serial?: string; sdcard?: string }>;
  reinstallTownship?: (serial: string) => Promise<{ ok: boolean; package?: string; apkCount?: number }>;
  injectFreshProfile?: (serial: string) => Promise<{ ok: boolean; package?: string; dir?: string; verified?: Record<string, number> }>;
  launchGame?: (serial: string) => Promise<{ ok: boolean; package?: string; output?: string }>;
  listStateFiles?: (serial: string) => Promise<{ ok: boolean; package: string; files: string[] }>;
  readFile?: (serial: string, path: string) => Promise<{ b64: string; file: string; size?: number }>;
  writeFile?: (serial: string, path: string, b64: string) => Promise<{ ok: boolean; file?: string }>;
  readAndroidId?: (serial: string) => Promise<{ ok: boolean; androidId: string }>;
  resetAndroidId?: (serial: string) => Promise<{ ok: boolean; androidId: string; oldAndroidId?: string }>;
  readGsfId?: (serial: string) => Promise<{ ok: boolean; gsfId?: string; reason?: string }>;
  resetGsfId?: (serial: string) => Promise<{ ok: boolean; deleted?: string[]; error?: string }>;
  forceAndroidId?: (serial: string) => Promise<{ ok: boolean; androidId: string; oldAndroidId?: string; needsReboot?: boolean }>;
  clearGms?: (serial: string) => Promise<{ ok: boolean; cleared?: string[]; skipped?: string[]; error?: string }>;
  verifyWipe?: (serial: string) => Promise<{ ok: boolean; remaining?: string[]; checked?: number }>;
  deviceFingerprint?: (serial: string) => Promise<{ ok: boolean; props?: Record<string, string> }>;
  nukeSecureSettings?: (serial: string) => Promise<{ ok: boolean; moved?: string[]; error?: string }>;
  rebootDevice?: (serial: string) => Promise<{ ok: boolean; rebooting?: boolean }>;
  waitForDevice?: (serial: string, timeout?: number) => Promise<{ ok: boolean }>;
  exportFile?: (name: string, b64: string) => Promise<{ ok: boolean; path: string; size?: number }>;
};

function nativeBridge(): NativeBridge | undefined {
  return (window as unknown as { iggNative?: NativeBridge }).iggNative;
}

function downloadB64(name: string, b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  // WebView2 ignores clicks on detached anchors, so attach first.
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "application/xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  // WebView2 ignores clicks on detached anchors, so attach first.
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// "regatta" sits at index 8, the first overflow slot, so the eight primary
// tabs keep their exact positions and only the second row gains a member.
// "events" is appended last for the same reason: it adds a slot to the second
// row without moving any tab that already exists.
const TABS: Tab[] = ["data", "profile", "avatars", "skins", "unban", "decor", "sticker", "items", "regatta", "barn", "museum", "zoo", "upgrades", "newgame", "events"];
// Premium tab bar: 8 primary slots + a "More" overflow for the rest, so
// labels never compress or wrap. Derived from TABS — one source of truth.
const PRIMARY_TABS: Tab[] = TABS.slice(0, 8);
const OVERFLOW_TABS: Tab[] = TABS.slice(8);
const TAB_KEY: Record<Tab, keyof Dict> = {
  data: "tabData",
  profile: "tabProfile",
  avatars: "tabAvatars",
  skins: "tabSkins",
  unban: "tabUnban",
  decor: "tabDecor",
  sticker: "tabSticker",
  items: "tabItems",
  regatta: "regatta",
  barn: "tabBarn",
  museum: "tabMuseum",
  zoo: "tabZoo",
  upgrades: "tabUpgrades",
  newgame: "tabNewGame",
  events: "tabEvents",
};
const TAB_EMOJI: Record<Tab, string> = {
  data: "📊",
  profile: "👤",
  avatars: "🎭",
  skins: "🎨",
  unban: "🔓",
  decor: "🖼️",
  sticker: "💬",
  items: "📦",
  regatta: "⛵",
  barn: "🌾",
  museum: "🏛️",
  zoo: "🐾",
  upgrades: "⚙️",
  newgame: "🎮",
  events: "🐝",
};

/** Why the Regatta tab will (or will not) accept a task batch. Mirrors
 *  `RegattaReason` in inject.server.ts so the reason the server would give is
 *  the one the user reads before pressing anything. */
const REGATTA_REASON_KEY = {
  ok: "regattaReady",
  no_active_regatta: "regattaNoRegatta",
  no_template: "regattaNoTemplate",
} as const;

/** Why the Events tab will (or will not) accept a token batch. Mirrors
 *  `BloomReason` in events.server.ts, so the badge answers for the save the
 *  user is looking at before anything is queued. It reports, it never gates —
 *  the button below stays pressable whatever the save says. */
const BLOOM_REASON_KEY = {
  ok: "bloomReady",
  no_wallet: "bloomNoWallet",
  incomplete: "bloomIncomplete",
  invalid: "bloomInvalid",
} as const;

function groupIcon(id: string): GameIconName {
  const value = id.toLowerCase();
  if (value.startsWith("ava_")) return "avatar";
  if (value.startsWith("paddock_")) return "zoo";
  if (value.includes("frame") || value.includes("badge") || value.includes("theme")) return "sticker";
  if (value.includes("style") || value.includes("skin")) return "skin";
  if (value.includes("rank")) return "season";
  if (value.includes("material") || value.includes("tool") || value.includes("order") || value.includes("gem") || value.includes("coupon")) return "items";
  if (value.includes("boost") || value.includes("match")) return "season";
  return "data";
}

function statEmoji(id: string): string {
  const value = id.toLowerCase();
  if (value.includes("cash") || value === "tca") return "💎";
  if (value.includes("coin")) return "🪙";
  if (value.includes("level") || value === "lvl") return "⭐";
  if (value.includes("date") || value === "dat") return "🗓️";
  if (value.includes("win")) return "🏆";
  if (value.includes("life") || value === "liv") return "💗";
  if (value.includes("regatta") || value === "reg") return "⛵";
  if (value.includes("help")) return "🤝";
  if (value.includes("energy")) return "⚡";
  if (value.includes("match") || value === "m3l") return "🎯";
  if (value.includes("resident")) return "🏡";
  if (value.includes("wheat") || value.includes("mine") || value.includes("warehouse")) return "🌾";
  return "◆";
}

function groupEmoji(id: string): string {
  const value = id.toLowerCase();
  if (value.startsWith("ava_")) return "🧑";
  if (value.startsWith("paddock_")) return "🐾";
  if (value.includes("badge") || value.includes("rank") || value === "expranks") return "🏅";
  if (value.includes("frame")) return "🖼️";
  if (value.includes("style") || value.includes("theme")) return "🎨";
  if (value.includes("material")) return "🧱";
  if (value.includes("tool")) return "🛠️";
  if (value.includes("match")) return "🧩";
  if (value.includes("order")) return "📋";
  if (value.includes("gem")) return "💎";
  if (value.includes("boost")) return "⚡";
  if (value.includes("coupon")) return "🎟️";
  if (value.includes("train")) return "🚂";
  if (value.includes("airplane") || value === "airport") return "✈️";
  if (value.includes("helicopterplace") || value.includes("helipad")) return "🛟";
  if (value.includes("helicopter")) return "🚁";
  if (value.includes("ship")) return "🚢";
  if (value.includes("harbor") || value.includes("harbour")) return "⚓";
  if (value.includes("fortress")) return "🏰";
  if (value.includes("chicken")) return "🐔";
  if (value.includes("cow")) return "🐮";
  if (value.includes("sheep")) return "🐑";
  if (value.includes("pig")) return "🐷";
  return "✦";
}

/** Professional fallback emoji when no original game PNG is mapped */
function itemEmoji(groupId: string | undefined, label: string, kind?: string): string {
  const g = (groupId || "").toLowerCase();
  const l = label.toLowerCase();
  if (kind === "sticker" || g.includes("sticker") || l.startsWith("sticker") || l.startsWith("special sticker") || l.startsWith("vip sticker")) {
    // Varied Township-style animal / fun emojis for stickers without a PNG
    const stickerEmojis = [
      "🐑", "🐷", "🐮", "🐔", "🐝", "🦦", "🦆", "🐦",
      "🦊", "🐰", "🐸", "🐧", "🦄", "🐲", "⭐", "💖",
      "🌟", "✨", "🎀", "🎈", "🎪", "🎭", "🎨", "🎵",
      "🌈", "🍭", "🧁", "🌸", "🍀", "🦋", "🐾", "💫",
    ];
    let h = 0;
    for (let i = 0; i < l.length; i++) h = (h * 31 + l.charCodeAt(i)) >>> 0;
    return stickerEmojis[h % stickerEmojis.length];
  }
  if (kind === "decor" || g === "decor") {
    if (l.includes("christmas") || l.includes("santa") || l.includes("snow") || l.includes("xmas")) return "🎄";
    if (l.includes("halloween") || l.includes("witch") || l.includes("pumpkin") || l.includes("ghost")) return "🎃";
    if (l.includes("easter") || l.includes("egg") || l.includes("bunny")) return "🐣";
    if (l.includes("valentine") || l.includes("love") || l.includes("heart")) return "💕";
    if (l.includes("fountain") || l.includes("water") || l.includes("lake") || l.includes("sea")) return "⛲";
    if (l.includes("fence") || l.includes("gate") || l.includes("hedge")) return "🪵";
    if (l.includes("statue") || l.includes("tower") || l.includes("castle") || l.includes("palace")) return "🗿";
    if (l.includes("tree") || l.includes("garden") || l.includes("flower") || l.includes("rose")) return "🌳";
    if (l.includes("cafe") || l.includes("food") || l.includes("candy") || l.includes("cake")) return "🍰";
    if (l.includes("zoo") || l.includes("animal") || l.includes("panda") || l.includes("tiger")) return "🦁";
    if (l.includes("beach") || l.includes("surf") || l.includes("yacht")) return "🏖️";
    if (l.includes("pirate") || l.includes("ship")) return "🏴‍☠️";
    if (l.includes("space") || l.includes("ufo") || l.includes("rocket")) return "🚀";
    if (l.includes("road") || l.includes("asphalt") || l.includes("path")) return "🛤️";
    return "🏡";
  }
  if (g.includes("train")) return "🚂";
  if (g.includes("airplane") || g === "airport") return "✈️";
  if (g.includes("helicopterplace")) return "🛟";
  if (g.includes("helicopter")) return "🚁";
  if (g.includes("ship")) return "🚢";
  if (g.includes("harbor")) return "⚓";
  if (g.includes("fortress")) return "🏰";
  if (g.includes("chicken")) return "🐔";
  if (g.includes("cow")) return "🐮";
  if (g.includes("sheep")) return "🐑";
  if (g.includes("pig")) return "🐷";
  if (g.includes("material")) {
    if (l.includes("brick")) return "🧱";
    if (l.includes("glass")) return "🪟";
    if (l.includes("slab")) return "⬜";
    return "🧱";
  }
  if (g.includes("tool")) {
    if (l.includes("axe")) return "🪓";
    if (l.includes("pick")) return "⛏️";
    if (l.includes("tnt") || l.includes("dynamite")) return "🧨";
    if (l.includes("drill")) return "🔩";
    if (l.includes("saw")) return "🪚";
    if (l.includes("jack")) return "🔨";
    return "🛠️";
  }
  if (g.includes("match")) return "🧩";
  if (g.includes("boost")) return "⚡";
  if (g.includes("coupon")) return "🎟️";
  if (g.includes("gem")) return "💎";
  if (g.startsWith("paddock_")) return "🐾";
  if (g.includes("order")) return "📦";
  if (g.includes("badge")) return "🏅";
  if (g.includes("rank") || g === "expranks") return "👑";
  if (g.includes("frame")) return "🖼️";
  if (g.includes("style") || g.includes("theme")) {
    // Named-style fallbacks — unique per button, no repeats
    if (l.includes("festival")) return "🎪";
    if (l.includes("easter")) return "🐣";
    if (l.includes("cooking")) return "🍳";
    if (l.includes("neon")) return "💡";
    if (l.includes("underwater")) return "🌊";
    if (l.includes("style 6") || l.includes("gold")) return "👑";
    if (l.includes("bubble")) return "🫧";
    return "🎨";
  }
  if (g.includes("gem")) {
    if (l.includes("gem 1")) return "💎";
    if (l.includes("gem 2")) return "💍";
    if (l.includes("gem 3")) return "🔮";
    return "💎";
  }
  if (kind === "barn") {
    if (l.includes("wheat")) return "🌾";
    if (l.includes("corn")) return "🌽";
    if (l.includes("carrot")) return "🥕";
    if (l.includes("milk")) return "🥛";
    if (l.includes("egg")) return "🥚";
    if (l.includes("wool")) return "🧶";
    if (l.includes("bread")) return "🍞";
    if (l.includes("honey")) return "🍯";
    if (l.includes("cotton")) return "☁️";
    return "🧺";
  }
  // theme keywords on any label
  if (l.includes("halloween")) return "🎃";
  if (l.includes("christmas") || l.includes("santa")) return "🎄";
  if (l.includes("easter")) return "🐣";
  if (l.includes("valentine") || l.includes("love")) return "💕";
  if (l.includes("pirate")) return "🏴‍☠️";
  if (l.includes("space") || l.includes("mars") || l.includes("ufo")) return "🚀";
  if (l.includes("egypt")) return "🔺";
  if (l.includes("japan")) return "🎌";
  if (l.includes("knight") || l.includes("castle")) return "🛡️";
  if (l.includes("gatsby") || l.includes("disco")) return "✨";
  if (l.includes("winter") || l.includes("snow")) return "❄️";
  if (l.includes("beach") || l.includes("surf") || l.includes("vacation")) return "🏖️";
  return "✦";
}

type Tone = "teal" | "pink" | "amber" | "cyan" | "ok" | "purple";
const TONE_TEXT: Record<Tone, string> = {
  teal: "text-primary",
  pink: "text-pink",
  amber: "text-amber",
  cyan: "text-cyan",
  ok: "text-ok",
  purple: "text-purple",
};
const GROUP_TONE: Record<string, Tone> = {
  Badges: "teal",
  ExpRanks: "pink",
  Frames: "amber",
  Styles: "cyan",
  Themes: "purple",
  Materials: "teal",
  Tools: "pink",
  Match3: "amber",
  "Match3 Boosts": "amber",
  Orders: "cyan",
  Gems: "pink",
  Boosts: "cyan",
  Coupons: "purple",
};
const SKIN_CYCLE: Tone[] = ["pink", "purple", "cyan", "teal", "amber", "ok"];
const DECOR_THEMES = [
  "All", "Halloween", "Christmas", "Easter", "Valentine", "Birthday", "Wedding", "CNY/Lunar",
  "Festival", "Summer", "Winter", "Spring/Flowers", "Autumn", "Signs/Banners", "Nature/Garden",
  "Water/Sea", "Beach/Resort", "City/Buildings", "Travel/World", "Adventure/Expedition",
  "Castle/Medieval", "Space/Future", "Music/Stage", "Sports", "Food/Cafe", "Animals",
  "Lights/Lanterns", "Pirate", "Western", "Gatsby", "Fashion", "Japan/Asia", "Europe/Paris",
  "Egypt", "Italy/Greece", "Underwater", "Christmas/Winter", "Other",
] as const;
type DecorTheme = typeof DECOR_THEMES[number];

const CATALOG_LABELS: Record<string, Partial<Record<Lang, string>>> = {
  Badges: { vi: "Huy hiệu", en: "Badges", pt: "Emblemas", id: "Lencana", zh: "徽章", es: "Insignias", th: "ตราสัญลักษณ์", ja: "バッジ", ko: "배지", fr: "Badges", de: "Abzeichen", it: "Badge", ru: "Значки", tr: "Rozetler", ar: "شارات", hi: "बैज", ms: "Lencana", nl: "Badges", pl: "Odznaki", uk: "Значки" },
  ExpRanks: { vi: "Danh hiệu", en: "Titles", pt: "Títulos", id: "Gelar", zh: "称号", es: "Títulos", th: "ตำแหน่ง", ja: "タイトル", ko: "칭호", fr: "Titres", de: "Titel", it: "Titoli", ru: "Титулы", tr: "Unvanlar", ar: "ألقاب", hi: "उपाधियाँ", ms: "Gelaran", nl: "Titels", pl: "Tytuły", uk: "Звання" },
  Frames: { vi: "Khung", en: "Frames", pt: "Molduras", id: "Bingkai", zh: "头像框", es: "Marcos", th: "กรอบ", ja: "フレーム", ko: "프레임", fr: "Cadres", de: "Rahmen", it: "Cornici", ru: "Рамки", tr: "Çerçeveler", ar: "إطارات", hi: "फ्रेम", ms: "Bingkai", nl: "Kaders", pl: "Ramki", uk: "Рамки" },
  Styles: { vi: "Phong cách", en: "Styles", pt: "Estilos", id: "Gaya", zh: "风格", es: "Estilos", th: "สไตล์", ja: "スタイル", ko: "스타일", fr: "Styles", de: "Stile", it: "Stili", ru: "Стили", tr: "Stiller", ar: "أنماط", hi: "शैलियाँ", ms: "Gaya", nl: "Stijlen", pl: "Style", uk: "Стилі" },
  Materials: { vi: "Nguyên liệu", en: "Materials", pt: "Materiais", id: "Bahan", zh: "材料", es: "Materiales", th: "วัตถุดิบ", ja: "素材", ko: "재료", fr: "Matériaux", de: "Materialien", it: "Materiali", ru: "Материалы", tr: "Malzemeler", ar: "مواد", hi: "सामग्री", ms: "Bahan", nl: "Materialen", pl: "Materiały", uk: "Матеріали" },
  Tools: { vi: "Công cụ", en: "Tools", pt: "Ferramentas", id: "Alat", zh: "工具", es: "Herramientas", th: "เครื่องมือ", ja: "ツール", ko: "도구", fr: "Outils", de: "Werkzeuge", it: "Strumenti", ru: "Инструменты", tr: "Araçlar", ar: "أدوات", hi: "उपकरण", ms: "Alat", nl: "Gereedschap", pl: "Narzędzia", uk: "Інструменти" },
  Match3: { vi: "Ghép 3", en: "Match-3", pt: "Match-3", id: "Match-3", zh: "三消", es: "Match-3", th: "จับคู่ 3", ja: "マッチ3", ko: "매치3", fr: "Match-3", de: "Match-3", it: "Match-3", ru: "Три-в-ряд", tr: "Üçlü eşleştirme", ar: "مطابقة 3", hi: "मैच-3", ms: "Match-3", nl: "Match-3", pl: "Match-3", uk: "Матч-3" },
  "Match3 Boosts": { vi: "Tăng cường M3", en: "Match-3 Boosts", pt: "Boosts Match-3", id: "Boost Match-3", zh: "三消增益", es: "Potenciadores Match-3", th: "บูสต์จับคู่ 3", ja: "マッチ3ブースト", ko: "매치3 부스터", fr: "Boosts Match-3", de: "Match-3-Booster", it: "Boost Match-3", ru: "Бустеры Матч-3", tr: "Üçlü eşleştirme güçlendirmeleri", ar: "تعزيزات مطابقة 3", hi: "मैच-3 बूस्ट", ms: "Boost Match-3", nl: "Match-3-boosts", pl: "Boosty Match-3", uk: "Бустери Матч-3" },
  Orders: { vi: "Đơn hàng", en: "Orders", pt: "Pedidos", id: "Pesanan", zh: "订单", es: "Pedidos", th: "ออเดอร์", ja: "注文", ko: "주문", fr: "Commandes", de: "Bestellungen", it: "Ordini", ru: "Заказы", tr: "Siparişler", ar: "الطلبات", hi: "ऑर्डर", ms: "Pesanan", nl: "Bestellingen", pl: "Zamówienia", uk: "Замовлення" },
  Gems: { vi: "Ngọc", en: "Gems", pt: "Gemas", id: "Permata", zh: "宝石", es: "Gemas", th: "อัญมณี", ja: "ジェム", ko: "보석", fr: "Gemmes", de: "Edelsteine", it: "Gemme", ru: "Самоцветы", tr: "Mücevherler", ar: "جواهر", hi: "रत्न", ms: "Permata", nl: "Edelstenen", pl: "Klejnoty", uk: "Самоцвіти" },
  Boosts: { vi: "Tăng cường", en: "Boosts", pt: "Boosts", id: "Boost", zh: "增益", es: "Potenciadores", th: "บูสต์", ja: "ブースト", ko: "부스터", fr: "Boosts", de: "Boosts", it: "Boost", ru: "Усилители", tr: "Güçlendiriciler", ar: "تعزيزات", hi: "बूस्ट", ms: "Boost", nl: "Boosts", pl: "Boosty", uk: "Бустери" },
  Coupons: { vi: "Phiếu", en: "Coupons", pt: "Cupons", id: "Kupon", zh: "优惠券", es: "Cupones", th: "คูปอง", ja: "クーポン", ko: "쿠폰", fr: "Coupons", de: "Gutscheine", it: "Coupon", ru: "Купоны", tr: "Kuponlar", ar: "قسائم", hi: "कूपन", ms: "Kupon", nl: "Coupons", pl: "Kupony", uk: "Купони" },
};

const STAT_LABELS: Record<string, Partial<Record<Lang, string>>> = {
  tca: { vi: "T-Cash", en: "T-Cash", pt: "T-Cash", id: "T-Cash" },
  coi: { vi: "Xu", en: "Coins", pt: "Moedas", id: "Koin" },
  lvl: { vi: "Cấp", en: "Level", pt: "Nível", id: "Level" },
  dat: { vi: "Ngày bắt đầu", en: "Start date", pt: "Data inicial", id: "Tanggal mulai" },
  win: { vi: "Thắng M3 lượt đầu", en: "First-attempt wins", pt: "Vitórias na 1ª tentativa", id: "Menang percobaan pertama" },
  liv: { vi: "Mạng đã gửi", en: "Lives sent", pt: "Vidas enviadas", id: "Nyawa terkirim" },
  reg: { vi: "Regata", en: "Regatta", pt: "Regata", id: "Regata" },
  hlp: { vi: "Giúp đỡ", en: "Help", pt: "Ajuda", id: "Bantuan" },
  exp: { vi: "Năng lượng", en: "Energy", pt: "Energia", id: "Energi" },
  key: { vi: "Chìa khóa", en: "Keys", pt: "Keys", id: "Kunci" },
  m3l: { vi: "Cấp M3", en: "M3 level", pt: "Nível M3", id: "Level M3" },
  match3Life: { vi: "Mạng M3", en: "M3 lives", pt: "Vidas M3", id: "Nyawa M3" },
  residents: { vi: "Dân số", en: "Residents", pt: "Moradores", id: "Penduduk" },
  spentCash: { vi: "T-Cash đã tiêu", en: "Spent T-Cash", pt: "T-Cash gasto", id: "T-Cash terpakai" },
  earnedCash: { vi: "T-Cash kiếm được", en: "Earned T-Cash", pt: "T-Cash ganho", id: "T-Cash diperoleh" },
  EarnedCoins: { vi: "Xu kiếm được", en: "Earned coins", pt: "Moedas ganhas", id: "Koin diperoleh" },
  wheatCounter: { vi: "Lúa", en: "Wheat", pt: "Trigo", id: "Gandum" },
  plowFieldsAchiev: { vi: "Cày ruộng", en: "Plowed fields", pt: "Campos arados", id: "Lahan dibajak" },
  defaultOrdersCount: { vi: "Đơn hàng", en: "Orders", pt: "Pedidos", id: "Pesanan" },
  mineCounter: { vi: "Mỏ", en: "Mine", pt: "Mina", id: "Tambang" },
  timeInGame: { vi: "Thời gian chơi", en: "Time in game", pt: "Tempo no jogo", id: "Waktu bermain" },
  WareHouseCashUpgrade: { vi: "Nâng cấp kho", en: "Warehouse upgrade", pt: "Upgrade do armazém", id: "Upgrade gudang" },
  WHUdup: { vi: "WHUdup", en: "WHUdup", pt: "WHUdup", id: "WHUdup" },
  Match3Lives_infTime: { vi: "M3 vô hạn", en: "M3 infinite", pt: "M3 infinito", id: "M3 tak terbatas" },
};

const DECOR_THEME_LABELS: Record<string, Partial<Record<Lang, string>>> = {
  All: { vi: "Tất cả", en: "All", pt: "Todos", id: "Semua" },
  Halloween: { vi: "Halloween", en: "Halloween", pt: "Halloween", id: "Halloween" },
  Christmas: { vi: "Giáng sinh", en: "Christmas", pt: "Natal", id: "Natal" },
  Easter: { vi: "Phục sinh", en: "Easter", pt: "Páscoa", id: "Paskah" },
  Valentine: { vi: "Valentine", en: "Valentine", pt: "Valentine", id: "Valentine" },
  Birthday: { vi: "Sinh nhật", en: "Birthday", pt: "Aniversário", id: "Ulang tahun" },
  Wedding: { vi: "Đám cưới", en: "Wedding", pt: "Casamento", id: "Pernikahan" },
  "CNY/Lunar": { vi: "Tết / Âm lịch", en: "CNY / Lunar", pt: "Ano Novo Lunar", id: "Imlek" },
  Festival: { vi: "Lễ hội", en: "Festival", pt: "Festival", id: "Festival" },
  Summer: { vi: "Mùa hè", en: "Summer", pt: "Verão", id: "Musim panas" },
  Winter: { vi: "Mùa đông", en: "Winter", pt: "Inverno", id: "Musim dingin" },
  "Spring/Flowers": { vi: "Xuân / Hoa", en: "Spring / Flowers", pt: "Primavera / Flores", id: "Musim semi / Bunga" },
  Autumn: { vi: "Mùa thu", en: "Autumn", pt: "Outono", id: "Musim gugur" },
  "Signs/Banners": { vi: "Biển / Băng rôn", en: "Signs / Banners", pt: "Placas / Faixas", id: "Tanda / Spanduk" },
  "Nature/Garden": { vi: "Thiên nhiên / Vườn", en: "Nature / Garden", pt: "Natureza / Jardim", id: "Alam / Taman" },
  "Water/Sea": { vi: "Nước / Biển", en: "Water / Sea", pt: "Água / Mar", id: "Air / Laut" },
  "Beach/Resort": { vi: "Bãi biển / Resort", en: "Beach / Resort", pt: "Praia / Resort", id: "Pantai / Resor" },
  "City/Buildings": { vi: "Thành phố / Công trình", en: "City / Buildings", pt: "Cidade / Edifícios", id: "Kota / Bangunan" },
  "Travel/World": { vi: "Du lịch / Thế giới", en: "Travel / World", pt: "Viagem / Mundo", id: "Wisata / Dunia" },
  "Adventure/Expedition": { vi: "Phiêu lưu / Thám hiểm", en: "Adventure / Expedition", pt: "Aventura / Expedição", id: "Petualangan / Ekspedisi" },
  "Castle/Medieval": { vi: "Lâu đài / Trung cổ", en: "Castle / Medieval", pt: "Castelo / Medieval", id: "Kastil / Abad pertengahan" },
  "Space/Future": { vi: "Không gian / Tương lai", en: "Space / Future", pt: "Espaço / Futuro", id: "Luar angkasa / Masa depan" },
  "Music/Stage": { vi: "Âm nhạc / Sân khấu", en: "Music / Stage", pt: "Música / Palco", id: "Musik / Panggung" },
  Sports: { vi: "Thể thao", en: "Sports", pt: "Esportes", id: "Olahraga" },
  "Food/Cafe": { vi: "Ẩm thực / Quán", en: "Food / Cafe", pt: "Comida / Café", id: "Makanan / Kafe" },
  Animals: { vi: "Động vật", en: "Animals", pt: "Animais", id: "Hewan" },
  "Lights/Lanterns": { vi: "Đèn / Lồng đèn", en: "Lights / Lanterns", pt: "Luzes / Lanternas", id: "Lampu / Lentera" },
  Pirate: { vi: "Hải tặc", en: "Pirate", pt: "Pirata", id: "Bajak laut" },
  Western: { vi: "Miền Tây", en: "Western", pt: "Faroeste", id: "Western" },
  Gatsby: { vi: "Gatsby", en: "Gatsby", pt: "Gatsby", id: "Gatsby" },
  Fashion: { vi: "Thời trang", en: "Fashion", pt: "Moda", id: "Mode" },
  "Japan/Asia": { vi: "Nhật / Châu Á", en: "Japan / Asia", pt: "Japão / Ásia", id: "Jepang / Asia" },
  "Europe/Paris": { vi: "Châu Âu / Paris", en: "Europe / Paris", pt: "Europa / Paris", id: "Eropa / Paris" },
  Egypt: { vi: "Ai Cập", en: "Egypt", pt: "Egito", id: "Mesir" },
  "Italy/Greece": { vi: "Ý / Hy Lạp", en: "Italy / Greece", pt: "Itália / Grécia", id: "Italia / Yunani" },
  Underwater: { vi: "Dưới nước", en: "Underwater", pt: "Subaquático", id: "Bawah laut" },
  "Christmas/Winter": { vi: "Giáng sinh / Đông", en: "Christmas / Winter", pt: "Natal / Inverno", id: "Natal / Musim dingin" },
  Other: { vi: "Khác", en: "Other", pt: "Outros", id: "Lainnya" },
};


const STAT_I18N_EXTRA: Record<string, Partial<Record<Lang, string>>> = {
  "tca": {},
  "coi": {
    "fr": "Pièces",
    "de": "Münzen",
    "it": "Monete",
    "ru": "Монеты",
    "es": "Monedas",
    "pt": "Moedas",
    "id": "Koin",
    "zh": "金币",
    "ja": "コイン",
    "ko": "코인"
  },
  "lvl": {
    "fr": "Niveau",
    "de": "Level",
    "it": "Livello",
    "ru": "Уровень",
    "es": "Nivel",
    "pt": "Nível",
    "id": "Level",
    "zh": "等级",
    "ja": "レベル",
    "ko": "레벨"
  },
  "dat": {
    "fr": "Date de début",
    "de": "Startdatum",
    "it": "Data inizio",
    "ru": "Дата начала",
    "es": "Fecha de inicio",
    "pt": "Data inicial",
    "id": "Tanggal mulai",
    "zh": "开始日期",
    "ja": "開始日",
    "ko": "시작일"
  },
  "win": {
    "fr": "Victoires au premier essai",
    "de": "Siege beim ersten Versuch",
    "it": "Vittorie al primo tentativo",
    "ru": "Победы с первой попытки",
    "es": "Victorias al primer intento",
    "pt": "Vitórias na 1ª tentativa",
    "id": "Menang percobaan pertama",
    "zh": "首次尝试胜利",
    "ja": "初回勝利",
    "ko": "첫 시도 승리"
  },
  "liv": {
    "fr": "Vies envoyées",
    "de": "Gesendete Leben",
    "it": "Vite inviate",
    "ru": "Отправленные жизни",
    "es": "Vidas enviadas",
    "pt": "Vidas enviadas",
    "id": "Nyawa terkirim",
    "zh": "已发送生命",
    "ja": "送ったライフ",
    "ko": "보낸 라이프"
  },
  "reg": {},
  "hlp": {
    "fr": "Aide",
    "de": "Hilfe",
    "it": "Aiuto",
    "ru": "Помощь",
    "es": "Ayuda",
    "pt": "Ajuda",
    "id": "Bantuan",
    "zh": "帮助",
    "ja": "ヘルプ",
    "ko": "도움말"
  },
  "exp": {
    "fr": "Énergie",
    "de": "Energie",
    "it": "Energia",
    "ru": "Энергия",
    "es": "Energía",
    "pt": "Energia",
    "id": "Energi",
    "zh": "能量",
    "ja": "エネルギー",
    "ko": "에너지"
  },
  "key": {
    "fr": "Clés",
    "de": "Schlüssel",
    "it": "Chiavi",
    "ru": "Ключи",
    "es": "Llaves",
    "pt": "Chaves",
    "id": "Kunci",
    "zh": "钥匙",
    "ja": "鍵",
    "ko": "열쇠"
  },
  "m3l": {
    "fr": "Niveau M3",
    "de": "M3-Level",
    "it": "Livello M3",
    "ru": "Уровень M3",
    "es": "Nivel M3",
    "pt": "Nível M3",
    "id": "Level M3",
    "zh": "三消等级",
    "ja": "M3レベル",
    "ko": "M3 레벨"
  },
  "match3Life": {
    "fr": "Vies M3",
    "de": "M3-Leben",
    "it": "Vite M3",
    "ru": "Жизни M3",
    "es": "Vidas M3",
    "pt": "Vidas M3",
    "id": "Nyawa M3",
    "zh": "三消生命",
    "ja": "M3ライフ",
    "ko": "M3 생명"
  },
  "residents": {
    "fr": "Habitants",
    "de": "Bewohner",
    "it": "Abitanti",
    "ru": "Жители",
    "es": "Habitantes",
    "pt": "Moradores",
    "id": "Penduduk",
    "zh": "居民",
    "ja": "住民",
    "ko": "주민"
  },
  "spentCash": {
    "fr": "T-Cash dépensé",
    "de": "Ausgegebenes T-Cash",
    "it": "T-Cash speso",
    "ru": "Потраченный T-Cash",
    "es": "T-Cash gastado",
    "pt": "T-Cash gasto",
    "id": "T-Cash terpakai",
    "zh": "已花费 T-Cash",
    "ja": "使用T-Cash",
    "ko": "사용한 T-Cash"
  },
  "earnedCash": {
    "fr": "T-Cash gagné",
    "de": "Verdientes T-Cash",
    "it": "T-Cash guadagnato",
    "ru": "Заработанный T-Cash",
    "es": "T-Cash ganado",
    "pt": "T-Cash ganho",
    "id": "T-Cash diperoleh",
    "zh": "获得的 T-Cash",
    "ja": "獲得T-Cash",
    "ko": "획득 T-Cash"
  },
  "EarnedCoins": {
    "fr": "Pièces gagnées",
    "de": "Verdiente Münzen",
    "it": "Monete guadagnate",
    "ru": "Заработанные монеты",
    "es": "Monedas ganadas",
    "pt": "Moedas ganhas",
    "id": "Koin diperoleh",
    "zh": "获得的金币",
    "ja": "獲得コイン",
    "ko": "획득 코인"
  },
  "wheatCounter": {
    "fr": "Blé",
    "de": "Weizen",
    "it": "Grano",
    "ru": "Пшеница",
    "es": "Trigo",
    "pt": "Trigo",
    "id": "Gandum",
    "zh": "小麦",
    "ja": "小麦",
    "ko": "밀"
  },
  "plowFieldsAchiev": {
    "fr": "Champs labourés",
    "de": "Gepflügte Felder",
    "it": "Campi arati",
    "ru": "Вспаханные поля",
    "es": "Campos arados",
    "pt": "Campos arados",
    "id": "Lahan dibajak",
    "zh": "耕地数量",
    "ja": "耕した畑",
    "ko": "경작한 밭"
  },
  "defaultOrdersCount": {
    "fr": "Commandes",
    "de": "Bestellungen",
    "it": "Ordini",
    "ru": "Заказы",
    "es": "Pedidos",
    "pt": "Pedidos",
    "id": "Pesanan",
    "zh": "订单",
    "ja": "注文",
    "ko": "주문"
  },
  "mineCounter": {
    "fr": "Mine",
    "de": "Mine",
    "it": "Miniera",
    "ru": "Шахта",
    "es": "Mina",
    "pt": "Mina",
    "id": "Tambang",
    "zh": "矿井",
    "ja": "鉱山",
    "ko": "광산"
  },
  "timeInGame": {
    "fr": "Temps de jeu",
    "de": "Spielzeit",
    "it": "Tempo di gioco",
    "ru": "Время в игре",
    "es": "Tiempo de juego",
    "pt": "Tempo no jogo",
    "id": "Waktu bermain",
    "zh": "游戏时间",
    "ja": "プレイ時間",
    "ko": "플레이 시간"
  },
  "WareHouseCashUpgrade": {
    "fr": "Amélioration de l’entrepôt",
    "de": "Lager-Upgrade",
    "it": "Upgrade magazzino",
    "ru": "Улучшение склада",
    "es": "Mejora del almacén",
    "pt": "Upgrade do armazém",
    "id": "Upgrade gudang",
    "zh": "仓库升级",
    "ja": "倉庫アップグレード",
    "ko": "창고 업그레이드"
  },
  "Match3Lives_infTime": {}
};

function catalogLabel(lang: Lang, id: string, fallback: string) {
  return CATALOG_LABELS[id]?.[lang] ?? CATALOG_LABELS[id]?.en ?? fallback;
}

function statLabel(lang: Lang, id: string, fallback: string) {
  return STAT_LABELS[id]?.[lang] ?? STAT_LABELS[id]?.en ?? fallback;
}

function decorThemeLabel(lang: Lang, id: string) {
  return DECOR_THEME_LABELS[id]?.[lang] ?? DECOR_THEME_LABELS[id]?.en ?? id;
}

function normalizeDecorText(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function decorThemesFor(item: Item): DecorTheme[] {
  const text = normalizeDecorText(`${item.id} ${item.label}`);
  const out = new Set<DecorTheme>();
  const add = (theme: DecorTheme, words: string[]) => { if (words.some((w) => text.includes(w))) out.add(theme); };
  add("Halloween", ["halloween", "spooky", "witch", "pumpkin", "ghost", "haunted"]);
  add("Christmas", ["christmas", "xmas", "santa", "snowman", "reindeer", "gingerbread"]);
  add("Easter", ["easter", "egg", "bunny"]);
  add("Valentine", ["valentine", "heart", "love", "romantic"]);
  add("Birthday", ["birthday", "cake", "party"]);
  add("Wedding", ["wedding", "bride", "groom"]);
  add("CNY/Lunar", ["cny", "lunar", "chinese", "lantern", "dragon", "newyear"]);
  add("Festival", ["festival", "carnival", "parade", "fair"]);
  add("Summer", ["summer", "sunny", "surf", "pool"]);
  add("Winter", ["winter", "snow", "ice", "frost"]);
  add("Spring/Flowers", ["spring", "flower", "blossom", "garden", "rose", "tulip"]);
  add("Autumn", ["autumn", "harvest", "fall", "maple"]);
  add("Signs/Banners", ["sign", "banner", "poster", "billboard", "flag", "direction"]);
  add("Nature/Garden", ["garden", "tree", "bush", "park", "nature", "fountain"]);
  add("Water/Sea", ["sea", "ocean", "marine", "beach", "boat", "ship", "harbor", "pool", "water"]);
  add("Beach/Resort", ["beach", "resort", "vacation", "summer", "island", "palm"]);
  add("City/Buildings", ["building", "house", "shop", "store", "tower", "station", "city"]);
  add("Travel/World", ["travel", "tour", "world", "airport", "airplane", "paris", "italy", "egypt"]);
  add("Adventure/Expedition", ["expedition", "adventure", "explore", "jungle", "ruins"]);
  add("Castle/Medieval", ["castle", "fortress", "medieval", "knight", "king", "queen"]);
  add("Space/Future", ["space", "future", "ufo", "robot", "moon", "mars", "galaxy"]);
  add("Music/Stage", ["music", "theatrical", "stage", "concert", "disco", "rocknroll"]);
  add("Sports", ["sport", "stadium", "football", "basketball", "tennis", "skate"]);
  add("Food/Cafe", ["food", "cafe", "coffee", "restaurant", "culinary", "bakery", "cake"]);
  add("Animals", ["animal", "chicken", "cow", "pig", "sheep", "horse", "dog", "cat"]);
  add("Lights/Lanterns", ["light", "lantern", "neon", "lamp"]);
  add("Pirate", ["pirate", "buccaneer"]);
  add("Western", ["western", "cowboy", "wildwest"]);
  add("Gatsby", ["gatsby"]);
  add("Fashion", ["fashion", "style"]);
  add("Japan/Asia", ["japan", "japanese", "asia", "sakura", "kyoto"]);
  add("Europe/Paris", ["paris", "france", "venice", "europe"]);
  add("Egypt", ["egypt", "pharaoh", "pyramid"]);
  add("Italy/Greece", ["italy", "italian", "hellas", "greece"]);
  add("Underwater", ["underwater", "atlantis", "aquarium"]);
  if (text.includes("christmas") || text.includes("winter") || text.includes("snow")) out.add("Christmas/Winter");
  if (!out.size) out.add("Other");
  return [...out];
}

function groupTone(id: string, index = 0) {
  return TONE_TEXT[GROUP_TONE[id] ?? SKIN_CYCLE[index % SKIN_CYCLE.length]];
}

function useSetMap() {
  const [map, setMap] = useState<Record<string, Set<string>>>({});
  const toggle = useCallback((g: string, id: string) => {
    setMap((prev) => {
      const next = { ...prev, [g]: new Set(prev[g]) };
      if (next[g].has(id)) next[g].delete(id);
      else next[g].add(id);
      return next;
    });
  }, []);
  const setGroup = useCallback((g: string, ids: string[], on: boolean) => {
    setMap((prev) => {
      const cur = new Set(prev[g]);
      for (const id of ids) {
        if (on) cur.add(id);
        else cur.delete(id);
      }
      return { ...prev, [g]: cur };
    });
  }, []);
  const clear = useCallback(() => setMap({}), []);
  const allOn = useCallback((groups: Group[]) => {
    const n: Record<string, Set<string>> = {};
    for (const g of groups) n[g.id] = new Set(g.items.map((i) => i.id));
    setMap(n);
  }, []);
  const asRecord = useCallback(() => {
    const o: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(map)) {
      if (v.size) o[k] = [...v];
    }
    return o;
  }, [map]);
  const addMany = useCallback((groups: Record<string, string[]>) => {
    setMap((prev) => {
      const next = { ...prev };
      for (const [g, ids] of Object.entries(groups)) {
        const cur = new Set(next[g]);
        for (const id of ids) cur.add(id);
        next[g] = cur;
      }
      return next;
    });
  }, []);
  const removeMany = useCallback((groups: Record<string, string[]>) => {
    setMap((prev) => {
      const next = { ...prev };
      for (const [g, ids] of Object.entries(groups)) {
        const cur = new Set(next[g]);
        for (const id of ids) cur.delete(id);
        next[g] = cur;
      }
      return next;
    });
  }, []);
  const count = useMemo(() => Object.values(map).reduce((n, s) => n + s.size, 0), [map]);
  return { map, toggle, setGroup, clear, allOn, asRecord, addMany, removeMany, count };
}

function zooPaddockLabel(id: string): string {
  const bare = id.replace(/^paddock_/i, "").replace(/[_-]+/g, " ").trim();
  if (!bare) return id;
  return bare
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatRemain(ms: number, lifetime: boolean, lang: Lang) {
  if (lifetime) return lang === "vi" ? "Vĩnh viễn" : "Lifetime";
  if (ms <= 0) return lang === "vi" ? "Hết hạn" : "Expired";
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (lang === "vi") {
    if (d > 0) return `${d}n ${h}g`;
    if (h > 0) return `${h}g ${m}p`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function Mark({ className }: { className?: string }) {
  return <img src="/logo.jpeg" className={cn("shrink-0 object-contain", className)} alt="" aria-hidden />;
}

type GameIconName =
  | "device"
  | "copy"
  | "license"
  | "unlock"
  | "connect"
  | "save"
  | "regatta"
  | "season"
  | "data"
  | "profile"
  | "avatar"
  | "skin"
  | "unban"
  | "decor"
  | "sticker"
  | "items"
  | "barn"
  | "museum"
  | "zoo"
  | "feedback"
  | "language"
  | "refresh"
  | "log"
  | "warning"
  | "success"
  | "control"
  | "search"
  | "events";

/**
 * Small, original game-management glyphs. These are intentionally drawn in
 * one stroke language so a missing licensed game asset never turns into a
 * random icon-library mashup. The registry is presentation-only.
 */
function GameIcon({ name, className, ...props }: { name: GameIconName; className?: string } & SVGProps<SVGSVGElement>) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.7,
  };
  let content: ReactNode;
  switch (name) {
    case "device":
      content = <><rect x="4.5" y="2.8" width="15" height="18.4" rx="2.4" /><path d="M8 6h8M10 18h4" /><circle cx="12" cy="9.8" r="2.3" /><path d="M8.2 15.2h7.6" /></>;
      break;
    case "copy":
      content = <><rect x="7.2" y="5.2" width="11.8" height="14" rx="1.8" /><path d="M7.2 8.3H5.8A1.8 1.8 0 0 1 4 6.5V4.8A1.8 1.8 0 0 1 5.8 3h8.5a1.8 1.8 0 0 1 1.8 1.8v.4M10 10h6M10 13.5h6M10 17h3.4" /></>;
      break;
    case "license":
      content = <><path d="m14.5 4.2 5.3 5.3-8.3 8.3-5.3-5.3z" /><path d="m6.4 12.5-2.7 2.7 2 2-1.3 1.3 2 2 2.5-2.5" /><circle cx="15.7" cy="8.3" r="1" /></>;
      break;
    case "unlock":
      content = <><path d="M8 10V7.5a4 4 0 0 1 7.7-1.5" /><rect x="4.4" y="10" width="15.2" height="10.2" rx="2.2" /><path d="M12 14.1v2.1M9.7 16.2h4.6" /></>;
      break;
    case "connect":
      content = <><path d="M8.2 8.2 5.8 5.8a2.6 2.6 0 0 0-3.6 3.6l4.1 4.1a2.6 2.6 0 0 0 3.6 0l1.4-1.4" /><path d="m15.8 15.8 2.4 2.4a2.6 2.6 0 0 0 3.6-3.6l-4.1-4.1a2.6 2.6 0 0 0-3.6 0l-1.4 1.4M8.3 15.7l7.4-7.4" /></>;
      break;
    case "save":
      content = <><path d="M4 7.3 12 3l8 4.3v9.4L12 21l-8-4.3z" /><path d="m4.2 7.5 7.8 4.2 7.8-4.2M12 11.7V21" /><path d="M8.4 5.1v3.1h7.2V5.1" /></>;
      break;
    case "regatta":
      content = <><path d="M4 17.8h16M6.1 18.1c.7 1.7 2.3 2.5 4.3 1.1 1.5-1 2.8-1 4.1.1 1.8 1.4 3.4.5 4.1-1.1" /><path d="M11.8 4v13.2M12 4 6.8 15.2h10.4z" /></>;
      break;
    case "season":
      content = <><path d="m12 3 2 4.1 4.5.7-3.2 3.2.8 4.5-4.1-2.1-4.1 2.1.8-4.5-3.2-3.2 4.5-.7z" /><path d="M7.5 18.8h9M9.5 21h5" /></>;
      break;
    case "data":
      content = <><path d="M3.5 20.5h17M5 18V9.5h3V18M10.5 18V5h3v13M16 18v-5.5h3V18" /><path d="m5 7 3-2 2.5 1.2L16 3.5l3 1.2" /></>;
      break;
    case "profile":
    case "avatar":
      content = <><circle cx="12" cy="8" r="3.2" /><path d="M5.2 20.3a6.8 6.8 0 0 1 13.6 0" /><path d="M3.2 5.2v3M20.8 5.2v3" /></>;
      break;
    case "skin":
      content = <><path d="M8.2 4.2 12 6.5l3.8-2.3 2.7 3.1-2.2 3v9.2H7.7v-9.2l-2.2-3z" /><path d="M9.2 9.2h5.6M12 6.5v12.9" /></>;
      break;
    case "unban":
      content = <><path d="M12 3.2 19 6v5.1c0 4.2-2.8 7.6-7 9.7-4.2-2.1-7-5.5-7-9.7V6z" /><path d="M9 11.7V10a3 3 0 0 1 5.8-1M8 11.7h7.5v5.1H8z" /><path d="m17.8 7.1 2.2-2.2" /></>;
      break;
    case "decor":
      content = <><path d="M12 20.8v-5.1M8.7 20.8h6.6" /><path d="M12 3.2 9.2 7h2l-3.1 4.1h3L7.8 15h8.4l-3.3-3.9h3L12.8 7h2z" /></>;
      break;
    case "sticker":
      content = <><path d="M5 3.8h9.2l4.8 4.8v7.6a4 4 0 0 1-4 4H5a2 2 0 0 1-2-2V5.8a2 2 0 0 1 2-2z" /><path d="M14.2 3.9v4.8H19M7 12h6M7 15.5h3.5" /><path d="m7.2 8.2.7.7 1.5-1.5" /></>;
      break;
    case "items":
      content = <><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.8 7.7 12 12l8.2-4.3M12 12v8.5M8 5.1l8.3 4.4" /><path d="M8.4 14.3h3.1" /></>;
      break;
    case "barn":
      content = <><path d="m3.5 10.2 8.5-6.4 8.5 6.4v10.3h-17z" /><path d="M8.2 20.5v-6.1h7.6v6.1M6.5 10.2h11M12 4v2.5" /><path d="M17.8 7.4h2.4v13.1" /></>;
      break;
    case "museum":
      content = <><path d="m12 3.5 8.5 4v2H3.5v-2z" /><path d="M5.5 9.5v9M9.5 9.5v9M14.5 9.5v9M18.5 9.5v9" /><path d="M3.5 18.5h17M4.5 21h15" /></>;
      break;
    case "zoo":
      content = <><circle cx="12" cy="14.5" r="3.4" /><circle cx="6.6" cy="9.5" r="1.7" /><circle cx="10" cy="7" r="1.7" /><circle cx="14" cy="7" r="1.7" /><circle cx="17.4" cy="9.5" r="1.7" /></>;
      break;
    case "feedback":
      content = <><path d="M4.5 4.2h15a2 2 0 0 1 2 2v9.1a2 2 0 0 1-2 2h-8.1l-4.2 3v-3H4.5a2 2 0 0 1-2-2V6.2a2 2 0 0 1 2-2z" /><path d="M7 9h10M7 12.5h6" /></>;
      break;
    case "language":
      content = <><circle cx="12" cy="12" r="8.7" /><path d="M3.7 12h16.6M12 3.3c2.1 2.3 3.2 5.2 3.2 8.7s-1.1 6.4-3.2 8.7c-2.1-2.3-3.2-5.2-3.2-8.7S9.9 5.6 12 3.3z" /></>;
      break;
    case "refresh":
      content = <><path d="M19.7 8.8A8 8 0 0 0 5.2 6.5L3.5 8.2M3.5 4.5v3.7h3.7M4.3 15.2a8 8 0 0 0 14.5 2.3l1.7-1.7M20.5 19.5v-3.7h-3.7" /></>;
      break;
    case "log":
      content = <><path d="M6 3.5h8.2l3.8 3.8v13.2H6z" /><path d="M14 3.5v4h4M8.8 11h6.5M8.8 14.5h6.5M8.8 18h4" /></>;
      break;
    case "warning":
      content = <><path d="m12 3.4 9 16.1H3z" /><path d="M12 9v4.2M12 16.6v.2" /></>;
      break;
    case "success":
      content = <><circle cx="12" cy="12" r="8.8" /><path d="m7.5 12.2 2.9 2.9 6.2-6.2" /></>;
      break;
    case "control":
      content = <><path d="M12 3.2 19 6v5.1c0 4.2-2.8 7.6-7 9.7-4.2-2.1-7-5.5-7-9.7V6z" /><path d="M9 12h6M12 9v6" /></>;
      break;
    case "search":
      content = <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m15.5 15.5 5 5" /></>;
      break;
    case "events":
      // A bloom, for the Bloom & Buzz card: centre plus four petals, drawn in
      // the same single-stroke language as the rest of the registry.
      content = <>
        <circle cx="12" cy="12" r="2.4" />
        <ellipse cx="12" cy="7.4" rx="2.1" ry="3" />
        <ellipse cx="12" cy="16.6" rx="2.1" ry="3" />
        <ellipse cx="7.4" cy="12" rx="3" ry="2.1" />
        <ellipse cx="16.6" cy="12" rx="3" ry="2.1" />
      </>;
      break;
  }
  return (
    <svg
      {...props}
      className={cn("game-icon", className)}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      {...common}
    >
      {content}
    </svg>
  );
}

const Chip = memo(function Chip({
  checked,
  onChange,
  label,
  iconSrc,
  emoji,
  banner,
  avatar,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  iconSrc?: string | null;
  emoji?: string | null;
  banner?: boolean;
  avatar?: boolean;
}) {
  const fallback = emoji || "✦";
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={onChange}
      className={cn(
        "inventory-chip premium-chip flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm text-fg",
        "transition-[background-color,box-shadow,border-color] duration-150 ease-smooth",
        "border border-transparent hover:border-primary/25 hover:bg-input hover:shadow-[0_0_0_1px_rgba(124,58,237,0.12),0_0_12px_rgba(124,58,237,0.08)]",
        checked && "border-primary/35 bg-primary/10 shadow-[0_0_0_1px_rgba(124,58,237,0.2),0_0_14px_rgba(56,189,248,0.08)]",
      )}
    >
      <span
        className={cn(
          "check-pop grid size-4 shrink-0 place-items-center rounded-sm shadow-hairline",
          checked && "bg-primary text-primary-fg shadow-none",
        )}
      >
        <GameIcon name="success" className={cn("size-3", checked ? "is-on" : "is-off")} />
      </span>
      {iconSrc ? (
        <span
          className={cn("chip-asset", avatar && "chip-asset-avatar", banner && "chip-asset-banner")}
          aria-hidden="true"
        >
          <img
            src={iconSrc}
            alt=""
            className="chip-asset-img"
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        </span>
      ) : (
        <span className="chip-asset chip-emoji" aria-hidden="true">
          <span className="chip-emoji-glyph">{fallback}</span>
        </span>
      )}
      <span className="chip-label truncate">{label}</span>
    </button>
  );
});

function GroupCard({
  lang,
  group,
  selected,
  onToggle,
  onGroup,
  collapsed,
  onCollapse,
  allLabel,
  noneLabel,
  toneClass,
  iconFor,
}: {
  lang: Lang;
  group: Group;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onGroup: (on: boolean) => void;
  collapsed?: boolean;
  onCollapse?: () => void;
  allLabel: string;
  noneLabel: string;
  toneClass?: string;
  iconFor?: (groupId: string, label: string) => string | null;
}) {
  const n = selected.size;
  const collapsible = Boolean(onCollapse);
  const open = !collapsible || !collapsed;
  const customGroupArt = iconFor?.(group.id, group.label) ?? null;
  const headerArt = customGroupArt ?? iconForGroup(group.id);
  return (
    <section className="panel inventory-group">
      <header className={cn("flex items-center gap-2", open && "mb-3")}>
        {collapsible ? (
          <button
            type="button"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
            onClick={onCollapse}
            aria-expanded={open}
          >
            {headerArt ? (
              <span className="group-asset" aria-hidden="true">
                <img src={headerArt} alt="" className="group-asset-img" draggable={false} />
              </span>
            ) : (
              <span className="group-emoji" aria-hidden="true">{groupEmoji(group.id)}</span>
            )}
            <GameIcon name={groupIcon(group.id)} className="group-icon" />
            <h3 className={cn("truncate text-xs font-bold tracking-wider uppercase", toneClass ?? "text-primary")}>
              {catalogLabel(lang, group.id, group.label)}
            </h3>
            <span className="text-xs text-muted tabular-nums">
              {n}/{group.items.length}
            </span>
            <ChevronDown
              className={cn(
                "ml-auto size-4 shrink-0 text-muted transition-transform duration-200 ease-smooth",
                !open && "-rotate-90",
              )}
            />
          </button>
        ) : (
          <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2">
            {headerArt ? (
              <span className="group-asset" aria-hidden="true">
                <img src={headerArt} alt="" className="group-asset-img" draggable={false} />
              </span>
            ) : (
              <span className="group-emoji" aria-hidden="true">{groupEmoji(group.id)}</span>
            )}
            <GameIcon name={groupIcon(group.id)} className="group-icon" />
            <h3 className={cn("truncate text-xs font-bold tracking-wider uppercase", toneClass ?? "text-primary")}>
              {catalogLabel(lang, group.id, group.label)}
            </h3>
            <span className="text-xs text-muted tabular-nums">
              {n}/{group.items.length}
            </span>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="h-8 px-2 text-xs text-muted hover:text-primary" onClick={() => onGroup(true)}>
            {allLabel}
          </button>
          <button type="button" className="h-8 px-2 text-xs text-muted hover:text-primary" onClick={() => onGroup(false)}>
            {noneLabel}
          </button>
        </div>
      </header>
      {open ? (
        <div className="grid grid-cols-2 gap-x-2 sm:grid-cols-3 lg:grid-cols-4">
          {group.items.map((it) => {
            const isAva = group.id.startsWith("ava_");
            const avaIcon = isAva ? avatarIconPath(it.id) : null;
            const avaEmoji = isAva && !avaIcon ? avatarEmoji(it.id) : null;
            const skinIcon = iconForSkin(group.id, it.label);
            const profileIcon = iconForProfileLabel(it.label);
            const itemIcon = iconForItemLabel(it.label);
            const gemIcon = group.id === "Gems" ? iconForGem(it.label) : null;
            const customIcon = iconFor?.(group.id, it.label) ?? null;
            return (
              <Chip
                key={it.id}
                label={it.label}
                iconSrc={customIcon ?? avaIcon ?? skinIcon ?? profileIcon ?? itemIcon ?? gemIcon}
                emoji={avaEmoji ?? (avaIcon ? null : itemEmoji(group.id, it.label))}
                avatar={Boolean(avaIcon)}
                banner={group.id === "Styles" || group.id === "Themes"}
                checked={selected.has(it.id)}
                onChange={() => onToggle(it.id)}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function LangSwitch({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  const tr = useCallback((k: keyof Dict) => t(lang, k), [lang]);
  return (
    <label className="icon-lang inline-flex items-center text-xs font-semibold">
      <GameIcon name="language" className="size-4 shrink-0 text-primary" />
      <span className="sr-only">{tr("language")}</span>
      <select
        className="min-w-0 flex-1 bg-input text-sm font-semibold text-fg outline-none"
        value={lang}
        onChange={(e) => onChange(e.target.value as Lang)}
        aria-label={tr("language")}
      >
        {LANGS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function StudioApp() {
  const [lang, setLang] = useState<Lang>("en");
  const tr = useCallback((k: keyof Dict) => t(lang, k), [lang]);

  const [key, setKey] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [license, setLicense] = useState<LicenseSnap | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [view, setView] = useState<"client" | "control">("client");
  const [deviceId, setDeviceId] = useState("VIP-LOCAL");
  const [copied, setCopied] = useState(false);
  const [sheet, setSheet] = useState<Sheet>("none");
  const [freshRelease, setFreshRelease] = useState<{ version: string; notes: string; downloadUrl: string; sha256: string } | null>(null);

  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [device, setDevice] = useState("");
  const [session, setSession] = useState<SessionSnap | null>(null);
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("data");
  const [stats, setStats] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [skinOpen, setSkinOpen] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState<string | null>(null);
  const initialProfileRef = useRef<Record<string, string[]>>({});
  const [avatarOpen, setAvatarOpen] = useState<string | null>(null);
  const [itemsOpen, setItemsOpen] = useState<string | null>(null);
  const [bulkQty, setBulkQty] = useState("500");
  const [decorLimit, setDecorLimit] = useState(36);
  const [decorTheme, setDecorTheme] = useState<DecorTheme>("All");
  const [decorQty, setDecorQty] = useState("10");
  const [cityManual, setCityManual] = useState("");
  const [friendSel, setFriendSel] = useState<string | null>(null);
  const [tabReady, setTabReady] = useState(false);
  const [avaFrom, setAvaFrom] = useState(1);
  const [avaTo, setAvaTo] = useState(50);
  const [barnUpgrades, setBarnUpgrades] = useState<number | null>(null);
  const [barnItems, setBarnItems] = useState<Record<string, number>>({});
  const [barnFill, setBarnFill] = useState("500");
  const [barnVerify, setBarnVerify] = useState<{ success: string[]; failed: string[] } | null>(null);
  const [barnShowAll, setBarnShowAll] = useState(false);

  const profileSel = useSetMap();
  const avatarSel = useSetMap();
  const skinSel = useSetMap();
  const itemSel = useSetMap();
  const zooSel = useSetMap();
  const [decorSel, setDecorSel] = useState<Set<string>>(new Set());
  const [stickerSel, setStickerSel] = useState<Set<string>>(new Set());
  const [museumSel, setMuseumSel] = useState<Set<string>>(new Set());
  const [pendingRegatta, setPendingRegatta] = useState(false);
  // How many completed tasks the Regatta tab should reach (the server clamps
  // to REGATTA_MAX_TASKS regardless — 73 is the largest real week on record).
  // It is a weekly *total*, but a push is limited harder than that by the
  // window's own length: early in the week only a handful of days have run, so
  // the batch refuses rather than compressing a week's worth of completions
  // onto one or two days.
  const [regattaTasks, setRegattaTasks] = useState(REGATTA_DEFAULT_TASKS);
  const [pendingSeason, setPendingSeason] = useState(false);
  const [pendingBloom, setPendingBloom] = useState(false);
  // Frozen Fortune (`DragonNest` in game data) is the same wallet mechanism,
  // so it gets its own pending flag rather than a mode on Bloom's — one card,
  // one queue flag, and the Bloom payload keeps the shape it shipped with. The
  // count below is shared by both cards on purpose: it is labelled "tokens to
  // add", and whichever cards are queued each receive exactly that many.
  const [pendingFrozen, setPendingFrozen] = useState(false);
  // How many Bloom & Buzz (TrainJourney) tokens this push *adds* — a delta,
  // exactly like the Regatta count: the wallet keeps what it already holds and
  // gains this many on both Amount and TokensEarned.
  const [bloomTokens, setBloomTokens] = useState(BLOOM_TOKENS_DEFAULT);
  const [pendingUnban, setPendingUnban] = useState<UnbanMode | null>(null);
  const [pendingDecorFragments, setPendingDecorFragments] = useState(false);
  const [pendingDecorClone, setPendingDecorClone] = useState(false);
  const [pendingTownClone, setPendingTownClone] = useState(false);
  // Which of the three copy stages has actually been pushed. The reference
  // tool does not transplant a city in one go: stage 1 lands the stats, the
  // account then plays the tutorial to level 3 and unlocks the zoo, and only
  // stage 2/3 — each of which force-stops the game and re-pulls
  // mGameInfo.xml first — put the town and the advanced blocks on top.
  // Every banned save on file is the opposite shape: a whole city pushed onto
  // an account that had never finished a tutorial or synced once. So the next
  // stage stays locked until the one before it has been applied.
  const [copyStage, setCopyStage] = useState(0);
  // Fresh-start ("New Account") phase machine. Fully isolated: nothing from
  // other tabs' state is read or written here.
  const [freshPhase, setFreshPhase] = useState<"idle" | "backedup" | "verified">("idle");
  const [freshBackup, setFreshBackup] = useState<{ oldCityId: string; oldLevel: number; extraCount: number; skippedCount: number; androidId: string } | null>(null);
  const [freshCheck, setFreshCheck] = useState<{ newCityId: string; androidReset: boolean; gsfReset: boolean } | null>(null);
  const [freshInjectNote, setFreshInjectNote] = useState("");
  const [freshIdentityNote, setFreshIdentityNote] = useState("");
  const [freshIdentity, setFreshIdentity] = useState<{ androidId: string; gsfWiped: boolean } | null>(null);
  const [clientVer, setClientVer] = useState("");

  useEffect(() => {
    let stop = false;
    nativeBridge()
      ?.version()
      .then((v) => {
        if (!stop && v) setClientVer(v);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);
  const [pendingDecorMaxAll, setPendingDecorMaxAll] = useState(false);
  const upgradeFactorySel = useSetMap();
  const upgradeTrainSel = useSetMap();
  const upgradeIslandSel = useSetMap();
  const [upgradeTargetLevel, setUpgradeTargetLevel] = useState(1);
  const upgradeTargetSessionRef = useRef<string | null>(null);
  const [pendingUpgradeFactory, setPendingUpgradeFactory] = useState(false);
  const [pendingUpgradeTrain, setPendingUpgradeTrain] = useState(false);
  const [pendingUpgradeIsland, setPendingUpgradeIsland] = useState(false);
  const initialStatsRef = useRef<Record<string, string>>({});
  const localInfoAtRef = useRef(0);

  useEffect(() => {
    let stop = false;
    try {
      const stored = localStorage.getItem("igg-vip-lang");
      if (stored && isLang(stored)) setLang(stored);
    } catch {
      /* ignore */
    }

    const readStoredOrMint = (): string => {
      try {
        const hwid = localStorage.getItem("igg-vip-hwid");
        if (hwid && isDeviceId(hwid)) return normalizeDeviceId(hwid);
      } catch {
        /* private mode */
      }
      const fresh = mintDeviceId();
      try {
        localStorage.setItem("igg-vip-hwid", fresh);
      } catch {
        /* ignore */
      }
      return fresh;
    };

    // Instant paint from the stored id. Inside the EXE this is then
    // upgraded to the file-backed machine id below.
    setDeviceId(readStoredOrMint());

    // The shell injects window.iggNative ~100ms after boot, i.e. AFTER this
    // effect runs — reading it once here would miss it every launch and
    // fall back to a fresh random id. So wait for the bridge: its ready
    // event first, then a bounded poll (old EXE builds without deviceId
    // resolve immediately; plain browsers hit the timeout and keep the
    // stored id).
    void (async () => {
      const readNative = async (): Promise<string | null> => {
        try {
          const fn = nativeBridge()?.deviceId;
          if (typeof fn !== "function") return null;
          const nid = await fn();
          return nid && isDeviceId(nid) ? normalizeDeviceId(nid) : null;
        } catch {
          return null;
        }
      };
      let nid = await readNative();
      if (!nid) {
        nid = await new Promise<string | null>((resolve) => {
          let settled = false;
          let waited = 0;
          const done = (v: string | null) => {
            if (settled) return;
            settled = true;
            window.clearInterval(tick);
            window.removeEventListener("igg-native-ready", onEvent);
            resolve(v);
          };
          const probe = (): boolean => {
            const bridge = nativeBridge();
            if (!bridge) return false;
            if (typeof bridge.deviceId !== "function") {
              done(null);
              return true;
            }
            void (async () => {
              try {
                const v = await bridge.deviceId!();
                done(v && isDeviceId(v) ? normalizeDeviceId(v) : null);
              } catch {
                done(null);
              }
            })();
            return true;
          };
          const onEvent = () => {
            probe();
          };
          const tick = window.setInterval(() => {
            waited += 1;
            if (probe() || waited >= 30) done(null);
          }, 50);
          window.addEventListener("igg-native-ready", onEvent);
          probe();
        });
      }
      if (!stop && nid) {
        try {
          localStorage.setItem("igg-vip-hwid", nid);
        } catch {
          /* ignore */
        }
        setDeviceId(nid);
      }
    })();
    setTabReady(true);
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!license || license.lifetime) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [license]);

  useEffect(() => {
    if (!token) return;
    let stop = false;
    let currentVersion = "0.0.0";
    const native = nativeBridge();
    const compareVersions = (a: string, b: string) => {
      const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
      const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return 1;
        if ((pa[i] || 0) < (pb[i] || 0)) return -1;
      }
      return 0;
    };
    const tick = async () => {
      try {
        if (native) currentVersion = await native.version();
        const r = await getRelease({ data: { token } });
        if (stop || !currentVersion) return;
        if (compareVersions(r.version, currentVersion) <= 0) return;
        const marker = `igg-vip-auto-update-${r.version}`;
        try {
          if (localStorage.getItem(marker) === "done") return;
        } catch {}
        setFreshRelease(r);
        if (native && r.downloadUrl && r.sha256) {
          try {
            const result = await native.installUpdate(r);
            if (result.ok) {
              try { localStorage.setItem(marker, "done"); } catch {}
            }
          } catch (e) {
            toast.error(e instanceof Error ? e.message : tr("updateFailed"));
          }
        }
      } catch {
        /* keep the studio usable if the poll misses once */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 15 * 60 * 1000);
    return () => { stop = true; window.clearInterval(id); };
  }, [token, tr]);

  const setLangPersist = (l: Lang) => {
    setLang(l);
    try {
      localStorage.setItem("igg-vip-lang", l);
    } catch {
      /* ignore */
    }
  };

  const applySnap = (s: SessionSnap, profileGroups?: Group[]) => {
    setSession(s);
    setStats(s.stats);
    initialStatsRef.current = { ...s.stats };
    setBarnUpgrades(s.barn.upgrades);
    setBarnItems({ ...s.barn.items });
    // Default the upgrade target to the save's own max on each new session.
    // The old hardcoded 1 meant "apply" with an untouched dropdown raised
    // every selected row toward level 1 — a guaranteed no-op error.
    if (s.sessionId !== upgradeTargetSessionRef.current) {
      upgradeTargetSessionRef.current = s.sessionId;
      setUpgradeTargetLevel(s.factoryMax ?? s.upgradeCaps.factory);
    }

    // Only keep profile IDs that actually exist in the current catalog.
    // The save can contain legacy/unknown profile IDs; keeping those in the
    // selection map made the UI show counts like 69/16 and caused unchanged
    // profile data to be re-submitted on every save.
    const groups = profileGroups ?? catalogs?.profile ?? [];
    const allowed = new Map<string, Set<string>>();
    for (const g of groups) allowed.set(g.id, new Set(g.items.map((it) => it.id)));
    const visibleUnlocked: Record<string, string[]> = {};
    for (const [g, ids] of Object.entries(s.profileUnlocked ?? {})) {
      const set = allowed.get(g);
      if (!set) continue;
      const filtered = ids.filter((id) => set.has(id));
      if (filtered.length) visibleUnlocked[g] = filtered;
    }
    initialProfileRef.current = visibleUnlocked;
    profileSel.clear();
    profileSel.addMany(visibleUnlocked);
  };

  const profileAdditions = useCallback(() => {
    const current = profileSel.asRecord();
    const additions: Record<string, string[]> = {};
    for (const [g, ids] of Object.entries(current)) {
      const before = new Set(initialProfileRef.current[g] ?? []);
      const added = ids.filter((id) => !before.has(id));
      if (added.length) additions[g] = added;
    }
    return additions;
  }, [profileSel]);

  const remainingMs = !license || license.lifetime ? 0 : Math.max(0, license.expiresAt - nowTick);

  const unlock = async (providedKey?: string) => {
    const candidate = (providedKey ?? key).trim();
    setLoginErr("");
    if (candidate.length < 4) {
      setLoginErr(tr("errKey"));
      return;
    }
    setBusy(true);
    try {
      const r = await verifyLicense({ data: { key: candidate, deviceId } });
      setKey(candidate);
      setToken(r.token);
      setDeviceId(r.deviceId);
      setLicense(r.license);
      try {
        const native = nativeBridge();
        if (native) await native.saveKey(candidate);
        else localStorage.setItem("igg-vip-license-key", candidate);
      } catch {}
      setView("client");
      const [cats] = await Promise.all([
        getCatalogs({ data: { token: r.token } }),
      ]);
      setCatalogs(cats);
      const native = nativeBridge();
      let source = "";
      let saveB64: string | undefined;
      if (native) {
        try {
          const list = await native.devices();
          setDevices(list);
          source = list[0]?.id ?? "";
          setDevice(source);
          if (list[0]) {
            const pulled = await native.pull(list[0].id);
            saveB64 = pulled.b64;
          }
        } catch {
          setDevices([]);
          setDevice("");
        }
      } else {
        setDevices([]);
        setDevice("");
      }
      if (source && saveB64) {
        const s = await connectLoad({
          data: { token: r.token, device: source, saveB64 },
        });
        applySnap(s, cats.profile);
        toast.success(`${tr("online")} · ${tr("cityReady")}`);
      } else {
        toast.success(tr("online"));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed";
      if (/invalid key|key revoked|key expired|locked to another device|device not on this key/i.test(message)) {
        try {
          const native = nativeBridge();
          if (native) await native.clearSavedKey();
          else localStorage.removeItem("igg-vip-license-key");
        } catch {}
      }
      setLoginErr(message);
    } finally {
      setBusy(false);
    }
  };

  const refreshLocalInfoCached = useCallback(async (force = false) => {
    if (!token || !session || !device) return;
    const now = Date.now();
    if (!force && now - localInfoAtRef.current < 60_000) return;
    const native = nativeBridge();
    if (!native) throw new Error("Chưa có ADB emulator");
    try {
      const li = await native.pullLocalInfo(device);
      const next = await attachLocal({ data: { token, sessionId: session.sessionId, b64: li.b64 } });
      localInfoAtRef.current = Date.now();
      applySnap(next, catalogs?.profile);
    } catch (e) {
      // mLocalInfo is optional — some installs never create it, and the save
      // itself already carries <Version> for FetchCity. Don't surface this as
      // a red error when everything else works; just keep the cached time so
      // we don't retry every click.
      const msg = e instanceof Error ? e.message : String(e);
      if (/mLocalInfo|No such file|package not installed/i.test(msg)) {
        localInfoAtRef.current = Date.now();
        return;
      }
      throw e;
    }
  }, [token, session, device, catalogs?.profile]);

  const connect = async (_xml?: string, source = device, _b64?: string) => {
    if (!token) return;
    setBusy(true);
    try {
      const native = nativeBridge();
      if (!native || !source) throw new Error("Chưa kết nối emulator bằng ADB.");
      const pulled = await native.pull(source);
      const s = await connectLoad({
        data: { token, device: source, saveB64: pulled.b64 },
      });
      applySnap(s, catalogs?.profile);
      localInfoAtRef.current = 0;
      avatarSel.clear();
      skinSel.clear();
      itemSel.clear();
      zooSel.clear();
      setDecorSel(new Set());
      setStickerSel(new Set());
      setMuseumSel(new Set());
      setPendingRegatta(false);
      setPendingSeason(false);
      setPendingBloom(false);
      setPendingFrozen(false);
      setPendingUnban(null);
      setPendingDecorFragments(false);
      setPendingDecorClone(false);
      setPendingTownClone(false);
      setPendingDecorMaxAll(false);
      setProfileOpen(null);
      setSkinOpen(null);
      setAvatarOpen(null);
      setItemsOpen(null);
      setBulkQty("500");
      setDecorQty("10");
      setAvaFrom(1);
      setAvaTo(50);
      toast.success(tr("cityReady"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("connectFailed"));
    } finally {
      setBusy(false);
    }
  };

  const barnDirty = useMemo(() => {
    if (!session) return false;
    if (barnUpgrades && barnUpgrades !== session.barn.upgrades) return true;
    return Object.entries(barnItems).some(([k, v]) => v !== (session.barn.items[k] ?? 0));
  }, [session, barnUpgrades, barnItems]);

  const pending =
    profileSel.count + avatarSel.count + skinSel.count + itemSel.count + zooSel.count + decorSel.size + stickerSel.size + museumSel.size +
    upgradeFactorySel.count + upgradeTrainSel.count + upgradeIslandSel.count +
    (barnDirty ? 1 : 0) + (pendingRegatta ? 1 : 0) + (pendingSeason ? 1 : 0) + (pendingUnban ? 1 : 0) +
    (pendingBloom ? 1 : 0) + (pendingFrozen ? 1 : 0) +
    (pendingDecorFragments ? 1 : 0) + (pendingDecorClone ? 1 : 0) + (pendingDecorMaxAll ? 1 : 0) +
    (pendingTownClone ? 1 : 0) +
    (pendingUpgradeFactory ? 1 : 0) + (pendingUpgradeTrain ? 1 : 0) + (pendingUpgradeIsland ? 1 : 0);

  const parseQty = useCallback(() => {
    const n = Number.parseInt(bulkQty, 10);
    return Number.isFinite(n) && n > 0 ? n : 500;
  }, [bulkQty]);

  const parseDecorQty = useCallback(() => {
    const n = Number.parseInt(decorQty, 10);
    return Number.isFinite(n) && n > 0 ? n : 10;
  }, [decorQty]);

  const save = useCallback(async () => {
    if (!token || !session) return;
    setBusy(true);
    try {
      // The stage only advances once its push has actually succeeded, so a
      // refused or failed Save & push never unlocks the next one.
      const unbanStage = pendingUnban === "inicial" ? 1 : pendingUnban === "completo" ? 2 : pendingUnban === "novo" ? 3 : 0;
      const qty = parseQty();
      const itemIds = Object.values(itemSel.asRecord()).flat();
      const changedBarn: Record<string, number> = {};
      for (const [k, v] of Object.entries(barnItems)) {
        if (v !== (session.barn.items[k] ?? 0)) changedBarn[k] = v;
      }
      const changedStats: Record<string, string> = {};
      for (const [k, v] of Object.entries(stats)) {
        if (String(v) !== String(initialStatsRef.current[k] ?? "")) changedStats[k] = v;
      }

      let activeSession = session;
      if (pendingUnban && (pendingUnban === "completo" || pendingUnban === "novo")) {
        const native = nativeBridge();
        if (!native || !device) throw new Error("Cần emulator thật để Unban Complete/New");
        // Keep the legacy Unban sequence: close the game, wait briefly, then
        // re-pull the current save before applying ONLY the Unban operation.
        await native.forceStop(device);
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        const fresh = await native.pull(device);
        activeSession = await refreshOwn({ data: { token, sessionId: session.sessionId, saveB64: fresh.b64 } });
        applySnap(activeSession, catalogs?.profile);
      } else {
        // Re-pull the device save before granting, so consumable grants
        // (gems, items) apply as a delta on current device state. Without
        // this a second push re-sends the stale session and resurrects
        // items the game already consumed. Best-effort: a failed pull
        // keeps the previous behavior instead of blocking the save.
        const native = nativeBridge();
        if (native && device) {
          try {
            const fresh = await native.pull(device);
            activeSession = await refreshOwn({ data: { token, sessionId: session.sessionId, saveB64: fresh.b64 } });
            applySnap(activeSession, catalogs?.profile);
          } catch {
            /* keep the loaded session */
          }
        }
      }

      // Legacy Unban is intentionally kept on its dedicated server operation.
      // Do not route it through the compound save pipeline: that pipeline also
      // processes every other pending editor state and can make Unban behave
      // differently from v1.15.
      // Auto-fit the barn tier to the edited total before saving: the game
      // trims anything above capacity on load (325 products at 500 each need
      // far more than a small tier holds), which reads as "only some items
      // collected". The picked tier stays visible in the UI like a manual pick.
      let barnTier = barnUpgrades;
      if (catalogs) {
        const total = Object.values(barnItems).reduce((n, v) => n + (Number(v) || 0), 0);
        const cur = catalogs.barnCapacity.find((c) => c.upgrades === (barnTier ?? activeSession.barn.upgrades))?.capacity
          ?? activeSession.barn.capacity ?? 0;
        if (total > cur) {
          const fit = catalogs.barnCapacity.find((c) => c.capacity >= total)
            ?? catalogs.barnCapacity[catalogs.barnCapacity.length - 1];
          if (fit && fit.upgrades !== (barnTier ?? activeSession.barn.upgrades)) {
            barnTier = fit.upgrades;
            setBarnUpgrades(fit.upgrades);
          }
        }
      }
      const profileDelta = profileAdditions();
      const hasProfileChanges = Object.keys(profileDelta).length > 0;
      const hasOtherChanges =
        Object.keys(changedStats).length > 0 ||
        hasProfileChanges ||
        avatarSel.count > 0 ||
        skinSel.count > 0 ||
        itemSel.count > 0 ||
        zooSel.count > 0 ||
        decorSel.size > 0 ||
        stickerSel.size > 0 ||
        museumSel.size > 0 ||
        Object.keys(changedBarn).length > 0 ||
        pendingRegatta ||
        pendingSeason ||
        pendingBloom ||
        pendingFrozen ||
        pendingDecorFragments ||
        pendingDecorClone ||
        pendingTownClone ||
        pendingDecorMaxAll;

      if (pendingUnban && !hasOtherChanges) {
        const r = await applyUnban({
          data: {
            token,
            sessionId: activeSession.sessionId,
            mode: pendingUnban,
          },
        });
        applySnap(r, catalogs?.profile);
        if (unbanStage) setCopyStage((c) => Math.max(c, unbanStage));
        if (r.fileB64) {
          const native = nativeBridge();
          if (native && device) {
            await native.push(device, r.fileB64, { alreadyStopped: pendingUnban === "completo" || pendingUnban === "novo", restart: true });
            toast.success(`${tr("pushed")} · Unban`);
          } else {
            downloadB64("mGameInfo.xml", r.fileB64);
            toast.success(`${tr("savedXml")} · Unban`);
          }
        }
        setPendingUnban(null);
        return;
      }

      const r = await saveAll({
        data: {
          token,
          sessionId: activeSession.sessionId,
          stats: Object.keys(changedStats).length ? changedStats : undefined,
          profile: profileDelta,
          avatars: Object.values(avatarSel.asRecord()).flat(),
          skins: skinSel.asRecord(),
          items: Object.fromEntries(itemIds.map((id) => [id, qty])),
          zoo: Object.values(zooSel.asRecord()).flat(),
          decor: [...decorSel],
          decorQty: parseDecorQty(),
          sticker: [...stickerSel],
          museum: museumSel.size ? [...museumSel] : undefined,
          barnUpgrades: barnTier && barnTier !== activeSession.barn.upgrades ? barnTier : undefined,
          barnItems: Object.keys(changedBarn).length ? changedBarn : undefined,
          regatta: pendingRegatta,
          regattaTasks: pendingRegatta ? regattaTasks : undefined,
          season: pendingSeason,
          bloomTokens: pendingBloom ? bloomTokens : undefined,
          frozenTokens: pendingFrozen ? bloomTokens : undefined,
          unbanMode: pendingUnban ?? undefined,
          decorFragments: pendingDecorFragments,
          decorClone: pendingDecorClone,
          townClone: pendingTownClone,
          decorMaxAll: pendingDecorMaxAll,
          upgrades: (upgradeFactorySel.count > 0 || upgradeTrainSel.count > 0 || upgradeIslandSel.count > 0) ? {
            factory: upgradeFactorySel.count > 0 ? Object.fromEntries(Object.values(upgradeFactorySel.asRecord()).flat().map(id => [id, upgradeTargetLevel])) : undefined,
            train: upgradeTrainSel.count > 0 ? Object.fromEntries(Object.values(upgradeTrainSel.asRecord()).flat().map(id => [id, upgradeTargetLevel])) : undefined,
            island: upgradeIslandSel.count > 0 ? Object.fromEntries(Object.values(upgradeIslandSel.asRecord()).flat().map(id => [id, upgradeTargetLevel])) : undefined,
          } : undefined,
        },
      });
      applySnap(r, catalogs?.profile);
      if (r.fileB64) {
        const native = nativeBridge();
        if (native && device) {
          await native.push(device, r.fileB64);
          toast.success(`${tr("pushed")} · ${r.parts.join(", ")}`);
        } else {
          downloadB64("mGameInfo.xml", r.fileB64);
          toast.success(`${tr("savedXml")} · ${r.parts.join(", ")}`);
        }
      } else if (r.xml) {
        downloadText("city.xml", r.xml);
        toast.success(`${tr("savedXml")} · ${r.parts.join(", ")}`);
      } else {
        toast.success(`${tr("saved")} · ${r.parts.join(", ")}`);
      }
      avatarSel.clear();
      skinSel.clear();
      itemSel.clear();
      zooSel.clear();
      profileSel.clear();
      setDecorSel(new Set());
      setStickerSel(new Set());
      setMuseumSel(new Set());
      upgradeFactorySel.clear();
      upgradeTrainSel.clear();
      upgradeIslandSel.clear();
      setPendingRegatta(false);
      setPendingSeason(false);
      setPendingBloom(false);
      setPendingFrozen(false);
      if (unbanStage) setCopyStage((c) => Math.max(c, unbanStage));
      setPendingUnban(null);
      setPendingDecorFragments(false);
      setPendingDecorClone(false);
      setPendingTownClone(false);
      setPendingDecorMaxAll(false);
      setPendingUpgradeFactory(false);
      setPendingUpgradeTrain(false);
      setPendingUpgradeIsland(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("nothing"));
    } finally {
      setBusy(false);
    }
  }, [token, session, stats, profileSel, avatarSel, skinSel, itemSel, zooSel, decorSel, stickerSel, parseQty, barnUpgrades, barnItems, pendingRegatta, regattaTasks, pendingSeason, pendingBloom, pendingFrozen, bloomTokens, pendingUnban, pendingDecorFragments, pendingDecorClone, pendingTownClone, pendingDecorMaxAll, parseDecorQty, tr, device, upgradeFactorySel, upgradeTrainSel, upgradeIslandSel, upgradeTargetLevel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // The snapshot's `regattaInfo.reason` is computed for the *default* batch of
  // 12 — `snapshot()` cannot know which number the user is about to pick. The
  // button has to answer for the count on screen: a save already holding 12
  // read "enough tasks" with the count raised to 15 (dead button, but 15 would
  // have worked). Re-running the server's own helper here makes "pressable"
  // and "will succeed" the same decision.
  //
  // The count no longer decides anything — it is how many tasks this push adds
  // — so what is left for it to answer is the two things that genuinely depend
  // on the block rather than on the number: whether a regatta is open, and
  // whether there is a record to copy.
  const regattaState: RegattaReason = session
    ? regattaReason(
        {
          window: session.regattaInfo.window,
          templates: session.regattaInfo.templates,
          current: session.regattaInfo.current,
          lastDone: session.regattaInfo.lastDone,
          quota: session.regattaInfo.quota,
        },
        regattaTasks,
      )
    : "no_active_regatta";

  const tool = (kind: "regatta" | "season" | "bloom" | "frozen") => {
    if (kind === "regatta") {
      setPendingRegatta(true);
      toast.success(tr("toastRegattaQueued"));
    } else if (kind === "bloom") {
      setPendingBloom(true);
      toast.success(tr("toastBloomQueued"));
    } else if (kind === "frozen") {
      setPendingFrozen(true);
      toast.success(tr("toastFrozenQueued"));
    } else {
      setPendingSeason(true);
      toast.success(tr("toastSeasonQueued"));
    }
  };

  const applyAvaRange = (on: boolean) => {
    const { byGroup, lo } = avatarsInRange(avaFrom, avaTo);
    if (on) {
      avatarSel.addMany(byGroup);
      setAvatarOpen(avatarGroupId(lo));
    } else avatarSel.removeMany(byGroup);
  };

  const fields = useMemo(() => catalogs?.fields ?? [], [catalogs]);

  const zooGroups: Group[] = useMemo(    () =>
      (session?.zoo ?? []).map((p) => ({
        id: p.paddock,
        label: zooPaddockLabel(p.paddock),
        emoji: "🐾",
        items: p.members.map((m) => ({
          id: m.key,
          label: `${m.name} · ${m.pieces}/${m.required}${m.status === 3 && m.pieces >= m.required ? " ✓" : ""}`,
        })),
      })),
    [session],
  );
  const decoratedWithThemes = useMemo(() => {
    const list = catalogs?.decor ?? [];
    return list.map((d) => ({ item: d, themes: decorThemesFor(d) }));
  }, [catalogs]);
  const filteredDecor = useMemo(() => {
    const q = normalizeDecorText(search.trim());
    return decoratedWithThemes
      .filter(({ item, themes }) => decorTheme === "All" || themes.includes(decorTheme))
      .filter(({ item }) => !q || normalizeDecorText(`${item.id} ${item.label}`).includes(q))
      .map(({ item }) => item);
  }, [decoratedWithThemes, decorTheme, search]);
  const decorThemeCounts = useMemo(() => {
    const counts = new Map<DecorTheme, number>();
    for (const theme of DECOR_THEMES) counts.set(theme, 0);
    for (const { themes } of decoratedWithThemes) for (const theme of themes) counts.set(theme, (counts.get(theme) ?? 0) + 1);
    counts.set("All", decoratedWithThemes.length);
    return counts;
  }, [decoratedWithThemes]);

  // Fresh-start ("New Account") flow. Phase machine only: idle -> backed up ->
  // wiped -> verified. Device file traffic goes through the native bridge;
  // the server only validates, tracks the backup, and verifies the result.
  const onFreshBackupCore = async (): Promise<boolean> => {
    if (!token || !session || !device) {
      toast.error(tr("actionFailed"));
      return false;
    }
    const native = nativeBridge();
    if (!native?.readAndroidId) {
      toast.error(tr("freshNoBridge"));
      return false;
    }
    const city = await native.pull(device);
    const local = await native.pullLocalInfo(device);
    let androidId = "";
    try {
      androidId = (await native.readAndroidId(device)).androidId ?? "";
    } catch {
      androidId = "";
    }
    let gsfId = "";
    try {
      gsfId = (await native.readGsfId?.(device))?.gsfId ?? "";
    } catch {
      gsfId = "";
    }
    const r = await backupFreshStart({
      data: {
        token, sessionId: session.sessionId, serial: device,
        cityPath: city.file, localPath: local.file,
        cityB64: city.b64, localB64: local.b64, extraFiles: [], androidId, gsfId,
      },
    });
    setFreshBackup({ oldCityId: r.oldCityId, oldLevel: r.oldLevel, extraCount: r.extraCount, skippedCount: r.skippedCount ?? 0, androidId });
    setFreshCheck(null);
    setFreshPhase("backedup");
    return true;
  };

  const onFreshBackup = async () => {
    if (!token || !session || !device) {
      toast.error(tr("actionFailed"));
      return;
    }
    setBusy(true);
    try {
      if (await onFreshBackupCore()) toast.success(tr("freshBackedUp"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("nothing"));
    } finally {
      setBusy(false);
    }
  };

  // New device identity between Backup and Inject. Backup reads the current
  // Android ID + GSF id; Inject writes the same L1 file pair onto whatever
  // identity the device holds — so without this step a "new account" keeps
  // the old device's ids and the server re-links the fresh city to the old
  // ban (resetting Android ID alone leaves GSF behind for the same reason).
  // Optional by design: existing flows that never needed it work exactly as
  // before. Every write is verified by re-read inside the bridge; anything
  // unverified throws and Inject must not run after it.
  const onFreshIdentity = async () => {
    if (!device) {
      toast.error(tr("actionFailed"));
      return;
    }
    const native = nativeBridge();
    if (!native?.resetAndroidId || !native?.resetGsfId || !native?.readAndroidId) {
      toast.error(tr("freshNoBridge"));
      return;
    }
    setBusy(true);
    try {
      setFreshIdentityNote(`⏳ ${tr("freshIdentityDoing")}`);
      setFreshIdentity(null);
      const r = await native.resetAndroidId(device);
      if (!r.ok) throw new Error(tr("nothing"));
      let gsfWiped = false;
      try {
        const g = await native.resetGsfId(device);
        if (g.ok) {
          gsfWiped = true;
        } else if (!/not found/i.test(g.error ?? "")) {
          throw new Error(g.error || tr("nothing"));
        }
      } catch (e) {
        // No GMS on the emulator means nothing to re-link — not a failure.
        if (!/not found/i.test(e instanceof Error ? e.message : "")) throw e;
      }
      const nowId = (await native.readAndroidId(device)).androidId ?? "";
      if (!nowId || (r.oldAndroidId && nowId === r.oldAndroidId)) throw new Error(tr("nothing"));
      setFreshIdentity({ androidId: nowId, gsfWiped });
      const done = tr("freshIdentityDone").replace("{old}", (r.oldAndroidId ?? "").slice(0, 8)).replace("{new}", nowId.slice(0, 8));
      setFreshIdentityNote(`✅ ${done}`);
      toast.success(done);
    } catch (e) {
      const msg = e instanceof Error ? e.message : tr("nothing");
      setFreshIdentityNote(`❌ ${msg}`);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  // TS-Lite-style Level 1: hand the game a complete ready-made city instead
  // of wiping. A wipe leaves no identity, so Playrix re-links the old city
  // from the device fingerprint; injecting the pair means that request never
  // happens. Requires an existing backup — the pair replaces the save.
  const onFreshInject = async () => {
    if (!token || !session || !device) {
      toast.error(tr("actionFailed"));
      return;
    }
    const native = nativeBridge();
    if (!native?.injectFreshProfile) {
      toast.error(tr("freshNoBridge"));
      return;
    }
    setBusy(true);
    try {
      setFreshInjectNote(`⏳ ${tr("freshInjecting")}`);
      const r = await native.injectFreshProfile(device);
      if (!r.ok) throw new Error(tr("nothing"));
      setFreshInjectNote(`✅ ${tr("freshInjected")}: ${r.dir ?? ""} · mGameInfo ${r.verified?.["mGameInfo.xml"] ?? "?"}B · LocalInfo ${r.verified?.["LocalInfo.xml"] ?? "?"}B`);
      toast.success(tr("freshInjected"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : tr("nothing");
      setFreshInjectNote(`❌ ${msg}`);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const onFreshLaunch = async () => {
    if (!device) {
      toast.error(tr("actionFailed"));
      return;
    }
    const native = nativeBridge();
    if (!native?.launchGame) {
      toast.error(tr("freshNoBridge"));
      return;
    }
    setBusy(true);
    try {
      await native.launchGame(device);
      toast.success(tr("freshGameOpened"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("nothing"));
    } finally {
      setBusy(false);
    }
  };

  const onFreshVerify = async () => {
    if (!token || !session || !device) {
      toast.error(tr("actionFailed"));
      return;
    }
    const native = nativeBridge();
    if (!native?.readAndroidId) {
      toast.error(tr("freshNoBridge"));
      return;
    }
    setBusy(true);
    try {
      const city = await native.pull(device);
      let androidId = "";
      try {
        androidId = (await native.readAndroidId(device)).androidId ?? "";
      } catch {
        androidId = "";
      }
      let gsfAndroidId = "";
      try {
        gsfAndroidId = (await native.readGsfId?.(device))?.gsfId ?? "";
      } catch {
        gsfAndroidId = "";
      }
      const r = await verifyFreshStart({
        data: { token, sessionId: session.sessionId, cityB64: city.b64, androidId, gsfAndroidId },
      });
      setFreshCheck({ newCityId: r.newCityId, androidReset: r.androidReset, gsfReset: r.gsfReset ?? false });
      setFreshPhase("verified");
      toast.success(tr("freshVerified"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : tr("nothing");
      toast.error(/could not read mgameinfo/i.test(msg) ? tr("freshOpenGameFirst") : msg);
    } finally {
      setBusy(false);
    }
  };

  const onFreshRestore = async () => {
    if (!token || !session || !device) {
      toast.error(tr("actionFailed"));
      return;
    }
    const native = nativeBridge();
    if (!native?.writeFile) {
      toast.error(tr("freshNoBridge"));
      return;
    }
    setBusy(true);
    try {
      const r = await restoreFreshStart({ data: { token, sessionId: session.sessionId } });
      const b = r.backup as { cityB64: string; localB64: string; extra: Record<string, string>; cityPath: string; localPath: string };
      await native.writeFile(device, b.cityPath, b.cityB64);
      await native.writeFile(device, b.localPath, b.localB64);
      for (const [p, data] of Object.entries(b.extra ?? {})) {
        await native.writeFile(device, p, data);
      }
      toast.success(tr("saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("nothing"));
    } finally {
      setBusy(false);
    }
  };

  const tabCount: Record<Tab, number> = {
    data: 0,
    profile: profileSel.count,
    avatars: avatarSel.count,
    skins: skinSel.count,
    unban: session?.unban.applied ? 1 : 0,
    decor: decorSel.size,
    sticker: stickerSel.size,
    items: itemSel.count,
    regatta: pendingRegatta ? regattaTasks : 0,
    barn: barnDirty ? 1 : 0,
    museum: museumSel.size,
    zoo: zooSel.count,
    upgrades: upgradeFactorySel.count + upgradeTrainSel.count + upgradeIslandSel.count,
    newgame: freshPhase === "idle" ? 0 : 1,
    events: (pendingBloom ? bloomTokens : 0) + (pendingFrozen ? bloomTokens : 0),
  };

  const barnTotal = Object.values(barnItems).reduce((n, v) => n + (Number(v) || 0), 0);
  const barnKinds = Object.values(barnItems).filter((v) => v > 0).length;
  // The game keeps only what fits the barn tier — anything above capacity is
  // trimmed on load, which reads as "only some items collected".
  const barnEffectiveCap = useMemo(() => {
    const picked = catalogs?.barnCapacity.find((c) => c.upgrades === barnUpgrades)?.capacity;
    return picked ?? session?.barn.capacity ?? null;
  }, [catalogs, barnUpgrades, session]);
  const barnOverCap = barnEffectiveCap != null && barnTotal > barnEffectiveCap;

  if (!token) {
    return (
      <main className="login-scene relative min-h-dvh px-4 py-8 sm:px-8">
        <div className="login-language absolute top-4 right-4 z-10">
          <LangSwitch lang={lang} onChange={setLangPersist} />
        </div>
        <div className="login-grid mx-auto min-h-[calc(100dvh-4rem)] w-full max-w-6xl items-center gap-8">
          <section className="login-visual gate-in" aria-label="IGG VIP TOOL">
            <div className="login-brand-lockup">
              <span className="login-brand-mark"><Mark className="size-9" /></span>
              <div>
                <p className="kicker">{tr("loginTitle")}</p>
                <p className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
                  IGG <span className="login-brand-wordmark">VIP TOOL</span>
                </p>
              </div>
            </div>
            <p className="login-lead login-tagline mt-5 max-w-lg leading-relaxed text-muted">{tr("tagline")}</p>
            <ul className="login-feature-list mt-7 space-y-3 text-sm text-muted">
              <li><span className="login-feature-mark"><GameIcon name="connect" /></span>{tr("archClientD")}</li>
              <li><span className="login-feature-mark"><GameIcon name="data" /></span>{tr("archServerD")}</li>
            </ul>
          </section>

          <section className="login-card w-full p-6 sm:p-8" aria-labelledby="login-heading">
            <header className="login-card-heading gate-in flex items-start gap-3">
              <span className="login-card-mark"><Mark className="size-7" /></span>
              <div className="min-w-0">
                <p className="kicker">{tr("app")}</p>
                <h1 id="login-heading" className="mt-1 font-display text-xl font-semibold tracking-tight">{tr("loginTitle")}</h1>
                <p className="mt-1 text-sm leading-relaxed text-muted">{tr("loginDesc")}</p>
              </div>
            </header>
            <div className="login-divider" />

            <div className="gate-in mt-5">
              <div className="login-label"><GameIcon name="device" /><span className="kicker">{tr("deviceId")}</span></div>
              <div className="device-id-card mt-2">
                <span className="device-id-icon"><GameIcon name="device" /></span>
                <div className="min-w-0 flex-1">
                  <span className="device-id-caption">{tr("deviceId")}</span>
                  <code className="mt-1 block break-all font-mono text-xs leading-relaxed tabular-nums sm:text-sm">{deviceId}</code>
                </div>
                <button
                  type="button"
                  className="copy-button"
                  onClick={async () => {
                    let didCopy = false;
                    try {
                      if (navigator.clipboard?.writeText) {
                        await navigator.clipboard.writeText(deviceId);
                        didCopy = true;
                      }
                    } catch {
                      /* fall through to the compatibility copy path */
                    }
                    if (!didCopy) {
                      const fallback = document.createElement("textarea");
                      fallback.value = deviceId;
                      fallback.setAttribute("readonly", "true");
                      fallback.style.position = "fixed";
                      fallback.style.left = "-9999px";
                      fallback.style.opacity = "0";
                      document.body.appendChild(fallback);
                      fallback.select();
                      fallback.setSelectionRange(0, fallback.value.length);
                      try {
                        didCopy = document.execCommand("copy");
                      } catch {
                        didCopy = false;
                      }
                      fallback.remove();
                    }
                    if (!didCopy) return;
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                  }}
                >
                  <span className="icon-swap size-4">
                    <GameIcon name="success" className={cn("size-4", copied ? "is-on" : "is-off")} />
                    <GameIcon name="copy" className={cn("size-4", copied ? "is-off" : "is-on")} />
                  </span>
                  <span>{copied ? tr("copied") : tr("copy")}</span>
                </button>
              </div>
            </div>

            <div className="gate-in mt-5">
              <label className="login-label" htmlFor="license">
                <GameIcon name="license" />
                <span className="kicker">{tr("license")}</span>
              </label>
              <div className="field-shell mt-2">
                <GameIcon name="license" className="field-leading-icon" />
                <input
                  id="license"
                  className="field login-field font-mono"
                  type="password"
                  autoComplete="off"
                  placeholder={tr("licensePh")}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void unlock();
                  }}
                />
              </div>
              {loginErr ? (
                <p className="login-error mt-3 flex items-start gap-2 px-3 py-2 text-sm text-err"><GameIcon name="warning" /><span>{loginErr}</span></p>
              ) : null}
              <Button className="login-unlock mt-5 w-full" size="lg" disabled={busy} onClick={() => void unlock()}>
                <span className="icon-swap login-action-icon size-5">
                  <LoaderCircle className={cn("size-5", busy ? "is-on animate-spin" : "is-off")} />
                  <GameIcon name="unlock" className={cn("size-5", busy ? "is-off" : "is-on")} />
                </span>
                {tr("unlock")}
              </Button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <div className="app-root flex min-h-dvh flex-col">
      <header className="app-header sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="header-logo"><Mark className="size-7" /></span>
        <p className="header-brand font-display font-semibold tracking-tight">
          IGG <span className="text-primary">VIP TOOL</span>
        </p>
        <div className="header-statuses ml-auto flex items-center gap-1">
          {license ? (
            <span className="status-chip status-chip--license inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-kicker font-semibold tracking-wide uppercase">
              <GameIcon name="license" className="size-3.5" />
              <span className="status-chip-label">{tr("license")}</span>
              <span>{formatRemain(remainingMs, license.lifetime, lang)}</span>
            </span>
          ) : null}
          <span className="status-chip status-chip--online inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-kicker font-semibold tracking-wide uppercase">
            <span className="status-dot size-1.5 rounded-full" />
            <span>{tr("online")}</span>
          </span>
          {license?.admin ? (
            <div className="mode-switch mr-1 inline-flex rounded-md p-1">
              <button
                type="button"
                className={cn(
                  "mode-switch-button inline-flex h-9 items-center gap-1.5 rounded-sm px-3 text-xs font-semibold",
                  view === "client" ? "mode-switch-button--active" : "text-muted hover:text-fg",
                )}
                onClick={() => setView("client")}
              >
                <GameIcon name="device" className="size-3.5" />
                {tr("modeClient")}
              </button>
              <button
                type="button"
                className={cn(
                  "mode-switch-button inline-flex h-9 items-center gap-1.5 rounded-sm px-3 text-xs font-semibold",
                  view === "control" ? "mode-switch-button--active mode-switch-button--control" : "text-muted hover:text-fg",
                )}
                onClick={() => setView("control")}
              >
                <GameIcon name="control" className="size-3.5" />
                {tr("modeControl")}
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="header-action grid size-11 place-items-center rounded-md text-muted hover:text-fg"
            aria-label={tr("feedback")}
            onClick={() => setSheet("feedback")}
          >
            <GameIcon name="feedback" className="size-4" />
          </button>
          <LangSwitch lang={lang} onChange={setLangPersist} />
        </div>
      </header>

      {view !== "control" ? (
      <>
      {freshRelease ? (
        <div className="update-banner flex shrink-0 items-center gap-3 px-4 py-2">
          <Sparkles className="size-4 shrink-0 text-amber" />
          <p className="min-w-0 flex-1 truncate text-sm">
            <span className="font-semibold text-amber">{tr("updateReady")} {freshRelease.version}</span>
            <span className="hidden text-muted sm:inline"> · {freshRelease.notes}</span>
          </p>
          <Button
            size="sm"
            variant="amber"
            onClick={async () => {
              const native = nativeBridge();
              if (native && freshRelease.downloadUrl && freshRelease.sha256) {
                try {
                  await native.installUpdate(freshRelease);
                  return;
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : tr("updateFailed"));
                  return;
                }
              }
              try { sessionStorage.setItem("igg-vip-ver", freshRelease.version); } catch {}
              window.location.reload();
            }}
          >
            {tr("updateApply")}
          </Button>
        </div>
      ) : null}

      <div className="console-shell app-workspace">
        <aside className="app-sidebar flex shrink-0 flex-col gap-4 rounded-lg p-4 lg:gap-5">
          <div className="sidebar-device-block">
            <p className="kicker mb-2">{tr("device")}</p>
            <div className="device-selector-card">
              <span className="device-selector-icon"><GameIcon name="device" /></span>
              <div className="min-w-0 flex-1">
                <span className="device-selector-caption">{tr("device")}</span>
                <select className="device-selector-select" value={device} onChange={(e) => setDevice(e.target.value)} aria-label={tr("device")}>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <span className={cn("device-selector-state", device ? "device-selector-state--ready" : "")}>{device ? tr("online") : tr("empty")}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="icon-refresh device-refresh"
                aria-label={tr("refresh")}
                onClick={() => {
                  const native = nativeBridge();
                  if (!native) {
                    setDevices([]);
                    setDevice("");
                    toast.error(tr("adbNeed"));
                    return;
                  }
                  void native
                    .devices()
                    .then((list) => {
                      setDevices(list);
                      if (list[0]) setDevice(list[0].id);
                    })
                    .catch(() => toast.error(tr("adbNeed")));
                }}
              >
                <GameIcon name="refresh" className="size-4" />
              </Button>
            </div>
            <div className="sidebar-actions mt-3 flex flex-col gap-2">
              <Button className="primary-action w-full" disabled={busy} onClick={() => void connect()}>
                <span className="icon-swap size-5">
                  <LoaderCircle className={cn("size-5", busy ? "is-on animate-spin" : "is-off")} />
                  <GameIcon name="connect" className={cn("size-5", busy ? "is-off" : "is-on")} />
                </span>
                {tr("connect")}
              </Button>
              <Button className="secondary-action w-full" variant="outline" disabled={busy || !session} onClick={() => void save()}>
                <GameIcon name="save" className="size-4" />
                {tr("save")}
                {pending > 0 ? <span className="badge-pop tabular-nums">{pending}</span> : null}
              </Button>
              <Button
                className="w-full"
                variant="ghost"
                disabled={busy || !session}
                onClick={async () => {
                  if (!token || !session) return;
                  setBusy(true);
                  try {
                    const r = await exportCurrent({ data: { token, sessionId: session.sessionId } });
                    const native = nativeBridge();
                    if (native && typeof native.exportFile === "function") {
                      try {
                        const saved = await native.exportFile("mGameInfo.current.xml", r.fileB64);
                        toast.success(saved.path);
                        return;
                      } catch {
                        /* fall through to the browser download */
                      }
                    }
                    downloadB64("mGameInfo.current.xml", r.fileB64);
                    toast.success(tr("savedXml"));
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : tr("nothing"));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <GameIcon name="log" className="size-4" />
                {tr("exportXml")}
              </Button>
            </div>
            <p className="mt-2 hidden text-xs text-muted lg:block">{tr("shortcut")}</p>
            <p className="mt-1 hidden text-xs text-muted tabular-nums lg:block">build {__BUILD_ID__}{clientVer ? ` · exe v${clientVer}` : ""}</p>
          </div>

          <div className="sidebar-tools">
            <p className="kicker mb-2">{tr("tools")}</p>
            <div className="flex flex-col gap-2">
              <Button className="tool-action tool-action--season w-full" variant="amber" disabled={!session || busy} onClick={() => void tool("season")}>
                <span className="tool-asset" aria-hidden="true">
                  <img src="/game-icons/Season_pass.png" alt="" className="tool-asset-img" draggable={false} />
                </span>
                {tr("season")}
              </Button>
            </div>
          </div>

          <div className="sidebar-log flex max-h-28 flex-col lg:max-h-none lg:min-h-28 lg:flex-1">
            <p className="kicker mb-2 flex items-center gap-1.5">
              <GameIcon name="log" className="size-3.5" /> {tr("log")}
            </p>
            <div className="min-h-16 flex-1 overflow-auto rounded-md bg-input p-3 font-mono text-xs leading-relaxed text-primary">
              {(session?.log ?? [tr("ready")]).map((line, i) => (
                <p key={i}>› {line}</p>
              ))}
            </div>
          </div>
        </aside>

        <section className="app-main flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg shadow-hairline">
          <nav
            className="feature-tabs relative border-b border-border px-3 pt-3 pb-2"
          >
            <span aria-hidden className={cn("tab-pill", tabReady && "ready")} />
            {[PRIMARY_TABS, OVERFLOW_TABS].map((row, ri) => (
              <div
                key={ri}
                className={cn(
                  "feature-tabs-row grid grid-cols-4 gap-1 sm:grid-cols-8",
                  ri === 1 && "feature-tabs-overflow mt-1 border-t border-border/60 pt-2",
                )}
              >
                {row.map((id) => {
                  const on = tab === id;
                  const tabLabel = tr(TAB_KEY[id] as keyof Dict);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setTab(id)}
                      aria-current={on ? "page" : undefined}
                      aria-label={id !== "profile" && tabCount[id] > 0 ? `${tabLabel} ${tabCount[id]}` : tabLabel}
                      className={cn(
                        "feature-tab relative z-10 flex min-h-11 items-center justify-center gap-1 rounded-t-lg px-0.5 text-center text-xs font-semibold leading-tight transition-[color] duration-200 ease-smooth sm:text-sm",
                        on ? "feature-tab--active text-primary-fg" : "text-muted hover:text-fg",
                      )}
                    >
                      <span className="feature-tab-emoji" aria-hidden="true">{TAB_EMOJI[id]}</span>
                      <span className="whitespace-nowrap">{tabLabel}</span>
                      {id !== "profile" && tabCount[id] > 0 ? (
                        <span className={cn("tabular-nums", on ? "text-primary-fg/70" : "text-primary")}>
                          {tabCount[id]}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="dashboard-content min-h-0 flex-1 overflow-auto p-4 sm:p-5">
            {!session ? (
              <div className="panel-in grid min-h-64 place-items-center text-center">
                <div>
                  <GameIcon name="connect" className="empty-state-icon mx-auto size-8 text-muted" />
                  <p className="mt-3 text-sm text-muted">{tr("empty")}</p>
                  <p className="mt-1 text-xs text-muted">{tr("emptyCta")}</p>
                </div>
              </div>
            ) : (
              <div key={tab} className="panel-in">
                {tab === "data" && (
                  <div>
                    <p className="mb-4 text-sm text-muted">{tr("dataHint")}</p>
                    <div className="mb-4 flex flex-wrap gap-2">
                      <span className="state-badge state-badge--ready rounded-full px-2.5 py-1 text-xs font-medium">
                        <GameIcon name="success" className="size-3.5" />
                        {tr("cityReady")}
                      </span>
                      {session.season.premium ? (
                        <span className="state-badge state-badge--season rounded-full px-2.5 py-1 text-xs font-medium">
                          <GameIcon name="season" className="size-3.5" />
                          {tr("season")} · {session.season.score}
                        </span>
                      ) : null}
                      {session.regatta ? (
                        <span className="state-badge state-badge--regatta rounded-full px-2.5 py-1 text-xs font-medium">
                          <GameIcon name="regatta" className="size-3.5" />
                          {tr("regatta")} {session.regatta.tasks}×{session.regatta.score}
                        </span>
                      ) : null}
                    </div>
                    <div className="stagger-in grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {fields.filter((f) => !new Set([
                        "key", "match3Life", "spentCash", "earnedCash", "EarnedCoins",
                        "wheatCounter", "plowFieldsAchiev", "defaultOrdersCount", "mineCounter", "timeInGame",
                        // The barn tab owns this XOR pair — editing either
                        // value alone desyncs capacity and the game resets it.
                        "WareHouseCashUpgrade", "WHUdup", "Match3Lives_infTime",
                        "xpr", "xpl", "zxl",
                      ]).has(f.key ?? f.id)).map((f, i) => (
                        <label key={f.id} className="stat-card panel" data-tone={String((i % 7) + 1)}>
                          <span className="stat-title">
                            {iconForStat(f.key ?? f.id) ? (
                              <span className="stat-asset" aria-hidden="true">
                                <img src={iconForStat(f.key ?? f.id)!} alt="" className="stat-asset-img" draggable={false} />
                              </span>
                            ) : (
                              <span className="stat-emoji" aria-hidden="true">{statEmoji(f.key ?? f.id)}</span>
                            )}
                            {statLabel(lang, f.key ?? f.id, lang === "vi" ? f.labelVi : f.labelEn)}
                          </span>
                          <input
                            className="field field-stat mt-2"
                            value={stats[f.id] ?? ""}
                            onChange={(e) => setStats((p) => ({ ...p, [f.id]: e.target.value }))}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {tab === "profile" && catalogs && (
                  <div className="space-y-3">
                    <Bar
                      hint={tr("profileHint")}
                      onAll={() => {
                        profileSel.allOn(catalogs.profile);
                        setProfileOpen(catalogs.profile[0]?.id ?? null);
                      }}
                      onClear={profileSel.clear}
                      allLabel={tr("selectAll")}
                      clearLabel={tr("clear")}
                    />
                    {catalogs.profile.filter((g) => g.id !== "Themes").map((g, i) => (
                      <GroupCard
                        lang={lang}
                        key={g.id}
                        group={g}
                        selected={profileSel.map[g.id] ?? new Set()}
                        onToggle={(id) => profileSel.toggle(g.id, id)}
                        onGroup={(on) => profileSel.setGroup(g.id, g.items.map((it) => it.id), on)}
                        collapsed={false}
                        onCollapse={() => setProfileOpen(profileOpen === g.id ? null : g.id)}
                        allLabel={tr("allShort")}
                        noneLabel={tr("noneShort")}
                        toneClass={groupTone(g.id, i)}
                      />
                    ))}
                  </div>
                )}

                {tab === "avatars" && catalogs && (
                  <div className="space-y-3">
                    <Bar
                      hint={tr("avatarsHint")}
                      onAll={() => {
                        avatarSel.allOn(catalogs.avatars);
                        setAvatarOpen(catalogs.avatars[0]?.id ?? null);
                      }}
                      onClear={avatarSel.clear}
                      allLabel={tr("selectAll")}
                      clearLabel={tr("clear")}
                    />
                    <div className="panel">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-2 text-xs text-muted">
                          {tr("avaFrom")}
                          <input
                            className="field field-qty"
                            inputMode="numeric"
                            value={avaFrom}
                            onChange={(e) => setAvaFrom(Math.max(1, Math.min(AVATAR_MAX, Number(e.target.value) || 1)))}
                          />
                        </label>
                        <label className="flex items-center gap-2 text-xs text-muted">
                          {tr("avaTo")}
                          <input
                            className="field field-qty"
                            inputMode="numeric"
                            value={avaTo}
                            onChange={(e) => setAvaTo(Math.max(1, Math.min(AVATAR_MAX, Number(e.target.value) || 1)))}
                          />
                        </label>
                        <Button size="sm" variant="ghost" onClick={() => applyAvaRange(true)}>
                          {tr("avaRange")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => applyAvaRange(false)}>
                          {tr("avaClearRange")}
                        </Button>
                      </div>
                      <div className="range-dual">
                        <input
                          type="range"
                          min={1}
                          max={AVATAR_MAX}
                          value={Math.min(avaFrom, avaTo)}
                          onChange={(e) => setAvaFrom(Number(e.target.value))}
                          onPointerUp={() => applyAvaRange(true)}
                        />
                        <input
                          type="range"
                          min={1}
                          max={AVATAR_MAX}
                          value={Math.max(avaFrom, avaTo)}
                          onChange={(e) => setAvaTo(Number(e.target.value))}
                          onPointerUp={() => applyAvaRange(true)}
                        />
                      </div>
                    </div>
                    {catalogs.avatars.map((g, i) => (
                      <GroupCard
                        lang={lang}
                        key={g.id}
                        group={g}
                        selected={avatarSel.map[g.id] ?? new Set()}
                        onToggle={(id) => avatarSel.toggle(g.id, id)}
                        onGroup={(on) => avatarSel.setGroup(g.id, g.items.map((it) => it.id), on)}
                        collapsed={false}
                        onCollapse={() => setAvatarOpen(avatarOpen === g.id ? null : g.id)}
                        allLabel={tr("allShort")}
                        noneLabel={tr("noneShort")}
                        toneClass={groupTone(g.id, i)}
                      />
                    ))}
                  </div>
                )}

                {tab === "skins" && catalogs && (
                  <div className="space-y-3">
                    <Bar
                      hint={tr("skinsHint")}
                      onAll={() => {
                        skinSel.allOn(catalogs.skins);
                        setSkinOpen(catalogs.skins[0]?.id ?? null);
                      }}
                      onClear={skinSel.clear}
                      allLabel={tr("selectAll")}
                      clearLabel={tr("clear")}
                    />
                    {catalogs.skins.map((g, i) => (
                      <GroupCard
                        lang={lang}
                        key={g.id}
                        group={g}
                        selected={skinSel.map[g.id] ?? new Set()}
                        onToggle={(id) => skinSel.toggle(g.id, id)}
                        onGroup={(on) => skinSel.setGroup(g.id, g.items.map((it) => it.id), on)}
                        collapsed={false}
                        onCollapse={() => setSkinOpen(skinOpen === g.id ? null : g.id)}
                        allLabel={tr("allShort")}
                        noneLabel={tr("noneShort")}
                        toneClass={groupTone(g.id, i)}
                      />
                    ))}
                  </div>
                )}

                {tab === "sticker" && catalogs && (
                  <div className="space-y-3">
                    <Bar
                      hint={tr("stickerHint")}
                      onAll={() => setStickerSel(new Set(catalogs.emoji.map((e) => e.id)))}
                      onClear={() => setStickerSel(new Set())}
                      allLabel={tr("selectAll")}
                      clearLabel={tr("clear")}
                    />
                    <section className="panel">
                      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
                        {catalogs.emoji.map((e) => (
                          <Chip
                            key={e.id}
                            label={e.label}
                            iconSrc={iconForSticker(e.id)}
                            emoji={itemEmoji(undefined, e.label, "sticker")}
                            checked={stickerSel.has(e.id)}
                            onChange={() => setStickerSel((prev) => {
                              const next = new Set(prev);
                              if (next.has(e.id)) next.delete(e.id); else next.add(e.id);
                              return next;
                            })}
                          />
                        ))}
                      </div>
                      <p className="mt-3 text-xs text-muted">{tr("stickerSelectedHint").replace("{count}", String(stickerSel.size))}</p>
                    </section>
                  </div>
                )}

                {tab === "museum" && (
                  <div className="space-y-3">
                    <p className="rounded-md bg-input px-3 py-2 text-sm text-amber">{tr("museumNote")}</p>
                    <Bar
                      hint={tr("museumHint")}
                      onAll={() => setMuseumSel(new Set(MUSEUM_IDS))}
                      onClear={() => setMuseumSel(new Set())}
                      allLabel={tr("selectAll")}
                      clearLabel={tr("clear")}
                    />
                    <section className="panel">
                      <p className="mb-3 text-xs text-muted">
                        {tr("museumSelected")}: {museumSel.size} / {MUSEUM_IDS.length}
                      </p>
                      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
                        {MUSEUM_IDS.map((id) => (
                          <Chip
                            key={id}
                            label={museumLabel(id)}
                            iconSrc={artifactIconPath(id)}
                            emoji={artifactEmoji(id)}
                            checked={museumSel.has(id)}
                            onChange={() => setMuseumSel((prev) => {
                              const next = new Set(prev);
                              if (next.has(id)) next.delete(id); else next.add(id);
                              return next;
                            })}
                          />
                        ))}
                      </div>
                    </section>
                  </div>
                )}

                {tab === "zoo" && (
                  <div className="space-y-3">
                    <p className="rounded-md bg-input px-3 py-2 text-sm text-amber">{tr("zooNote")}</p>
                    <Bar
                      hint={tr("zooHint")}
                      onAll={() => zooSel.allOn(zooGroups)}
                      onClear={zooSel.clear}
                      allLabel={tr("selectAll")}
                      clearLabel={tr("clear")}
                    />
                    {!session?.zoo.length ? (
                      <p className="text-xs text-amber">{tr("zooNone")}</p>
                    ) : (
                      zooGroups.map((g, i) => (
                        <GroupCard
                          lang={lang}
                          key={g.id}
                          group={g}
                          selected={zooSel.map[g.id] ?? new Set()}
                          onToggle={(id) => zooSel.toggle(g.id, id)}
                          onGroup={(on) => zooSel.setGroup(g.id, g.items.map((it) => it.id), on)}
                          allLabel={tr("allShort")}
                          noneLabel={tr("noneShort")}
                          toneClass={groupTone(g.id, i)}
                          iconFor={(gid) => iconForZoo(gid)}
                        />
                      ))
                    )}
                  </div>
                )}

                {tab === "upgrades" && catalogs && session && (
                  <div className="space-y-3">
                    <p className="rounded-md bg-input px-3 py-2 text-sm text-amber">{tr("upgradesHint")}</p>
                    {!session.factoryMax && !session.trainMax && !session.islandMax ? (
                      <p className="rounded-md bg-input px-3 py-2 text-sm text-amber">{tr("upgradesEmpty")}</p>
                    ) : null}
                    <div className="space-y-4">
                      {/* Factories Section */}
                      <section className="panel">
                        <header className="mb-3 flex items-center gap-2">
                          <GameIcon name="control" className="size-5 text-teal" />
                          <h3 className="text-xs font-bold tracking-wider uppercase text-teal">
                            {tr("upgradesFactoryTitle")} {session.factoryMax ? `(${tr("upgradesMax")} ${session.factoryMax})` : ""}
                          </h3>
                          <div className="ml-auto flex items-center gap-2">
                            <Button size="sm" variant="ghost" onClick={() => upgradeFactorySel.allOn(catalogs.factories)}>
                              {tr("selectAll")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => upgradeFactorySel.clear()}>
                              {tr("clear")}
                            </Button>
                            <label className="flex items-center gap-1 text-xs text-muted">
                              {tr("targetLevel")}
                              <select
                                className="field field-sm"
                                value={upgradeTargetLevel}
                                onChange={(e) => setUpgradeTargetLevel(Number(e.target.value))}
                              >
                                {Array.from({ length: session.factoryMax ?? session.upgradeCaps.factory }, (_, i) => i + 1).map(n => (
                                  <option key={n} value={n}>{n}</option>
                                ))}
                              </select>
                            </label>
                            <Button size="sm" variant="primary" onClick={() => setPendingUpgradeFactory(true)}>
                              {upgradeFactorySel.count === catalogs.factories.flatMap(g => g.items).length ? tr("unlockMaxAllFactories") : tr("applySelected")}
                            </Button>
                          </div>
                        </header>
                        {catalogs.factories.map((g, i) => (
                          <GroupCard
                            key={g.id}
                            lang={lang}
                            group={g}
                            selected={upgradeFactorySel.map[g.id] ?? new Set()}
                            onToggle={(id) => upgradeFactorySel.toggle(g.id, id)}
                            onGroup={(on) => upgradeFactorySel.setGroup(g.id, g.items.map(it => it.id), on)}
                            allLabel={tr("allShort")}
                            noneLabel={tr("noneShort")}
                            toneClass={groupTone(g.id, i)}
                            iconFor={(_, label) => iconForUpgradeLabel(label)}
                          />
                        ))}
                      </section>

                      {/* Trains Section */}
                      <section className="panel">
                        <header className="mb-3 flex items-center gap-2">
                          <GameIcon name="control" className="size-5 text-pink" />
                          <h3 className="text-xs font-bold tracking-wider uppercase text-pink">
                            {tr("upgradesTrainTitle")} {session.trainMax ? `(${tr("upgradesMax")} ${session.trainMax})` : ""}
                          </h3>
                          <div className="ml-auto flex items-center gap-2">
                            <Button size="sm" variant="ghost" onClick={() => upgradeTrainSel.allOn(catalogs.trains)}>
                              {tr("selectAll")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => upgradeTrainSel.clear()}>
                              {tr("clear")}
                            </Button>
                            <label className="flex items-center gap-1 text-xs text-muted">
                              {tr("targetLevel")}
                              <select
                                className="field field-sm"
                                value={upgradeTargetLevel}
                                onChange={(e) => setUpgradeTargetLevel(Number(e.target.value))}
                              >
                                {Array.from({ length: session.trainMax ?? session.upgradeCaps.train }, (_, i) => i + 1).map(n => (
                                  <option key={n} value={n}>{n}</option>
                                ))}
                              </select>
                            </label>
                            <Button size="sm" variant="primary" onClick={() => setPendingUpgradeTrain(true)}>
                              {tr("applySelected")}
                            </Button>
                          </div>
                        </header>
                        {catalogs.trains.map((g, i) => (
                          <GroupCard
                            key={g.id}
                            lang={lang}
                            group={g}
                            selected={upgradeTrainSel.map[g.id] ?? new Set()}
                            onToggle={(id) => upgradeTrainSel.toggle(g.id, id)}
                            onGroup={(on) => upgradeTrainSel.setGroup(g.id, g.items.map(it => it.id), on)}
                            allLabel={tr("allShort")}
                            noneLabel={tr("noneShort")}
                            toneClass={groupTone(g.id, i)}
                            iconFor={(_, label) => iconForUpgradeLabel(label)}
                          />
                        ))}
                      </section>

                      {/* Islands Section */}
                      <section className="panel">
                        <header className="mb-3 flex items-center gap-2">
                          <GameIcon name="control" className="size-5 text-cyan" />
                          <h3 className="text-xs font-bold tracking-wider uppercase text-cyan">
                            {tr("upgradesIslandTitle")} {session.islandMax ? `(${tr("upgradesMax")} ${session.islandMax})` : ""}
                          </h3>
                          <div className="ml-auto flex items-center gap-2">
                            <Button size="sm" variant="ghost" onClick={() => upgradeIslandSel.allOn(catalogs.islands)}>
                              {tr("selectAll")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => upgradeIslandSel.clear()}>
                              {tr("clear")}
                            </Button>
                            <label className="flex items-center gap-1 text-xs text-muted">
                              {tr("targetLevel")}
                              <select
                                className="field field-sm"
                                value={upgradeTargetLevel}
                                onChange={(e) => setUpgradeTargetLevel(Number(e.target.value))}
                              >
                                {Array.from({ length: session.islandMax ?? session.upgradeCaps.island }, (_, i) => i + 1).map(n => (
                                  <option key={n} value={n}>{n}</option>
                                ))}
                              </select>
                            </label>
                            <Button size="sm" variant="primary" onClick={() => setPendingUpgradeIsland(true)}>
                              {tr("applySelected")}
                            </Button>
                          </div>
                        </header>
                        {catalogs.islands.map((g, i) => (
                          <GroupCard
                            key={g.id}
                            lang={lang}
                            group={g}
                            selected={upgradeIslandSel.map[g.id] ?? new Set()}
                            onToggle={(id) => upgradeIslandSel.toggle(g.id, id)}
                            onGroup={(on) => upgradeIslandSel.setGroup(g.id, g.items.map(it => it.id), on)}
                            allLabel={tr("allShort")}
                            noneLabel={tr("noneShort")}
                            toneClass={groupTone(g.id, i)}
                            iconFor={(_, label) => iconForUpgradeLabel(label)}
                          />
                        ))}
                      </section>
                    </div>
                  </div>
                )}

                {tab === "events" && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted">{tr("eventsHint")}</p>

                    <section className="panel">
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
                        <GameIcon name="events" className="size-4" />
                        {tr("eventsCard")}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        <span
                          className={cn(
                            "state-badge rounded-full px-2.5 py-1 text-xs font-medium",
                            session.bloom.reason === "ok" ? "state-badge--ready" : "bg-input text-muted",
                          )}
                        >
                          <GameIcon
                            name={session.bloom.reason === "ok" ? "success" : "events"}
                            className="size-3.5"
                          />
                          {tr(BLOOM_REASON_KEY[session.bloom.reason])}
                        </span>
                        <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs font-medium text-muted tabular-nums">
                          {tr("eventsTokens")} {session.bloom.amount} →{" "}
                          {session.bloom.amount + (pendingBloom ? bloomTokens : 0)}
                        </span>
                        <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs font-medium text-muted tabular-nums">
                          {tr("eventsEarned")} {session.bloom.earned + (pendingBloom ? bloomTokens : 0)}
                        </span>
                      </div>
                    </section>

                    <section className="panel">
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
                        <GameIcon name="events" className="size-4" />
                        {tr("eventsCardFrozen")}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        <span
                          className={cn(
                            "state-badge rounded-full px-2.5 py-1 text-xs font-medium",
                            session.frozen.reason === "ok" ? "state-badge--ready" : "bg-input text-muted",
                          )}
                        >
                          <GameIcon
                            name={session.frozen.reason === "ok" ? "success" : "events"}
                            className="size-3.5"
                          />
                          {tr(BLOOM_REASON_KEY[session.frozen.reason])}
                        </span>
                        <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs font-medium text-muted tabular-nums">
                          {tr("eventsTokens")} {session.frozen.amount} →{" "}
                          {session.frozen.amount + (pendingFrozen ? bloomTokens : 0)}
                        </span>
                        <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs font-medium text-muted tabular-nums">
                          {tr("eventsEarned")} {session.frozen.earned + (pendingFrozen ? bloomTokens : 0)}
                        </span>
                      </div>
                      <p className="mt-3 text-xs text-muted">{tr("frozenHint")}</p>
                    </section>

                    <section className="panel">
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-amber uppercase">
                        <GameIcon name="events" className="size-4" />
                        {tr("eventsCount")}
                      </h3>
                      <div className="flex flex-wrap items-center gap-3">
                        <input
                          className="field field-qty"
                          inputMode="numeric"
                          aria-label={tr("eventsCount")}
                          value={bloomTokens}
                          onChange={(e) => {
                            const raw = Number(e.target.value.replace(/[^\d]/g, ""));
                            setBloomTokens(raw > 0 ? Math.min(BLOOM_TOKENS_MAX, raw) : BLOOM_TOKENS_DEFAULT);
                          }}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          className="tool-action"
                          variant="purple"
                          disabled={busy || pendingBloom}
                          onClick={() => tool("bloom")}
                        >
                          <GameIcon name="events" className="size-4" />
                          {pendingBloom ? tr("bloomQueued") : tr("bloomAdd")}
                        </Button>
                        {pendingBloom ? (
                          <Button size="sm" variant="ghost" onClick={() => setPendingBloom(false)}>
                            {tr("clear")}
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          className="tool-action"
                          variant="purple"
                          disabled={busy || pendingFrozen}
                          onClick={() => tool("frozen")}
                        >
                          <GameIcon name="events" className="size-4" />
                          {pendingFrozen ? tr("frozenQueued") : tr("frozenAdd")}
                        </Button>
                        {pendingFrozen ? (
                          <Button size="sm" variant="ghost" onClick={() => setPendingFrozen(false)}>
                            {tr("clear")}
                          </Button>
                        ) : null}
                      </div>
                    </section>
                  </div>
                )}

                {tab === "newgame" && (
                  <div className="space-y-3">
                    <p className="rounded-md bg-input px-3 py-2 text-xs text-muted">⚠️ {tr("freshCloudWarn")}</p>
                    <section className="panel">
                      <h3 className="mb-3 text-xs font-bold tracking-wider uppercase text-cyan">🏙️ {tr("freshInject")}</h3>
                      <div className="flex flex-wrap items-center gap-2">
                        {!freshBackup && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={onFreshBackup}>
                            {tr("freshBackupBtn")}
                          </Button>
                        )}
                        <Button size="sm" variant="primary" disabled={!freshBackup || busy} onClick={onFreshInject}>
                          {tr("freshInjectBtn")}
                        </Button>
                        <Button size="sm" variant="secondary" disabled={!freshBackup || busy} onClick={onFreshIdentity}>
                          {tr("freshIdentityBtn")}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={onFreshLaunch}>
                          🎮 {tr("freshOpenGame")}
                        </Button>
                        {freshBackup && (
                          <span className="text-xs text-muted">
                            ✅ {tr("freshBackedUp")}: {freshBackup.oldCityId.slice(0, 12)}… · Lv{freshBackup.oldLevel} · {freshBackup.extraCount} {tr("freshExtra")}{freshBackup.skippedCount > 0 ? ` · ⏭️${freshBackup.skippedCount}` : ""}
                          </span>
                        )}
                      </div>
                      {!freshBackup && (
                        <p className="mt-2 text-xs text-muted">{tr("freshInjectNeedBackup")}</p>
                      )}
                      <p className="mt-2 text-xs text-muted">🆔 {tr("freshIdentityHint")}</p>
                      {freshIdentityNote && (
                        <p className="mt-2 break-all text-xs text-muted">{freshIdentityNote}</p>
                      )}
                      {freshInjectNote && (
                        <p className="mt-2 break-all text-xs text-muted">{freshInjectNote}</p>
                      )}
                    </section>
                    <section className="panel">
                      <h3 className="mb-1 text-xs font-bold tracking-wider uppercase text-primary">{tr("freshStep3")}</h3>
                      <p className="mb-3 text-xs text-muted">{tr("freshStep3d")}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="primary" disabled={busy} onClick={onFreshVerify}>
                          {tr("freshVerifyBtn")}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={!freshBackup} onClick={onFreshRestore}>
                          {tr("freshRestoreBtn")}
                        </Button>
                      </div>
                      {freshCheck && (
                        <p className="mt-2 text-xs text-muted">
                          ✅ {tr("freshVerified")}: {freshCheck.newCityId.slice(0, 12)}…{freshCheck.androidReset ? " · 🆔✓" : ""}{freshCheck.gsfReset ? " · GSF✓" : ""}
                        </p>
                      )}
                    </section>
                    <p className="rounded-md bg-input px-3 py-2 text-xs text-muted">ℹ️ {tr("freshLimits")}</p>
                  </div>
                )}

                {tab === "items" && catalogs && (
                  <PanelChecks
                    lang={lang}
                    hint={tr("itemsHint")}
                    groups={catalogs.items}
                    sel={itemSel}
                    onAll={() => {
                      itemSel.allOn(catalogs.items);
                      setItemsOpen(catalogs.items[0]?.id ?? null);
                    }}
                    onClear={itemSel.clear}
                    allLabel={tr("selectAll")}
                    clearLabel={tr("clear")}
                    allShort={tr("allShort")}
                    noneShort={tr("noneShort")}
                    openId={itemsOpen}
                    onOpen={setItemsOpen}
                    extra={
                      <label className="flex items-center gap-2 text-xs text-muted">
                        {tr("itemsBulk")}
                        <input
                          className="field field-qty"
                          inputMode="numeric"
                          aria-label={tr("itemsBulk")}
                          value={bulkQty}
                          onChange={(e) => setBulkQty(e.target.value.replace(/[^\d]/g, ""))}
                        />
                      </label>
                    }
                  />
                )}

                {tab === "regatta" && (
                  <div className="space-y-3">
                    <section className="panel">
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-cyan uppercase">
                        <GameIcon name="regatta" className="size-4" />
                        {tr("regattaState")}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        <span
                          className={cn(
                            "state-badge rounded-full px-2.5 py-1 text-xs font-medium",
                            regattaState === "ok" ? "state-badge--ready" : "bg-input text-muted",
                          )}
                        >
                          <GameIcon
                            name={regattaState === "ok" ? "success" : "regatta"}
                            className="size-3.5"
                          />
                          {tr(REGATTA_REASON_KEY[regattaState])}
                        </span>
                        <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs font-medium text-muted tabular-nums">
                          {tr("regattaDone")} {session.regattaInfo.current} →{" "}
                          {session.regattaInfo.current + regattaTasks}
                        </span>
                        <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs font-medium text-muted tabular-nums">
                          {tr("regattaTemplates")} {session.regattaInfo.templates}
                        </span>
                        <span className="state-badge rounded-full bg-input px-2.5 py-1 text-xs font-medium text-muted tabular-nums">
                          {tr("regattaPool")} {session.regattaInfo.pool}
                        </span>
                      </div>
                    </section>

                    <section className="panel">
                      <h3 className="mb-3 flex items-center gap-2 text-xs font-bold tracking-wider text-amber uppercase">
                        <GameIcon name="regatta" className="size-4" />
                        {tr("regattaCount")}
                      </h3>
                      <div className="flex flex-wrap items-center gap-3">
                        <input
                          className="field field-qty"
                          inputMode="numeric"
                          aria-label={tr("regattaCount")}
                          value={regattaTasks}
                          onChange={(e) => {
                            const raw = Number(e.target.value.replace(/[^\d]/g, ""));
                            setRegattaTasks(raw > 0 ? Math.min(REGATTA_MAX_TASKS, raw) : REGATTA_DEFAULT_TASKS);
                          }}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          className="tool-action tool-action--regatta"
                          variant="purple"
                          disabled={busy || pendingRegatta}
                          onClick={() => void tool("regatta")}
                        >
                          <GameIcon name="regatta" className="size-4" />
                          {pendingRegatta ? tr("regattaQueued") : tr("regattaAdd")}
                        </Button>
                        {pendingRegatta ? (
                          <Button size="sm" variant="ghost" onClick={() => setPendingRegatta(false)}>
                            {tr("clear")}
                          </Button>
                        ) : null}
                      </div>
                    </section>
                  </div>
                )}

                {tab === "barn" && catalogs && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted">{tr("barnHint")}</p>
                    <section className="panel">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <h3 className="flex items-center gap-2 text-xs font-bold tracking-wider text-amber uppercase">
                          <GameIcon name="barn" className="size-4" />
                          {tr("barnCapacity")}
                        </h3>
                        <span className="text-xs text-muted">
                          {tr("barnCurrent")}: {session.barn.upgrades ?? "—"} {tr("barnUpgrades")}
                          {session.barn.capacity ? ` · ${session.barn.capacity}` : ""}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto"
                          disabled={busy}
                          onClick={async () => {
                            if (!token || !session) return;
                            setBusy(true);
                            try {
                              const r = await refreshBarn({ data: { token, sessionId: session.sessionId } });
                              applySnap(r);
                              toast.success(tr("saved"));
                            } catch (e) {
                              toast.error(e instanceof Error ? e.message : tr("nothing"));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <GameIcon name="refresh" className="size-3.5" />
                          {tr("refresh")}
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {catalogs.barnCapacity.map((p) => (
                          <button
                            key={p.upgrades}
                            type="button"
                            className="barn-cap flex min-h-14 flex-col items-center justify-center rounded-md bg-input text-sm font-semibold"
                            data-on={barnUpgrades === p.upgrades ? "true" : "false"}
                            onClick={() => setBarnUpgrades(p.upgrades)}
                          >
                            <span>{p.upgrades}</span>
                            <span className="text-xs font-medium opacity-80">{tr("barnUpgrades")}</span>
                          </button>
                        ))}
                      </div>
                      {barnUpgrades ? (
                        <p className="mt-3 text-xs text-amber">
                          {tr("barnSelectedCap")}: {barnUpgrades} {tr("barnUpgrades")}
                          {catalogs.barnCapacity.find((c) => c.upgrades === barnUpgrades)
                            ? ` · ${catalogs.barnCapacity.find((c) => c.upgrades === barnUpgrades)?.capacity}`
                            : ""}
                        </p>
                      ) : null}
                    </section>
                    <section className="panel">
                      <p className="mb-3 rounded-md bg-input px-3 py-2 text-sm text-amber">{tr("barnStockNote")}</p>
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <h3 className="text-xs font-bold tracking-wider text-amber uppercase">{tr("barnItemsTitle")}</h3>
                        <span className="text-xs text-muted">
                          {tr("barnItemsCount")}: {barnKinds} · {tr("barnItemsTotal")}: {barnTotal}
                        </span>
                        {barnOverCap ? (
                          <span className="text-xs font-semibold text-amber">
                            {tr("barnOverCapacity")}: {barnTotal} / {barnEffectiveCap}
                          </span>
                        ) : null}
                        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
                          {tr("barnFill")}
                          <input
                            className="field field-qty"
                            inputMode="numeric"
                            value={barnFill}
                            onChange={(e) => setBarnFill(e.target.value.replace(/[^\d]/g, ""))}
                          />
                        </label>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const n = Math.max(0, Number.parseInt(barnFill, 10) || 0);
                            const next: Record<string, number> = {};
                            // Fill only counters the save already holds: the
                            // server keeps those and purges everything else
                            // on load, so filling unknown goods only litters.
                            const unlocked = Object.keys(session?.barn.items ?? {});
                            const ids = unlocked.length ? unlocked : catalogs.barnProducts.map((p) => p.id);
                            for (const id of ids) next[id] = n;
                            setBarnItems(next);
                            // Auto-pick the smallest tier that fits the fill so
                            // the game has no reason to trim anything on load.
                            const total = n * ids.length;
                            const fit = catalogs.barnCapacity.find((c) => c.capacity >= total)
                              ?? catalogs.barnCapacity[catalogs.barnCapacity.length - 1];
                            if (fit && total > 0) setBarnUpgrades(fit.upgrades);
                          }}
                        >
                          {tr("barnFill")}
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {catalogs.barnProducts.map((p) => {
                          // No counter in the save only means zero stock, not
                          // locked — carrot grows in the fields with no
                          // counter until stocked. Everything stays grantable;
                          // the game shows each good once its level unlocks.
                          // (Proven locked goods come back as exact 0 and are
                          // skipped by the game itself, harming nothing.)
                          return (
                          <label key={p.id} className="premium-chip flex min-h-11 items-center justify-between gap-3 rounded-lg border border-transparent bg-input px-3 hover:border-primary/25">
                            <span className="flex min-w-0 items-center gap-2.5">
                              {iconForBarn(p.id) ? (
                                <span className="chip-asset" aria-hidden="true">
                                  <img src={iconForBarn(p.id)!} alt="" className="chip-asset-img" draggable={false} />
                                </span>
                              ) : (
                                <span className="chip-asset chip-emoji" aria-hidden="true">
                                  <span className="chip-emoji-glyph">{itemEmoji(undefined, p.label, "barn")}</span>
                                </span>
                              )}
                              <span className="chip-label truncate">{p.label}</span>
                            </span>
                            <input
                              className="field field-qty"
                              inputMode="numeric"
                              value={barnItems[p.id] ?? 0}
                              onChange={(e) => {
                                const n = Number.parseInt(e.target.value.replace(/[^\d]/g, ""), 10);
                                setBarnItems((prev) => ({ ...prev, [p.id]: Number.isFinite(n) ? n : 0 }));
                              }}
                            />
                          </label>
                          );
                        })}
                      </div>
                    </section>
                  </div>
                )}

                {tab === "decor" && catalogs && (
                  <div>
                    <p className="mb-3 text-sm text-muted">{tr("decorHint")}</p>
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-2 text-xs text-muted">
                        {tr("quantity")}
                        <input
                          className="field field-qty"
                          inputMode="numeric"
                          min={1}
                          value={decorQty}
                          onChange={(e) => setDecorQty(e.target.value.replace(/[^\d]/g, ""))}
                        />
                      </label>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy || !catalogs?.decor.length}
                        onClick={() => {
                          setDecorSel(new Set(catalogs?.decor.map((d: Item) => d.id) ?? []));
                          setPendingDecorMaxAll(true);
                          toast.success(tr("toastDecorAll"));
                        }}
                      >
                        {tr("decorUnlockAll")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || !decorSel.size}
                        onClick={() => { setDecorSel(new Set()); setPendingDecorMaxAll(false); }}
                      >
                        Bỏ chọn
                      </Button>
                    </div>
                    {decorSel.size ? (
                      <p className="mb-3 text-xs text-muted">{decorSel.size} {tr("decorSelected")} · {tr("quantity").toLowerCase()} {parseDecorQty()} · {tr("decorApplyHint")}.</p>
                    ) : null}
                    <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_260px]">
                      <div className="field-shell">
                        <GameIcon name="search" className="field-leading-icon" />
                        <input
                          className="field search-field"
                          placeholder={tr("search")}
                          value={search}
                          onChange={(e) => {
                            setSearch(e.target.value);
                            setDecorLimit(36);
                          }}
                          aria-label={tr("search")}
                        />
                      </div>
                      <select
                        className="field font-semibold"
                        value={decorTheme}
                        onChange={(e) => {
                          setDecorTheme(e.target.value as DecorTheme);
                          setDecorLimit(36);
                        }}
                        aria-label={tr("decorTheme")}
                      >
                        {DECOR_THEMES.map((theme) => (
                          <option key={theme} value={theme}>
                            {decorThemeLabel(lang, theme)} ({decorThemeCounts.get(theme) ?? 0})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="mb-3 text-xs text-muted">
                      {filteredDecor.length} {tr("decorLabel")}
                    </div>
                    <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
                      {filteredDecor.slice(0, decorLimit).map((d: Item) => (
                        <Chip
                          key={d.id}
                          label={d.label}
                          iconSrc={iconForDecorLabel(d.label)}
                          emoji={itemEmoji(undefined, d.label, "decor")}
                          checked={decorSel.has(d.id)}
                          onChange={() => {
                            setPendingDecorMaxAll(false);
                            setDecorSel((prev) => {
                              const n = new Set(prev);
                              if (n.has(d.id)) n.delete(d.id);
                              else n.add(d.id);
                              return n;
                            });
                          }}
                        />
                      ))}
                    </div>
                    {filteredDecor.length > decorLimit ? (
                      <Button className="mt-3" variant="ghost" onClick={() => setDecorLimit((n) => n + 36)}>
                        {tr("showMore")}
                      </Button>
                    ) : null}
                  </div>
                )}

                {tab === "unban" && (
                  <Unban
                    tr={tr}
                    session={session}
                    cityManual={cityManual}
                    setCityManual={setCityManual}
                    friendSel={friendSel}
                    setFriendSel={setFriendSel}
                    busy={busy}
                    copyStage={copyStage}
                    onRefresh={async () => {
                      if (!token || !session || !device) return;
                      setBusy(true);
                      try {
                        const native = nativeBridge();
                        if (!native) throw new Error("Chưa có ADB emulator");
                        await refreshLocalInfoCached(true);
                        toast.success(tr("refreshFriends"));
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : tr("actionFailed"));
                      } finally {
                        setBusy(false);
                      }
                    }}
                    onFetch={async () => {
                      if (!token || !session || !device) return;
                      const cityId = cityManual || friendSel || "";
                      setBusy(true);
                      try {
                        // LocalInfo only refines the version metadata; the save itself already
                        // carries <Version>. A stale or unreadable mLocalInfo (an unrooted
                        // emulator, say) must not block FetchCity — best-effort, silent when
                        // the file simply doesn't exist.
                        try {
                          await refreshLocalInfoCached(false);
                        } catch {
                          /* silent — fallback versions will be used */
                        }
                        applySnap(await fetchCity({ data: { token, sessionId: session.sessionId, cityId } }), catalogs?.profile);
                        // A new donor means a fresh wizard: the stages belong
                        // to the city that was just fetched, not to the last one.
                        setCopyStage(0);
                        toast.success(tr("fetchCity"));
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : tr("actionFailed"));
                      } finally {
                        setBusy(false);
                      }
                    }}
                    onCopy={(kind) => {
                      if (kind === "decor") {
                        setPendingTownClone(true);
                        setPendingDecorClone(true);
                        toast.success(tr("copyDecorQueued"));
                        return;
                      }
                      // Staged like the reference tool: stats first, the town
                      // second, the advanced blocks last — one push each, with
                      // the game opened and the save re-pulled in between.
                      const mode: UnbanMode =
                        kind === "stage1" ? "inicial" : kind === "stage2" ? "completo" : "novo";
                      setPendingUnban(mode);
                      toast.success(
                        tr("copyStageQueued").replace("{n}", String(mode === "inicial" ? 1 : mode === "completo" ? 2 : 3)),
                      );
                    }}
                    onRestore={(mode) => {
                      setPendingUnban(mode);
                      toast.success(`${tr("unbanQueued")} · ${mode}`);
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      </>
      ) : null}

      {sheet === "feedback" && token && license ? (
        <SheetFrame onClose={() => setSheet("none")}>
          <FeedbackForm
            tr={tr}
            token={token}
            remainingLabel={formatRemain(remainingMs, license.lifetime, lang)}
            onDone={() => setSheet("none")}
          />
        </SheetFrame>
      ) : null}
      {view === "control" && token && license?.admin ? (
        <OwnerHub tr={tr} lang={lang} token={token} embedded onClose={() => setView("client")} />
      ) : null}
    </div>
  );
}

function Bar({
  hint,
  onAll,
  onClear,
  allLabel,
  clearLabel,
  extra,
}: {
  hint: string;
  onAll: () => void;
  onClear: () => void;
  allLabel: string;
  clearLabel: string;
  extra?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <p className="mr-auto text-sm text-muted">{hint}</p>
      {extra}
      <Button size="sm" variant="ghost" onClick={onAll}>
        {allLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear}>
        {clearLabel}
      </Button>
    </div>
  );
}

function PanelChecks({
  lang,
  hint,
  groups,
  sel,
  onAll,
  onClear,
  allLabel,
  clearLabel,
  allShort,
  noneShort,
  extra,
  openId,
  onOpen,
}: {
  lang: Lang;
  hint: string;
  groups: Group[];
  sel: ReturnType<typeof useSetMap>;
  onAll: () => void;
  onClear: () => void;
  allLabel: string;
  clearLabel: string;
  allShort: string;
  noneShort: string;
  extra?: ReactNode;
  openId?: string | null;
  onOpen?: (id: string | null) => void;
}) {
  return (
    <div className="space-y-3">
      <Bar hint={hint} onAll={onAll} onClear={onClear} allLabel={allLabel} clearLabel={clearLabel} extra={extra} />
      <div className="stagger-in space-y-3">
        {groups.map((g, i) => (
          <GroupCard
            lang={lang}
            key={g.id}
            group={g}
            selected={sel.map[g.id] ?? new Set()}
            onToggle={(id) => sel.toggle(g.id, id)}
            onGroup={(on) => sel.setGroup(g.id, g.items.map((it) => it.id), on)}
            collapsed={false}
            onCollapse={onOpen ? () => onOpen(openId === g.id ? null : g.id) : undefined}
            allLabel={allShort}
            noneLabel={noneShort}
            toneClass={groupTone(g.id, i)}
          />
        ))}
      </div>
    </div>
  );
}

function coopCheckLabel(tr: (k: keyof Dict) => string, key: string): string {
  if (key === "name") return tr("coopCheckName");
  if (key === "stickers") return tr("coopCheckStickers");
  if (key === "tutorial") return tr("coopCheckTutorial");
  if (key === "age") return tr("coopCheckAge");
  return tr("coopCheckCounters");
}

function coopCheckWhy(tr: (k: keyof Dict) => string, key: string): string {
  if (key === "name") return tr("coopWhyName");
  if (key === "stickers") return tr("coopWhyStickers");
  if (key === "tutorial") return tr("coopWhyTutorial");
  if (key === "age") return tr("coopWhyAge");
  return tr("coopWhyCounters");
}

function Unban({
  tr,
  session,
  cityManual,
  setCityManual,
  friendSel,
  setFriendSel,
  busy,
  onRefresh,
  onFetch,
  onRestore,
  onCopy,
  copyStage,
}: {
  tr: (k: keyof Dict) => string;
  session: SessionSnap;
  cityManual: string;
  setCityManual: (v: string) => void;
  friendSel: string | null;
  setFriendSel: (v: string) => void;
  busy: boolean;
  onRefresh: () => void;
  onFetch: () => void;
  onRestore: (m: UnbanMode) => void;
  onCopy: (k: "decor" | "stage1" | "stage2" | "stage3") => void;
  copyStage: number;
}) {
  // The reference tool locks each stage behind the one before it; a stage
  // only counts as done once its own Save & push actually succeeded.
  const stage = Math.min(3, copyStage);
  return (
    <div className="stagger-in space-y-3">
      <p className="text-sm text-muted">{tr("unbanIntro")}</p>

      <article className="panel flex gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          1
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{tr("step1")}</h3>
          <p className="text-sm text-muted">{tr("step1d")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={onRefresh}>
              {tr("refreshFriends")}
            </Button>
            <span className="text-xs text-muted">
              {session.friends.length} {tr("friends")}
            </span>
          </div>
          <div className="mt-3 max-h-44 overflow-auto rounded-md bg-input">
            {session.friends.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted">{tr("noFriends")}</p>
            ) : (
              session.friends.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-primary/10",
                    friendSel === f.id && "bg-primary/15 text-primary",
                  )}
                  onClick={() => {
                    setFriendSel(f.id);
                    setCityManual(f.id);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-card text-xs font-semibold">
                      {f.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 truncate">
                      <span className="block truncate font-medium">
                        {f.type === "request" ? `${tr("request")} · ` : ""}
                        {f.name}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted">
                        {f.id}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 rounded-md bg-card/70 px-2 py-1 font-mono text-xs text-muted tabular-nums">
                    Lv{f.level || "?"}
                  </span>
                </button>
              ))
            )}
          </div>
          <input
            className="field mt-3 font-mono"
            placeholder={tr("cityManual")}
            value={cityManual}
            onChange={(e) => setCityManual(e.target.value)}
          />
        </div>
      </article>

      <article className="panel flex gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          2
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{tr("step2")}</h3>
          <p className="text-sm text-muted">{tr("step2d")}</p>
          <Button className="mt-3" variant="secondary" disabled={busy} onClick={onFetch}>
            {tr("fetchCity")}
          </Button>
          {session.friendCity ? (
            <p className="mt-2 font-mono text-xs text-primary">
              {tr("cityReady")} · {session.friendCity}
            </p>
          ) : null}
        </div>
      </article>

      <article className="panel flex gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          3
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{tr("step3")}</h3>
          <p className="text-sm text-muted">{tr("step3d")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="success" disabled={busy} onClick={() => onRestore("inicial")}>
              {tr("restoreBasic")}
            </Button>
            <Button size="sm" variant="warn" disabled={busy} onClick={() => onRestore("completo")}>
              {tr("restoreFull")}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => onRestore("novo")}>
              {tr("restoreAll")}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">{tr("restoreKeepOwn")}</p>
          {session.unban.applied ? (
            <p className="mt-2 text-xs text-primary">
              {tr("unbanOk")} · {session.unban.mode}
            </p>
          ) : null}
        </div>
      </article>

      <article className="panel flex gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          4
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{tr("copySection")}</h3>
          <p className="text-sm text-muted">{tr("copySectionHint")}</p>
          {!session.friendCity ? (
            <p className="mt-3 text-xs text-warning">{tr("copyNeedFetch")}</p>
          ) : (
            <>
              <p className="mt-3 text-xs text-muted">{tr("copyStageLead")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="success"
                  disabled={busy || stage >= 1}
                  onClick={() => onCopy("stage1")}
                >
                  {tr("copyStage1")}
                </Button>
                <Button
                  size="sm"
                  variant="warn"
                  disabled={busy || stage !== 1}
                  onClick={() => onCopy("stage2")}
                >
                  {tr("copyStage2")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || stage !== 2}
                  onClick={() => onCopy("stage3")}
                >
                  {tr("copyStage3")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => onCopy("decor")}
                >
                  {tr("copyDecor")}
                </Button>
              </div>
              {stage === 1 ? (
                <p className="mt-2 text-xs text-muted">{tr("copyStageHint1")}</p>
              ) : stage === 2 ? (
                <p className="mt-2 text-xs text-muted">{tr("copyStageHint2")}</p>
              ) : stage >= 3 ? (
                <p className="mt-2 text-xs text-primary">{tr("copyStageDone")}</p>
              ) : null}
              {stage < 3 ? (
                <p className="mt-1 text-xs text-muted">
                  {tr("copyStageNext").replace("{n}", String(stage + 1))}
                </p>
              ) : null}
            </>
          )}
          <p className="mt-2 text-xs text-muted">{tr("decorApplyHint")}</p>
        </div>
      </article>

      {session.hasXml ? (
        <article className="panel flex gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
            5
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">{tr("coopReady")}</h3>
            <p className="text-sm text-muted">{tr("coopReadyHint")}</p>
            <p className={`mt-2 text-xs ${session.coopReady.ready ? "text-primary" : "text-warning"}`}>
              {session.coopReady.ready ? tr("coopReadyOk") : tr("coopReadyWait")}
            </p>
            <ul className="mt-2 space-y-1">
              {session.coopReady.checks.map((c) => (
                <li key={c.key} className="text-xs text-muted">
                  <span className={c.ok ? "text-primary" : "text-warning"}>
                    {c.ok ? "✓" : "!"}
                  </span>{" "}
                  {coopCheckLabel(tr, c.key)}
                  {c.ok ? null : <span> — {coopCheckWhy(tr, c.key)}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">{tr("coopDevice")}</p>
          </div>
        </article>
      ) : null}
    </div>
  );
}

function SheetFrame({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <>
      <button type="button" className="sheet-scrim" aria-label="Close" onClick={onClose} />
      <div className="sheet-card" role="dialog">
        <div className="mb-3 flex justify-end">
          <button type="button" className="grid size-9 place-items-center rounded-md text-muted hover:text-fg" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

function FeedbackForm({
  tr,
  token,
  remainingLabel,
  onDone,
}: {
  tr: (k: keyof Dict) => string;
  token: string;
  remainingLabel: string;
  onDone: () => void;
}) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <h2 className="font-display text-lg font-semibold">{tr("feedback")}</h2>
      <p className="mt-1 text-sm text-muted">{tr("feedbackHint")}</p>
      <p className="mt-3 rounded-md bg-amber/15 px-3 py-2 text-xs font-medium text-amber">
        {tr("remainingWith")}: {remainingLabel}
      </p>
      <textarea
        className="field mt-3 h-32 py-3"
        placeholder={tr("feedbackPh")}
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
      />
      <Button
        className="mt-4 w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await sendFeedback({ data: { token, message: msg } });
            toast.success(tr("feedbackOk"));
            onDone();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : tr("actionFailed"));
          } finally {
            setBusy(false);
          }
        }}
      >
        {tr("feedbackSend")}
      </Button>
    </div>
  );
}
