import * as THREE from 'three';
import { GlyphAtlas } from './GlyphAtlas.js';
import { tintFor } from './palette.js';
import { COMMON, BILLBOARD } from './shaders.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT — typography particles                                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Concepts are rendered as words suspended in space. Not labels attached to
 * nodes — there are no nodes. The word *is* the rendering of the concept.
 *
 * Every word in the Firmament is one instance of one quad, in one draw call, at any
 * depth. A depth-0 domain concept and a depth-7 nested concept are the same kind
 * of object here; only their scale and their state differ.
 *
 * ── SEMANTIC MAGNIFICATION ────────────────────────────────────────────────
 *
 * A word's opacity is a function of how large it currently is on screen.
 * Nothing switches layers, nothing pops in: proximity increases resolving
 * power, exactly as it does for the eye. Anchors resolve out of the atmosphere
 * from thousands of units away; the fine vocabulary of a region assembles only
 * once you are inside it; the vocabulary inside a single word waits until you
 * have gone to that word.
 *
 * ── OBJECT POOL ───────────────────────────────────────────────────────────
 *
 * Instance slots are pooled. The Resolution system says what exists right now;
 * this allocates a slot per node and frees it when the camera leaves, with a
 * swap-remove so active slots stay contiguous and the draw stays one call. The
 * buffers are sized once, at capacity, and never reallocated — which is what
 * makes unbounded depth affordable.
 *
 * ── TWO REPRESENTATIONS ───────────────────────────────────────────────────
 *
 * Each resolved concept is drawn as typography *and* as a mote of light, with
 * the mote's opacity the exact inverse of the word's. Too far to read is not
 * the same as absent: structure stays perceptible as light long before it is
 * legible as language, which is what makes approach feel like resolution
 * rather than loading.
 */
export class Typography {
  constructor(embedding, { legibility = 55, fogDensity = 0.00012, capacity = 4096, atlasSize, atlasMax } = {}) {
    this.embedding = embedding;
    this.capacity = capacity;
    this.legibility = legibility;

    this.atlas = new GlyphAtlas({ size: atlasSize ?? 4096, maxSize: atlasMax ?? 8192 });
    this.atlasGeneration = this.atlas.generation;

    const texture = new THREE.CanvasTexture(this.atlas.canvas);
    texture.flipY = false; // atlas UVs are measured top-down
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.colorSpace = THREE.NoColorSpace; // the atlas is a coverage mask
    this.texture = texture;

    // ── pooled instance buffers ───────────────────────────────────────────
    this.positions = new Float32Array(capacity * 3);
    this.scales = new Float32Array(capacity * 2);
    this.uvs = new Float32Array(capacity * 4);
    this.meta = new Float32Array(capacity * 4);
    this.tints = new Float32Array(capacity * 3);
    /** attention, emergence, promotion, suppression — the only per-frame data. */
    this.state = new Float32Array(capacity * 4);

    this.slotOf = new Map();
    this.slotToRecord = new Array(capacity).fill(null);
    this.free = [];
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
    this.activeCount = 0;
    this.dropped = 0;

    const base = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.attributes.position);
    geometry.setAttribute('uv', base.attributes.uv);

    this.aPosition = dynamic(new THREE.InstancedBufferAttribute(this.positions, 3));
    this.aScale = dynamic(new THREE.InstancedBufferAttribute(this.scales, 2));
    this.aUv = dynamic(new THREE.InstancedBufferAttribute(this.uvs, 4));
    this.aMeta = dynamic(new THREE.InstancedBufferAttribute(this.meta, 4));
    this.aTint = dynamic(new THREE.InstancedBufferAttribute(this.tints, 3));
    this.aState = dynamic(new THREE.InstancedBufferAttribute(this.state, 4));

    geometry.setAttribute('iPosition', this.aPosition);
    geometry.setAttribute('iScale', this.aScale);
    geometry.setAttribute('iUV', this.aUv);
    geometry.setAttribute('iMeta', this.aMeta);
    geometry.setAttribute('iTint', this.aTint);
    geometry.setAttribute('iState', this.aState);
    geometry.instanceCount = 0;
    base.dispose();

