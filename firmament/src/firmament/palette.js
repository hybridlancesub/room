// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT — palette                                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The discipline: every tint is a near-white with a whisper of hue. Saturated
 * colour would turn regions into categories; the whisper only lets the eye
 * tell neighbours apart and notice kinship.
 *
 * Domains are not authored here — a room can have a hundred, and they arrive
 * live — so tints are DERIVED, once, from the substrate:
 *
 *   · Hue comes from where a domain sits among its relations. Domains that
 *     answer each other are close in hue; unrelated ones are not. This is a
 *     1-D spectral ordering of the relationship graph (Fiedler vector), which
 *     is the same idea the Embedding uses for space, applied to colour.
 *   · Isolated domains (no relations) take a stable hue from their id, so
 *     the same room shows the same sky every time.
 *   · Saturation is low and grows slightly with a domain's weight: the big
 *     regions read a touch warmer or cooler; sparks stay nearly white.
 */
export const VOID_COLOR = 0x050508;
export const STARLIGHT = [0.86, 0.9, 1.0];

const tints = new Map();

/** Compute and cache every domain's tint. Call once, after the Substrate exists. */
export function paintDomains(substrate) {
  tints.clear();
  const domains = substrate.domains;
  const n = domains.length;
  if (!n) return;

  // Relationship-weighted adjacency.
  const index = new Map(domains.map((d, i) => [d.id, i]));
  const adj = Array.from({ length: n }, () => new Float64Array(n));
  let anyEdge = false;
  for (const r of substrate.relationships) {
    const a = index.get(r.from);
    const b = index.get(r.to);
    if (a == null || b == null || a === b) continue;
    adj[a][b] += r.weight;
    adj[b][a] += r.weight;
    anyEdge = true;
  }

  // Fiedler vector by power iteration on (I - L_norm) — the second eigenvector of
  // the normalised Laplacian orders connected nodes along a line.
  const hueOf = new Float64Array(n);
  if (anyEdge) {
    const deg = adj.map((row) => row.reduce((s, v) => s + v, 0));
    let v = Float64Array.from({ length: n }, (_, i) => hash01(domains[i].id) - 0.5);
    const ones = Float64Array.from({ length: n }, (_, i) => Math.sqrt(deg[i] || 0));
    const norm1 = Math.hypot(...ones) || 1;
    for (let it = 0; it < 200; it++) {
      // v <- (I - L) v = D^-1/2 A D^-1/2 v  (plus v to shift spectrum), then deflate against sqrt(deg)
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        if (!deg[i]) continue;
        let s = 0;
        for (let j = 0; j < n; j++) if (adj[i][j]) s += (adj[i][j] / Math.sqrt(deg[i] * deg[j])) * v[j];
        next[i] = s + v[i];
      }
      let dot = 0;
      for (let i = 0; i < n; i++) dot += next[i] * ones[i];
      for (let i = 0; i < n; i++) next[i] -= (dot / (norm1 * norm1)) * ones[i];
      const len = Math.hypot(...next) || 1;
      for (let i = 0; i < n; i++) v[i] = next[i] / len;
    }
    // Rank-order the connected domains along the vector, spread over ~70% of the wheel so
    // the two ends are not the same colour.
    const connected = [...Array(n).keys()].filter((i) => deg[i] > 0).sort((a, b) => v[a] - v[b]);
    connected.forEach((i, k) => { hueOf[i] = 0.05 + 0.7 * (k / Math.max(1, connected.length - 1)); });
    for (let i = 0; i < n; i++) if (!deg[i]) hueOf[i] = hash01(domains[i].id);
  } else {
    for (let i = 0; i < n; i++) hueOf[i] = hash01(domains[i].id);
  }

  for (let i = 0; i < n; i++) {
    const d = domains[i];
    const sat = 0.07 + 0.11 * (d.weight ?? 0.5);
    tints.set(d.id, hsl(hueOf[i], sat, 0.93));
  }
}

export function tintFor(domainId) {
  return tints.get(domainId) ?? STARLIGHT;
}

/** Tints as a flat array indexed by domain index — convenient for buffers. */
export function tintTable(domains) {
  return domains.map((d) => tintFor(d.id));
}

function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

function hsl(h, s, l) {
  const k = (n) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
