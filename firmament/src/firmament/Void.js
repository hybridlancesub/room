import * as THREE from 'three';
import { PointCloud } from './PointCloud.js';
import { VOID_COLOR, STARLIGHT } from './palette.js';
import { createRng } from '../core/rng.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT — the void                                               │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Darkness is functional. It is not a background colour chosen for taste: it
 * is the state of not-yet-illuminated, and it has to be believable as *space*
 * or the regions have nothing to be suspended in.
 *
 * Two strata, and no more:
 *   · deep grain — an almost-static field at the edge of perception, which
 *     gives the void a floor and makes vast distances feel vast
 *   · near drift — sparse matter close enough to parallax when you move, so
 *     motion registers even in an empty part of the Firmament
 *
 * No grid. No axes. No horizon. Nothing that would tell you which way is up.
 */
export class Void {
  constructor(embedding, { seed = 'void', fogDensity = 0.00012 } = {}) {
    const radius = embedding.fieldRadius;

    this.object = new THREE.Group();
    this.object.name = 'firmament.void';

    this.deep = makeField({
      seed: `${seed}:deep`,
      count: 4200,
      inner: radius * 5.5,
      outer: radius * 17,
      sizeRange: [4.5, 26],
      intensity: 0.5,
      twinkle: 0.5,
      twinkleRate: 0.11,
      farFade: [radius * 40, radius * 90],
      nearFade: [0, 1],
      fogDensity: 0,
      name: 'firmament.void.deep',
      sizeClamp: [0.5, 2.1],
    });

    this.drift = makeField({
      seed: `${seed}:drift`,
      count: 2600,
      inner: radius * 0.35,
      outer: radius * 3.2,
      sizeRange: [0.9, 3.4],
      intensity: 0.22,
      twinkle: 0.42,
      twinkleRate: 0.19,
      farFade: [radius * 3.4, radius * 7],
      nearFade: [8, 90],
      fogDensity,
      name: 'firmament.void.drift',
      sizeClamp: [0.6, 2.6],
    });

    this.object.add(this.deep.object, this.drift.object);
  }

  /** Applied by the Firmament to the scene it owns. */
  static applyTo(scene) {
    scene.background = new THREE.Color(VOID_COLOR);
  }

  update(state) {
    this.deep.update(state);
    this.drift.update(state);
  }

  dispose() {
    this.deep.dispose();
    this.drift.dispose();
  }
}

function makeField({ seed, count, inner, outer, sizeRange, ...params }) {
  const rng = createRng(seed);
  const positions = new Float32Array(count * 3);
  const tints = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const [x, y, z] = rng.onSphere();
    const r = inner + (outer - inner) * Math.cbrt(rng.next());
    positions[i * 3 + 0] = x * r;
    positions[i * 3 + 1] = y * r * 0.8;
    positions[i * 3 + 2] = z * r;

    // Grain, not stars: the colour varies barely, toward cold.
    const warm = rng.range(-0.06, 0.04);
    tints[i * 3 + 0] = STARLIGHT[0] + warm;
    tints[i * 3 + 1] = STARLIGHT[1] + warm * 0.4;
    tints[i * 3 + 2] = STARLIGHT[2];

    sizes[i] = rng.range(sizeRange[0], sizeRange[1]);
    seeds[i] = rng.next();
  }

  return new PointCloud({ positions, tints, sizes, seeds, ...params });
}
