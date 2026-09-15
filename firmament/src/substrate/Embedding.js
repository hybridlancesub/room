import { createRng } from '../core/rng.js';
import { clamp01, lerp, TAU } from '../core/mathx.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE EMBEDDING — where meaning becomes coordinates                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * This is the *only* module allowed to turn semantics into space. It is the
 * hinge between the Substrate and the Firmament, and it belongs to the data
 * side of that hinge: it consumes meaning and emits a topology.
 *
 * The topology is computed once, deterministically, from the Substrate's seed.
 * TOPOLOGY IS STABLE. Nothing at runtime — not attention, not navigation, not
 * dwell — is permitted to move a single one of these numbers. Only visibility
 * changes. If you ever find yourself wanting to mutate an Embedding result per
 * frame, the thing you actually want lives in the Interaction layer.
 *
 * Domain placement is *relaxed*, not authored: relationship weight becomes
 * spring rest length, so strongly related domains sit close and the light
 * economic↔human filament stretches long and thin across the void. The
 * structure you fly through is therefore an argument about the knowledge, not
 * a layout someone liked the look of.
 *
 * It emits plain arrays and numbers — no THREE types. The Firmament adapts.
 */

const DEFAULTS = {
  /** Target mean separation between domain centres, in world units. */
  separation: 1180,
  /** Radius of a domain's semantic volume, before mass scaling. */
  regionRadius: 248,
  /** Vertical compression — the Firmament reads as a sheet-like web, not a ball. */
  flatten: 0.62,
  /** World height of an anchor's typography. */
  anchorScale: 34,
  /** World height range of a concept's typography, by centrality. */
  conceptScale: [7.5, 19],
  relaxIterations: 600,
  filamentSegments: 56,
  /** Concept strands are straighter, so they need fewer segments to read as curves. */
  conceptFilamentSegments: 40,

  // ── recursion ──
  /**
   * Derived proximity threshold, as a multiple of a node's own world height.
   * A word 19 units tall opens at ~530 units out; one 8 units tall at ~225.
   * Scale-relative by construction, so the behaviour is identical at depth 1
   * and depth 40.
   */
  thresholdRatio: 28,
  /** Sub-cluster shell radius, as a multiple of the parent word's height. */
  nestedRadius: 3.1,
  /**
   * …and as a multiple of the parent word's *width*, whichever is larger.
   *
   * Height alone is wrong: a word is five to nine times wider than it is tall,
   * so a shell sized by height puts every child that happens to sit left or
   * right of the parent inside the parent's own letters. Only the width knows
   * how much room a word actually occupies.
   */
  nestedSpread: 0.92,
  /**
   * Vertical stretch of a sub-cluster's shell. Above and below a word is cheap
   * room; beside it is expensive room.
   */
  nestedLift: 1.55,
  /**
   * Child height as a fraction of the parent's. Below 1 by a clear margin so
   * an approached concept unambiguously reads as the local anchor of what it
   * contains — the recursion is legible as recursion.
   */
  nestedScale: 0.44,
  /**
   * How much larger a promoted word renders than its nominal extent. Must stay
   * in step with the Firmament's `uPromoteScale`, plus a margin — the Embedding
   * cannot see the shader, so this is the one number the two layers have to
   * agree on by hand.
   */
  promotionAllowance: 1.5,
};

export class Embedding {
  constructor(substrate, options = {}) {
    this.substrate = substrate;
    this.options = { ...DEFAULTS, ...options };
    this.rng = createRng(substrate.seed);

    /** Sub-embeddings, computed on approach and then never again. */
    this._childEmbeddings = new Map();

    this.regions = this.#placeRegions();
    this._regionByDomain = new Map(this.regions.map((r) => [r.domainId, r]));
    this.concepts = this.#placeConcepts();
    this._conceptById = new Map(this.concepts.map((c) => [c.id, c]));
    this.filaments = this.#traceFilaments();
    this.conceptFilaments = this.#traceConceptFilaments();

    this.fieldRadius = this.regions.reduce(
      (max, r) => Math.max(max, Math.hypot(...r.center) + r.radius),
      0
    );
    this.center = this.regions
      .reduce((acc, r) => [acc[0] + r.center[0], acc[1] + r.center[1], acc[2] + r.center[2]], [0, 0, 0])
      .map((v) => v / this.regions.length);
  }

