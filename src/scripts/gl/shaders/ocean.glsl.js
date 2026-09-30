/* ============================================================
   PASS 1 — THE OCEAN
   WebGL2, procedural, above and below the surface.
   Renders the tone-mapped scene into a texture that the glass
   pass refracts and frosts. Bubbles are drawn here too, so
   they sit behind the glass rather than over it.
   The camera, water absorption and shaft colour come from
   GLSL_COMMON so the glass pass lights itself from the same model;
   the per-frame parts of that model (light, camera) are uniforms
   computed on the CPU (gl/lighting.js).
   Bubble positions are computed and frustum-culled per frame on
   the CPU (gl/bubble-field.js); only the first uBubbleCount
   entries are live, and only the ray–sphere test runs here.

   Sand: both floors (the deep seabed under water and the shallow
   floor seen through the surface from above) take their albedo
   from uSand (gl/sand-texture.js) via sandAlbedo():
     - the photo's mean colour (uSandMean) is divided out and the
       tuned SAND_TARGET substituted, so the texture adds detail
       without changing the grading
     - a noise-driven blend of randomly offset copies hides the
       tile grid (Quilez, "texture repetition")
     - it is sampled with textureGrad(), using floor footprints
       computed at the top of main() in uniform control flow, since
       implicit derivatives inside the render branches are undefined
       and shimmer at the branch edges and the horizon
   uSand is declared here, not in GLSL_COMMON, so the glass pass
   doesn't carry an unused sampler.
   ============================================================ */
import { GLSL_COMMON } from './common.glsl.js';
import { BUBBLE_COUNT } from '../bubble-field.js';

