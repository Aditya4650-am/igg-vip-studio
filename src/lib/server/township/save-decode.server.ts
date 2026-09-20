/**
 * Township save/container decoder.
 *
 * Port of `scripts/township/ts_township_core.py` (`ts_decode_bytearray` and the
 * per-wrapper routines) for the formats we can decode without extra native
 * dependencies.
 *
 * The game wraps the save body in one of several containers, distinguished by
 * the first byte. The previous TS port only understood `0x79` and plain XML,
 * which is why a save/LocalInfo pulled from a device using any other wrapper
 * failed with "not 0x79 format" even though the file was perfectly valid.
 *
 * Formats:
 *   0x3C  '<'          plain XML
 *   0x1F 0x8B          gzip
 *   0x53               key table 66, delta + xor
 *   0x54               key_0x54, delta + xor
 *   0x79               murmur2 hash table + delta + xor (LocalInfo)
 *   0x7D               key table 0x41, xor only
 *   PLXE / 0x1A4B4C42  base64 or zstd sub-containers
 */

import { inflateSync, gunzipSync } from "node:zlib";
import { mmh2, u32 } from "./murmur.server";
import { KEY_0X53, KEY_0X54, KEY_0X7D } from "./save-keys.server";

const HASH_TABLE_LEN = 0x2d7;

function u8(n: number) {
  return n & 0xff;
}

/** LocalInfo/murmur2 keystream table. */
function hashTable(length: number, seed: number) {
  const table = Buffer.alloc(HASH_TABLE_LEN);
  let h = u32(seed);
  for (let i = 0; i < HASH_TABLE_LEN; i += 4) {
    const input = Buffer.alloc(4);
    input.writeUInt32LE(h, 0);
    h = mmh2(input, 4, u32(length));
    const out = Buffer.alloc(4);
    out.writeUInt32LE(h, 0);
    out.copy(table, i, 0, Math.min(4, HASH_TABLE_LEN - i));
  }
  return table;
}

/** Shared delta-xor pass used by 0x53/0x54/0x79/PLXE-case-7. */
function deltaXor(data: Buffer, table: Buffer, limit = data.length) {
  const out = Buffer.from(data);
  const n = Math.min(limit, out.length);
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    if (i > 0) out[i] = u8(out[i]! - out[i - 1]!);
    out[i] = out[i]! ^ table[j]!;
    j = (j + 1) % table.length;
  }
  return out;
}

function xorOnly(data: Buffer, table: Buffer) {
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 1) out[i] = out[i]! ^ table[i % table.length]!;
  return out;
}

function keyTable(ascii: string) {
  return Buffer.from(ascii, "ascii");
}

const XOR_KEY = Buffer.from(
  "ca656f74c492d5544b861925a915de6786b7b169af25e22774d39c32d0413c8d39f5b8a77bed3c96a308fb8d7b197b2dbf7e002d845d387215b0ef9fe85abfd8",
  "hex",
);

function rol8(n: number, shift: number) {
  const s = shift % 8;
  return u8((n << s) | (n >>> (8 - s)));
}

/**
 * `_deocode_xor`: the PLXE case-1 stream cipher. Each byte mixes the static
 * key, a rolling byte and a counter accumulator; the accumulator advances by
 * a fixed step per byte, so it has to be tracked alongside the output.
 */
function decodeXor(input: Buffer) {
  const out = Buffer.alloc(input.length);
  let rolling = 0;
  let acc = 0;
  for (let i = 0; i < input.length; i += 1) {
    const k = XOR_KEY[i % XOR_KEY.length]!;
    const c = input[i]!;
    const mixed =
      rolling ^
      k ^
      c ^
      (acc & 0xff) ^
      ((acc >>> 16) & 0xff) ^
      (((acc ^ (acc >>> 16)) >>> 8) & 0xff);
    const val = u8(mixed);
    out[i] = val;
    rolling = val ^ rol8(rolling, 1);
    acc = u32(acc + 0x17);
  }
  return out;
}

/**
 * `_decode_x54` / `_decode_x53`: length-prefixed delta+xor containers.
 *
 * The declared length is masked with a fixed byte that differs per wrapper:
 * the reference `_decode_x54` uses `key_0x54[0]` (0x77) while `_decode_x53`
 * uses the literal tag 0x53. They are not interchangeable — using one for the
 * other miscomputes the length and silently truncates about half of all real
 * payloads, which reads as a corrupt save rather than a decoder bug.
 */
function decodeX54(raw: Buffer, table: Buffer, mask: number) {
  const declared = (raw[1]! ^ mask) | (raw[2]! << 8);
  const len = Math.min(declared, raw.length - 3);
  const data = Buffer.from(raw.subarray(3, 3 + len));
  data[0] = u8(data[0]! - 0x54);
  for (let i = 0; i < len; i += 1) {
    if (i > 0) data[i] = u8(data[i]! - data[i - 1]!);
    data[i] = data[i]! ^ table[i % table.length]!;
  }
  return data;
}