  region(domainId) {
    return this._regionByDomain.get(domainId) ?? null;
  }

  regionAt(index) {
    return this.regions[index] ?? null;
  }

  /** Nearest semantic region to a point, with its distances. Used by Navigation. */
  nearestRegion(x, y, z) {
    let best = null;
    let bestDist = Infinity;
    for (const r of this.regions) {
      const d = Math.hypot(x - r.center[0], y - r.center[1], z - r.center[2]);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    return { region: best, distance: bestDist, surface: bestDist - (best?.radius ?? 0) };
  }

  // ── domain placement: relational relaxation ─────────────────────────────

  #placeRegions() {
    const { substrate, options } = this;
    const rng = this.rng.fork('regions');
    const domains = substrate.domains;
    const n = domains.length;

    // Seeded initial scatter. Spread over a shell so relaxation has room.
    const pos = domains.map(() => {
      const [x, y, z] = rng.onSphere();
      const r = lerp(0.55, 1, rng.next()) * options.separation;
      return [x * r, y * r * options.flatten, z * r];
    });

    // Radii first: space is proportional to what a domain holds, so a hundred small
    // domains pack close while a few large ones keep their distance.
    const radii = domains.map((domain) => this.#regionRadius(domain));
    const size = (i, j) => (radii[i] + radii[j]) / (2 * options.regionRadius);

    // Rest length is inverse to relational weight: strong relations pull close.
    const rest = [];
    for (let i = 0; i < n; i++) {
      rest[i] = [];
      for (let j = 0; j < n; j++) {
        const w = i === j ? 1 : substrate.affinity(domains[i].id, domains[j].id);
        // Unrelated domains still repel, but have no spring at all.
        rest[i][j] = w > 0 ? lerp(1.85, 0.72, w) * options.separation * size(i, j) : null;
      }
    }

    const vel = pos.map(() => [0, 0, 0]);
    const iterations = options.relaxIterations;

    for (let step = 0; step < iterations; step++) {
      const cooling = 1 - step / iterations;
      const force = pos.map(() => [0, 0, 0]);

      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = pos[j][0] - pos[i][0];
          let dy = pos[j][1] - pos[i][1];
          let dz = pos[j][2] - pos[i][2];
          let d = Math.hypot(dx, dy, dz) || 1e-3;
          dx /= d;
          dy /= d;
          dz /= d;

          // Spring toward rest length, when a relation exists.
          const L = rest[i][j];
          if (L !== null) {
            const f = (d - L) * 0.0025;
            force[i][0] += dx * f;
            force[i][1] += dy * f;
            force[i][2] += dz * f;
            force[j][0] -= dx * f;
            force[j][1] -= dy * f;
            force[j][2] -= dz * f;
          }

          // Universal repulsion. Unrelated domains have no spring at all, so
          // this is the only thing keeping them from occupying each other.
          const rep = 0.55 * Math.pow((options.separation * size(i, j)) / d, 2);
          force[i][0] -= dx * rep;
          force[i][1] -= dy * rep;
          force[i][2] -= dz * rep;
          force[j][0] += dx * rep;
          force[j][1] += dy * rep;
          force[j][2] += dz * rep;
        }
      }

      for (let i = 0; i < n; i++) {
        for (let a = 0; a < 3; a++) {
          vel[i][a] = (vel[i][a] + force[i][a] * cooling) * 0.86;
          pos[i][a] += vel[i][a];
        }
      }
    }

    // Recentre, compress vertically, normalise scale so `separation` holds
    // regardless of how the relaxation happened to settle.
    const centroid = [0, 0, 0];
    for (const p of pos) for (let a = 0; a < 3; a++) centroid[a] += p[a] / n;
    for (const p of pos) for (let a = 0; a < 3; a++) p[a] -= centroid[a];

