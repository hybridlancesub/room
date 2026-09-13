import { clamp01, damp, smoothstep } from '../core/mathx.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIELD — resolution                                                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * FRACTAL SEMANTIC DEPTH. Zoom is not navigation through layers; it is semantic
 * recursion. Every concept is a potential cluster, and this system decides,
 * continuously, which scales of meaning are currently resolvable.
 *
 * ── LAZY RECURSIVE INSTANTIATION ──────────────────────────────────────────
 *
 * The same pattern that lets Space Engine render a universe: infinite in
 * theory, finite in memory at any moment.
 *
 *   · a node's children are embedded the first time the camera comes within its
 *     proximity threshold — never at load
 *   · what the camera leaves behind is released back to the pool
 *   · what cannot be resolved is not instantiated, at any depth
 *
 * Nothing here has a maximum depth. A node's children resolve when you approach
 * the node; that rule is indifferent to how you got there, so depth 3 and depth
 * 300 are the same code path.
 *
 * ── NO HARD TRANSITION ────────────────────────────────────────────────────
 *
 * Emergence is a continuous function of distance, not an event. Activation
 * happens *outside* the threshold, while emergence is still zero, so a
 * sub-cluster is always instantiated before it is visible. There is no click,
 * no load, and no frame on which something appears.
 *
 * Three continuous values come out of this, per resolved node:
 *
 *   emergence    0 → 1 as you close on its parent. Its right to be seen.
 *   promotion    0 → 1 as you close on it. Becoming a local anchor: larger,
 *                more luminous, the centre of its own scale.
 *   suppression  0 → 1 as a sibling is promoted. The environment responds by
 *                yielding attention, not by rearranging.
 *
 * None of them move anything. Positions come from the Embedding and are fixed
 * the moment they are computed.
 */
export class Resolution {
  constructor({ substrate, embedding, bus, options = {} } = {}) {
    this.substrate = substrate;
    this.embedding = embedding;
    this.bus = bus;

    this.options = {
      /** Instantiate at this multiple of the threshold — before anything shows. */
      activate: 1.18,
      /** Release at this multiple. The gap between the two is the hysteresis. */
      release: 1.62,
      /** Emergence completes at this fraction of the parent's threshold. */
      emergenceFloor: 0.44,
      /** How fast the three continuous values chase their targets. */
      response: 3.4,
      /** How much a promoted node's siblings yield. */
      suppression: 0.5,
      /** Anchors yield less — they are how you know where you are. */
      anchorSuppression: 0.55,
      /** Hard ceiling on simultaneously resolved nodes. */
      budget: 4000,
      ...options,
    };

    /**
     * id → record. Everything currently instantiated, at every depth.
     * This is the authoritative output; the Firmament reconciles against it.
     */
    this.active = new Map();
    /**
     * What changed this frame. Informational — for events, diagnostics and
     * future layers. Nothing that has to stay correct may depend on catching
     * these, because a diff is only true for whoever reads it in time.
     */
    this.activated = [];
    this.deactivated = [];

    /** Distance to the nearest resolved word — Navigation scales speed by it. */
    this.nearestConceptDistance = Infinity;
    this.nearestConceptId = null;
    /** The node currently acting as a local anchor, if any. */
    this.localAnchorId = null;

    this.deepest = 0;
    this._peak = 0;
    this._seeded = false;
  }

