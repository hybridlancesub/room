import * as THREE from 'three';
import { clamp, clamp01, damp, decay, easeInOutCubic, lerp } from '../core/mathx.js';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  NAVIGATION                                                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Movement is observational. There is no orbit target, no pivot, no "up"
 * enforced by a ground plane — you are not turning an object over in your
 * hands, you are travelling through something that does not care that you
 * arrived.
 *
 * Three behaviours make the difference between drifting and driving:
 *
 *   SCALE-RELATIVE SPEED   Thrust is proportional to how far you are from the
 *     nearest semantic region, so crossing the void and easing between two
 *     words in the same cluster use the same key at the same pressure. This is
 *     what makes scale traversal feel continuous rather than paginated.
 *
 *   GRAVITATIONAL EASING   Near a region, a gentle force settles you toward an
 *     observation shell just outside it — never into its core, never strongly
 *     enough to override a hand on the keys. Approach decelerates itself.
 *
 *   INERTIA               Nothing snaps. Velocity decays over seconds, look
 *     direction is critically damped, and even a cinematic flight hands back
 *     control with residual motion rather than a dead stop.
 */

const UP = new THREE.Vector3(0, 1, 0);

export class Navigator {
  velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  #yawVelocity = 0;
  #pitchVelocity = 0;
  #flight = null;
  #breath = 0;

  constructor({ camera, embedding, bus, options = {} } = {}) {
    this.camera = camera;
    this.embedding = embedding;
    this.bus = bus;

    this.options = {
      thrust: 1.6,
      wheelImpulse: 0.0042,
      boost: 3.4,
      precision: 0.22,
      damping: 0.972, // per 60fps frame
      lookDamping: 12,
      pitchLimit: Math.PI * 0.49,
      gravity: 0.5,
      gravityRange: 3.4, // multiples of region radius
      observationShell: 1.25, // multiples of region radius
      idleDrift: 0.0035,
      breathAmplitude: 0.5,
      boundary: 6.5, // multiples of field radius
      flightDuration: 2.9,
      ...options,
    };

    this.position = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._scratch = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

    /** Distance to the nearest region centre — published for the Firmament LOD. */
    this.nearestDistance = Infinity;
    this.nearestRegion = null;
    this.speed = 0;

    /**
     * Distance to the nearest *resolved* concept, supplied by the Firmament from the
     * Resolution system. Sets the scale at which movement operates. One frame
     * stale by construction — the Resolution system needs this frame's camera
     * position, so it necessarily reports afterwards. At 16ms, imperceptible.
     */
    this.scaleReference = Infinity;
  }

  /** @param {number} distance world units to the nearest resolved concept */
  setScaleReference(distance) {
    this.scaleReference = distance;
  }

