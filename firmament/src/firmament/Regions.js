import * as THREE from 'three';
import { PointCloud } from './PointCloud.js';
import { tintFor } from './palette.js';
import { COMMON, BILLBOARD } from './shaders.js';
import { createRng } from '../core/rng.js';
import { lerp } from '../core/mathx.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT — volumetric semantic regions                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * A region is not a node and has no boundary. It is rendered as two things
 * that trade places as you approach:
 *
 *   1. a luminous volume  — what a domain looks like from far away, when its
 *      language is unreadable and only its weather is perceptible
 *   2. suspended matter   — dust that gives the volume interior depth and makes
 *      motion through it parallax rather than slide
 *
 * The glow never fully disappears. Even standing inside a region you should
 * feel that you are inside something.
 */
export class Regions {
  constructor(embedding, substrate, { fogDensity = 0.00012, spread = 3.1, dustPerRegion = 520 } = {}) {
    this.embedding = embedding;
    const regions = embedding.regions;
    const n = regions.length;

    // ── the luminous volume ────────────────────────────────────────────────
    const iPosition = new Float32Array(n * 3);
    const iRadius = new Float32Array(n);
    const iTint = new Float32Array(n * 3);
    const iSeed = new Float32Array(n);
    this.glowAttention = new Float32Array(n);

    regions.forEach((r, i) => {
      const tint = tintFor(r.domainId);
      iPosition[i * 3 + 0] = r.center[0];
      iPosition[i * 3 + 1] = r.center[1];
      iPosition[i * 3 + 2] = r.center[2];
      iRadius[i] = r.radius;
      iTint[i * 3 + 0] = tint[0];
      iTint[i * 3 + 1] = tint[1];
      iTint[i * 3 + 2] = tint[2];
      iSeed[i] = i * 7.13 + 1.7;
    });

    const base = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.attributes.position);
    geometry.setAttribute('uv', base.attributes.uv);
    geometry.setAttribute('iPosition', new THREE.InstancedBufferAttribute(iPosition, 3));
    geometry.setAttribute('iRadius', new THREE.InstancedBufferAttribute(iRadius, 1));
    geometry.setAttribute('iTint', new THREE.InstancedBufferAttribute(iTint, 3));
    geometry.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iSeed, 1));
    this.glowAttentionAttribute = new THREE.InstancedBufferAttribute(this.glowAttention, 1);
    this.glowAttentionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iAttention', this.glowAttentionAttribute);
    geometry.instanceCount = n;
    base.dispose();

    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSpread: { value: spread },
        uIntensity: { value: 0.5 },
        uFogDensity: { value: fogDensity },
      },
      vertexShader: /* glsl */ `
        attribute vec3 iPosition;
        attribute float iRadius;
        attribute vec3 iTint;
        attribute float iSeed;
        attribute float iAttention;

        uniform float uTime;
        uniform float uSpread;
        uniform float uIntensity;
        uniform float uFogDensity;

        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vTint;
        varying float vSeed;
        varying float vInside;

        ${COMMON}
        ${BILLBOARD}

        void main() {
          float extent = iRadius * uSpread;
          float dist;
          gl_Position = billboard(iPosition, position.xy, vec2(extent), dist);
          vUv = uv;
          vSeed = iSeed;

          // Far away a region is weather. Close up it becomes the air you are in.
          float exterior = smoothstep(iRadius * 1.1, iRadius * 5.5, dist);
          vInside = 1.0 - exterior;
          float presence = mix(0.42, 1.0, exterior);
          float attention = 0.6 + 0.7 * iAttention;

          vAlpha = uIntensity * presence * attention * fogFade(uFogDensity, dist);
          vTint = mix(iTint, vec3(1.0), 0.15 * iAttention);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;

        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vTint;
        varying float vSeed;
        varying float vInside;

        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          float ang = atan(p.y, p.x);

          // Regions are not circles. The wobble drifts almost imperceptibly:
          // the Firmament is alive, but it is not animated.
          float wobble =
              0.11 * sin(ang * 3.0 + vSeed)
            + 0.07 * sin(ang * 5.0 - vSeed * 1.7 + uTime * 0.045)
            + 0.04 * sin(ang * 8.0 + vSeed * 2.3 - uTime * 0.031);
          r *= 1.0 - wobble;

          float body = pow(max(0.0, 1.0 - clamp(r, 0.0, 1.0)), 2.7);
          float core = pow(max(0.0, 1.0 - clamp(r * 1.9, 0.0, 1.0)), 6.0);

          // Standing inside, the core would blow out — hollow it instead.
          float shape = body * mix(1.0, 0.55, vInside) + core * (1.0 - vInside) * 0.9;

          float a = shape * vAlpha;
          if (a < 0.002) discard;
          gl_FragColor = vec4(vTint, a);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.glowGeometry = geometry;
    this.glow = new THREE.Mesh(geometry, this.glowMaterial);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 10;
    this.glow.name = 'firmament.regions.glow';

    // ── suspended matter ──────────────────────────────────────────────────
    const total = n * dustPerRegion;
    const positions = new Float32Array(total * 3);
    const tints = new Float32Array(total * 3);
    const sizes = new Float32Array(total);
    const seeds = new Float32Array(total);
    const domainIndices = new Int32Array(total);

    let maxRadius = 0;
    let cursor = 0;
    regions.forEach((region, ri) => {
      const rng = createRng(`dust:${region.domainId}:${embedding.substrate.seed}`);
      const tint = tintFor(region.domainId);
      const domain = substrate.domainAt(ri);
      // Denser domains carry more matter — mass is visible before it is legible.
      const count = Math.round(dustPerRegion * lerp(0.8, 1.2, domain ? domain.weight : 1));
      maxRadius = Math.max(maxRadius, region.radius);

      for (let k = 0; k < count && cursor < total; k++, cursor++) {
        const [x, y, z] = rng.inBall();
        // Concentrated toward the anchor, trailing off past the nominal radius.
        const falloff = Math.pow(rng.next(), 0.45);
        const shape = region.shape ?? [1, 0.7, 0.9];
        const rad = region.radius * 1.32;
        const bx = x * falloff * rad * shape[0];
        const by = y * falloff * rad * shape[1];
        const bz = z * falloff * rad * shape[2];
        const basis = region.basis ?? [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ];

        positions[cursor * 3 + 0] =
          region.center[0] + basis[0][0] * bx + basis[1][0] * by + basis[2][0] * bz;
        positions[cursor * 3 + 1] =
          region.center[1] + basis[0][1] * bx + basis[1][1] * by + basis[2][1] * bz;
        positions[cursor * 3 + 2] =
          region.center[2] + basis[0][2] * bx + basis[1][2] * by + basis[2][2] * bz;

        tints[cursor * 3 + 0] = tint[0];
        tints[cursor * 3 + 1] = tint[1];
        tints[cursor * 3 + 2] = tint[2];
        sizes[cursor] = rng.range(0.7, 2.6);
        seeds[cursor] = rng.next();
        domainIndices[cursor] = ri;
      }
    });

    this.dust = new PointCloud({
      positions: positions.subarray(0, cursor * 3),
      tints: tints.subarray(0, cursor * 3),
      sizes: sizes.subarray(0, cursor),
      seeds: seeds.subarray(0, cursor),
      domainIndices: domainIndices.subarray(0, cursor),
      name: 'firmament.regions.dust',
      intensity: 0.34,
      nearFade: [4, 55],
      farFade: [maxRadius * 9, maxRadius * 26],
      twinkle: 0.3,
      twinkleRate: 0.22,
      attentionMix: 0.85,
      sizeClamp: [0.7, 3.6],
      fogDensity,
      renderOrder: 12,
    });

    this.object = new THREE.Group();
    this.object.name = 'firmament.regions';
    this.object.add(this.glow, this.dust.object);
  }

  update(state) {
    this.glowMaterial.uniforms.uTime.value = state.time;

    const attention = state.attention;
    for (let i = 0; i < this.glowAttention.length; i++) this.glowAttention[i] = attention[i] ?? 0;
    this.glowAttentionAttribute.needsUpdate = true;

    this.dust.update(state);
  }

  dispose() {
    this.glowGeometry.dispose();
    this.glowMaterial.dispose();
    this.dust.dispose();
  }
}
