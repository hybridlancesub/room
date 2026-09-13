import { damp } from './mathx.js';

/**
 * Time for the simulation.
 *
 * Clamps dt so a stalled tab (or a breakpoint) cannot fling the camera across
 * the Firmament, and tracks a smoothed frame cost that the Firmament can use to
 * shed detail.
 */
export class Clock {
  elapsed = 0;
  dt = 1 / 60;
  fps = 60;
  frame = 0;

  #last = 0;
  #maxDt;

  constructor({ maxDt = 1 / 15 } = {}) {
    this.#maxDt = maxDt;
  }

  tick(now) {
    const t = now / 1000;
    if (this.#last === 0) this.#last = t;
    const raw = t - this.#last;
    this.#last = t;

    this.dt = Math.min(Math.max(raw, 1e-4), this.#maxDt);
    this.elapsed += this.dt;
    this.frame++;
    if (raw > 1e-4) this.fps = damp(this.fps, 1 / raw, 3, this.dt);
    return this.dt;
  }

  /** Called after a tab regains focus so the next dt is not a jump. */
  resync() {
    this.#last = 0;
  }
}
