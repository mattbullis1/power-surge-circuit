/**
 * Small, fast, deterministic PRNG (mulberry32).
 * Used for procedural campaign layouts, endless hazards, energy placement
 * and decorative circuit generation. The same seed always produces the same
 * sequence on every platform.
 */
export class RNG {
  constructor(seed = 0x9e3779b9) {
    this.seed = (Number(seed) >>> 0) || 0x9e3779b9;
    this.state = this.seed;
  }

  next() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min, max) {
    if (max < min) [min, max] = [max, min];
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  float(min, max) {
    return this.next() * (max - min) + min;
  }

  pick(list) {
    if (!list || list.length === 0) return undefined;
    return list[Math.floor(this.next() * list.length)];
  }

  chance(probability) {
    return this.next() < probability;
  }

  shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/** Stable 32-bit string hash, used to derive level seeds. */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

export function randomSeed() {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    cryptoObj.getRandomValues(buffer);
    return buffer[0] >>> 0;
  }
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}
