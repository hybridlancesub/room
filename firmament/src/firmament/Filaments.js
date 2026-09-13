import * as THREE from 'three';
import { tintFor } from './palette.js';
import { COMMON } from './shaders.js';

/** Screen-space width in CSS pixels, by authored relationship strength. */
const WIDTH_BY_STRENGTH = { strong: 2.3, medium: 1.5, light: 0.9 };

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT — filaments                                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * A filament is the rendering of a relationship, not an edge in a graph. It is
 * always there and almost never visible: at rest it sits at a few hundredths of
 * opacity, a suspicion rather than a line.
 *
 * It brightens from the end nearest whatever holds your attention, so a
 * relationship reveals itself directionally — you notice what the place you are
 * standing in is connected *to*, which is a different experience from reading a
 * diagram of connections.
 *
 * ── TWO STRATA, ONE RENDERER ──────────────────────────────────────────────
 *
 * The Firmament draws relationships at two scales, and this class serves both. What
 * differs is not the geometry but *what makes a strand answer*, which the caller
 * supplies as `glowFor`:
 *
 *   domain strands   centre to centre, thicker, faintly present everywhere.
 *                    They answer to attention, so the macro web is legible from
 *                    outside the Firmament.
 *   concept strands  word to word across the void, hair-fine and dark until you
 *                    are near one of their endpoints. They answer to proximity,
 *                    which is what keeps thirty-odd of them from reading as a
 *                    node-link diagram: from far away there is almost nothing
 *                    there, and from inside a cluster a specific idea reaches
 *                    out to a specific idea somewhere else.
 *
 * Ribbons are expanded in screen space, so a filament stays hairline-thin at
 * every scale. Cosmic-web thin, not pipe-like.
 */
