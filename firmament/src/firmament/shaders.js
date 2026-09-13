/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THE FIRMAMENT — shared GLSL                                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Chunks used by more than one rendering system. Kept small on purpose: the
 * shaders that define a system's *character* live with that system.
 *
 * Note on `fadeIn`: GLSL's smoothstep is undefined when edge0 > edge1, and
 * almost every fade in the Firmament runs "brighter as you approach". Hence an
 * explicit helper rather than a reversed smoothstep.
 */

export const COMMON = /* glsl */ `
  float fadeIn(float near, float far, float x) {
    return 1.0 - smoothstep(near, far, x);
  }

  float fogFade(float density, float dist) {
    return exp(-density * dist);
  }

  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`;

/**
 * A screen-aligned, upright billboard. Text must never tumble: the Firmament is
 * navigated, not orbited, and legibility is the whole point.
 */
export const BILLBOARD = /* glsl */ `
  vec4 billboard(vec3 worldPos, vec2 corner, vec2 size, out float viewDist) {
    vec4 mv = viewMatrix * vec4(worldPos, 1.0);
    viewDist = max(length(mv.xyz), 1e-3);
    mv.xy += corner * size;
    return projectionMatrix * mv;
  }
`;
