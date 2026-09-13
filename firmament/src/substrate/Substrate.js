import { clamp01 } from '../core/mathx.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE SUBSTRATE — semantics                                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * A read model over the authored ontology. It answers questions about meaning:
 * what exists, what relates to what, how central something is, and what lies
 * *inside* something.
 *
 * It knows nothing about space, colour, cameras or frames. Nothing in this file
 * may import THREE. That constraint is the whole point: the Substrate can be
 * swapped for a graph database or an embedding service without the Firmament
 * noticing.
 *
 * ── RECURSION ─────────────────────────────────────────────────────────────
 *
 * A concept is a potential cluster. `children(id)` resolves the next semantic
 * scale down, and it does so *lazily* — a node's children are normalised the
 * first time something asks for them, never at load. For an authored substrate
 * this is merely tidy. For a generated or remote one it is the difference
 * between a Firmament that opens and one that hangs, and it is the reason the
 * recursion has no depth limit anywhere in the code.
 *
 * Children inherit their container's domain. Context is structural: the same
 * word under two different containers is two different concepts, carrying the
 * relational weight of where it sits.
 */
export class Substrate {
  constructor(data) {
    this.raw = data;
    this.id = data.id;
    this.version = data.version;
    this.title = data.title;
    this.seed = data.seed;

    this._domains = [];
    this._byDomainId = new Map();
    this._byConceptId = new Map();
    this._childCache = new Map();
    this._relationships = [];
    this._relByDomain = new Map();
    this._conceptRelationships = [];
    this._conceptRelByConcept = new Map();

    this.#normalise(data);
  }

  #normalise(data) {
    data.domains.forEach((raw, index) => {
      const domain = {
        id: raw.id,
        label: raw.label,
        index,
        weight: clamp01(raw.weight ?? 1),
        subgroups: raw.subgroups ?? [],
        temporal: raw.temporal ?? null,
      };

      const anchor = this.#node(raw.anchor, {
        domain,
        parentId: null,
        depth: 0,
        forceType: 'anchor',
      });

      const concepts = raw.concepts.map((node) =>
        this.#node(node, { domain, parentId: null, depth: 0 })
      );

      // The anchor is a member of its own domain — it is the most central
      // concept, not a separate species of thing.
      domain.anchor = anchor;
      domain.concepts = concepts;
      domain.members = [anchor, ...concepts];
      domain.mass = domain.members.reduce((sum, m) => sum + m.weight, 0);