    const shared = {
      uTime: { value: 0 },
      uLegibility: { value: legibility },
      uFogDensity: { value: fogDensity },
      // Promotion is mostly luminosity and only a little size. Scale is the
      // expensive half — a word that grows a third larger collides with the
      // vocabulary it just brought into being — and it is the less legible
      // half, since apparent size is already increasing as you approach.
      uPromoteScale: { value: 0.2 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uAtlas: { value: texture },
        uExposure: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 iPosition;
        attribute vec2 iScale;
        attribute vec4 iUV;
        attribute vec4 iMeta;    // weight, isAnchor, phase, depth
        attribute vec3 iTint;
        attribute vec4 iState;   // attention, emergence, promotion, suppression

        uniform float uTime;
        uniform float uLegibility;
        uniform float uFogDensity;
        uniform float uPromoteScale;

        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vTint;

        ${COMMON}
        ${BILLBOARD}

        void main() {
          float attention  = iState.x;
          float emergence  = iState.y;
          float promotion  = iState.z;
          float suppression = iState.w;

          // A concept approached becomes the local anchor of its own scale:
          // larger and more luminous. Its POSITION never changes — promotion is
          // a change in salience, not in topology. And the glyph style never
          // changes either, because a word switching case mid-approach would be
          // exactly the hard transition this whole system exists to avoid.
          vec2 size = iScale * (1.0 + uPromoteScale * promotion);

          float dist;
          gl_Position = billboard(iPosition, position.xy, size, dist);

          // Atlas lookup: uv.y = 1 is the top of the word, iUV.y is its top row.
          vUv = vec2(mix(iUV.x, iUV.z, uv.x), mix(iUV.w, iUV.y, uv.y));

          // Semantic magnification — resolve by apparent size, not by layer.
          float legible = size.y * uLegibility;
          float resolve = fadeIn(legible * 0.75, legible * 2.6, dist);

          // Do not let the camera pass through a wall of text.
          float breach = smoothstep(size.y * 0.35, size.y * 1.25, dist);

          float base = 0.32 + 0.68 * iMeta.x;
          float anchor = mix(1.0, 1.28, iMeta.y);
          float attend = 0.42 + 0.58 * attention;
          float breathe = 0.94 + 0.06 * sin(uTime * 0.55 + iMeta.z);

          vAlpha = base * anchor * resolve * breach * attend * breathe
                 * emergence
                 * (1.0 + 0.55 * promotion)
                 * (1.0 - 0.62 * suppression)
                 * fogFade(uFogDensity, dist);

          // Attention and promotion both pull a word toward white — luminosity,
          // not a change of colour.
          vTint = mix(iTint, vec3(1.0), 0.22 * attention + 0.3 * promotion);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        uniform float uExposure;

        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vTint;

        void main() {
          float coverage = texture2D(uAtlas, vUv).a;
          float a = coverage * vAlpha * uExposure;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vTint * (0.8 + 0.4 * vAlpha), a);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Mesh(geometry, this.material);
    this.object.frustumCulled = false; // instanced positions are not in the base bounds
    this.object.renderOrder = 20;
    this.object.name = 'firmament.typography';
    this.geometry = geometry;

    // ── motes: the same concepts, as points of light ──────────────────────
    const moteRange = Math.max(600, embedding.fieldRadius * 1.6);
    const moteGeometry = new THREE.BufferGeometry();
    // Deliberately the same Float32Arrays as the instanced buffers above: one
    // source of truth for where a concept is, two ways of showing it.
    this.moteAPosition = dynamic(new THREE.BufferAttribute(this.positions, 3));
    this.moteAMeta = dynamic(new THREE.BufferAttribute(this.meta, 4));
    this.moteAState = dynamic(new THREE.BufferAttribute(this.state, 4));
    this.moteAScale = dynamic(new THREE.BufferAttribute(this.scales, 2));
    this.moteATint = dynamic(new THREE.BufferAttribute(this.tints, 3));
    moteGeometry.setAttribute('position', this.moteAPosition);
    moteGeometry.setAttribute('aMeta', this.moteAMeta);
    moteGeometry.setAttribute('aState', this.moteAState);
    moteGeometry.setAttribute('aScale', this.moteAScale);
    moteGeometry.setAttribute('aTint', this.moteATint);
    moteGeometry.setDrawRange(0, 0);
    moteGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.moteMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uProjScale: { value: 800 },
        uIntensity: { value: 0.42 },
        uRange: { value: new THREE.Vector2(moteRange, moteRange * 2.6) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aMeta;
        attribute vec4 aState;
        attribute vec2 aScale;
        attribute vec3 aTint;

        uniform float uTime;
        uniform float uLegibility;
        uniform float uFogDensity;
        uniform float uProjScale;
        uniform float uIntensity;
        uniform vec2 uRange;

        varying float vAlpha;
        varying vec3 vTint;

        ${COMMON}

        void main() {
          vec4 mv = viewMatrix * vec4(position, 1.0);
          float dist = max(length(mv.xyz), 1e-3);
          gl_Position = projectionMatrix * mv;

          float legible = aScale.y * uLegibility;
          float resolve = fadeIn(legible * 0.75, legible * 2.6, dist);

          // The exact inverse of the word: a concept is either legible or it is
          // a point of light, and it is never nothing.
          float unresolved = 1.0 - resolve;
          float reach = fadeIn(uRange.x, uRange.y, dist);
          float twinkle = 0.72 + 0.28 * sin(uTime * 0.5 + aMeta.z * 3.1);

          gl_PointSize = clamp(aScale.y * 0.22 * uProjScale / dist, 0.8, 3.2);
          vAlpha = uIntensity * unresolved * reach * aState.y * twinkle
                 * (0.45 + 0.55 * aState.x)
                 * (0.35 + 0.65 * aMeta.x)
                 * fogFade(uFogDensity, dist);
          vTint = aTint;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vTint;

        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float falloff = pow(max(0.0, 1.0 - d), 2.0);
          float a = falloff * vAlpha;
          if (a < 0.002) discard;
          gl_FragColor = vec4(vTint, a);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.motes = new THREE.Points(moteGeometry, this.moteMaterial);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 18;
    this.motes.name = 'firmament.typography.motes';
    this.moteGeometry = moteGeometry;

    this.group = new THREE.Group();
    this.group.name = 'firmament.language';
    this.group.add(this.motes, this.object);
  }

  // ── pool ────────────────────────────────────────────────────────────────

  #claim(record) {
    if (this.slotOf.has(record.id)) return this.slotOf.get(record.id);

    const slot = this.free.pop();
    if (slot === undefined) {
      this.dropped++;
      return -1;
    }

    const embed = record.embed;
    const style = embed.isAnchor ? 'anchor' : 'concept';
    this.atlas.add([{ text: embed.label, style }]);
    const cell = this.atlas.get(embed.label, style);
    const tint = tintFor(embed.domainId);

    this.positions[slot * 3 + 0] = embed.position[0];
    this.positions[slot * 3 + 1] = embed.position[1];
    this.positions[slot * 3 + 2] = embed.position[2];

    this.scales[slot * 2 + 0] = embed.scale * (cell ? cell.aspect : 4);
    this.scales[slot * 2 + 1] = embed.scale;

    this.#writeUv(slot, cell);

    this.meta[slot * 4 + 0] = embed.weight;
    this.meta[slot * 4 + 1] = embed.isAnchor ? 1 : 0;
    this.meta[slot * 4 + 2] = embed.phase;
    this.meta[slot * 4 + 3] = embed.depth;

    this.tints[slot * 3 + 0] = tint[0];
    this.tints[slot * 3 + 1] = tint[1];
    this.tints[slot * 3 + 2] = tint[2];

    // Emerging from nothing, always. Never a frame at full opacity.
    this.state[slot * 4 + 0] = 0;
    this.state[slot * 4 + 1] = 0;
    this.state[slot * 4 + 2] = 0;
    this.state[slot * 4 + 3] = 0;

    this.slotOf.set(record.id, slot);
    this.slotToRecord[slot] = record;
    return slot;
  }

  #writeUv(slot, cell) {
    if (!cell) return;
    this.uvs[slot * 4 + 0] = cell.uv[0];
    this.uvs[slot * 4 + 1] = cell.uv[1];
    this.uvs[slot * 4 + 2] = cell.uv[2];
    this.uvs[slot * 4 + 3] = cell.uv[3];
  }

  /** Swap-remove, so the active slots stay contiguous and the draw stays one call. */
  #release(id) {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return;
    this.slotOf.delete(id);
    this.slotToRecord[slot] = null;
    this.free.push(slot);
  }

  /**
   * Reconcile with the Resolution system, then compact.
   *
   * Reconciliation compares the pool against the *whole* resolved set rather
   * than consuming a per-frame diff. The diff would be cheaper, and it is what
   * this did first — but it made correctness depend on the renderer draining
   * every frame's changes in the right order, and anything that stepped the
   * simulation without drawing (a warm-up, a test harness, a second consumer)
   * silently lost words with no error anywhere. Comparing sets is idempotent:
   * call it twice, call it late, call it never — the pool still ends up
   * describing exactly what is resolved. A few hundred map lookups a frame is a
   * fair price for an invariant that cannot be broken by ordering.
   */
  sync(resolution, attention) {
    if (this.atlas.generation !== this.atlasGeneration) {
      // The atlas repacked. Every UV in flight is now wrong.
      this.atlasGeneration = this.atlas.generation;
      for (const [id, slot] of this.slotOf) {
        const embed = resolution.active.get(id)?.embed;
        if (embed) this.#writeUv(slot, this.atlas.get(embed.label, embed.isAnchor ? 'anchor' : 'concept'));
      }
    }

    let churned = false;

    // Gone from the resolved set — release the slot.
    for (const id of [...this.slotOf.keys()]) {
      if (!resolution.active.has(id)) {
        this.#release(id);
        churned = true;
      }
    }

    // Newly resolved — claim one.
    for (const record of resolution.active.values()) {
      if (!this.slotOf.has(record.id)) {
        this.#claim(record);
        churned = true;
      }
    }

    if (churned) this.#compact();

    // Per-frame state for the live prefix.
    for (let slot = 0; slot < this.activeCount; slot++) {
      const record = this.slotToRecord[slot];
      if (!record) continue;
      const i = slot * 4;
      this.state[i + 0] = attention[record.embed.domainIndex] ?? 0;
      this.state[i + 1] = record.emergence;
      this.state[i + 2] = record.promotion;
      this.state[i + 3] = record.suppression;
    }

    this.aState.needsUpdate = true;
    this.moteAState.needsUpdate = true;

    if (this.atlas.dirty) {
      this.texture.needsUpdate = true;
      this.atlas.dirty = false;
    }
  }

  /**
   * Collapse the pool back to a contiguous prefix. Only runs on frames where
   * something actually came into being or left, which is rare — approach is
   * continuous, but crossing a threshold is not.
   */
  #compact() {
    const order = [];
    for (const [, slot] of this.slotOf) order.push(slot);
    order.sort((a, b) => a - b);

    let write = 0;
    for (const slot of order) {
      if (slot !== write) this.#move(slot, write);
      write++;
    }

    // Everything above the prefix is free.
    this.free.length = 0;
    for (let i = this.capacity - 1; i >= write; i--) this.free.push(i);
    this.activeCount = write;

    this.geometry.instanceCount = write;
    this.moteGeometry.setDrawRange(0, write);

    this.aPosition.needsUpdate = true;
    this.aScale.needsUpdate = true;
    this.aUv.needsUpdate = true;
    this.aMeta.needsUpdate = true;
    this.aTint.needsUpdate = true;
    this.moteAPosition.needsUpdate = true;
    this.moteAScale.needsUpdate = true;
    this.moteAMeta.needsUpdate = true;
    this.moteATint.needsUpdate = true;
  }

