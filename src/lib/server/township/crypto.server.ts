import { Buffer } from "node:buffer";
import lz4 from "lz4js";
import { murmurHash2, u32 } from "./murmur.server";
import { decodeContainer, extractXml } from "./save-decode.server";

export { murmurHash2 };

function decodeWrapper(buf: Buffer) {
  const decoded = decodeContainer(buf);
  return decoded && decoded !== buf ? decoded : null;
}

function generateTable(inputVal: number, seed: number) {
  const table = Buffer.alloc(727);
  let value = murmurHash2((() => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(u32(inputVal));
    return b;
  })(), seed);
  let pos = 0;
  while (pos < 727) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(u32(value), 0);
    for (let i = 0; i < 4 && pos < 727; i++) table[pos++] = b[i]!;
    if (pos < 727) value = murmurHash2(b, seed);
  }
  return table;
}

export function parseHeader(encrypted: Buffer) {
  if (encrypted.length < 8) throw new Error("File too short");
  const byte0 = encrypted[0]!;
  const seed = encrypted[1]! | (encrypted[2]! << 8) | (encrypted[3]! << 16);
  const num = encrypted.readUInt32LE(4);
  return { byte0, seed, num };
}

function buildHeader(seed: number, num: number, byte0: number) {
  const header = Buffer.alloc(8);
  header[0] = byte0 & 0xff;
  header[1] = seed & 0xff;
  header[2] = (seed >> 8) & 0xff;
  header[3] = (seed >> 16) & 0xff;
  header.writeUInt32LE(u32(num), 4);
  return header;
}

function decryptBody(data: Buffer, seed: number, num: number) {
  const inputVal = u32(num + 4);
  const keystream = generateTable(inputVal, seed);
  const result = Buffer.from(data);
  let prev = 0;
  let idx = 0;
  for (let i = 0; i < result.length; i++) {
    if (idx >= 727) idx = 0;
    const key = keystream[idx]!;
    if (i === 0) result[i] = result[i]! ^ key;
    else result[i] = ((result[i]! - prev) & 0xff) ^ key;
    prev = result[i]!;
    idx += 1;
  }
  return result;
}

function encryptBody(plain: Buffer, seed: number, num: number) {
  const inputVal = u32(num + 4);
  const keystream = generateTable(inputVal, seed);
  const result = Buffer.alloc(plain.length);
  let prev = 0;
  let idx = 0;
  for (let i = 0; i < plain.length; i++) {
    if (idx >= 727) idx = 0;
    const key = keystream[idx]!;
    if (i === 0) result[i] = plain[i]! ^ key;
    else result[i] = ((plain[i]! ^ key) + prev) & 0xff;
    prev = plain[i]!;
    idx += 1;
  }
  return result;
}

export function decryptStream(encrypted: Buffer) {
  const { seed, num } = parseHeader(encrypted);
  return decryptBody(encrypted.subarray(8), seed, num);
}

export function encryptStream(plain: Buffer, header: Buffer) {
  const { byte0, seed, num } = parseHeader(Buffer.concat([header, Buffer.alloc(8)]));
  const body = encryptBody(plain, seed, num);
  return Buffer.concat([buildHeader(seed, num, byte0), body]);
}

function cleanXml(buf: Buffer) {
  const out: number[] = [];
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13 || b >= 32) out.push(b);
  }
  return Buffer.from(out);
}

export function postProcessDecrypt(decrypted: Buffer): { xml: Buffer; kind: "xml" | "lz4" | "raw" } {
  if (!decrypted.length) return { xml: decrypted, kind: "raw" };
  // The decrypted stream may still sit inside a container wrapper; unwrap it
  // before looking for XML so a 0x53/0x54/0x79/0x7D payload is not rejected.
  const unwrapped = decodeWrapper(decrypted);
  if (unwrapped && unwrapped !== decrypted) {
    const xml = extractXml(unwrapped);
    if (xml) return { xml: Buffer.from(xml, "utf8"), kind: "xml" };
  }
  if (decrypted[0] === 0x3c) {
    const last = decrypted.lastIndexOf(0x3e);
    return { xml: last >= 0 ? decrypted.subarray(0, last + 1) : decrypted, kind: "xml" };
  }
  if (decrypted.length >= 8 && decrypted[0] === 0x04 && decrypted[1] === 0x22) {
    const marker = Buffer.from("/root>\x00");
    const pos = decrypted.lastIndexOf(marker);
    const block = pos >= 0 ? decrypted.subarray(0, pos + marker.length) : decrypted;
    const originalSize = block.readInt32LE(4);
    const compressed = block.subarray(8);
    const dest = new Uint8Array(Math.max(originalSize + 65536, compressed.length * 12, 8_000_000));
    const n = lz4.decompressBlock(compressed, dest, 0, compressed.length, 0);
    const raw = Buffer.from(dest.subarray(0, Math.min(n, dest.length)));
    const last = raw.lastIndexOf(0x3e);
    return { xml: cleanXml(last >= 0 ? raw.subarray(0, last + 1) : raw), kind: "lz4" };
  }
  return { xml: decrypted, kind: "raw" };
}

export function prepareForEncrypt(xml: Buffer, kind: string) {
  const cleaned = cleanXml(xml);
  if (kind !== "lz4") return cleaned;
  const bound = lz4.compressBound(cleaned.length);
  const dst = new Uint8Array(bound);
  const hashTable = new Uint32Array(1 << 16);
  const n = lz4.compressBlock(cleaned, dst, 0, cleaned.length, hashTable);
  const block = Buffer.alloc(8 + n);
  block[0] = 0x04;
  block[1] = 0x22;
  block.writeInt32LE(cleaned.length, 4);
  Buffer.from(dst.subarray(0, n)).copy(block, 8);
  return block;
}

export function looksEncrypted(buf: Buffer) {
  if (buf.length < 16) return false;
  const head = buf.subarray(0, 8).toString("utf8");
  if (head.includes("<")) return false;
  return true;
}
