/**
 * MurmurHash2 — shared by the save crypto (`crypto.server.ts`) and the
 * container decoders (`save-decode.server.ts`).
 *
 * Township seeds this hash two different ways: the save crypto folds the
 * 4-byte length into the seed (`seed ^ 4`), while the container keystream
 * tables pass the seed and length separately. Both variants live here so the
 * two call sites cannot drift apart.
 */

const M = 0x5bd1e995;
const R = 24;

export function u32(n: number) {
  return n >>> 0;
}

/** MurmurHash2 over a little-endian 32-bit word, with the seed folded in. */
export function murmurHash2(data: Buffer, seed: number) {
  let h = u32(seed ^ 4);
  let k = data.readUInt32LE(0);
  k = u32(Math.imul(k, M));
  k ^= k >>> R;
  k = u32(Math.imul(k, M));
  h = u32(Math.imul(h, M));
  h ^= k;
  h ^= h >>> 13;
  h = u32(Math.imul(h, M));
  h ^= h >>> 15;
  return u32(h);
}

/** Variant where the caller supplies the length and seed independently. */
export function mmh2(data: Buffer, length: number, seed: number) {
  let h = u32(seed ^ length);
  let i = 0;
  let remaining = length;
  while (remaining >= 4) {
    let k = data.readUInt32LE(i);
    k = u32(Math.imul(k, M));
    k = u32(k ^ (k >>> R));
    k = u32(Math.imul(k, M));
    h = u32(Math.imul(h, M));
    h = u32(h ^ k);
    i += 4;
    remaining -= 4;
  }
  if (remaining >= 3) h ^= data[i + 2]! << 16;
  if (remaining >= 2) h ^= data[i + 1]! << 8;
  if (remaining >= 1) {
    h ^= data[i]!;
    h = u32(Math.imul(h, M));
  }
  h = u32(h ^ (h >>> 13));
  h = u32(Math.imul(h, M));
  h = u32(h ^ (h >>> 15));
  return h;
}