  #move(from, to) {
    copyRange(this.positions, from, to, 3);
    copyRange(this.scales, from, to, 2);
    copyRange(this.uvs, from, to, 4);
    copyRange(this.meta, from, to, 4);
    copyRange(this.tints, from, to, 3);
    copyRange(this.state, from, to, 4);

    const record = this.slotToRecord[from];
    this.slotToRecord[to] = record;
    this.slotToRecord[from] = null;
    if (record) this.slotOf.set(record.id, to);
  }

  update(state) {
    this.material.uniforms.uTime.value = state.time;
    this.moteMaterial.uniforms.uTime.value = state.time;
    this.moteMaterial.uniforms.uProjScale.value = state.projScale;

    if (state.resolution) this.sync(state.resolution, state.attention);

    // Nothing resolvable in view — skip both draws entirely.
    const visible = this.activeCount > 0;
    this.object.visible = visible;
    this.motes.visible = visible;
  }

  describe() {
    return {
      capacity: this.capacity,
      active: this.activeCount,
      atlasSize: this.atlas.size,
      atlasWords: this.atlas.used,
      atlasPressure: Number(this.atlas.pressure.toFixed(2)),
      atlasRepacks: this.atlas.generation,
      droppedForCapacity: this.dropped,
    };
  }

  dispose() {
    this.geometry.dispose();
    this.moteGeometry.dispose();
    this.material.dispose();
    this.moteMaterial.dispose();
    this.texture.dispose();
  }
}

function dynamic(attribute) {
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

function copyRange(array, from, to, stride) {
  for (let k = 0; k < stride; k++) array[to * stride + k] = array[from * stride + k];
}
