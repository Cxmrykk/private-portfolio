/* ============================================================
   BUBBLE FIELD — per-frame bubble positions on the CPU
   Every bubble's position depends only on time and the camera,
   so it is computed once per frame here instead of once per
   pixel in the ocean shader. The shader receives
     uBubbles[i] = vec4(position relative to the camera, radius)
   already wrapped into the 8-unit cell around the camera, and
   only runs the ray–sphere test and shading.

   Computing in float64 and sending small camera-relative values
   also avoids the float32 drift the shader had when uTime (and
   so the absolute positions) grew large.
   ============================================================ */
import { camOrigin, mix } from './camera.js';

export const BUBBLE_COUNT = 40;

const CELL = 8.0;   // size of the repeating cell around the camera
const HALF = 4.0;

/* Four random values per bubble: phase, size, x seed, z seed.
   Shared by both canvases so the UI glass refracts the same
   bubbles as the base layer. */
const seeds = new Float64Array(BUBBLE_COUNT * 4);
for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();

const ro = [0, 0, 0];

/* GLSL mod(v + 4, 8) - 4: wraps into [-4, 4) for negatives too */
function wrap(v){
  const x = v + HALF;
  return x - CELL * Math.floor(x / CELL) - HALF;
}

export function createBubbleBuffer(){
  return new Float32Array(BUBBLE_COUNT * 4);
}

/* state: { clock, dive, shallow, mouseX, mouseY } (see camera.js) */
export function updateBubbles(state, out){
  camOrigin(state, ro);
  const t = state.clock;

  for (let i = 0; i < BUBBLE_COUNT; i++){
    const j = i * 4;
    const h1 = seeds[j], h2 = seeds[j + 1], h3 = seeds[j + 2], h4 = seeds[j + 3];

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
    out[j]     = wrap(px - ro[0]);
    out[j + 1] = wrap(py - ro[1]);
    out[j + 2] = wrap(pz - ro[2]);
    out[j + 3] = radius;
  }
  return out;
}
