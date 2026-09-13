/**
 * Deterministic pseudo-randomness.
 *
 * The Firmament must look the same every time it is entered — structure is
 * *discovered*, not regenerated. Every stochastic decision in the Embedding
 * therefore flows through a seeded stream.
 */

/** FNV-1a — stable string → 32-bit seed. */
export function seedFrom(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, good enough for spatial distribution. */
export function createRng(seed) {
  let a = (typeof seed === 'string' ? seedFrom(seed) : seed >>> 0) || 0x9e3779b9;

  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    /** Uniform in [min, max). */
    range: (min, max) => min + next() * (max - min),
    /** Integer in [0, n). */
    int: (n) => Math.floor(next() * n),
    /** Approximately normal, mean 0, sd 1. */
    normal() {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /** Uniform point on the unit sphere. */
    onSphere() {
      const z = next() * 2 - 1;
      const t = next() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return [r * Math.cos(t), r * Math.sin(t), z];
    },
    /** Uniform point inside the unit ball. */
    inBall() {
      const [x, y, z] = this.onSphere();
      const r = Math.cbrt(next());
      return [x * r, y * r, z * r];
    },
    /** Fork a child stream — keeps sibling generators independent of call order. */
    fork(label) {
      return createRng(seedFrom(String(label)) ^ ((a * 2654435761) >>> 0));
    },
  };
}