export class Filaments {
  /**
   * @param {object[]} filaments  from the Embedding — domain or concept strands
   * @param {object} options
   * @param {(filament: object, state: object) => [number, number]} options.glowFor
   *        the 0..1 response of each end, this frame
   */
  constructor(
    filaments,
    {
      fogDensity = 0.00012,
      base = 0.045,
      gain = 0.34,
      spread = 0.35,
      name = 'firmament.filaments',
      glowFor = () => [0, 0],
    } = {}
  ) {
    this.filaments = filaments;
    this.glowFor = glowFor;

    let vertexTotal = 0;
    let indexTotal = 0;
    for (const f of filaments) {
      vertexTotal += (f.segments + 1) * 2;
      indexTotal += f.segments * 6;
    }

    const positions = new Float32Array(vertexTotal * 3);
    const tangents = new Float32Array(vertexTotal * 3);
    const tints = new Float32Array(vertexTotal * 3);
    const sides = new Float32Array(vertexTotal);
    const ts = new Float32Array(vertexTotal);
    const widths = new Float32Array(vertexTotal);
    const phases = new Float32Array(vertexTotal);
    const indices = new Uint32Array(indexTotal);

    // Kept for the per-frame glow pass: which strand each vertex belongs to,
    // and how far along it sits.
    this.vertexFilament = new Int32Array(vertexTotal);
    this.vertexT = ts;
    this.glowArray = new Float32Array(vertexTotal);

    let v = 0;
    let idx = 0;

    filaments.forEach((f, fi) => {
      const curve = new THREE.CatmullRomCurve3(
        f.spline.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
        false,
        'catmullrom',
        0.5
      );
      const fromTint = tintFor(f.fromDomain ?? f.from);
      const toTint = tintFor(f.toDomain ?? f.to);
      const width = f.width ?? WIDTH_BY_STRENGTH[f.strength] ?? 1.2;
      const first = v;

      for (let s = 0; s <= f.segments; s++) {
        const t = s / f.segments;
        const p = curve.getPoint(t);
        const tan = curve.getTangent(t).normalize();

        // A filament carries both ends' light, mixed along its length.
        const tint = [
          fromTint[0] + (toTint[0] - fromTint[0]) * t,
          fromTint[1] + (toTint[1] - fromTint[1]) * t,
          fromTint[2] + (toTint[2] - fromTint[2]) * t,
        ];

        for (let side = 0; side < 2; side++, v++) {
          positions[v * 3 + 0] = p.x;
          positions[v * 3 + 1] = p.y;
          positions[v * 3 + 2] = p.z;
          tangents[v * 3 + 0] = tan.x;
          tangents[v * 3 + 1] = tan.y;
          tangents[v * 3 + 2] = tan.z;
          tints[v * 3 + 0] = tint[0];
          tints[v * 3 + 1] = tint[1];
          tints[v * 3 + 2] = tint[2];
          sides[v] = side === 0 ? -1 : 1;
          ts[v] = t;
          widths[v] = width;
          phases[v] = f.phase;
          this.vertexFilament[v] = fi;
        }
      }

      for (let s = 0; s < f.segments; s++) {
        const a = first + s * 2;
        indices[idx++] = a;
        indices[idx++] = a + 1;
        indices[idx++] = a + 2;
        indices[idx++] = a + 1;
        indices[idx++] = a + 3;
        indices[idx++] = a + 2;
      }
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aTan', new THREE.BufferAttribute(tangents, 3));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 3));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
    geometry.setAttribute('aT', new THREE.BufferAttribute(ts, 1));
    geometry.setAttribute('aWidth', new THREE.BufferAttribute(widths, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    this.glowAttribute = new THREE.BufferAttribute(this.glowArray, 1);
    this.glowAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aGlow', this.glowAttribute);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uWidthScale: { value: 1 },
        uBase: { value: base },
        uGain: { value: gain },
        uSpread: { value: spread },
        uFogDensity: { value: fogDensity },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aTan;
        attribute vec3 aTint;
        attribute float aSide;
        attribute float aT;
        attribute float aWidth;
        attribute float aPhase;
        attribute float aGlow;

        uniform float uTime;
        uniform vec2 uResolution;
        uniform float uWidthScale;
        uniform float uBase;
        uniform float uGain;
        uniform float uFogDensity;

        varying float vSide;
        varying float vAlpha;
        varying vec3 vTint;

        ${COMMON}

        void main() {
          vec4 mv = viewMatrix * vec4(position, 1.0);
          float dist = max(length(mv.xyz), 1e-3);
          vec4 clip = projectionMatrix * mv;

          // Screen-space ribbon expansion: constant apparent thickness at any
          // scale, which is what keeps filaments reading as filaments.
          vec4 clipT = projectionMatrix * (viewMatrix * vec4(position + aTan, 1.0));
          vec2 here = clip.xy / max(abs(clip.w), 1e-4) * uResolution;
          vec2 ahead = clipT.xy / max(abs(clipT.w), 1e-4) * uResolution;
          vec2 dir = ahead - here;
          float len = length(dir);
          dir = len > 1e-5 ? dir / len : vec2(1.0, 0.0);
          vec2 nrm = vec2(-dir.y, dir.x);

          clip.xy += nrm * aSide * (aWidth * uWidthScale) * clip.w / uResolution;
          gl_Position = clip;

          // Alive, not animated.
          float pulse = 0.84 + 0.16 * sin(uTime * 0.42 + aPhase + aT * 5.0);
          // Dissolve into the ends instead of docking against them.
          float ends = smoothstep(0.0, 0.14, aT) * (1.0 - smoothstep(0.86, 1.0, aT));
          // Never a line drawn across your face.
          float front = smoothstep(8.0, 70.0, dist);

          vAlpha = (uBase + uGain * aGlow) * pulse * ends * front
                 * fogFade(uFogDensity, dist);
          vSide = aSide;
          vTint = aTint;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vSide;
        varying float vAlpha;
        varying vec3 vTint;

        void main() {
          float soft = pow(max(0.0, 1.0 - abs(vSide)), 1.5);
          float a = soft * vAlpha;
          if (a < 0.0015) discard;
          gl_FragColor = vec4(vTint, a);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });

    this.geometry = geometry;
    this.object = new THREE.Mesh(geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 8;
    this.object.name = name;
  }

  peakGlow = 0;

  update(state) {
    this.material.uniforms.uTime.value = state.time;

    const spread = this.material.uniforms.uSpread.value;
    const glow = this.glowArray;
    const owner = this.vertexFilament;
    const t = this.vertexT;

    // One glowFor call per strand, not per vertex — there are up to a hundred
    // vertices behind every one of these.
    const ends = this.filaments.map((f) => this.glowFor(f, state));

    for (let i = 0; i < glow.length; i++) {
      const [a, b] = ends[owner[i]];
      // Weighted along the strand: the near end lights first, but the whole
      // length answers a little, so a relationship is legible as one thing.
      const local = a * (1 - t[i]) + b * t[i];
      glow[i] = Math.min(1, local + spread * Math.max(a, b));
    }
    this.glowAttribute.needsUpdate = true;

    // Published so the response can be asserted rather than merely looked at:
    // a concept strand must read as dark from the arrival position and bright
    // from beside one of its words.
    let peak = 0;
    for (let i = 0; i < glow.length; i++) peak = Math.max(peak, glow[i]);
    this.peakGlow = peak;
  }

  setViewport(width, height, pixelRatio) {
    this.material.uniforms.uResolution.value.set(width, height);
    this.material.uniforms.uWidthScale.value = pixelRatio;
  }

  describe() {
    return {
      strands: this.filaments.length,
      vertices: this.glowArray.length,
      peakGlow: Number((this.peakGlow ?? 0).toFixed(3)),
    };
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