    // Normalise on the mean NEAREST-neighbour distance, not the mean pairwise one.
    // Pairwise grows with the count (a hundred regions would be flung ten times as
    // far apart as five), nearest-neighbour is what the eye reads as spacing.
    let meanSep = 0;
    for (let i = 0; i < n; i++) {
      let nearest = Infinity;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        nearest = Math.min(nearest, Math.hypot(pos[j][0] - pos[i][0], pos[j][1] - pos[i][1], pos[j][2] - pos[i][2]));
      }
      meanSep += n > 1 ? nearest / Math.max(0.3, radii[i] / options.regionRadius) : options.separation;
    }
    meanSep = n ? meanSep / n : options.separation;
    const scale = options.separation / (meanSep || 1);

    for (const p of pos) {
      p[0] *= scale;
      p[1] *= scale * options.flatten;
      p[2] *= scale;
    }

    return domains.map((domain, i) => {
      const radius = radii[i];
      return {
        domainId: domain.id,
        index: i,
        label: domain.label,
        anchorId: domain.anchor.id,
        anchorLabel: domain.anchor.label,
        center: [pos[i][0], pos[i][1], pos[i][2]],
        radius,
        /** How many concepts resolve here — used for LOD budgeting. */
        memberCount: domain.members.length,
        weight: domain.weight,
      };
    });
  }

  /**
   * Weight is the strong term: a domain with one entry is a spark, one with hundreds
   * is a weather system. Mass (how central its members are) is a nudge.
   */
  #regionRadius(domain) {
    const massRatio = domain.mass / (domain.members.length || 1);
    return (
      this.options.regionRadius *
      lerp(0.9, 1.1, clamp01(massRatio)) *
      lerp(0.3, 1.5, clamp01(domain.weight))
    );
  }

  // ── concept placement: organic, weighted, non-overlapping-ish ────────────

  #placeConcepts() {
    const { substrate, options } = this;
    const out = [];

    for (const domain of substrate.domains) {
      const region = this.regions[domain.index];
      const rng = this.rng.fork(`concepts:${domain.id}`);

      // A seeded orientation per region: nothing in the Firmament is axis-aligned.
      const basis = orthonormalBasis(rng);
      region.basis = basis;

      // Regions are lenticular rather than spherical — they read as volumes
      // with a grain, which is what makes a cluster feel like weather.
      const shape = [1, lerp(0.5, 0.78, rng.next()), lerp(0.78, 1, rng.next())];
      region.shape = shape;

      const placed = [];
      const members = [...domain.members].sort((a, b) => b.weight - a.weight);

      for (const member of members) {
        const scale = member.isAnchor
          ? options.anchorScale
          : lerp(options.conceptScale[0], options.conceptScale[1], easeWeight(member.weight));

        let local;
        if (member.isAnchor) {
          // The anchor is the centre. Not exactly — a hair of asymmetry keeps
          // it from reading as a diagram's origin point.
          local = [
            rng.range(-0.05, 0.05) * region.radius,
            rng.range(-0.04, 0.04) * region.radius,
            rng.range(-0.05, 0.05) * region.radius,
          ];
        } else {
          local = this.#sampleMemberPosition(rng, region, shape, member, scale, placed);
        }

        // Words are far wider than they are tall, so spacing has to reckon with
        // the *word*, not the point. Estimated from the label rather than the
        // glyph atlas — the Substrate side must not depend on rendering.
        const extent = scale * (0.62 * member.label.length + 0.4);

        placed.push({ member, local, scale, extent, phase: rng.range(0, TAU) });
      }

      this.#relax(placed, region.radius * 1.12);

      for (const entry of placed) {
        const { local, member } = entry;
        const world = [
          region.center[0] + basis[0][0] * local[0] + basis[1][0] * local[1] + basis[2][0] * local[2],
          region.center[1] + basis[0][1] * local[0] + basis[1][1] * local[1] + basis[2][1] * local[2],
          region.center[2] + basis[0][2] * local[0] + basis[1][2] * local[1] + basis[2][2] * local[2],
        ];

        out.push(
          this.#embed(member, {
            position: world,
            local,
            scale: entry.scale,
            extent: entry.extent,
            phase: entry.phase,
          })
        );
      }
    }

    return out;
  }

  // ── recursion: lazy sub-embeddings ──────────────────────────────────────

  /**
   * One embedded node — the shape every consumer works with, at every depth.
   * A depth-0 concept and a depth-7 concept are indistinguishable here, which
   * is what lets the Firmament, the Navigator and the Interaction layer stay
   * ignorant of how deep you have gone.
   */
  #embed(node, { position, local, scale, extent, phase, parentEmbed = null }) {
    const { substrate } = this;
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      domainId: node.domainId,
      domainIndex: node.domainIndex,
      isAnchor: node.isAnchor,
      depth: node.depth,
      parentId: node.parentId,
      weight: node.weight,
      salience: substrate.salience(node),
      position,
      local,
      /** World height of the rendered word. Width is derived from the glyph atlas. */
      scale,
      /** Approximate world width — spacing, and the LOD budget, both need it. */
      extent,
      /** Stable per-node phase so pulses never march in lockstep. */
      phase,
      /**
       * Camera distance at which this node's children begin to emerge.
       * Authored when the ontology says so, derived from the node's own scale
       * otherwise — a bigger word can be read from further away, so it should
       * open from further away too.
       */
      threshold: node.proximityThreshold ?? scale * this.options.thresholdRatio,
      childCount: node.childCount,
      /** The container this node emerged from; null at depth 0. */
      parent: parentEmbed,
    };
  }

  /**
   * The next scale down, in space. Computed the first time a node is approached
   * and cached forever after — the same sub-cluster must be in the same place
   * every time you return to it, or the Firmament would be rearranging itself
   * behind your back.
   *
   * Children are placed on a jittered shell around the parent word, small
   * enough that the parent reads as their local anchor. Nothing here knows or
   * cares what depth it is operating at.
   */
  embedChildren(parentEmbed) {
    const cached = this._childEmbeddings.get(parentEmbed.id);
    if (cached) return cached;

    let children = this.substrate.children(parentEmbed.id);
    if (!children.length) {
      this._childEmbeddings.set(parentEmbed.id, EMPTY_EMBEDDING);
      return EMPTY_EMBEDDING;
    }
    // A record can put hundreds of entries under one node. Instantiating all of
    // them at once rasterises hundreds of glyphs in a single frame — a stall on
    // weak GPUs. Embed the most-answered first; the rest stay latent, reachable
    // only through the ones that were answered (their own nesting).
    const cap = this.options.maxChildrenPerOpen ?? 140;
    if (children.length > cap) {
      children = [...children].sort((a, b) => b.weight - a.weight).slice(0, cap);
    }

    const rng = this.rng.fork(`nested:${parentEmbed.id}`);
    const { nestedRadius, nestedScale, nestedSpread, nestedLift } = this.options;
    // A shell sized for a dozen words cannot hold six hundred. Area grows with the
    // count, so radius grows with its square root; a small thread is unaffected.
    const crowd = Math.max(1, Math.sqrt(children.length / 12));
    const shellRadius = Math.max(
      parentEmbed.scale * nestedRadius,
      parentEmbed.extent * nestedSpread
    ) * crowd;

    // The parent participates in relaxation as an immovable body, so its own
    // word never ends up underneath its children.
    //
    // Inflated, because by the time these children are visible the parent has
    // been promoted and is rendering larger than its nominal extent. Relaxing
    // against the un-promoted size puts the nearest child inside the word it
    // belongs to at exactly the moment you arrive to read it.
    const placed = [
      {
        local: [0, 0, 0],
        extent: parentEmbed.extent,
        padded: parentEmbed.extent * this.options.promotionAllowance,
        fixed: true,
      },
    ];

    const ordered = [...children].sort((a, b) => b.weight - a.weight);
    const entries = ordered.map((child, index) => {
      const scale = parentEmbed.scale * nestedScale * lerp(0.78, 1.15, easeWeight(child.weight));
      const extent = scale * (0.62 * child.label.length + 0.4);

      // Fibonacci shell, seeded and jittered: even coverage without symmetry.
      const dir = fibonacciDirection(index, ordered.length, rng);
      const radius = shellRadius * lerp(0.82, 1.18, rng.next()) * lerp(1.05, 0.88, easeWeight(child.weight));

      // The shell is stretched vertically, and in *world* axes rather than a
      // seeded basis. Both parts of that are deliberate.
      //
      // The Navigator has yaw and pitch but no roll, so world-up is always
      // screen-up. And a word is a wide, short object: clearing it above or
      // below costs a fraction of what clearing it sideways costs. Lifting the
      // shell therefore buys legibility that a uniform sphere cannot, and it
      // only works because the offsets are not rotated into an arbitrary frame
      // on the way out.
      const local = [dir[0] * radius, dir[1] * radius * nestedLift, dir[2] * radius];

      const entry = {
        child,
        local,
        scale,
        extent,
        // A child that branches will itself be promoted when reached.
        padded: child.childCount ? extent * this.options.promotionAllowance : extent,
        phase: rng.range(0, TAU),
      };
      placed.push(entry);
      return entry;
    });

    this.#relax(placed, shellRadius * 1.6);

    const embedded = entries.map((entry) => {
      const { local } = entry;
      const position = [
        parentEmbed.position[0] + local[0],
        parentEmbed.position[1] + local[1],
        parentEmbed.position[2] + local[2],
      ];

      // An authored container-relative position overrides derivation entirely.
      const authored = entry.child.position;
      const finalPosition = authored
        ? [
            parentEmbed.position[0] + authored[0],
            parentEmbed.position[1] + authored[1],
            parentEmbed.position[2] + authored[2],
          ]
        : position;

      return this.#embed(entry.child, {
        position: finalPosition,
        local,
        scale: entry.scale,
        extent: entry.extent,
        phase: entry.phase,
        parentEmbed,
      });
    });

    // How far the children reach. The Resolution keeps a parent open while the
    // camera is anywhere among them, not only near the parent's own word.
    parentEmbed.reach = embedded.reduce(
      (max, e) => Math.max(max, Math.hypot(e.local[0], e.local[1], e.local[2]) + e.extent),
      0
    );

    this._childEmbeddings.set(parentEmbed.id, embedded);
    return embedded;
  }

  /** How many sub-embeddings have actually been computed. Proof of laziness. */
  get embeddedBranches() {
    return this._childEmbeddings.size;
  }

  /**
   * Sampling gets the character right — organic, weight-biased, un-gridded —
   * but it cannot guarantee that two long words never end up in each other's
   * space. A short relaxation pass fixes that without regularising anything:
   * words only move when they are too close, and only far enough to stop being
   * too close. The centre never moves — the anchor of a region, or the parent
   * word of a sub-cluster. Everything else yields around it.
   *
   * Depth-agnostic on purpose: the same routine spaces the vocabulary of a
   * domain and the vocabulary inside a single word.
   */
  #relax(placed, limit) {
    const immovable = (entry) => entry.fixed === true || entry.member?.isAnchor === true;

    for (let step = 0; step < 140; step++) {
      let settled = true;

      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i];
          const b = placed[j];
          // Two gap rules, because two situations.
          //
          // Between ordinary words, 0.3 of their combined width: enough to keep
          // them out of each other's volume, not enough to guarantee they never
          // align on screen. Full clearance there would sparsify a region into a
          // lattice, and two words at different depths can stack from one angle
          // no matter what — parallax is the real answer to that.
          //
          // Against the centre, 0.58 — near-true half-width clearance. A parent
          // word sits at the middle of its own sub-cluster, so *every* child can
          // line up horizontally with it, and "rare" becomes "always" for the
          // one pair the reader most needs to tell apart.
          const gap = a.fixed || b.fixed ? 0.58 : 0.3;
          const required = (extentOf(a) + extentOf(b)) * gap;

          let dx = b.local[0] - a.local[0];
          let dy = b.local[1] - a.local[1];
          let dz = b.local[2] - a.local[2];
          const d = Math.hypot(dx, dy, dz) || 1e-4;
          if (d >= required) continue;

          settled = false;
          const push = ((required - d) / d) * 0.5;
          dx *= push;
          dy *= push;
          dz *= push;

          // The centre holds its ground; everything else yields around it.
          if (immovable(a)) {
            b.local[0] += dx * 2;
            b.local[1] += dy * 2;
            b.local[2] += dz * 2;
          } else if (immovable(b)) {
            a.local[0] -= dx * 2;
            a.local[1] -= dy * 2;
            a.local[2] -= dz * 2;
          } else {
            a.local[0] -= dx;
            a.local[1] -= dy;
            a.local[2] -= dz;
            b.local[0] += dx;
            b.local[1] += dy;
            b.local[2] += dz;
          }
        }
      }

      // Keep the container a container.
      for (const entry of placed) {
        if (immovable(entry)) continue;
        const r = Math.hypot(entry.local[0], entry.local[1], entry.local[2]);
        if (r > limit) {
          const k = limit / r;
          entry.local[0] *= k;
          entry.local[1] *= k;
          entry.local[2] *= k;
        }
      }

      if (settled) break;
    }
  }

  /**
   * Rejection sampling with a weight-driven radial bias: central concepts sit
   * near the anchor, peripheral ones drift toward the region's edge, and words
   * try not to occupy each other's space.
   */
  #sampleMemberPosition(rng, region, shape, member, scale, placed) {
    const bias = 1 - easeWeight(member.weight); // 0 = central, 1 = peripheral
    const rMin = lerp(0.16, 0.5, bias);
    const rMax = lerp(0.56, 1.0, bias);
    const extent = scale * (0.62 * member.label.length + 0.4);

    let fallback = null;
    let bestSpread = -Infinity;

    for (let attempt = 0; attempt < 64; attempt++) {
      const dir = rng.onSphere();
      const r = lerp(rMin, rMax, Math.cbrt(rng.next())) * region.radius;
      const p = [dir[0] * r * shape[0], dir[1] * r * shape[1], dir[2] * r * shape[2]];

      // Because words billboard, two concepts can collide on screen from some
      // angles no matter what. Half the mean word extent keeps that rare
      // without forcing the region into a lattice.
      let worst = Infinity;
      for (const other of placed) {
        const d = Math.hypot(p[0] - other.local[0], p[1] - other.local[1], p[2] - other.local[2]);
        worst = Math.min(worst, d - (extent + other.extent) * 0.32);
      }

      if (worst > bestSpread) {
        bestSpread = worst;
        fallback = p;
      }
      if (worst > 0) return p;
    }

    // Nothing cleared — take the roomiest attempt rather than the first.
    return fallback;
  }

  // ── filaments: the spatial trace of a relationship ──────────────────────

  #traceFilaments() {
    const { substrate, options } = this;
    const rng = this.rng.fork('filaments');

    return substrate.relationships.map((rel) => {
      const a = this.region(rel.from);
      const b = this.region(rel.to);

      const dir = normalize([
        b.center[0] - a.center[0],
        b.center[1] - a.center[1],
        b.center[2] - a.center[2],
      ]);

      // Filaments emerge from inside the semantic volume, so they dissolve
      // into the region rather than docking against it like an edge.
      const start = add(a.center, scaleV(dir, a.radius * 0.35));
      const end = add(b.center, scaleV(dir, -b.radius * 0.35));

      // A weak relationship sags further off the direct line: causality that
      // is barely exercised takes the long way round.
      const sag = lerp(0.22, 0.05, rel.weight);
      const perp = normalize(cross(dir, rng.onSphere()));
      const span = dist(start, end);

      const control = [
        add(
          lerpV(start, end, 0.33),
          scaleV(perp, span * sag * rng.range(0.6, 1) * (rng.next() < 0.5 ? -1 : 1))
        ),
        add(
          lerpV(start, end, 0.67),
          scaleV(perp, span * sag * rng.range(0.6, 1) * (rng.next() < 0.5 ? -1 : 1))
        ),
      ];

      return {
        id: rel.id,
        relationshipId: rel.id,
        from: rel.from,
        to: rel.to,
        fromIndex: rel.fromIndex,
        toIndex: rel.toIndex,
        weight: rel.weight,
        strength: rel.strength,
        type: rel.type,
        /** Control points for a Catmull-Rom curve, resolved by the Firmament. */
        spline: [start, ...control, end],
        segments: options.filamentSegments,
        phase: rng.range(0, TAU),
        length: span,
      };
    });
  }

  /** A placed surface concept, by id. */
  concept(id) {
    return this._conceptById.get(id) ?? null;
  }

  /**
   * Concept filaments — the fine structure of the web.
   *
   * A domain filament runs centre to centre and says two fields of knowledge
   * bear on each other. These run word to word, and say which two ideas the
   * bearing actually passes through. They are drawn from the *word*, not from
   * the region, so from inside a cluster you can see a specific concept reach
   * across the void to a specific concept elsewhere.
   *
   * Straighter and shorter-sagging than domain filaments: a claim this specific
   * should look like it took the direct route.
   */
  #traceConceptFilaments() {
    const rng = this.rng.fork('concept-filaments');
    const out = [];

    const neighbourhood = (concept) => {
      const region = this.region(concept.domainId);
      return Math.min(concept.threshold, (region?.radius ?? 250) * 1.25);
    };

    for (const rel of this.substrate.conceptRelationships) {
      const a = this.concept(rel.from);
      const b = this.concept(rel.to);
      if (!a || !b) continue;

      const dir = normalize([
        b.position[0] - a.position[0],
        b.position[1] - a.position[1],
        b.position[2] - a.position[2],
      ]);

      // Clear of the words themselves, so a strand never crosses the letters of
      // the concept it belongs to.
      const start = add(a.position, scaleV(dir, a.extent * 0.4 + a.scale));
      const end = add(b.position, scaleV(dir, -(b.extent * 0.4 + b.scale)));

      const span = dist(start, end);
      const sag = lerp(0.11, 0.025, rel.weight);
      const perp = normalize(cross(dir, rng.onSphere()));
      const swing = rng.next() < 0.5 ? -1 : 1;

      out.push({
        id: rel.id,
        relationshipId: rel.id,
        from: rel.from,
        to: rel.to,
        fromDomain: a.domainId,
        toDomain: b.domainId,
        fromIndex: a.domainIndex,
        toIndex: b.domainIndex,
        fromLabel: a.label,
        toLabel: b.label,
        weight: rel.weight,
        type: rel.type,
        /** Screen-space width in CSS pixels — finer than any domain filament. */
        width: lerp(0.55, 1.45, rel.weight),
        spline: [
          start,
          add(lerpV(start, end, 0.35), scaleV(perp, span * sag * rng.range(0.7, 1) * swing)),
          add(lerpV(start, end, 0.65), scaleV(perp, span * sag * rng.range(0.7, 1) * -swing)),
          end,
        ],
        segments: this.options.conceptFilamentSegments,
        phase: rng.range(0, TAU),
        length: span,
        /**
         * The distance at which each end becomes perceptible.
         *
         * A concept strand is a *neighbourhood* phenomenon: it should answer
         * because you are standing near one of its words, not because one of its
         * words is large. Taken from the endpoint's own threshold — scale-aware,
         * so a small word answers from closer in — but capped by the radius of
         * the region it sits in.
         *
         * Without that cap, anchors ruin it. An anchor's threshold is around 950
         * units because the word is enormous, so every strand touching one would
         * be half-lit from the arrival position, and thirty-odd half-lit strands
         * across the void is precisely the node-link diagram this must never
         * become.
         */
        fromRange: neighbourhood(a),
        toRange: neighbourhood(b),
      });
    }

    return out;
  }

  describe() {
    return {
      fieldRadius: Math.round(this.fieldRadius),
      regions: this.regions.length,
      concepts: this.concepts.length,
      filaments: this.filaments.length,
      conceptFilaments: this.conceptFilaments.length,
      separation: this.options.separation,
      embeddedBranches: this.embeddedBranches,
    };
  }
}