export const OCEAN_FRAG = `#version 300 es
precision highp float;

#define BUBBLE_COUNT ${BUBBLE_COUNT}

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;
uniform float uScroll;
uniform float uChop;
uniform float uShallow;
uniform float uDive;
uniform vec4  uBubbles[BUBBLE_COUNT]; // xyz = position relative to the camera (pre-wrapped), w = radius
uniform int   uBubbleCount;           // visible bubbles, packed at the front of uBubbles
uniform sampler2D uSand;              // seamless sand photo, sRGB-decoded to linear, mipmapped
uniform vec3  uSandMean;              // mean linear colour of uSand

out vec4 fragColor;

${GLSL_COMMON}

/* ---------- sand ---------- */
#define SAND_TILE         3.5   // world units covered by one texture tile
#define SAND_VARIATION    0.35  // tiles per cell of the anti-repetition noise
#define SHALLOW_FLOOR_Y  -1.6   // floor height under the surface, seen from above
#define SHALLOW_SAND_GAIN 1.28  // the shallow floor was authored brighter

/* Average sand albedo the scene was tuned with; the photo's own mean
   is replaced by this, so only its detail comes through. */
const vec3 SAND_TARGET = vec3(0.66, 0.62, 0.50);

/* Screen-space derivatives of the floor hit points, written once in
   main() under uniform control flow and read inside the branches. */
vec2 gBedDx, gBedDy;       // deep seabed (under water)
vec2 gFloorDx, gFloorDy;   // shallow floor (from above, through the surface)

/* p: world xz on the floor. dx, dy: its screen-space derivatives. */
vec3 sandAlbedo(vec2 p, vec2 dx, vec2 dy){
  vec2 uv  = p / SAND_TILE;
  vec2 duvdx = dx / SAND_TILE;
  vec2 duvdy = dy / SAND_TILE;

  /* Pick between randomly offset copies of the tile with a slow
     noise, and blend across the change so no seam shows. */
  float l  = vnoise(uv * SAND_VARIATION) * 8.0;
  float f  = fract(l);
  float ia = floor(l + 0.5);
  float ib = floor(l);
  f = min(f, 1.0 - f) * 2.0;

  vec2 offA = sin(vec2(3.0, 7.0) * ia);
  vec2 offB = sin(vec2(3.0, 7.0) * ib);

  vec3 a = textureGrad(uSand, uv + offA, duvdx, duvdy).rgb;
  vec3 b = textureGrad(uSand, uv + offB, duvdx, duvdy).rgb;
  vec3 tex = mix(a, b, smoothstep(0.2, 0.8, f - 0.1 * dot(a - b, vec3(1.0))));

  return tex / max(uSandMean, vec3(0.02)) * SAND_TARGET;
}

/* Floor footprints for mip selection. Both are analytic stand-ins
   for the hits the render branches find:
     seabed   the ray against the seabed plane, exactly as
              renderUnder() hits it wherever the seabed is drawn
     shallow  the ray refracted by a FLAT sea at y = 0 down to the
              shallow floor. The real path bends with the waves, but
              the footprint size is what matters here, and ignoring
              the wave warp keeps crests from blurring the sand. */
void floorFootprints(vec3 ro, vec3 rd){
  float ry = min(rd.y, -0.035);
  vec2 bed = ro.xz + rd.xz * ((seabedDepth() - ro.y) / ry);
  gBedDx = dFdx(bed);
  gBedDy = dFdy(bed);

  vec3 rdc = normalize(vec3(rd.x, min(rd.y, -0.01), rd.z));
  vec3 s   = ro + rdc * (max(ro.y, 0.0) / -rdc.y);
  vec3 tr  = refract(rdc, vec3(0.0, 1.0, 0.0), 1.0 / 1.333);
  vec2 fl  = s.xz + tr.xz * (-SHALLOW_FLOOR_Y / max(-tr.y, 0.01));
  gFloorDx = dFdx(fl);
  gFloorDy = dFdy(fl);
}

/* ---------- wave field ---------- */
float waveField(vec2 p, float dist, int max_octaves, out vec2 grad){
  float h = 0.0;
  grad = vec2(0.0);
  float amp = 0.62, freq = 0.30, speed = 1.0, k = 1.60 * uChop;
  float ang = 0.0;
  vec2 warp = vec2(0.0);
  
  // Standard linear LOD scaling
  float pixel_width = max(dist * 0.0035, 0.001);

  for (int i = 0; i < 14; i++){
    if (i >= max_octaves) break;
    float wave_width = 1.0 / freq;
    float lod = smoothstep(pixel_width, pixel_width * 3.5, wave_width);
    if (lod < 0.001) break;

    ang += 2.39996;
    vec2 d = vec2(cos(ang), sin(ang));
    float ph = dot(p + warp, d) * freq + uTime * speed * freq * 2.4;
    float s  = sin(ph);
    float w  = exp(k * s - k);
    float dw = k * cos(ph) * w;

    h    += amp * w * lod;
    grad += amp * dw * freq * d * lod;
    warp += d * w * amp * 0.38 * lod;
    amp *= 0.66; freq *= 1.79; speed *= 1.06; k *= 0.93;
  }
  grad *= 0.80;
  return h * 0.80 - 0.55;
}

float waveHeight(vec2 p, int max_octaves){
  vec2 g; return waveField(p, 0.0, max_octaves, g);
}

/* ---------- ray marching ---------- */
float traceOcean(vec3 ro, vec3 rd, out vec3 hitP){
  float tn = 0.0, tf = 300.0;
  hitP = ro;
  if (rd.y > 0.01 && ro.y > 0.5) return -1.0;
  float tm = tn;
  float dN = ro.y - waveHeight(ro.xz, 5);
  float dF = (ro.y + rd.y * tf) - waveHeight((ro + rd * tf).xz, 5);
  if (dF > 0.0) return -1.0;

  for (int i = 0; i < 11; i++){
    tm = mix(tn, tf, dN / (dN - dF));
    vec3 p = ro + rd * tm;
    float d = p.y - waveHeight(p.xz, 5);
    if (d < 0.0){ tf = tm; dF = d; } else { tn = tm; dN = d; }
  }
  hitP = ro + rd * tm;
  return tm;
}

float traceUnderside(vec3 ro, vec3 rd){
  float t = (0.0 - ro.y) / max(rd.y, 0.02);
  for (int i = 0; i < 4; i++){
    vec3 p = ro + rd * t;
    float h = waveHeight(p.xz, 5);
    t = max((h - ro.y) / max(rd.y, 0.02), 0.02);
  }
  return t;
}

/* ---------- surface shading ---------- */
vec3 shadeOcean(vec3 p, vec3 rd, vec3 n, float dist){
  vec3 refl = reflect(rd, n);
  refl.y = max(refl.y, 0.015);
  vec3 skyCol = sky(refl, false); // Volumetric clouds disabled for rough ocean reflections

  float dayW, sunsetW, nightW;
  getPhaseWeights(dayW, sunsetW, nightW);
  float lightI = envLight();

  float f0 = 0.02;
  float fres = f0 + (1.0 - f0) * pow(clamp(1.0 - dot(-rd, n), 0.0, 1.0), 5.0);
  float crest = clamp(p.y * 0.95 + 0.45, 0.0, 1.0);

  vec3 deepD_day = vec3(0.005, 0.080, 0.180);
  vec3 deepD_set = vec3(0.003, 0.040, 0.100); 
  vec3 deepD_nig = vec3(0.002, 0.005, 0.015);
  vec3 deepD = deepD_day * dayW + deepD_set * sunsetW + deepD_nig * nightW;

  vec3 shallowD_day = vec3(0.030, 0.350, 0.480);
  vec3 shallowD_set = vec3(0.015, 0.150, 0.250); 
  vec3 shallowD_nig = vec3(0.010, 0.040, 0.080);
  vec3 shallowD = shallowD_day * dayW + shallowD_set * sunsetW + shallowD_nig * nightW;

  vec3 bodyDeep = mix(deepD, shallowD, crest);
  
  vec3 sss_day = vec3(0.12, 0.45, 0.35);
  vec3 sss_set = vec3(1.00, 0.45, 0.10) * 2.5; 
  vec3 sss_nig = vec3(0.02, 0.10, 0.15);
  vec3 sssCol = sss_day * dayW + sss_set * sunsetW + sss_nig * nightW;

  float sss = pow(clamp(dot(n, getPrimaryLight()) * 0.5 + 0.5, 0.0, 1.0), 3.0) * crest;
  bodyDeep += sssCol * sss * lightI;

  vec3 rdRefr = refract(rd, n, 1.0 / 1.333);
  float tFloor = (SHALLOW_FLOOR_Y - p.y) / min(rdRefr.y, -0.01);
  vec3 pFloor = p + rdRefr * tFloor;

  float caustics = getCaustics(pFloor.xz);
  vec3 sand = sandAlbedo(pFloor.xz, gFloorDx, gFloorDy) * SHALLOW_SAND_GAIN;
  vec3 floorC = sand + vec3(1.0, 0.95, 0.8) * caustics * 2.0 * lightI;

  float depthWalk = max(tFloor, 0.0);
  vec3 extinction = exp(-vec3(0.8, 0.25, 0.05) * depthWalk);
  
  bodyDeep *= lightI;
  vec3 scatter = vec3(0.0, 0.4, 0.5) * (1.0 - extinction) * 0.3 * lightI;
  vec3 bodyShallow = floorC * extinction + scatter;

  vec3 body = mix(bodyDeep, bodyShallow, uShallow);

  vec3 hv = normalize(getPrimaryLight() - rd);
  float specMain = pow(clamp(dot(n, hv), 0.0, 1.0), 350.0) * 3.5 * lightI;

  float microFade = smoothstep(60.0, 15.0, dist);
  float spec = specMain;

  if (microFade > 0.01){
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    vec2 microUV = p.xz * 12.0 - uTime * 0.3;
    float micro = vnoise(rot * microUV) * 0.5 + 0.5;
    vec3 nGlint = normalize(n + vec3(micro * 0.15, 0.0, micro * 0.15) * microFade);
    float specGlint = pow(clamp(dot(nGlint, hv), 0.0, 1.0), 1000.0) * (3.0 * microFade) * lightI;
    spec += specGlint;
  }

  float steep = 1.0 - n.y;
  mat2 foamRot = mat2(0.8, -0.6, 0.6, 0.8);
  float foamNoise = vnoise(foamRot * (p.xz * 3.5 + uTime * 0.4));
  float foam = smoothstep(0.15, 0.35, steep) * smoothstep(0.20, 0.85, crest) * (foamNoise * 0.8 + 0.2);

  vec3 col = mix(body, skyCol, fres);
  col += getPrimaryLightCol() * spec;
  col = mix(col, vec3(0.9, 0.95, 1.0), foam * 0.5 * uChop * lightI);

  float fog = 1.0 - exp(-dist * 0.0035);
  col = mix(col, sky(vec3(rd.x, 0.004, rd.z), false), fog); // Clouds disabled for horizon fog

  return col;
}

/* ---------- underwater ---------- */
vec3 seabedColor(vec3 p){
  float dayW, sunsetW, nightW;
  getPhaseWeights(dayW, sunsetW, nightW);
  float lightI = envLight();

  vec2 q = p.xz;

  /* Photo detail, with a slow brightness drift on top so large
     stretches of seabed don't read as one uniform material */
  float grain = fbm(q * 0.55);
  vec3 sand = sandAlbedo(q, gBedDx, gBedDy) * mix(0.84, 1.12, grain);

  float weed = smoothstep(0.52, 0.80, fbm(q * 0.22 + 7.3));
  sand = mix(sand, vec3(0.10, 0.24, 0.16), weed * 0.70);
  float rocks = smoothstep(0.74, 0.90, fbm(q * 0.95 + 21.0));
  sand = mix(sand, vec3(0.30, 0.32, 0.31), rocks * 0.55);

  vec3 s = p + getShaftDir() * ((0.0 - p.y) / getShaftDir().y);
  float c = getCaustics(s.xz * 0.38);

  vec3 caustic_day = vec3(1.0, 0.95, 0.80);
  vec3 caustic_set = vec3(1.0, 0.50, 0.15);
  vec3 caustic_nig = vec3(0.30, 0.60, 0.90);
  vec3 causticC = caustic_day * dayW + caustic_set * sunsetW + caustic_nig * nightW;

  float causticIntensity = mix(0.4, 1.15, lightI) + (nightW * 0.3);
  sand += causticC * c * causticIntensity * exp(p.y * 0.035);
  sand *= mix(0.3, 1.0, lightI) + (nightW * 0.1); 

  return sand;
}

vec3 renderUnder(vec3 ro, vec3 rd){
  float dayW, sunsetW, nightW;
  getPhaseWeights(dayW, sunsetW, nightW);
  float lightI = envLight();
  float bedY = seabedDepth();
  vec3 col; float t;

  if (rd.y > 0.035){
    t = min(traceUnderside(ro, rd), 260.0);
    vec3 p = ro + rd * t;
    vec2 g; waveField(p.xz, t, 10, g);
    vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
    vec3 nd = -n;
    vec3 refr = refract(rd, nd, 1.333);
    
    if (dot(refr, refr) > 1e-4){
      col = sky(normalize(refr), false) * 1.06; // Clouds disabled for refracted sky through surface
      float rim = 1.0 - clamp(dot(-rd, nd), 0.0, 1.0);
      
      vec3 rim_day = vec3(0.50, 0.86, 0.96);
      vec3 rim_set = vec3(1.00, 0.45, 0.15);
      vec3 rim_nig = vec3(0.20, 0.40, 0.80);
      vec3 rimCol = rim_day * dayW + rim_set * sunsetW + rim_nig * nightW;
      
      col += rimCol * pow(rim, 6.0) * 0.55 * lightI;
    } else {
      vec3 rr = reflect(rd, nd);
      float down = clamp(-rr.y, 0.0, 1.0);
      
      vec3 tirUp_day = vec3(0.16, 0.30, 0.28);
      vec3 tirDn_day = vec3(0.03, 0.16, 0.24);
      vec3 tirUp_set = vec3(0.80, 0.35, 0.10);
      vec3 tirDn_set = vec3(0.15, 0.05, 0.10);
      vec3 tirUp_nig = vec3(0.04, 0.10, 0.20);
      vec3 tirDn_nig = vec3(0.01, 0.02, 0.05);

      vec3 upC = tirUp_day * dayW + tirUp_set * sunsetW + tirUp_nig * nightW;
      vec3 dnC = tirDn_day * dayW + tirDn_set * sunsetW + tirDn_nig * nightW;
      col = mix(dnC, upC, down);

      vec3 uC_day = vec3(0.20, 0.45, 0.48);
      vec3 uC_set = vec3(0.90, 0.40, 0.10);
      vec3 uC_nig = vec3(0.10, 0.25, 0.50);
      vec3 uC = uC_day * dayW + uC_set * sunsetW + uC_nig * nightW;
      col += uC * getCaustics(p.xz * 0.45) * 0.35 * lightI;
    }
    vec3 uC2_day = vec3(0.30, 0.60, 0.62);
    vec3 uC2_set = vec3(1.00, 0.60, 0.20);
    vec3 uC2_nig = vec3(0.15, 0.35, 0.60);
    vec3 uC2 = uC2_day * dayW + uC2_set * sunsetW + uC2_nig * nightW;
    col += uC2 * getCaustics(p.xz * 0.55) * 0.30 * lightI;
    
  } else if (rd.y < -0.035){
    float tb = (bedY - ro.y) / rd.y;
    t = min(tb, 240.0);
    
    vec3 void_day = vec3(0.02, 0.09, 0.14);
    vec3 void_set = vec3(0.06, 0.03, 0.08);
    vec3 void_nig = vec3(0.01, 0.01, 0.03);
    vec3 voidC = void_day * dayW + void_set * sunsetW + void_nig * nightW;

    col = (tb < 240.0) ? seabedColor(ro + rd * t) : voidC * mix(0.2, 1.0, lightI);
  } else {
    t = 200.0;
    vec3 void_day = vec3(0.02, 0.09, 0.14);
    vec3 void_set = vec3(0.06, 0.03, 0.08);
    vec3 void_nig = vec3(0.01, 0.01, 0.03);
    vec3 voidC = void_day * dayW + void_set * sunsetW + void_nig * nightW;
    col = voidC * mix(0.2, 1.0, lightI);
  }
  
  float td = min(t, 150.0);
  vec3 absorbC = waterAbsorption(dayW, sunsetW, nightW);
  vec3 ext = exp(-absorbC * td);
  
  float midY = ro.y + rd.y * td * 0.5;
  
  vec3 amb_day = vec3(0.045, 0.30, 0.42);
  vec3 amb_set = vec3(0.15, 0.08, 0.12);
  vec3 amb_nig = vec3(0.015, 0.03, 0.08);
  vec3 ambBase = amb_day * dayW + amb_set * sunsetW + amb_nig * nightW;
  
  vec3 amb = ambBase * exp(clamp(midY, -70.0, 0.0) * 0.045);
  float surfGlow = exp(clamp(midY, -15.0, 0.0) * 0.25);
  amb += vec3(0.8, 0.3, 0.05) * surfGlow * sunsetW * 0.4;
  amb *= mix(0.2 + (nightW * 0.2), 1.0, lightI);
  col = col * ext + amb * (1.0 - ext);
  
  float shaft = 0.0;
  float dith  = hash21(gl_FragCoord.xy * 0.37 + fract(uTime) * 91.0);
  
  // 10 volumetric steps for smooth rendering and to prevent Moire banding
  float segLen = min(td, 60.0) / 10.0;
  vec3 sDir = getShaftDir();
  
  for (int i = 0; i < 10; i++){
    vec3 sp = ro + rd * (segLen * (float(i) + dith));
    if (sp.y > -0.15) continue;
    
    vec3 q = sp + sDir * ((0.0 - sp.y) / sDir.y);
    vec2 drift = vec2(sin(sp.y * 0.15 + uTime * 0.4), cos(sp.y * 0.15 + uTime * 0.3)) * 0.6;
    shaft += getCaustics(q.xz * 0.15 + drift) * exp(sp.y * 0.08);
  }
  shaft /= 10.0;
  float toSun = clamp(dot(rd, sDir), 0.0, 1.0);
  
  vec3 shaftCol = shaftColour(dayW, sunsetW, nightW);
  float shaftIntensity = mix(0.15, 1.25, lightI) + (nightW * 0.15); 
  col += shaftCol * shaft * (0.55 + 1.35 * pow(toSun, 2.2)) * shaftIntensity;
  
  return col;
}

/* ---------- True 3D Physical Bubbles (Frutiger Aero Physics) ----------
   Positions (buoyancy, helical wobble, wrap around the camera) are
   computed and culled once per frame on the CPU; see gl/bubble-field.js.
   uBubbles[i].xyz is the bubble relative to the camera, so it is
   directly the camera-to-bubble vector. Only the first uBubbleCount
   entries are live; they keep their original order. */
vec3 addBubbles(vec3 col, vec3 rd, float amount){
  if (amount <= 0.001) return col;
  
  float dayW, sunsetW, nightW;
  getPhaseWeights(dayW, sunsetW, nightW);
  
  // Highlight tint matching ambient day phase
  vec3 hi_day = vec3(1.0);
  vec3 hi_set = vec3(1.0, 0.85, 0.6);
  vec3 hi_nig = vec3(0.7, 0.9, 1.0);
  vec3 hiCol = hi_day * dayW + hi_set * sunsetW + hi_nig * nightW;

  vec3 finalCol = col;
  float focalZ = 2.5; // Focal plane distance for Depth of Field
  
  for (int i = 0; i < BUBBLE_COUNT; i++){
    if (i >= uBubbleCount) break;
    vec4 b = uBubbles[i];
    vec3 V = b.xyz;          // Vector from camera to bubble
    float radius = b.w;
    
    float Z = dot(V, rd); // Depth along view ray
    
    // Frustum cull (skip if behind camera or too far away)
    if (Z < 0.1 || Z > 8.0) continue;
    
    // Perpendicular distance from ray to bubble center
    vec3 perp = V - Z * rd;
    float dist = length(perp);
    
    // Dynamic Depth of field blur factor
    float blur = mix(0.001, 0.04, abs(Z - focalZ) * 0.15);
    
    if (dist < radius + blur) {
        float alpha = smoothstep(radius + blur, radius - blur, dist);
        
        // Reconstruct precise 3D Normal of the intersected sphere
        float nZ = sqrt(max(0.0, 1.0 - (dist/radius)*(dist/radius)));
        vec3 N = normalize(-perp - rd * (radius * nZ));
        
        float ndotv = max(dot(N, -rd), 0.0);
        float f = 1.0 - ndotv;
        
        // --- Exaggerated Aero Optics ---
        
        // 1. Refraction Darkening Center (Diverging Lens effect)
        vec3 refrCol = col * mix(0.4, 0.9, ndotv);
        
        // 2. Chromatic Aberration Rim (Prismatic TIR Edge)
        vec3 ca = vec3(pow(f, 3.0), pow(f, 2.4), pow(f, 1.8));
        vec3 rimDark = mix(vec3(0.0, 0.1, 0.2), vec3(0.1, 0.02, 0.0), sunsetW);
        vec3 rimBright = mix(vec3(0.3, 0.8, 1.0), vec3(1.0, 0.5, 0.1), sunsetW);
        vec3 edgeCol = mix(rimBright * ca, rimDark, pow(f, 6.0));
        
        // 3. Studio Softbox Reflection (Broad top highlight)
        float softbox = smoothstep(0.2, 0.9, dot(N, vec3(0.0, 1.0, 0.0))) * 0.5;
        
        // 4. Razor Sharp Specular Highlights (Primary Sun/Light)
        vec3 lightDir = normalize(vec3(0.4, 0.8, -0.6));
        vec3 H = normalize(lightDir - rd);
        float specMain = pow(max(dot(N, H), 0.0), 600.0) * 4.0;
        
        // 5. Anamorphic Lens Flare (Horizontal streak)
        float flare = pow(max(dot(N, H), 0.0), 60.0) * pow(max(1.0 - abs(N.x), 0.0), 12.0) * 2.0;
        
        // 6. Bottom Glow (Internal bounce volume)
        float innerGlow = smoothstep(0.1, -0.8, dot(N, vec3(0.0, 1.0, 0.0))) * 0.4;
        
        // Combine all optic layers
        vec3 bubbleCol = refrCol + edgeCol + (softbox + innerGlow) * hiCol + (specMain + flare) * hiCol;
        
        // Fade out smoothly at the cell's vertical boundaries to prevent grid popping
        float life = smoothstep(-4.0, -3.0, V.y) * smoothstep(4.0, 3.0, V.y);
        
        // Fade out at far distances
        float fade = smoothstep(8.0, 5.0, Z) * amount * life;
        
        finalCol = mix(finalCol, bubbleCol, alpha * fade);
    }
  }
  return clamp(finalCol, 0.0, 1.0);
}

void main(){
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  float d = clamp(uDive, 0.0, 1.0);
  float sub = smoothstep(0.15, 0.60, d);

  uv += vec2(sin(uv.y * 7.0 + uTime * 0.9), cos(uv.x * 6.0 + uTime * 0.75)) * 0.0045 * sub;

  vec3 ro = camOrigin();
  vec3 rd = camRay(uv);

  /* Before any branching: the sand's mip footprints need derivatives
     taken in uniform control flow. */
  floorFootprints(ro, rd);

  vec3 col;
  if (ro.y < waveHeight(ro.xz, 5) - 0.02){
    col = renderUnder(ro, rd);
  } else {
    vec3 p; float t = traceOcean(ro, rd, p);
    if (t < 0.0){
      col = sky(rd, true); // Direct sky view, full clouds rendered
    } else {
      vec2 g; waveField(p.xz, t, 14, g);
      vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
      col = shadeOcean(p, rd, n, t);
    }
  }

  float expo = mix(1.28, 1.58, sub);
  col = 1.0 - exp(-col * expo);
  col = pow(col, vec3(0.86));
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, mix(1.12, 1.04, sub));
  col *= 1.0 - 0.45 * sub * smoothstep(0.55, 1.85, length(uv));

  col = addBubbles(col, rd, smoothstep(0.10, 0.32, d));

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
