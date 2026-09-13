import * as THREE from 'three';
import { Void } from './Void.js';
import { Regions } from './Regions.js';
import { Typography } from './Typography.js';
import { Filaments } from './Filaments.js';
import { Atmosphere } from './Atmosphere.js';
import { smoothstep } from '../core/mathx.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT                                                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The navigable environment. It owns the renderer, the scene and the camera,
 * and it composes the rendering systems — but it owns no meaning.
 *
 * The Firmament reads two things each frame and nothing else:
 *   · the Embedding — fixed at construction. Topology is stable.
 *   · attention     — a per-region 0..1 array. Visibility is dynamic.
 *
 * That is the entire contract. Every visual behaviour in the Firmament is a
 * function of a stable topology and a changing attention field, which is why
 * nothing ever rearranges to accommodate the viewer.
 */
export class Firmament {
  constructor({ canvas, substrate, embedding, quality = {} }) {
    this.substrate = substrate;
    this.embedding = embedding;

    const fogDensity = quality.fogDensity ?? 0.000105;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // glow is authored, not filtered — AA buys nothing here
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setClearColor(0x050508, 1);
    this.pixelRatioCap = quality.pixelRatioCap ?? 1.75;

    this.scene = new THREE.Scene();
    Void.applyTo(this.scene);

    const radius = embedding.fieldRadius;
    this.camera = new THREE.PerspectiveCamera(55, 1, 1, radius * 42);
    this.camera.name = 'firmament.camera';

    this.void = new Void(embedding, { seed: substrate.seed, fogDensity });
    this.regions = new Regions(embedding, substrate, {
      fogDensity,
      dustPerRegion: quality.dustPerRegion ?? 520,
    });
    this.typography = new Typography(embedding, {
      legibility: quality.legibility ?? 55,
      fogDensity,
    });
    // Domain strands: the macro web. They answer to attention, so the shape of
    // the whole Firmament stays legible from outside it.
    this.filaments = new Filaments(embedding.filaments, {
      fogDensity,
      base: 0.045,
      gain: 0.34,
      name: 'firmament.filaments.domains',
      glowFor: (f, state) => [state.attention[f.fromIndex] ?? 0, state.attention[f.toIndex] ?? 0],
    });

    // Concept strands: the fine structure. They answer to *proximity to their
    // own endpoints* rather than to attention, which is the whole reason
    // thirty-odd of them do not read as a node-link diagram — from out here
    // there is almost nothing to see, and the web only becomes specific once
    // you are standing next to one of the words it connects.
    this.conceptFilaments = new Filaments(embedding.conceptFilaments, {
      fogDensity,
      base: 0.014,
      gain: 0.42,
      spread: 0.3,
      name: 'firmament.filaments.concepts',
      glowFor: (f, state) => [
        endpointResponse(f.from, f.fromRange, state),
        endpointResponse(f.to, f.toRange, state),
      ],
    });
    this.atmosphere = new Atmosphere({
      vignette: quality.vignette ?? 0.62,
      grain: quality.grain ?? 0.035,
    });

    this.scene.add(
      this.void.object,
      this.regions.object,
      this.filaments.object,
      this.conceptFilaments.object,
      this.typography.group
    );

    this.systems = [
      this.void,
      this.regions,
      this.filaments,
      this.conceptFilaments,
      this.typography,
    ];
    this._projScale = 800;
    this._stats = { calls: 0, triangles: 0, points: 0 };
  }

  resize(width, height, devicePixelRatio) {
    const ratio = Math.min(devicePixelRatio || 1, this.pixelRatioCap);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();

    const bufferWidth = Math.round(width * ratio);
    const bufferHeight = Math.round(height * ratio);
    this.filaments.setViewport(bufferWidth, bufferHeight, ratio);
    this.conceptFilaments.setViewport(bufferWidth, bufferHeight, ratio);
    this.atmosphere.setViewport(width, height);

    // Converts a world size into device pixels at unit distance — needed so
    // point sizes are resolution-independent.
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) * 0.5;
    this._projScale = (0.5 * bufferHeight) / Math.tan(halfFov);
  }

  /**
   * @param {object} state
   * @param {number} state.time
   * @param {number} state.dt
   * @param {Float32Array} state.attention   per-region attention, 0..1
   * @param {number} state.nearestDistance   camera → nearest region centre
   * @param {import('../field/Resolution.js').Resolution} state.resolution
   *        what is currently resolved, at every depth
   */
  update(state) {
    const frameState = { ...state, projScale: this._projScale };
    for (const system of this.systems) system.update(frameState);
  }

  render(time) {
    this.renderer.render(this.scene, this.camera);

    // `renderer.info` resets on every render() call, and the atmosphere is a
    // second one — so the totals have to be taken in two bites or the numbers
    // report the vignette and nothing else.
    const main = this.renderer.info.render;
    this._stats.calls = main.calls;
    this._stats.triangles = main.triangles;
    this._stats.points = main.points;

    this.atmosphere.render(this.renderer, time);
    this._stats.calls += main.calls;
    this._stats.triangles += main.triangles;
  }

  get domainCount() {
    return this.embedding.regions.length;
  }

  describe() {
    return {
      renderer: this.renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1',
      maxTextureSize: this.renderer.capabilities.maxTextureSize,
      typography: this.typography.describe(),
      dust: this.regions.dust.count,
      filaments: {
        domain: this.filaments.describe(),
        concept: this.conceptFilaments.describe(),
      },
      drawCalls: this._stats.calls,
      triangles: this._stats.triangles,
      points: this._stats.points,
    };
  }

  dispose() {
    for (const system of this.systems) system.dispose();
    this.atmosphere.dispose();
    this.renderer.dispose();
  }
}

/**
 * How strongly one end of a concept strand answers, from how close the camera is
 * to the word at that end.
 *
 * The distance comes from the Resolution system, which has already measured it
 * this frame for every resolved node — so the fine web costs one map lookup per
 * strand end and no new geometry work at all.
 *
 * `range` is the endpoint's own proximity threshold, which makes this
 * scale-free: a strand attached to a large word answers from further out than
 * one attached to a small word, in the same proportion as everything else that
 * resolves on approach.
 */
function endpointResponse(conceptId, range, state) {
  const record = state.resolution?.active.get(conceptId);
  if (!record) return 0;
  return 1 - smoothstep(range * 0.45, range * 1.9, record.distance);
}
