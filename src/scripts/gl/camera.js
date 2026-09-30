/* ============================================================
   CAMERA — the camera model, computed on the CPU
   The shaders no longer build the camera per pixel: camOrigin(),
   camPitch() and submergence() are evaluated here once per frame
   and uploaded as uniforms (gl/lighting.js). The bubble field
   uses the same functions, so everything sees one camera.
   Inputs map to the shader uniforms:
     clock → uTime, dive → uDive, shallow → uShallow,
     scroll → uScroll, mouseX / mouseY → uMouse
   seabedDepth() is still mirrored in GLSL (common.glsl.js).
   ============================================================ */

export function clamp(x, lo, hi){
  return Math.min(hi, Math.max(lo, x));
}

export function mix(a, b, t){
  return a + (b - a) * t;
}

export function smoothstep(e0, e1, x){
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/* GLSL: seabedDepth() */
export function seabedDepth(shallow){
  return mix(-27.0, -12.0, shallow);
}

/* The piecewise dive curve without the idle bob or mouse lift.
   Phase 1 (0.0 - 0.3): plunge from 3.3 to -4.0
   Phase 2 (0.3 - 1.0): descend from -4.0 to 1.5 units above the seabed */
export function diveHeight(dive, shallow){
  const d = clamp(dive, 0, 1);
  if (d < 0.3){
    const t = d / 0.3;
    return 3.3 - 7.3 * t * t;
  }
  const t = (d - 0.3) / 0.7;
  return mix(-4.0, seabedDepth(shallow) + 1.5, t);
}

/* Camera height: dive curve + idle bob + mouse lift */
export function camHeight(state){
  return diveHeight(state.dive, state.shallow)
       + Math.sin(state.clock * 0.42) * 0.16
       + state.mouseY * 0.35;
}

/* Camera position. Writes into `out` to avoid per-frame allocation. */
export function camOrigin(state, out = [0, 0, 0]){
  const sub = smoothstep(0.15, 0.60, clamp(state.dive, 0, 1));
  out[0] = state.mouseX * 1.6 + Math.sin(state.clock * 0.23) * 0.6 * sub;
  out[1] = camHeight(state);
  out[2] = -state.clock * 0.78;
  return out;
}

/* Pitch, applied in the shader as a shear on the view ray (camRay),
   so the camera axes stay aligned with world x / y / -z. */
export function camPitch(state){
  const d = clamp(state.dive, 0, 1);
  return mix(-0.085 - state.scroll * 0.02, 0.0, smoothstep(0.0, 0.45, d))
       + smoothstep(0.30, 0.62, d) * (1.0 - smoothstep(0.70, 1.0, d) * 0.66) * 0.30
       + state.mouseY * 0.035;
}

/* 0 in air, 1 under water. Crosses over while the camera is within
   one unit of the waterline, which the splash veil (|camY| < 2) hides. */
export function submergence(state){
  return 1.0 - smoothstep(-1.0, 1.0, camHeight(state));
}
