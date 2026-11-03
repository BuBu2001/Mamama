// Deterministic seeded PRNG suite: sfc32 + xmur3 string hash + mulberry32.
// Same seed => same sequence => reproducible scenarios & tests.

export type Rng = () => number;

/** Hash an arbitrary string seed into 4 32-bit ints. */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** sfc32 — fast, high-quality 32-bit PRNG. Returns floats in [0,1). */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 1)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Create a named, deterministic RNG stream from a string seed. */
export function makeRng(seed: string, stream = 'main'): Rng {
  const h = xmur3(`${seed}:${stream}`);
  return sfc32(h(), h(), h(), h());
}

/** Uniform float in [lo, hi). */
export function rngUniform(rng: Rng, lo = 0, hi = 1): number {
  return lo + (hi - lo) * rng();
}

/** Standard normal via Box–Muller. */
export function rngNormal(rng: Rng): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Bernoulli trial. */
export function rngChance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** Pick integer index uniformly. */
export function rngInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n) % n;
}

/** Choose element uniformly. */
export function rngPick<T>(rng: Rng, arr: T[]): T {
  return arr[rngInt(rng, arr.length)];
}

/** Random id generator that does NOT consume the sim RNG (UI-only ids). */
let idCounter = 0;
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}
