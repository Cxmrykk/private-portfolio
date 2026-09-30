/* ============================================================
   BUBBLE FIELD — per-frame bubble positions on the CPU
   Every bubble's position depends only on time and the camera,
   so it is computed once per frame here instead of once per
   pixel in the ocean shader. The shader receives
     uBubbles[i] = vec4(position relative to the camera, radius)
   already wrapped into the 8-unit cell around the camera, plus
   uBubbleCount, and only runs the ray–sphere test and shading.

   Culling: bubbles that no pixel's view ray can touch are dropped
   here, so the shader loops over the visible ones only. The test
   is conservative, and the survivors keep their original order
   (the shader composites them in sequence), so the image is
   identical:
     - the frustum is bounded by a cone around the centre ray
     - a bubble is kept if its direction lies within that cone
       widened by its angular radius (radius + the largest depth-
       of-field blur the shader applies)
     - anything nearer than the shader's near plane is dropped

   Computing in float64 and sending small camera-relative values
   also avoids the float32 drift the shader had when uTime (and
   so the absolute positions) grew large.
   ============================================================ */
import { mix } from './camera.js';

export const BUBBLE_COUNT = 40;

const CELL = 8.0;   // size of the repeating cell around the camera
const HALF = 4.0;

/* Must match addBubbles() in ocean.glsl.js */
const Z_NEAR = 0.1;          // frustum cull: Z < 0.1 is skipped
const BLUR_MAX = 0.04;       // upper bound of the depth-of-field blur
const FOCAL_LENGTH = 1.45;   // camRay(): vec3(uv.x, uv.y + pitch, -1.45)

/* Slack on the screen edges: the underwater shimmer offsets uv by up
   to 0.0045, and float32 in the shader vs float64 here */
const UV_MARGIN = 0.02;
const ANGLE_EPS = 1e-3;

/* Four random values per bubble: phase, size, x seed, z seed.
   Shared by both canvases so the UI glass refracts the same
   bubbles as the base layer. */
const seeds = new Float64Array(BUBBLE_COUNT * 4);
for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();

/* View cone: centre direction (x is always 0) and half-angle */
const fwd = [0, 0, -1];

/* GLSL mod(v + 4, 8) - 4: wraps into [-4, 4) for negatives too */
function wrap(v){
  const x = v + HALF;
  return x - CELL * Math.floor(x / CELL) - HALF;
}

export function createBubbleBuffer(){
  return new Float32Array(BUBBLE_COUNT * 4);
}

/* Half-angle of the smallest cone around the centre ray that holds
   every view ray. uv spans [-aspect, aspect] x [-1, 1]; the angle to
   the centre is quasi-convex over that rectangle, so the corners
   bound it. */
function frustumCone(aspect, pitch){
  const fl = Math.hypot(pitch, FOCAL_LENGTH);
  fwd[1] = pitch / fl;
  fwd[2] = -FOCAL_LENGTH / fl;

  let minCos = 1;
  for (let sx = -1; sx <= 1; sx += 2){
    for (let sy = -1; sy <= 1; sy += 2){
      const cx = sx * (aspect + UV_MARGIN);
      const cy = sy * (1 + UV_MARGIN) + pitch;
      const cz = -FOCAL_LENGTH;
      const c = (cy * fwd[1] + cz * fwd[2]) / Math.hypot(cx, cy, cz);
      if (c < minCos) minCos = c;
    }
  }
  return Math.acos(Math.max(-1, Math.min(1, minCos)));
}

/* Can any view ray in the cone reach this bubble? */
function visible(vx, vy, vz, radius, cone){
  const len = Math.hypot(vx, vy, vz);
  if (len <= Z_NEAR) return false;          // Z = dot(V, rd) <= |V|

  const cosVF = (vy * fwd[1] + vz * fwd[2]) / len;
  const off = Math.acos(Math.max(-1, Math.min(1, cosVF))) - cone;
  if (off <= 0) return true;                // centre is on screen
  if (off >= Math.PI / 2) return false;     // every ray has Z <= 0

  const reach = (radius + BLUR_MAX) / len;
  if (reach >= 1) return true;
  return off <= Math.asin(reach) + ANGLE_EPS;
}

/* state: { clock } · view: { origin: [x,y,z], pitch, aspect }
   Writes the visible bubbles to the front of `out`; returns how many. */
export function updateBubbles(state, out, view){
  const ro = view.origin;
  const t = state.clock;
  const cone = frustumCone(view.aspect, view.pitch);
  let count = 0;

  for (let i = 0; i < BUBBLE_COUNT; i++){
    const s = i * 4;
    const h1 = seeds[s], h2 = seeds[s + 1], h3 = seeds[s + 2], h4 = seeds[s + 3];

    /* Buoyancy speed depends heavily on bubble radius */
    const radius = mix(0.015, 0.08, h2 * h2);
    const speed = 0.8 + radius * 15.0;

    /* Helical wobble */
    const cyc = t * 1.5 + h1 * 20.0;
    const wobbleX = Math.sin(cyc) * radius * 1.2;
    const wobbleZ = Math.cos(cyc) * radius * 1.2;

    /* Virtual world position */
    const px = (h3 - 0.5) * 8.0 + wobbleX;
    const py = t * speed + h1 * 50.0;
    const pz = (h4 - 0.5) * 8.0 + wobbleZ;

    /* Wrap around the camera for an infinite field; the shader only
       ever needs the bubble relative to the camera. */
    const vx = wrap(px - ro[0]);
    const vy = wrap(py - ro[1]);
    const vz = wrap(pz - ro[2]);

    if (!visible(vx, vy, vz, radius, cone)) continue;

    const j = count * 4;
    out[j]     = vx;
    out[j + 1] = vy;
    out[j + 2] = vz;
    out[j + 3] = radius;
    count++;
  }
  return count;
}
