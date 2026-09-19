import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const AAD = Buffer.from("igg-vip-token-v1");

function loadSecret() {
  const env = process.env.IGG_VIP_MASTER?.trim();
  if (env && env.length >= 16) {
    return Buffer.from(hkdfSync("sha256", env, "igg-vip-env", "master", 32));
  }
  if (process.env.NODE_ENV === "production") {
    console.warn("[igg-vip] IGG_VIP_MASTER is unset — set a 32+ char secret on the host");
  }
  return Buffer.from(hkdfSync("sha256", "igg-vip-dev-placeholder", "igg-vip-env", "master", 32));
}

const MASTER = loadSecret();
const AES_KEY = Buffer.from(hkdfSync("sha256", MASTER, "igg-vip-aes", "payload-v1", 32));
const HMAC_KEY = Buffer.from(hkdfSync("sha256", MASTER, "igg-vip-hmac", "token-v1", 32));

export function fingerprintKey(key: string) {
  return createHash("sha256").update(`igg-vip-key:${key.trim()}`).digest("hex");
}

export function deviceWrapKey(deviceId: string) {
  return Buffer.from(
    hkdfSync("sha256", MASTER, `dev:${deviceId.trim().toUpperCase()}`, "device-bind-v1", 32),
  ).toString("hex");
}

export type TokenPayload = {
  k: string;
  d: string;
  exp: number;
  n: string;
  bind: string;
};

export function sealToken(input: { keyFp: string; deviceId: string; ttlMs?: number }) {
  const deviceId = input.deviceId.trim().toUpperCase();
  const payload: TokenPayload = {
    k: input.keyFp,
    d: deviceId,
    exp: Date.now() + (input.ttlMs ?? TOKEN_TTL_MS),
    n: randomBytes(8).toString("hex"),
    bind: deviceWrapKey(deviceId),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", AES_KEY, iv);
  cipher.setAAD(AAD);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const pack = Buffer.concat([iv, tag, enc]).toString("base64url");
  const sig = createHmac("sha256", HMAC_KEY).update(pack).digest("base64url");
  return `${pack}.${sig}`;
}

export function openToken(token: string): TokenPayload {
  const raw = (token || "").trim();
  const dot = raw.lastIndexOf(".");
  if (dot < 16) throw new Error("Not licensed");
  const pack = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = createHmac("sha256", HMAC_KEY).update(pack).digest("base64url");
  const a = Buffer.from(expect);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Not licensed");

  const buf = Buffer.from(pack, "base64url");
  if (buf.length < 29) throw new Error("Not licensed");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", AES_KEY, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  let json: string;
  try {
    json = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Not licensed");
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(json) as TokenPayload;
  } catch {
    throw new Error("Not licensed");
  }
  if (!payload?.k || !payload?.d || !payload.exp) throw new Error("Not licensed");
  if (Date.now() >= payload.exp) throw new Error("Session expired — unlock again");
  if (payload.bind !== deviceWrapKey(payload.d)) throw new Error("Not licensed");
  return payload;
}

export function tokenTtlMs() {
  return TOKEN_TTL_MS;
}
