/* ============================================================
   PASS 1b — BUBBLES
   Drawn over the tone-mapped ocean, into the same texture, before
   the glass pass samples it; so bubbles still sit behind the glass.

   One instanced quad per visible bubble. The quad is the bubble's
   screen-space bounding box (computed on the CPU, gl/bubble-field.js),
   so the fragment shader only runs on the pixels a bubble can touch,
   instead of every ocean pixel looping over every bubble.

   The per-pixel maths is the ray–sphere test and "Aero" shading the
   ocean shader used to run, unchanged. Compositing is done by the
   blender. The old code did

     final = mix(scene, scene * k + E, w)
           = scene * (1 - w * (1 - k)) + w * E

   which is premultiplied blending (ONE, ONE_MINUS_SRC_ALPHA) with
     rgb = w * E          the bubble's own light (rim, highlights)
     a   = w * (1 - k)    how much it darkens what is behind it
   Identical for a single bubble; where two overlap, the front one
   now refracts the one behind it rather than the bare water.

   Per-instance attributes (see BUBBLE_STRIDE in bubble-field.js):
     aBubble  xyz = bubble relative to the camera, w = radius
     aRect    bounding box in uv space: min x, min y, max x, max y
              (uv = (fragCoord * 2 - res) / res.y, as in the ocean)

   Must match the ocean pass: the uv warp (uWarp = 0.0045 * sub),
   and camRay() in common.glsl.js (focal length 1.45, pitch shear).
   ============================================================ */

export const BUBBLE_VERT = `#version 300 es
layout(location = 0) in vec4 aBubble;
layout(location = 1) in vec4 aRect;

uniform vec2  uRes;
uniform float uAmount;   // overall bubble visibility for the dive, 0..1

flat out vec4  vBubble;
flat out float vFade;

void main(){
  /* Triangle strip: (0,0) (1,0) (0,1) (1,1) */
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 uv = mix(aRect.xy, aRect.zw, corner);

  /* Fade out at the cell's vertical boundaries to prevent grid popping */
  float life = smoothstep(-4.0, -3.0, aBubble.y) * (1.0 - smoothstep(3.0, 4.0, aBubble.y));

  vBubble = aBubble;
  vFade = uAmount * life;
  gl_Position = vec4(uv.x * uRes.y / uRes.x, uv.y, 0.0, 1.0);
}`;

export const BUBBLE_FRAG = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform float uWarp;      // underwater uv shimmer amplitude (same as the ocean pass)
uniform float uCamPitch;  // pitch shear applied to view rays
uniform vec3  uPhase;     // dayW, sunsetW, nightW

flat in vec4  vBubble;
flat in float vFade;

out vec4 fragColor;

void main(){
  /* The same view ray the ocean pass used for this pixel */
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  uv += vec2(sin(uv.y * 7.0 + uTime * 0.9), cos(uv.x * 6.0 + uTime * 0.75)) * uWarp;
  vec3 rd = normalize(vec3(uv.x, uv.y + uCamPitch, -1.45));

  vec3  V = vBubble.xyz;     // Vector from camera to bubble
  float radius = vBubble.w;

  float Z = dot(V, rd);      // Depth along view ray

  // Frustum cull (skip if behind camera or too far away)
  if (Z < 0.1 || Z > 8.0) discard;

  // Perpendicular distance from ray to bubble center
  vec3  perp = V - Z * rd;
  float dist = length(perp);

  // Dynamic Depth of field blur factor (focal plane at 2.5)
  float blur = mix(0.001, 0.04, abs(Z - 2.5) * 0.15);
  if (dist >= radius + blur) discard;

  float alpha = 1.0 - smoothstep(radius - blur, radius + blur, dist);

  // Reconstruct precise 3D Normal of the intersected sphere
  float nZ = sqrt(max(0.0, 1.0 - (dist / radius) * (dist / radius)));
  vec3  N = normalize(-perp - rd * (radius * nZ));

  float ndotv = max(dot(N, -rd), 0.0);
  float f = 1.0 - ndotv;

  float dayW = uPhase.x, sunsetW = uPhase.y, nightW = uPhase.z;

  // Highlight tint matching ambient day phase
  vec3 hiCol = vec3(1.0) * dayW + vec3(1.0, 0.85, 0.6) * sunsetW + vec3(0.7, 0.9, 1.0) * nightW;

  // --- Exaggerated Aero Optics ---

  // 1. Refraction Darkening Center (Diverging Lens effect):
  //    the scene behind is multiplied by this (done by the blender)
  float refrK = mix(0.4, 0.9, ndotv);

  // 2. Chromatic Aberration Rim (Prismatic TIR Edge)
  vec3 ca = vec3(pow(f, 3.0), pow(f, 2.4), pow(f, 1.8));
  vec3 rimDark = mix(vec3(0.0, 0.1, 0.2), vec3(0.1, 0.02, 0.0), sunsetW);
  vec3 rimBright = mix(vec3(0.3, 0.8, 1.0), vec3(1.0, 0.5, 0.1), sunsetW);
  vec3 edgeCol = mix(rimBright * ca, rimDark, pow(f, 6.0));

  // 3. Studio Softbox Reflection (Broad top highlight)
  float softbox = smoothstep(0.2, 0.9, N.y) * 0.5;

  // 4. Razor Sharp Specular Highlights (Primary Sun/Light)
  vec3  lightDir = normalize(vec3(0.4, 0.8, -0.6));
  vec3  H = normalize(lightDir - rd);
  float ndh = max(dot(N, H), 0.0);
  float specMain = pow(ndh, 600.0) * 4.0;

  // 5. Anamorphic Lens Flare (Horizontal streak)
  float flare = pow(ndh, 60.0) * pow(max(1.0 - abs(N.x), 0.0), 12.0) * 2.0;

  // 6. Bottom Glow (Internal bounce volume)
  float innerGlow = 1.0 - smoothstep(-0.8, 0.1, N.y);
  innerGlow *= 0.4;

  // The bubble's own light, on top of the darkened scene
  vec3 emit = edgeCol + (softbox + innerGlow + specMain + flare) * hiCol;

  // Fade out at far distances (and by dive amount / cell life)
  float w = alpha * (1.0 - smoothstep(5.0, 8.0, Z)) * vFade;

  fragColor = vec4(emit * w, w * (1.0 - refrK));
}`;
