import * as THREE from 'three';
import { COMMON } from './shaders.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT — atmosphere                                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * A two-quad screen pass, drawn last: a vignette that closes the edges of the
 * frame, and a hair of grain so the void is never a flat digital black.
 *
 * Deliberately *not* a post-processing stack. No render targets, no bloom, no
 * FXAA — glow is authored into the glyph atlas and the region shader instead.
 * Two extra draw calls, no bandwidth cost, and 60fps stays cheap to hold.
 */
export class Atmosphere {
  constructor({ vignette = 0.62, grain = 0.035 } = {}) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const quad = new THREE.PlaneGeometry(2, 2);

    this.vignetteMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uStrength: { value: vignette },
        uAspect: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        uniform float uAspect;
        varying vec2 vUv;

        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          p.x *= mix(1.0, uAspect, 0.35);
          float r = length(p) * 0.72;
          // A long, shallow falloff. A short one leaves a visible ring in the
          // corner of the eye, and a ring is a shape — the void must have none.
          float a = pow(smoothstep(0.12, 1.45, r), 1.6) * uStrength;
          gl_FragColor = vec4(0.0, 0.0, 0.01, a);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.grainMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uStrength: { value: grain },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uStrength;
        varying vec2 vUv;

        ${COMMON}

        void main() {
          // Quantised time: grain that shimmers per-frame reads as noise on a
          // screen. At ~12hz it reads as film, which is to say as air.
          float t = floor(uTime * 12.0);
          float n = hash21(gl_FragCoord.xy + vec2(t * 13.7, t * 7.3));
          float a = n * n * uStrength;
          gl_FragColor = vec4(vec3(0.72, 0.76, 0.9) * a, a);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const vignetteMesh = new THREE.Mesh(quad, this.vignetteMaterial);
    vignetteMesh.frustumCulled = false;
    vignetteMesh.renderOrder = 0;

    const grainMesh = new THREE.Mesh(quad, this.grainMaterial);
    grainMesh.frustumCulled = false;
    grainMesh.renderOrder = 1;

    this.scene.add(vignetteMesh, grainMesh);
    this.geometry = quad;
  }

  setViewport(width, height) {
    this.vignetteMaterial.uniforms.uAspect.value = width / Math.max(1, height);
  }

  render(renderer, time) {
    this.grainMaterial.uniforms.uTime.value = time;
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = previousAutoClear;
  }

  dispose() {
    this.geometry.dispose();
    this.vignetteMaterial.dispose();
    this.grainMaterial.dispose();
  }
}
