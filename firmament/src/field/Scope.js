/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIELD — scope                                                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Which *world* is open.
 *
 * Not to be confused with `Resolution.js`, and the distinction matters:
 *
 *   Resolution  which nodes are instantiated right now, at every depth, inside
 *               the current world. This is where fractal semantic depth lives.
 *               Descent is continuous and spatial: you fly into a concept and
 *               its vocabulary emerges around it. You never leave.
 *
 *   Scope       which node is the *origin* of the world you are flying in. One
 *               scope, the root, covering the whole Substrate.
 *
 * Fractal depth did not need a scope change, and that is the interesting part:
 * approaching a concept resolves its interior in place, so semantic recursion
 * happens without ever swapping worlds. The Firmament renders regions, concepts
 * and filaments at whatever depth they arrive from, and cannot tell.
 *
 * Scope therefore remains for the one thing recursion in place cannot do:
 * making a concept the new root — discarding the containing cosmos, re-relaxing
 * its interior as a full Firmament with its own regions and filaments, for when a
 * branch grows large enough to deserve being a world rather than a
 * neighbourhood. That is a different gesture from zooming, and it is not built.
 */
export class Scope {
  /**
   * @param {object} spec
   * @param {import('../substrate/Substrate.js').Substrate} spec.substrate
   * @param {import('../substrate/Embedding.js').Embedding} spec.embedding
   * @param {string[]} [spec.path]  concept ids descended through to get here
   * @param {Scope} [spec.parent]
   */
  constructor({ substrate, embedding, path = [], parent = null }) {
    this.substrate = substrate;
    this.embedding = embedding;
    this.path = Object.freeze([...path]);
    this.parent = parent;
  }

  get isRoot() {
    return this.path.length === 0;
  }

  get depth() {
    return this.path.length;
  }

  /** The concept this scope is the interior of; null at the root. */
  get conceptId() {
    return this.path.length ? this.path[this.path.length - 1] : null;
  }

  get regions() {
    return this.embedding.regions;
  }

  get concepts() {
    return this.embedding.concepts;
  }

  get filaments() {
    return this.embedding.filaments;
  }

  /** True when a concept in this scope has an interior of its own. */
  canDescend(conceptId) {
    return this.substrate.hasChildren(conceptId);
  }

  describe() {
    return {
      depth: this.depth,
      path: this.path,
      ...this.substrate.describe(),
      ...this.embedding.describe(),
    };
  }
}