// ── vector helpers (plain arrays — the Substrate side stays THREE-free) ────

function easeWeight(w) {
  // Slight contrast boost so centrality reads clearly in scale and opacity.
  return clamp01(Math.pow(clamp01(w), 1.35));
}

function normalize(v) {
  const d = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / d, v[1] / d, v[2] / d];
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaleV = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const lerpV = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const EMPTY_EMBEDDING = Object.freeze([]);

/**
 * The width to space a word by. A node that has children can be promoted, and a
 * promoted word renders larger than its nominal extent — so it must be given the
 * room it will occupy at its largest, not the room it occupies at rest.
 */
const extentOf = (entry) => entry.padded ?? entry.extent;

/**
 * Even coverage of a sphere without symmetry. The golden-angle spiral gives
 * children room from each other; the seeded jitter keeps a sub-cluster from
 * reading as a diagram of a molecule.
 */
function fibonacciDirection(index, count, rng) {
  const offset = rng.next();
  const y = count === 1 ? 0 : 1 - (2 * (index + 0.5)) / count;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = (index + offset) * 2.39996323;
  const jitter = 0.22;
  return normalize([
    Math.cos(theta) * radius + rng.range(-jitter, jitter),
    y + rng.range(-jitter, jitter),
    Math.sin(theta) * radius + rng.range(-jitter, jitter),
  ]);
}

/** A seeded right-handed basis. */
function orthonormalBasis(rng) {
  const u = normalize(rng.onSphere());
  let t = rng.onSphere();
  // Guard against a degenerate parallel pick.
  if (Math.abs(u[0] * t[0] + u[1] * t[1] + u[2] * t[2]) > 0.94) t = rng.onSphere();
  const v = normalize(cross(u, t));
  const w = cross(u, v);
  return [u, v, w];
}

