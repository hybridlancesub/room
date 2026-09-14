import * as THREE from 'three';
import { Substrate } from '../substrate/Substrate.js';
import { Embedding } from '../substrate/Embedding.js';
import { Scope } from './Scope.js';
import { Resolution } from './Resolution.js';
import { Firmament } from '../firmament/Firmament.js';
import { paintDomains } from '../firmament/palette.js';
import { Navigator } from '../navigation/Navigator.js';
import { Input } from '../navigation/Input.js';
import { Attention } from '../interaction/Attention.js';
import { pickRegion } from '../interaction/pick.js';
import { EventBus } from '../core/EventBus.js';
import { Clock } from '../core/Clock.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT                                                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The platform. It hosts the Substrate and the Firmament and lets them evolve
 * independently; it is not a third renderer and holds no meaning of its own.
 *
 * Composition order is the architecture, read top to bottom:
 *
 *     Substrate   what exists                    (no space, no pixels)
 *       └ Embedding   where it exists            (space, no pixels)
 *           └ Scope       what is resolved now
 *               ├ Firmament    how it appears    (pixels, no meaning)
 *               ├ Navigation   where you are
 *               └ Interaction  what you are attending to
 *
 * Per frame, exactly one value crosses from Interaction back into rendering:
 * an attention array. Nothing else. Topology is stable; visibility is dynamic.
 */
export class Field {
  constructor({ canvas, data, quality = {}, embedding: embeddingOptions = {} } = {}) {
    if (!canvas) throw new Error('The Firmament needs a canvas to open onto.');
    if (!data) throw new Error('The Firmament needs substrate data to open.');

    this.canvas = canvas;
    this.bus = new EventBus();
    this.clock = new Clock();

    // ── the substrate ──────────────────────────────────────────────────────
    this.substrate = new Substrate(data);
    paintDomains(this.substrate);
    this.embedding = new Embedding(this.substrate, embeddingOptions);
    this.scope = new Scope({ substrate: this.substrate, embedding: this.embedding });

    // What is resolvable right now, at every depth. Depth 0 is always present;
    // everything below it comes into being because the camera went there.
    this.resolution = new Resolution({
      substrate: this.substrate,
      embedding: this.embedding,
      bus: this.bus,
    });

    // ── the firmament ─────────────────────────────────────────────────────
    this.firmament = new Firmament({
      canvas,
      substrate: this.substrate,
      embedding: this.embedding,
      quality,
    });

    // ── navigation ────────────────────────────────────────────────────────
    this.input = new Input(canvas);
    this.navigator = new Navigator({
      camera: this.firmament.camera,
      embedding: this.embedding,
      bus: this.bus,
    });

    // ── interaction ───────────────────────────────────────────────────────
    this.attention = new Attention({ embedding: this.embedding, bus: this.bus });

    this.running = false;
    this._raf = 0;
    this._moved = false;
    this._disposers = [];

    this.#enter();
    this.#bindHost();
  }

  /**
   * Arrival. Far enough out that the Firmament reads as five luminous weather
   * systems in a dark volume — anchors legible, vocabulary not yet.
   */
  #enter() {
    const radius = this.embedding.fieldRadius;
    const center = new THREE.Vector3(...this.embedding.center);
    const approach = new THREE.Vector3(0.42, 0.3, 1).normalize();
    const position = center.clone().addScaledVector(approach, radius * 1.85);
    this.navigator.enterAt(position, center);
    this.resize();
  }

  #bindHost() {
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._disposers.push(() => target.removeEventListener(type, fn, opts));
    };

    on(window, 'resize', () => this.resize());
    on(document, 'visibilitychange', () => this.clock.resync());

    on(this.canvas, 'webglcontextlost', (event) => {
      event.preventDefault();
      this.stop();
      this.bus.emit('field:context-lost', {});
      console.warn('[firmament] WebGL context lost');
    });
    on(this.canvas, 'webglcontextrestored', () => {
      this.clock.resync();
      this.start();
      this.bus.emit('field:context-restored', {});
    });
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.firmament.resize(width, height, window.devicePixelRatio || 1);
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.clock.resync();
    this._raf = requestAnimationFrame(this.#frame);
    this.bus.emit('field:start', {});
    return this;
  }

  stop() {
    if (!this.running) return this;
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.bus.emit('field:stop', {});
    return this;
  }

  #frame = (now) => {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this.#frame);

    const dt = this.clock.tick(now);

    this.#consumeTaps();
    this.navigator.update(dt, this.input);

    this.attention.update(dt, {
      position: this.navigator.position,
      forward: this.navigator.forward,
      speed: this.navigator.speed,
    });

    // Resolution runs after movement — it answers "what can be resolved from
    // where the camera now is", which is not knowable before the camera moves.
    this.resolution.update(dt, this.navigator.position);
    // …and feeds the next frame's sense of scale back to Navigation.
    this.navigator.setScaleReference(this.resolution.nearestConceptDistance);

    this.firmament.update({
      time: this.clock.elapsed,
      dt,
      attention: this.attention.values,
      nearestDistance: this.navigator.nearestDistance,
      resolution: this.resolution,
    });

    this.firmament.render(this.clock.elapsed);

    if (!this._moved && this.input.active) {
      this._moved = true;
      this.bus.emit('viewer:first-movement', {});
    }

    this.input.endFrame(dt);
    this.bus.emit('field:frame', { dt, elapsed: this.clock.elapsed, frame: this.clock.frame });
  };

  /**
   * A tap on a region is a request to go there, not a selection. Nothing is
   * highlighted, nothing opens, no panel appears — the Firmament simply carries
   * you closer, and the language resolves because you are nearer to it.
   */
  #consumeTaps() {
    for (const tap of this.input.taps) {
      const region = pickRegion(tap, this.firmament.camera, this.embedding);
      if (!region) continue;
      this.navigator.flyTo(region);
      this.bus.emit('viewer:approach', { regionId: region.domainId, label: region.label });
      break;
    }
  }

  describe() {
    return {
      scope: this.scope.describe(),
      resolution: this.resolution.describe(),
      firmament: this.firmament.describe(),
      navigation: this.navigator.describe(),
      attention: this.attention.describe(),
      fps: Math.round(this.clock.fps),
      frame: this.clock.frame,
    };
  }

  dispose() {
    this.stop();
    for (const off of this._disposers) off();
    this._disposers.length = 0;
    this.input.dispose();
    this.firmament.dispose();
    this.bus.clear();
  }
}
