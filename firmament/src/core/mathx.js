/**
 * Small numeric helpers shared by every layer.
 * Deliberately dependency-free — no THREE, no DOM.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const clamp01 = (v) => clamp(v, 0, 1);

export const lerp = (a, b, t) => a + (b - a) * t;

export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

export function smoothstep(edge0, edge1, x) {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. `rate` is roughly "per second". */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Frame-rate independent multiplicative decay, expressed as a per-60fps-frame factor. */
export function decay(perFrame, dt) {
  return Math.pow(perFrame, dt * 60);
}

export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export const TAU = Math.PI * 2;
