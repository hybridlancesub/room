import * as THREE from 'three';
import { COMMON } from './shaders.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT — point fields                                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * One shader serves every diffuse thing in the Firmament: the void's distant
 * grain, the drifting near dust that gives movement its parallax, and the
 * volumetric body of a semantic region.
 *
 * They differ only in parameters. That is deliberate — the void and a cluster's
 * interior are the same *kind* of matter here, at different densities.
 */
export class PointCloud {
  /**
   * @param {object} spec
   * @param {Float32Array} spec.positions  xyz triples
   * @param {Float32Array} spec.tints      rgb triples
   * @param {Float32Array} spec.sizes      per-point world size
   * @param {Float32Array} spec.seeds      per-point phase, 0..1
   * @param {Int32Array}  [spec.domainIndices]  for attention-reactive fields
   */
  constructor({
    positions,
    tints,
    sizes,
    seeds,
    domainIndices = null,
    name = 'firmament.points',
    intensity = 0.5,
    nearFade = [30, 160],
    farFade = [3000, 9000],
    twinkle = 0.35,
    twinkleRate = 0.35,
    attentionMix = 0,
    sizeClamp = [0.7, 3.4],
    fogDensity = 0.00012,
    renderOrder = 5,
    depthWrite = false,
  }) {
    const count = positions.length / 3;
    this.count = count;
    this.domainIndices = domainIndices;

    const geometry = new THREE.BufferGeometry();
    // Named 'position' so three can compute real bounds and frustum-cull us.
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    this.attentionArray = new Float32Array(count);
    if (!domainIndices) this.attentionArray.fill(1);
    this.attentionAttribute = new THREE.BufferAttribute(this.attentionArray, 1);
    if (domainIndices) this.attentionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAttention', this.attentionAttribute);
    geometry.computeBoundingSphere();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProjScale: { value: 800 },
        uIntensity: { value: intensity },
        uNear: { value: new THREE.Vector2(nearFade[0], nearFade[1]) },
        uFar: { value: new THREE.Vector2(farFade[0], farFade[1]) },
        uTwinkle: { value: twinkle },
        uTwinkleRate: { value: twinkleRate },
        uAttentionMix: { value: attentionMix },
        uSizeClamp: { value: new THREE.Vector2(sizeClamp[0], sizeClamp[1]) },
        uFogDensity: { value: fogDensity },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aTint;
        attribute float aSize;
        attribute float aSeed;
        attribute float aAttention;

        uniform float uTime;
        uniform float uProjScale;
        uniform float uIntensity;
        uniform vec2 uNear;
        uniform vec2 uFar;
        uniform float uTwinkle;
        uniform float uTwinkleRate;
        uniform float uAttentionMix;
        uniform vec2 uSizeClamp;
        uniform float uFogDensity;

        varying vec3 vTint;
        varying float vAlpha;

        ${COMMON}

        void main() {
          vec4 mv = viewMatrix * vec4(position, 1.0);
          float dist = max(length(mv.xyz), 1e-3);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uProjScale / dist, uSizeClamp.x, uSizeClamp.y);

          float near = smoothstep(uNear.x, uNear.y, dist);
          float far = fadeIn(uFar.x, uFar.y, dist);
          float twinkle = 1.0 - uTwinkle * (0.5 + 0.5 * sin(uTime * uTwinkleRate + aSeed * 6.2831853));
          float attention = mix(1.0, 0.28 + 0.72 * aAttention, uAttentionMix);

          vAlpha = uIntensity * near * far * twinkle * attention * fogFade(uFogDensity, dist);
          vTint = aTint;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vTint;
        varying float vAlpha;

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
      depthWrite,
      blending: THREE.AdditiveBlending,
    });

    this.geometry = geometry;
    this.object = new THREE.Points(geometry, this.material);
    this.object.name = name;
    this.object.renderOrder = renderOrder;
  }

  /** @param {{time:number, projScale:number, attention?:Float32Array}} state */
  update(state) {
    this.material.uniforms.uTime.value = state.time;
    this.material.uniforms.uProjScale.value = state.projScale;

    if (this.domainIndices && state.attention) {
      const arr = this.attentionArray;
      const idx = this.domainIndices;
      for (let i = 0; i < arr.length; i++) arr[i] = state.attention[idx[i]] ?? 0;
      this.attentionAttribute.needsUpdate = true;
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
