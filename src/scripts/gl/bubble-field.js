/* ============================================================
   BUBBLE FIELD — per-frame bubble positions on the CPU
   Every bubble's position depends only on time and the camera,
   so it is computed once per frame here. The bubble pass
   (shaders/bubbles.glsl.js) draws one instanced quad per bubble
   and receives, per bubble (BUBBLE_STRIDE floats):

     0..3   position relative to the camera (already wrapped into
            the 8-unit cell around it) and radius
     4..7   its bounding box on screen, in uv space
            (uv = (fragCoord * 2 - res) / res.y): min x, min y,
            max x, max y

   Bounding box: the shader keeps a pixel when its view ray passes
   within radius + blur of the bubble's centre. View rays are
   (uv.x, uv.y + pitch, -FOCAL_LENGTH), so the rays that can do so
   are bounded, per axis, by the two tangent lines to a circle of
   that reach in the xz (or yz) plane. The reach uses an upper
   bound of the depth-of-field blur over the bubble, and the box is
   padded for the underwater uv shimmer. It is conservative: the
   shader still does the exact test, so the image does not depend
   on it; it only limits which pixels are shaded.

   Culling: bubbles whose box misses the screen, or that lie
   behind the camera / nearer than the shader's near plane, are
   dropped. Survivors keep their original order (they are blended
   in sequence).

   Computing in float64 and sending small camera-relative values
   also avoids float32 drift when the clock (and so the absolute
   positions) grows large.
   ============================================================ */
import { mix } from './camera.js';

export const BUBBLE_COUNT = 40;

/* Floats per bubble in the instance buffer (see above) */
export const BUBBLE_STRIDE = 8;

const CELL = 8.0;   // size of the repeating cell around the camera
const HALF = 4.0;

/* Must match shaders/bubbles.glsl.js */
const Z_NEAR = 0.1;          // frustum cull: Z < 0.1 is skipped
const BLUR_MIN = 0.001;      // depth-of-field blur: mix(BLUR_MIN, BLUR_MAX,
const BLUR_MAX = 0.04;       //   abs(Z - FOCAL_Z) * BLUR_RATE)
const BLUR_RATE = 0.15;
const FOCAL_Z = 2.5;
const FOCAL_LENGTH = 1.45;   // camRay(): vec3(uv.x, uv.y + pitch, -1.45)

/* Slack on the reach for float32 in the shader vs float64 here */
const REACH_EPS = 1e-4;

/* Padding on every side of the box: the underwater shimmer offsets uv
   by up to 0.0045, plus a pixel or two of slack */
const UV_PAD = 0.01;

/* Slack on the screen edges when culling (the two canvases' aspect
   ratios can differ by a rounding) */
const UV_MARGIN = 0.02;

/* Box used when a bubble straddles the camera plane and has no finite
   projection: larger than any screen, clipped by the GPU */
const UV_HUGE = 64;

/* Four random values per bubble: phase, size, x seed, z seed.
   Shared by both canvases so the UI glass refracts the same
   bubbles as the base layer. */
const seeds = new Float64Array(BUBBLE_COUNT * 4);
for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();

/* Scratch for extent(): [lo, hi] */
const span = [0, 0];

/* GLSL mod(v + 4, 8) - 4: wraps into [-4, 4) for negatives too */
function wrap(v){
  const x = v + HALF;
  return x - CELL * Math.floor(x / CELL) - HALF;
}

export function createBubbleBuffer(){
  return new Float32Array(BUBBLE_COUNT * BUBBLE_STRIDE);
}

/* Slopes (x / depth) of the two lines through the camera tangent to a
   circle of radius `reach` centred at offset c, depth d (d > reach).
   Every ray passing within `reach` of the centre lies between them. */
function extent(c, d, reach){
  const k = d * d - reach * reach;
  const root = reach * Math.sqrt(c * c + k);
  span[0] = (d * c - root) / k;
  span[1] = (d * c + root) / k;
  return span;
}

/* state: { clock } · view: { origin: [x,y,z], pitch, aspect }
   Writes the visible bubbles to the front of `out`
   (BUBBLE_STRIDE floats each); returns how many. */
export function updateBubbles(state, out, view){
  const ro = view.origin;
  const t = state.clock;
  const pitch = view.pitch;
  const edgeX = view.aspect + UV_MARGIN;
  const edgeY = 1 + UV_MARGIN;
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

    const len = Math.hypot(vx, vy, vz);
    if (len <= Z_NEAR) continue;              // Z = dot(V, rd) <= |V|

    /* Largest blur any pixel of this bubble can get. For rays within
       reach of the centre, Z lies in [len - reach, len], and the blur
       grows with |Z - FOCAL_Z|, so the ends of that range bound it. */
    const zLo = Math.max(len - (radius + BLUR_MAX), 0);
    const zOff = Math.max(Math.abs(len - FOCAL_Z), Math.abs(zLo - FOCAL_Z));
    const blur = BLUR_MIN + (BLUR_MAX - BLUR_MIN) * zOff * BLUR_RATE;
    const reach = radius + Math.min(blur, BLUR_MAX) + REACH_EPS;

    /* View rays point toward -z */
    const depth = -vz;
    if (depth <= -reach) continue;            // entirely behind the camera

    let uMin, uMax, vMin, vMax;
    if (depth > reach){
      const ex = extent(vx, depth, reach);
      uMin = ex[0] * FOCAL_LENGTH - UV_PAD;
      uMax = ex[1] * FOCAL_LENGTH + UV_PAD;
      const ey = extent(vy, depth, reach);
      vMin = ey[0] * FOCAL_LENGTH - pitch - UV_PAD;
      vMax = ey[1] * FOCAL_LENGTH - pitch + UV_PAD;

      /* Off screen */
      if (uMax < -edgeX || uMin > edgeX || vMax < -edgeY || vMin > edgeY) continue;
    } else {
      /* Straddles the camera plane: no finite box; cover the screen */
      uMin = vMin = -UV_HUGE;
      uMax = vMax = UV_HUGE;
    }

    const j = count * BUBBLE_STRIDE;
    out[j]     = vx;
    out[j + 1] = vy;
    out[j + 2] = vz;
    out[j + 3] = radius;
    out[j + 4] = uMin;
    out[j + 5] = vMin;
    out[j + 6] = uMax;
    out[j + 7] = vMax;
    count++;
  }
  return count;
}
