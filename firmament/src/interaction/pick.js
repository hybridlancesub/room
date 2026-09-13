import * as THREE from 'three';

const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _toCenter = new THREE.Vector3();

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  INTERACTION — picking                                                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Regions are volumes of light with no surface, so there is nothing to
 * raycast against. Selection is therefore analytic: which semantic volume
 * does this ray pass closest to the middle of, relative to its own size.
 *
 * Relative, not absolute — otherwise a large region far away would always
 * out-compete a small one nearby, and pointing at what you can see would stop
 * working the moment you moved.
 */
export function pickRegion(ndc, camera, embedding, { tolerance = 1.5 } = {}) {
  _origin.copy(camera.position);
  _direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(_origin).normalize();

  let best = null;
  let bestScore = Infinity;

  for (const region of embedding.regions) {
    _toCenter.set(region.center[0], region.center[1], region.center[2]).sub(_origin);
    const along = _toCenter.dot(_direction);
    if (along <= 0) continue; // behind the viewer

    const perpendicular = Math.sqrt(Math.max(0, _toCenter.lengthSq() - along * along));
    const score = perpendicular / region.radius;
    if (score < tolerance && score < bestScore) {
      bestScore = score;
      best = region;
    }
  }

  return best;
}