  #activate(embed) {
    const record = {
      embed,
      id: embed.id,
      depth: embed.depth,
      parentId: embed.parentId,
      distance: Infinity,
      emergence: embed.depth === 0 ? 1 : 0,
      promotion: 0,
      suppression: 0,
      /** True once this node's children have been instantiated. */
      opened: false,
    };
    this.active.set(embed.id, record);
    this.activated.push(record);
    this.deepest = Math.max(this.deepest, embed.depth);
    this._peak = Math.max(this._peak, this.active.size);
    return record;
  }

  /** Release a node and, recursively, everything that emerged from it. */
  #release(record) {
    if (record.depth === 0) return; // the surface never unloads
    for (const child of this.#childrenOf(record)) this.#release(child);
    this.active.delete(record.id);
    this.deactivated.push(record.id);
  }

  #childrenOf(record) {
    const out = [];
    for (const other of this.active.values()) {
      if (other.parentId === record.id) out.push(other);
    }
    return out;
  }

  /**
   * @param {number} dt
   * @param {{x:number, y:number, z:number}} camera
   *
   * Safe to call any number of times, in any order relative to rendering.
   * `active` is always the whole truth; the diff lists are a convenience.
   */
  update(dt, camera) {
    const o = this.options;
    this.activated.length = 0;
    this.deactivated.length = 0;

    if (!this._seeded) {
      this._seeded = true;
      // Depth 0 is always resolved: the surface of the Firmament is never lazy.
      for (const embed of this.embedding.concepts) this.#activate(embed);
    }

    // ── distance, and the recursive open/close decision ────────────────────
    let nearest = Infinity;
    let nearestId = null;

    // Snapshot: opening a node mutates `active` while we are walking it.
    const records = [...this.active.values()];

    for (const record of records) {
      const p = record.embed.position;
      const distance = Math.hypot(camera.x - p[0], camera.y - p[1], camera.z - p[2]);
      record.distance = distance;

      if (distance < nearest) {
        nearest = distance;
        nearestId = record.id;
      }

      if (!record.embed.childCount) continue;
      const threshold = record.embed.threshold;

      if (!record.opened && distance < threshold * o.activate) {
        // Crossing inward. This is the only place in the Firmament where new
        // meaning comes into being, and it happens because you went there.
        if (this.active.size + record.embed.childCount <= o.budget) {
          for (const child of this.embedding.embedChildren(record.embed)) {
            if (!this.active.has(child.id)) this.#activate(child);
          }
          record.opened = true;
          this.bus?.emit('resolution:opened', {
            id: record.id,
            label: record.embed.label,
            depth: record.depth,
            children: record.embed.childCount,
          });
        }
      } else if (record.opened && distance > Math.max(threshold * o.release, (record.embed.reach ?? 0) * 1.3)) {
        // Crossing outward. Reduce to nothing rendered; the embedding stays
        // cached, so returning costs no work and lands in the same place.
        for (const child of this.#childrenOf(record)) this.#release(child);
        record.opened = false;
        this.bus?.emit('resolution:closed', { id: record.id, depth: record.depth });
      }
    }

    this.nearestConceptDistance = nearest;
    this.nearestConceptId = nearestId;

    // ── the three continuous values ───────────────────────────────────────
    let localAnchor = null;
    let localAnchorPromotion = 0.08;
    const domainPromotion = new Map();

    for (const record of this.active.values()) {
      const embed = record.embed;

      // PROMOTION — how much this node is behaving as a local anchor. A leaf
      // promotes too (it has no children to open, but it can still be the thing
      // you are reading); it just does so over a tighter radius.
      const promotionTarget = embed.childCount
        ? 1 - smoothstep(embed.threshold * o.emergenceFloor, embed.threshold, record.distance)
        : 1 - smoothstep(embed.threshold * o.emergenceFloor * 0.5, embed.threshold * 0.5, record.distance);
      record.promotion = damp(record.promotion, promotionTarget, o.response, dt);

      // EMERGENCE — inherited from the parent's approach, so a whole
      // sub-cluster resolves together as one gesture.
      let emergenceTarget = 1;
      if (embed.depth > 0) {
        const parent = this.active.get(record.parentId);
        emergenceTarget = parent ? parent.promotion : 0;
      }
      record.emergence = damp(record.emergence, emergenceTarget, o.response, dt);

      if (record.promotion > localAnchorPromotion) {
        localAnchorPromotion = record.promotion;
        localAnchor = record;
      }

      // Track the strongest promotion per domain, for sibling suppression.
      const key = embed.domainIndex;
      if (!domainPromotion.has(key) || domainPromotion.get(key) < record.promotion) {
        domainPromotion.set(key, record.promotion);
      }
    }

    // ── suppression ───────────────────────────────────────────────────────
    // When a concept becomes a local anchor, the vocabulary around it yields.
    // This is the same idea as attention gravity, one scale down: salience
    // changes, topology does not.
    for (const record of this.active.values()) {
      const embed = record.embed;
      const rival = domainPromotion.get(embed.domainIndex) ?? 0;
      const isPromoted = record.promotion > 0.05;
      const isDescendant = record.depth > 0;

      let target = 0;
      if (!isPromoted && !isDescendant && rival > 0.05) {
        target = rival * o.suppression * (embed.isAnchor ? o.anchorSuppression : 1);
      }
      record.suppression = damp(record.suppression, clamp01(target), o.response, dt);
    }

    const anchorId = localAnchor?.id ?? null;
    if (anchorId !== this.localAnchorId) {
      this.localAnchorId = anchorId;
      this.bus?.emit('resolution:local-anchor', {
        id: anchorId,
        label: localAnchor?.embed.label ?? null,
        depth: localAnchor?.depth ?? 0,
      });
    }
  }

  describe() {
    const byDepth = {};
    for (const record of this.active.values()) {
      byDepth[record.depth] = (byDepth[record.depth] ?? 0) + 1;
    }
    return {
      resolved: this.active.size,
      byDepth,
      deepestSeen: this.deepest,
      peakResolved: this._peak,
      localAnchor: this.localAnchorId,
      nearestConcept: this.nearestConceptId,
      nearestConceptDistance: Number.isFinite(this.nearestConceptDistance)
        ? Math.round(this.nearestConceptDistance)
        : null,
    };
  }
}
