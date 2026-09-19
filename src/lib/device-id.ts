const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RE = /^VIP(?:-[A-Z0-9]{4}){5}$/;

function group(chars: string[], i: number) {
  return chars.slice(i, i + 4).join("");
}

export function mintDeviceId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => ALPH[b % ALPH.length]!);
  return `VIP-${group(chars, 0)}-${group(chars, 4)}-${group(chars, 8)}-${group(chars, 12)}-${group(chars, 16)}`;
}

export function normalizeDeviceId(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export function isDeviceId(raw: string): boolean {
  return RE.test(normalizeDeviceId(raw));
}
