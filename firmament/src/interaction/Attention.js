import { clamp01, damp, smoothstep } from '../core/mathx.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  INTERACTION — attention                                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * "Attention behaves like gravity. Proximity and dwell increase local
 *  luminosity and filament visibility. The environment responds without
 *  rearranging."
 *
 * This system is the entire implementation of that sentence, and it is the
 * only thing the Firmament reads that changes between frames.
 *
 * Attention is composed from three signals, none of which move anything:
 *
 *   PROXIMITY  where the body is       — immediate, spatial
 *   AIM        where the gaze is       — reaches across the void, so a region
 *                                        you are looking toward begins to
 *                                        answer before you arrive
 *   DWELL      where the time went     — slow to rise, slower to fade, which
 *                                        is what gives regions the sense of
 *                                        having been *visited* rather than
 *                                        merely passed
 *
 * DWELL is also the seed of everything V2 wants: a trace layer, attention
 * gravity, collective memory. It is accumulated and published here already —
 * nothing else needs to change for those layers to be built on top.
 */
export class Attention {
  constructor({ embedding, bus, options = {} } = {}) {
    this.embedding = embedding;
    this.bus = bus;

    this.options = {
      proximityInner: 1.15, // × region radius — fully present
      proximityOuter: 5.5, // × region radius — first stirring
      aimThreshold: 0.55, // cosine
      aimReach: 26, // × region radius
      dwellRise: 0.28, // per second, at full presence
      dwellFall: 0.11, // per second
      dwellSpeedLimit: 260, // world units/sec above which you are passing through
      response: 2.6, // how fast rendered attention chases the target
      focusThreshold: 0.3,
      traceInterval: 0.75,
      traceCapacity: 512,
      ...options,
    };

    const n = embedding.regions.length;
    /** What the Firmament reads. 0..1 per region. */
    this.values = new Float32Array(n);
    this.proximity = new Float32Array(n);
    this.aim = new Float32Array(n);
    this.dwell = new Float32Array(n);

    this.focusIndex = -1;
    this.focusId = null;

    /** FUTURE (trace layer): where the viewer has actually been. */
    this.trace = [];
    this._traceClock = 0;
  }

  /**
   * @param {number} dt
   * @param {{position: {x,y,z}, forward: {x,y,z}, speed: number}} viewer
   */
  update(dt, viewer) {
    const o = this.options;
    const regions = this.embedding.regions;
    const { position, forward, speed } = viewer;

    let bestIndex = -1;
    let bestValue = o.focusThreshold;

    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      const dx = region.center[0] - position.x;
      const dy = region.center[1] - position.y;
      const dz = region.center[2] - position.z;
      const distance = Math.hypot(dx, dy, dz) || 1e-5;

      // Proximity — presence in a region's volume.
      const proximity =
        1 - smoothstep(region.radius * o.proximityInner, region.radius * o.proximityOuter, distance);

      // Aim — regard, which carries further than the body does.
      const alignment = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
      const reach = 1 - smoothstep(region.radius * o.aimReach, region.radius * o.aimReach * 2.4, distance);
      const aim = clamp01((alignment - o.aimThreshold) / (1 - o.aimThreshold)) * reach;

      // Dwell — time spent, discounted for velocity. Passing through at speed
      // is not the same as being somewhere.
      const stillness = 1 - clamp01(speed / o.dwellSpeedLimit);
      const engagement = Math.max(proximity, aim * 0.6) * stillness;
      const target = engagement > 0.08 ? this.dwell[i] + o.dwellRise * engagement * dt : this.dwell[i] - o.dwellFall * dt;
      this.dwell[i] = clamp01(target);

      this.proximity[i] = proximity;
      this.aim[i] = aim;

      const desired = clamp01(0.5 * proximity + 0.25 * aim + 0.3 * this.dwell[i]);
      // Luminosity chases attention; it never jumps.
      this.values[i] = damp(this.values[i], desired, o.response, dt);

      if (this.values[i] > bestValue) {
        bestValue = this.values[i];
        bestIndex = i;
      }
    }

    if (bestIndex !== this.focusIndex) {
      const previous = this.focusId;
      this.focusIndex = bestIndex;
      this.focusId = bestIndex >= 0 ? regions[bestIndex].domainId : null;
      this.bus?.emit('attention:focus', {
        regionId: this.focusId,
        previousRegionId: previous,
        region: bestIndex >= 0 ? regions[bestIndex] : null,
        value: bestIndex >= 0 ? this.values[bestIndex] : 0,
      });
    }

    this.#recordTrace(dt, position);
  }

  #recordTrace(dt, position) {
    this._traceClock += dt;
    if (this._traceClock < this.options.traceInterval) return;
    this._traceClock = 0;

    this.trace.push({
      position: [position.x, position.y, position.z],
      focus: this.focusId,
      t: this.trace.length,
    });
    if (this.trace.length > this.options.traceCapacity) this.trace.shift();
  }

  valueFor(domainId) {
    const region = this.embedding.region(domainId);
    return region ? this.values[region.index] : 0;
  }

  describe() {
    return {
      focus: this.focusId,
      values: Array.from(this.values, (v) => Number(v.toFixed(3))),
      dwell: Array.from(this.dwell, (v) => Number(v.toFixed(3))),
      traceLength: this.trace.length,
    };
  }
}
