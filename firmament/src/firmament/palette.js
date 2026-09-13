/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT — palette                                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Colour is a rendering primitive, so it lives here and not in the Substrate.
 * Domains are keyed by id; an unknown domain falls back to bare starlight.
 *
 * The discipline: every tint is a near-white with a *whisper* of hue. Saturated
 * colour would turn semantic regions into categories on a chart. These are
 * temperatures, not labels.
 */

export const VOID_COLOR = 0x050508;

export const STARLIGHT = [0.86, 0.9, 1.0];

const TINTS = {
  human: [1.0, 0.93, 0.86], //  warm — bodies, breath
  environmental: [0.85, 0.99, 0.92], //  cool green — living systems
  urban: [0.9, 0.9, 1.0], //  pale violet — collective
  economic: [1.0, 0.96, 0.85], //  pale gold — value
  meta: [0.85, 0.95, 1.0], //  pale cyan — signal
};

export function tintFor(domainId) {
  return TINTS[domainId] ?? STARLIGHT;
}

/** Tints as a flat array indexed by domain index — convenient for buffers. */
export function tintTable(domains) {
  return domains.map((d) => tintFor(d.id));
}
