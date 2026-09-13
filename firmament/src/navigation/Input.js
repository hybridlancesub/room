/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  NAVIGATION — input                                                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Raw intent, accumulated between frames. It knows nothing about cameras,
 * physics or the Firmament — it reports what the hands did.
 *
 * The Navigator is the only consumer, which is what keeps "how movement feels"
 * in one file rather than smeared across event handlers.
 */

const KEY_AXES = {
  KeyW: ['forward', 1],
  ArrowUp: ['forward', 1],
  KeyS: ['forward', -1],
  ArrowDown: ['forward', -1],
  KeyA: ['right', -1],
  ArrowLeft: ['right', -1],
  KeyD: ['right', 1],
  ArrowRight: ['right', 1],
  Space: ['up', 1],
  KeyR: ['up', 1],
  KeyC: ['up', -1],
  KeyF: ['up', -1],
};

export class Input {
  look = { x: 0, y: 0 };
  axes = { forward: 0, right: 0, up: 0 };
  wheel = 0;
  boost = false;
  precision = false;
  dragging = false;
  /** Seconds since the last deliberate act. Drives idle drift. */
  idleTime = 0;
  /** NDC positions of taps that were not drags. */
  taps = [];

  #keys = new Set();
  #pointers = new Map();
  #pinchDistance = 0;
  #pressAt = null;
  #canvas;
  #disposers = [];

  constructor(canvas, { lookSensitivity = 0.0022 } = {}) {
    this.#canvas = canvas;
    this.lookSensitivity = lookSensitivity;

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.#disposers.push(() => target.removeEventListener(type, fn, opts));
    };

    on(canvas, 'pointerdown', this.#onPointerDown);
    on(window, 'pointermove', this.#onPointerMove);
    on(window, 'pointerup', this.#onPointerUp);
    on(window, 'pointercancel', this.#onPointerUp);
    on(canvas, 'wheel', this.#onWheel, { passive: false });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(window, 'keydown', this.#onKeyDown);
    on(window, 'keyup', this.#onKeyUp);
    on(window, 'blur', this.#onBlur);
  }

  #onPointerDown = (event) => {
    this.#canvas.setPointerCapture?.(event.pointerId);
    this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.#pointers.size === 1) {
      this.dragging = true;
      this.#pressAt = { x: event.clientX, y: event.clientY, t: performance.now(), moved: 0 };
      this.#canvas.classList.add('dragging');
    } else if (this.#pointers.size === 2) {
      this.#pinchDistance = this.#pinchSpan();
      this.#pressAt = null; // a two-finger gesture is never a tap
    }
  };

  #onPointerMove = (event) => {
    const previous = this.#pointers.get(event.pointerId);
    if (!previous) return;

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    previous.x = event.clientX;
    previous.y = event.clientY;

    if (this.#pointers.size === 1) {
      this.look.x += dx * this.lookSensitivity;
      this.look.y += dy * this.lookSensitivity;
      if (this.#pressAt) this.#pressAt.moved += Math.abs(dx) + Math.abs(dy);
      this.#markActive();
    } else if (this.#pointers.size === 2) {
      const span = this.#pinchSpan();
      // Pinch open = move in. The gesture people already have for "closer".
      this.wheel -= (span - this.#pinchDistance) * 2.4;
      this.#pinchDistance = span;
      this.#markActive();
    }
  };

  #onPointerUp = (event) => {
    if (!this.#pointers.has(event.pointerId)) return;
    this.#pointers.delete(event.pointerId);

    if (this.#pressAt && this.#pointers.size === 0) {
      const held = performance.now() - this.#pressAt.t;
      if (this.#pressAt.moved < 6 && held < 400) {
        const rect = this.#canvas.getBoundingClientRect();
        this.taps.push({
          x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
          y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
        });
      }
    }

    if (this.#pointers.size === 0) {
      this.dragging = false;
      this.#pressAt = null;
      this.#canvas.classList.remove('dragging');
    }
    if (this.#pointers.size < 2) this.#pinchDistance = 0;
  };

  #onWheel = (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? 380 : 1;
    // Scroll up = move forward, the direction of "toward".
    this.wheel -= event.deltaY * unit;
    this.#markActive();
  };

  #onKeyDown = (event) => {
    if (event.metaKey) return;
    if (KEY_AXES[event.code]) {
      event.preventDefault();
      this.#keys.add(event.code);
      this.#markActive();
    }
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') this.boost = true;
    if (event.code === 'ControlLeft' || event.code === 'ControlRight' || event.altKey) {
      this.precision = true;
    }
    this.#recomputeAxes();
  };

  #onKeyUp = (event) => {
    this.#keys.delete(event.code);
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') this.boost = false;
    if (event.code === 'ControlLeft' || event.code === 'ControlRight' || event.code === 'AltLeft' || event.code === 'AltRight') {
      this.precision = false;
    }
    this.#recomputeAxes();
  };

  #onBlur = () => {
    this.#keys.clear();
    this.#pointers.clear();
    this.dragging = false;
    this.boost = false;
    this.precision = false;
    this.#recomputeAxes();
  };

  #recomputeAxes() {
    const axes = { forward: 0, right: 0, up: 0 };
    for (const code of this.#keys) {
      const entry = KEY_AXES[code];
      if (entry) axes[entry[0]] += entry[1];
    }
    axes.forward = Math.sign(axes.forward);
    axes.right = Math.sign(axes.right);
    axes.up = Math.sign(axes.up);
    this.axes = axes;
  }

  #pinchSpan() {
    const [a, b] = [...this.#pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  #markActive() {
    this.idleTime = 0;
  }

  /** True while the viewer is deliberately doing something. */
  get active() {
    return (
      this.dragging ||
      this.wheel !== 0 ||
      this.look.x !== 0 ||
      this.look.y !== 0 ||
      this.axes.forward !== 0 ||
      this.axes.right !== 0 ||
      this.axes.up !== 0
    );
  }

  /** Called once per frame by the Navigator, after it has read everything. */
  endFrame(dt) {
    const wasActive = this.active;
    this.look.x = 0;
    this.look.y = 0;
    this.wheel = 0;
    this.taps.length = 0;
    this.idleTime = wasActive ? 0 : this.idleTime + dt;
  }

  dispose() {
    for (const off of this.#disposers) off();
    this.#disposers.length = 0;
  }
}
