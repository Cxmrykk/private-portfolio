/* ============================================================
   LIGHTING — per-frame shader constants, computed on the CPU
   These values depend only on uniforms (time of day, camera
   inputs), yet the shaders used to recompute them per pixel,
   several times per pixel inside sky(), shading and the glass.
   They are computed once per frame here and uploaded as uniforms
   (see GLSL_COMMON in shaders/common.glsl.js):

     uPhase        dayW, sunsetW, nightW          getPhaseWeights()
     uPrimaryDir   sun, or moon once the sun sets getPrimaryLight()
     uShaftDir     primary light refracted        getShaftDir()
     uPrimaryCol   light colour by phase          getPrimaryLightCol()
     uEnvLight     overall scene light level      envLight()
     uSkyAmbient   zenith luminance (moon fade)   moonVisibility()
     uCamOrigin    camera position                camOrigin()
     uCamPitch     camera pitch shear             camPitch()
     uSubmergence  0 in air, 1 under water        submergence()

   The maths mirrors the GLSL it replaced exactly (computed in
   float64 instead of float32). If the shader's lighting model
   changes, change this file with it.
   ============================================================ */
import { mix, smoothstep, camOrigin, camPitch, submergence } from './camera.js';

/* IOR air / water */
const ETA = 0.75018;

/* Zenith sky colours (skyZenithCol) */
const DAY_Z = [0.06, 0.32, 0.73];
const SET_Z = [0.08, 0.22, 0.38];
const NIG_Z = [0.01, 0.02, 0.05];

/* Primary light colours (getPrimaryLightCol) */
const DAY_L = [1.00, 0.97, 0.90];
const SET_L = [1.00, 0.45, 0.15];
const NIG_L = [0.50, 0.70, 1.00];

const zenith = [0, 0, 0];

export function createFrameUniforms(){
  return {
    phase: [1, 0, 0],
    primaryDir: [0, 1, 0],
    shaftDir: [0, 1, 0],
    primaryCol: [1, 1, 1],
    envLight: 1,
    skyAmbient: 0,
    camOrigin: [0, 0, 0],
    camPitch: 0,
    submergence: 0
  };
}

/* GLSL: getPhaseWeights(). out = [dayW, sunsetW, nightW] */
export function phaseWeights(sunY, out = [0, 0, 0]){
  const dayW = smoothstep(0.15, 0.60, sunY);
  const nightW = 1.0 - smoothstep(-0.30, 0.0, sunY);
  out[0] = dayW;
  out[1] = Math.max(0.0, 1.0 - (dayW + nightW));
  out[2] = nightW;
  return out;
}

function blend3(a, b, c, w, out){
  for (let i = 0; i < 3; i++) out[i] = a[i] * w[0] + b[i] * w[1] + c[i] * w[2];
  return out;
}

/* GLSL: getShaftDir(). The primary light refracted through a flat
   surface, pointing back up toward it from under water. */
function shaftDirection(p, out){
  /* incident = -normalize(vec3(p.x, max(p.y, 0.001), p.z)) */
  let ix = -p[0], iy = -Math.max(p[1], 0.001), iz = -p[2];
  const il = Math.hypot(ix, iy, iz);
  ix /= il; iy /= il; iz /= il;

  /* refract(incident, N = (0, 1, 0), ETA) */
  const cosI = iy;
  const k = 1.0 - ETA * ETA * (1.0 - cosI * cosI);
  if (k < 0.0){
    /* Cannot happen for light entering water (ETA < 1); kept for safety */
    out[0] = 0; out[1] = 1; out[2] = 0;
    return out;
  }
  const s = ETA * cosI + Math.sqrt(k);
  const rx = ETA * ix, ry = ETA * iy - s, rz = ETA * iz;
  const rl = Math.hypot(rx, ry, rz);

  /* -normalize(refracted) */
  out[0] = -rx / rl;
  out[1] = -ry / rl;
  out[2] = -rz / rl;
  return out;
}

/* state: { sunDir, moonDir, clock, dive, shallow, scroll, mouseX, mouseY } */
export function updateFrameUniforms(state, f){
  const sun = state.sunDir;
  const moon = state.moonDir;

  phaseWeights(sun[1], f.phase);

  blend3(DAY_Z, SET_Z, NIG_Z, f.phase, zenith);
  f.skyAmbient = zenith[0] * 0.299 + zenith[1] * 0.587 + zenith[2] * 0.114;

  blend3(DAY_L, SET_L, NIG_L, f.phase, f.primaryCol);
  f.envLight = mix(0.15, 1.0, smoothstep(-0.1, 0.2, sun[1]));

  /* The Sun is vastly brighter: anywhere near the horizon or above, it dominates */
  const p = sun[1] > -0.05 ? sun : moon;
  f.primaryDir[0] = p[0];
  f.primaryDir[1] = p[1];
  f.primaryDir[2] = p[2];
  shaftDirection(p, f.shaftDir);

  camOrigin(state, f.camOrigin);
  f.camPitch = camPitch(state);
  f.submergence = submergence(state);
  return f;
}