  /** Place the viewer somewhere with a view of everything, then let go. */
  enterAt(position, lookAt) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.#aimAt(lookAt, true);
    this.#apply(0);
  }

  #aimAt(target, immediate = false) {
    this._scratch.copy(target).sub(this.position);
    const horizontal = Math.hypot(this._scratch.x, this._scratch.z) || 1e-5;
    const yaw = Math.atan2(-this._scratch.x, -this._scratch.z);
    const pitch = Math.atan2(this._scratch.y, horizontal);
    if (immediate) {
      this.yaw = yaw;
      this.pitch = pitch;
    }
    return { yaw, pitch };
  }

  /** Cinematic interpolation to an observation position outside a region. */
  flyTo(region, { duration = this.options.flightDuration } = {}) {
    const center = new THREE.Vector3(...region.center);
    const away = this._scratch.copy(this.position).sub(center);
    if (away.lengthSq() < 1e-4) away.set(0, 0, 1);
    away.normalize();

    // Arrive slightly above the region's equator: a viewpoint, not an orbit.
    away.y += 0.22;
    away.normalize();

    const target = center.clone().addScaledVector(away, region.radius * 2.15);

    this.#flight = {
      from: this.position.clone(),
      to: target,
      lookAt: center,
      fromYaw: this.yaw,
      fromPitch: this.pitch,
      elapsed: 0,
      duration,
      region,
    };
    this.velocity.multiplyScalar(0.25);
    this.bus?.emit('navigation:flight-begin', { regionId: region.domainId });
  }

  cancelFlight(reason = 'interrupted') {
    if (!this.#flight) return;
    const region = this.#flight.region;
    this.#flight = null;
    this.bus?.emit('navigation:flight-end', { regionId: region?.domainId, reason });
  }

  get flying() {
    return this.#flight !== null;
  }

  /** Current view basis. Read by the Interaction layer; never written to. */
  get forward() {
    return this._forward;
  }

  get right() {
    return this._right;
  }

  update(dt, input) {
    this.#updateBasis();

    const nearest = this.embedding.nearestRegion(this.position.x, this.position.y, this.position.z);
    this.nearestRegion = nearest.region;
    this.nearestDistance = nearest.distance;

    if (this.#flight) this.#updateFlight(dt, input);
    else this.#updateFreeFlight(dt, input, nearest);

    this.speed = this.velocity.length();
    this.#breath += dt;
    this.#apply(dt);
  }

  // ── free flight ─────────────────────────────────────────────────────────

  #updateFreeFlight(dt, input, nearest) {
    const o = this.options;

    // Look: impulses accumulate into an angular velocity that bleeds off, so
    // the view keeps turning fractionally after the hand stops.
    this.#yawVelocity += -input.look.x;
    this.#pitchVelocity += -input.look.y;
    this.yaw += this.#yawVelocity * dt * 60;
    this.pitch = clamp(this.pitch + this.#pitchVelocity * dt * 60, -o.pitchLimit, o.pitchLimit);
    this.#yawVelocity = damp(this.#yawVelocity, 0, o.lookDamping, dt);
    this.#pitchVelocity = damp(this.#pitchVelocity, 0, o.lookDamping, dt);

    this.#updateBasis();

    // Speed is relative to the scale you are working at: the distance to the
    // nearest thing that has resolved. Same key, same feel, at every magnitude —
    // crossing the void, drifting between two concepts in a region, or easing
    // between two words nested inside one of them.
    //
    // The reference used to be the region surface, which reads as zero anywhere
    // inside a region and so collapsed every interior scale onto one speed.
    // Distance to the nearest resolved word is scale-free by construction, and
    // it keeps working at depths that do not exist yet.
    const reference = Number.isFinite(this.scaleReference)
      ? this.scaleReference
      : Math.max(nearest.surface, 0);
    const scale = clamp(reference * 0.45 + 10, 12, 3200);
    const modifier = (input.boost ? o.boost : 1) * (input.precision ? o.precision : 1);
    const accel = scale * o.thrust * modifier;

    this._scratch.set(0, 0, 0);
    if (input.axes.forward) this._scratch.addScaledVector(this._forward, input.axes.forward);
    if (input.axes.right) this._scratch.addScaledVector(this._right, input.axes.right);
    if (input.axes.up) this._scratch.addScaledVector(UP, input.axes.up);
    if (this._scratch.lengthSq() > 0) {
      this._scratch.normalize();
      this.velocity.addScaledVector(this._scratch, accel * dt);
    }

    if (input.wheel !== 0) {
      this.velocity.addScaledVector(this._forward, input.wheel * o.wheelImpulse * scale * modifier);
    }

    this.#applyGravity(dt, nearest, input);
    this.#applyBoundary(dt);

    // Idle: the Firmament keeps moving when you stop, but only just.
    if (input.idleTime > 5 && !input.dragging) {
      const gentle = clamp01((input.idleTime - 5) / 6);
      this.yaw += o.idleDrift * gentle * dt;
      this.velocity.addScaledVector(this._forward, scale * 0.02 * gentle * dt);
    }

    this.velocity.multiplyScalar(decay(o.damping, dt));
    this.position.addScaledVector(this.velocity, dt);
  }

  /**
   * Attention behaves like gravity — including for the body. Approaching a
   * region slows you and settles you at a viewing distance. Leaving is free.
   */
  #applyGravity(dt, nearest, input) {
    const o = this.options;
    const region = nearest.region;
    if (!region) return;

    const range = region.radius * o.gravityRange;
    if (nearest.distance > range) return;

    const shell = region.radius * o.observationShell;
    const proximity = 1 - nearest.distance / range;
    const pull = proximity * proximity * o.gravity * region.radius;

    this._scratch
      .set(region.center[0], region.center[1], region.center[2])
      .sub(this.position);
    const distance = this._scratch.length() || 1e-5;
    this._scratch.divideScalar(distance);

    // Gravity only ever draws you *in*. It never pushes back out.
    //
    // An earlier version eased you back toward an observation shell whenever
    // you went inside it, on the theory that a region is a thing you look at.
    // With fractal depth that theory is wrong: the vocabulary inside a word is
    // reachable only from deep inside its region, and a centring force that
    // exceeded thrust at close range made those depths literally unreachable.
    // Inside the shell there is now no force at all — only arrival damping.
    const signed = Math.max(0, Math.tanh((distance - shell) / (region.radius * 0.9)));
    if (signed > 0) this.velocity.addScaledVector(this._scratch, signed * pull * dt);

    // Arrival damping — only when the viewer is not actively pushing through.
    if (!input.active) {
      this.velocity.multiplyScalar(decay(lerp(1, 0.965, proximity), dt));
    }
  }

  /** The Firmament is unbounded in feeling and finite in fact. */
  #applyBoundary(dt) {
    const limit = this.embedding.fieldRadius * this.options.boundary;
    const distance = this.position.length();
    if (distance < limit) return;

    const overshoot = (distance - limit) / limit;
    this._scratch.copy(this.position).multiplyScalar(-1 / distance);
    this.velocity.addScaledVector(this._scratch, overshoot * distance * 0.8 * dt);
  }

  // ── cinematic flight ────────────────────────────────────────────────────

  #updateFlight(dt, input) {
    const flight = this.#flight;

    // Any deliberate act returns control immediately, mid-arc.
    if (input.active) {
      const travelled = this._scratch.copy(flight.to).sub(flight.from).normalize();
      this.velocity.addScaledVector(travelled, this.embedding.fieldRadius * 0.02);
      this.cancelFlight('input');
      return;
    }

    flight.elapsed += dt;
    const t = clamp01(flight.elapsed / flight.duration);
    const eased = easeInOutCubic(t);

    this.position.lerpVectors(flight.from, flight.to, eased);

    const aim = this.#aimAt(flight.lookAt);
    this.yaw = lerp(flight.fromYaw, flight.fromYaw + shortestAngle(flight.fromYaw, aim.yaw), eased);
    this.pitch = lerp(flight.fromPitch, aim.pitch, eased);

    if (t >= 1) {
      // Hand back with a breath of drift rather than a dead stop.
      this._scratch.copy(flight.to).sub(flight.from).normalize();
      this.velocity.copy(this._scratch).multiplyScalar(flight.region.radius * 0.05);
      this.cancelFlight('arrived');
    }
  }

  // ── camera application ──────────────────────────────────────────────────

  #updateBasis() {
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this._quat.setFromEuler(this._euler);
    this._forward.set(0, 0, -1).applyQuaternion(this._quat);
    this._right.set(1, 0, 0).applyQuaternion(this._quat);
    this._up.set(0, 1, 0).applyQuaternion(this._quat);
  }

  #apply() {
    this.#updateBasis();
    const breathe = this.options.breathAmplitude;
    this.camera.position.set(
      this.position.x + Math.sin(this.#breath * 0.21) * breathe,
      this.position.y + Math.sin(this.#breath * 0.17 + 1.3) * breathe,
      this.position.z + Math.cos(this.#breath * 0.19 + 0.6) * breathe
    );
    this.camera.quaternion.copy(this._quat);
    this.camera.updateMatrixWorld();
  }

  describe() {
    return {
      position: this.position.toArray().map((v) => Math.round(v)),
      speed: Math.round(this.speed),
      nearest: this.nearestRegion?.domainId ?? null,
      nearestDistance: Math.round(this.nearestDistance),
    };
  }
}

/** Signed shortest delta between two angles, so flights never take the long way. */
function shortestAngle(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