      this._domains.push(domain);
      this._byDomainId.set(domain.id, domain);
      this._relByDomain.set(domain.id, []);
    });

    for (const raw of data.relationships) {
      const [aId, bId] = raw.between;
      const a = this._byDomainId.get(aId);
      const b = this._byDomainId.get(bId);
      if (!a || !b) {
        console.warn(`[substrate] relationship ${raw.id} references an unknown domain`);
        continue;
      }
      const rel = {
        ...raw,
        weight: clamp01(raw.weight ?? 0.5),
        from: a.id,
        to: b.id,
        fromIndex: a.index,
        toIndex: b.index,
      };
      this._relationships.push(rel);
      this._relByDomain.get(a.id).push(rel);
      this._relByDomain.get(b.id).push(rel);
    }

    this.#normaliseConceptRelationships(data.conceptRelationships ?? []);
  }

  /**
   * Concept-level relationships: the specific pair of concepts a domain-level
   * relationship actually runs through.
   *
   * Two rules are enforced here rather than trusted, because a filament that
   * connects the wrong things is worse than no filament — it is a false claim
   * rendered as structure:
   *
   *   · both endpoints must exist, and must be at the surface of a domain. A
   *     nested endpoint cannot be honoured yet: its position does not exist
   *     until the camera has been near enough to embed it, so a strand to it
   *     would have nowhere to attach for most of the session.
   *   · endpoints must sit in different domains. Relatedness inside a domain is
   *     already carried by proximity to the anchor, and drawing it as well would
   *     turn a region into a diagram of itself.
   */
  #normaliseConceptRelationships(raws) {
    for (const raw of raws) {
      const [aId, bId] = raw.between;
      const a = this._byConceptId.get(aId);
      const b = this._byConceptId.get(bId);

      if (!a || !b) {
        const missing = [!a ? aId : null, !b ? bId : null].filter(Boolean).join(', ');
        console.warn(
          `[substrate] concept relationship ${raw.id} dropped: no surface concept "${missing}"`
        );
        continue;
      }
      if (a.domainId === b.domainId) {
        console.warn(
          `[substrate] concept relationship ${raw.id} dropped: ${aId} and ${bId} are both in "${a.domainId}"`
        );
        continue;
      }

      const rel = {
        ...raw,
        weight: clamp01(raw.weight ?? 0.5),
        from: a.id,
        to: b.id,
        fromDomain: a.domainId,
        toDomain: b.domainId,
        /** The domain-level relationship this strand is one instance of, if any. */
        domainRelationshipId: this.relationshipBetween(a.domainId, b.domainId)?.id ?? null,
      };

      this._conceptRelationships.push(rel);
      for (const id of [a.id, b.id]) {
        if (!this._conceptRelByConcept.has(id)) this._conceptRelByConcept.set(id, []);
        this._conceptRelByConcept.get(id).push(rel);
      }
    }
  }

  /**
   * Normalise one ConceptNode. The raw `nested` array is kept aside rather than
   * walked — descent happens on demand, in `children()`.
   */
  #node(raw, { domain, parentId, depth, forceType = null }) {
    const nested = raw.nested ?? [];
    const node = {
      id: raw.id,
      label: raw.label,
      weight: clamp01(raw.weight ?? 0.5),
      type: forceType ?? raw.type ?? (raw.weight >= 0.72 ? 'primary' : 'secondary'),
      /** Inherited, never re-declared: a nested concept belongs to its container's domain. */
      domainId: domain.id,
      domainIndex: domain.index,
      parentId,
      depth,
      isAnchor: (forceType ?? raw.type) === 'anchor',
      childCount: nested.length,
      /** Optional authored spatial hints. The Embedding derives these when absent. */
      proximityThreshold: raw.proximityThreshold ?? null,
      position: raw.position ?? null,
      /** Whatever the source knows about this node that is not meaning-structure (e.g. a record entry). Opaque here. */
      record: raw.record ?? null,
      _nested: nested,
    };

    this._byConceptId.set(node.id, node);
    return node;
  }

  // ── meaning primitives ──────────────────────────────────────────────────

  get domains() {
    return this._domains;
  }

  get domainCount() {
    return this._domains.length;
  }

  get relationships() {
    return this._relationships;
  }

  /** Cross-domain relationships between individual concepts. */
  get conceptRelationships() {
    return this._conceptRelationships;
  }

  conceptRelationshipsOf(conceptId) {
    return this._conceptRelByConcept.get(conceptId) ?? [];
  }

  domain(id) {
    return this._byDomainId.get(id) ?? null;
  }

  domainAt(index) {
    return this._domains[index] ?? null;
  }

  /**
   * Any node at any depth — but only once it has been resolved. A node deep in
   * an unvisited branch is not in the index yet, because nothing has needed it.
   */
  concept(id) {
    return this._byConceptId.get(id) ?? null;
  }

  /** Every depth-0 concept in the Firmament, anchors included, in authored order. */
  concepts() {
    const out = [];
    for (const d of this._domains) out.push(...d.members);
    return out;
  }

  relationshipsOf(domainId) {
    return this._relByDomain.get(domainId) ?? [];
  }

  relationshipBetween(aId, bId) {
    return (
      this._relationships.find(
        (r) =>
          (r.from === aId && r.to === bId) || (r.from === bId && r.to === aId)
      ) ?? null
    );
  }

  /** Relational weight between two domains; 0 when unrelated. */
  affinity(aId, bId) {
    if (aId === bId) return 1;
    return this.relationshipBetween(aId, bId)?.weight ?? 0;
  }

  /**
   * Base salience — a node's intrinsic claim on attention, before the
   * Interaction layer adds anything situational.
   *
   * Salience compounds down the tree: a node is as salient as it is central
   * *within a container that is itself only so salient*. Depth costs you
   * presence, which is why an unvisited branch reads as latent rather than
   * missing.
   */
  salience(conceptId) {
    const node = typeof conceptId === 'string' ? this.concept(conceptId) : conceptId;
    if (!node) return 0;

    const domain = this.domain(node.domainId);
    const context = node.parentId
      ? this.salience(node.parentId)
      : 0.65 + 0.35 * (domain?.weight ?? 1);

    return clamp01(node.weight * context);
  }

  // ── recursion ───────────────────────────────────────────────────────────

  /**
   * The next semantic scale down. Normalised on first call and cached; an empty
   * array for a leaf. This is the seam V1 left open and this version fills in —
   * note that nothing above it had to change to accommodate being filled in.
   */
  children(conceptId) {
    const cached = this._childCache.get(conceptId);
    if (cached) return cached;

    const parent = this.concept(conceptId);
    if (!parent || !parent._nested.length) {
      this._childCache.set(conceptId, EMPTY);
      return EMPTY;
    }

    const domain = this.domain(parent.domainId);
    const children = parent._nested.map((raw) =>
      this.#node(raw, { domain, parentId: parent.id, depth: parent.depth + 1 })
    );

    this._childCache.set(conceptId, children);
    return children;
  }

  hasChildren(conceptId) {
    const node = typeof conceptId === 'string' ? this.concept(conceptId) : conceptId;
    return Boolean(node && node.childCount > 0);
  }

  /** Ancestor chain, nearest first. Used for traces and for context display. */
  ancestry(conceptId) {
    const out = [];
    let node = this.concept(conceptId);
    while (node?.parentId) {
      node = this.concept(node.parentId);
      if (node) out.push(node);
    }
    return out;
  }

  /**
   * Walk the whole tree eagerly. Only for census and tooling — the runtime
   * deliberately never does this, or laziness would be a lie.
   */
  walk(visit, node = null, depth = 0) {
    if (node) {
      visit(node, depth);
      for (const child of this.children(node.id)) this.walk(visit, child, depth + 1);
      return;
    }
    for (const domain of this._domains) {
      for (const member of domain.members) this.walk(visit, member, 0);
    }
  }

  /**
   * Census from the raw data, without normalising anything. Counting the tree
   * must not resolve it, or laziness would be a claim the diagnostics quietly
   * falsify. `resolvedConcepts` is the honest counterpart: how much of the
   * ontology this session has actually had reason to look at.
   */
  describe() {
    let total = 0;
    let branching = 0;
    let maxDepth = 0;

    const count = (raw, depth) => {
      total++;
      maxDepth = Math.max(maxDepth, depth);
      const nested = raw.nested ?? [];
      if (nested.length) branching++;
      for (const child of nested) count(child, depth + 1);
    };
    for (const domain of this.raw.domains) {
      count(domain.anchor, 0);
      for (const concept of domain.concepts) count(concept, 0);
    }

    return {
      id: this.id,
      version: this.version,
      domains: this._domains.length,
      surfaceConcepts: this.concepts().length,
      totalConcepts: total,
      branchingConcepts: branching,
      maxDepth,
      resolvedConcepts: this._byConceptId.size,
      relationships: this._relationships.length,
      conceptRelationships: this._conceptRelationships.length,
    };
  }
}

const EMPTY = Object.freeze([]);