/** `_decode_0x79`: murmur2 table + delta+xor, size derived from the header. */
function decode0x79(raw: Buffer) {
  const hashLength = raw[1]! | (raw[2]! << 8) | (raw[3]! << 16);
  const hashSeed = raw.readUInt32LE(4);
  const table = hashTable(hashLength, u32(hashSeed + 4));
  const size = u32(u32(hashLength - (raw.length ^ 0xc5eed)) ^ 0x396a8);
  return deltaXor(raw.subarray(8), table, size);
}

/**
 * `_decode_45584c50`: container of length-prefixed records.
 *
 * Case 1 holds an XOR-encoded document, case 7 a zstd stream. The reference
 * also lists cases 2/3/5/6, which it does not implement, so neither do we —
 * returning null keeps the caller's error message honest.
 */
function decodePlxe(raw: Buffer): Buffer | null {
  let offset = 0;
  while (offset + 4 <= raw.length) {
    const data = raw.readUInt32LE(offset);
    if (data === 0x45584c50 || data === 0x1a4b4c42) {
      offset += 4;
      continue;
    }
    const kind = data & 0xffff;
    const skip = (data >>> 16) & 0xffff;
    if (kind === 1) {
      offset += 4 + skip;
      if (offset > raw.length) return null;
      return decodeXor(raw.subarray(offset));
    }
    if (kind === 7) {
      // The case-7 record carries its own length/seed right after the header,
      // with a fixed 7-byte gap before the compressed payload.
      const lengthOffset = offset + 4 + 6 + 1;
      if (lengthOffset + 7 > raw.length) return null;
      const length = raw.readUIntLE(lengthOffset, 3);
      const seed = raw.readUInt32LE(lengthOffset + 3);
      const table = hashTable(length, u32(seed + 4));
      const buff = deltaXor(raw.subarray(lengthOffset + 7), table);
      try {
        return inflateSync(buff, { windowBits: 15 + 16 });
      } catch {
        return null;
      }
    }
    return null;
  }
  return null;
}

function stripTrailingNul(buf: Buffer) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end -= 1;
  return buf.subarray(0, end);
}

/**
 * Detect an ADB/shell error message that was mistaken for file content.
 *
 * `adb exec-out` merges stderr into stdout, so a failed `su -c "cat …"` returns
 * its diagnostic instead of the file. That text is long enough to clear the
 * client's length guard, so it reaches us as a "save". Decoding it would fail
 * with a misleading container error (its first byte is just `c`), and the real
 * cause — no root, or a wrong package path — stays hidden.
 */
const SHELL_ERROR = /^\s*(cat|cp|su|sh|run-as|mv|ls|rm|chmod|adb)\s*[:/]|\bPermission denied\b|\bNo such file or directory\b|\bnot found\b|\bOperation not permitted\b|^\s*\/system\/bin\/sh\b/i;

export function shellErrorMessage(buf: Buffer): string | null {
  const head = buf.subarray(0, 512);
  // A real container is binary (NUL bytes, control chars); shell diagnostics are
  // plain text. Requiring printable content keeps the phrase matches below from
  // firing on a coincidence inside compressed data.
  for (const b of head) {
    if (b === 0) return null;
    if (b < 9 || (b > 13 && b < 32)) return null;
  }
  const text = head.toString("utf8").replace(/^\uFEFF/, "");
  // A document that starts with `<` is a save, whatever words it contains; the
  // phrase matches below are for diagnostics, which never start with a tag.
  if (text.trimStart().startsWith("<")) return null;
  if (!SHELL_ERROR.test(text)) return null;
  return text.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? "ADB read failed";
}

/**
 * Decode any container the game may have used into raw XML.
 * Returns null when the wrapper is not recognised.
 */
export function decodeContainer(buf: Buffer): Buffer | null {
  if (!buf.length) return null;
  const first = buf[0]!;
  const xorKey = first ^ 0x3c;

  if (first === 0x3c && xorKey === 0x00) return buf;
  if (first === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf);
    } catch {
      return null;
    }
  }
  if (first === 0x54 && xorKey === 0x68) return decodeX54(buf, keyTable(KEY_0X54), KEY_0X54.charCodeAt(0));
  if (first === 0x53 && xorKey === 0x6f) return decodeX54(buf, keyTable(KEY_0X53), 0x53);
  if (first === 0x79 && xorKey === 0x45) return stripTrailingNul(decode0x79(buf));
  if (first === 0x7d && xorKey === 0x41) return xorOnly(buf, keyTable(KEY_0X7D));
  if (first === 0x50 && buf[1] === 0x4c && buf[2] === 0x58 && buf[3] === 0x45) return decodePlxe(buf);
  // A `{...}` JSON envelope is not a save; leave it to the caller to reject.
  if (first === 0x7b && buf[buf.length - 1] === 0x7d) return buf;
  return null;
}

/** Locate the XML document inside a decoded buffer. */
export function extractXml(buf: Buffer): string | null {
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");
  const start = text.indexOf("<");
  if (start < 0) return null;
  // Prefer the end of the last tag over the last '>' so a trailing comment or
  // an entity like `&gt;` cannot extend the slice past the document.
  const end = text.lastIndexOf(">");
  if (end < start) return null;
  return text.slice(start, end + 1);
}