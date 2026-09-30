/* ============================================================
   Shared GLSL — fullscreen vertex stage and the helpers both
   passes need (camera, celestial light, water constants, noise,
   sky, caustics).

   Per-frame constants (phase of day, light directions and
   colours, camera) are uniforms computed once per frame on the
   CPU (gl/lighting.js, gl/camera.js). The helper functions keep
   their names and meaning, so the passes read them as before.

   GLSL_COMMON declares its own uniforms (below) and expects the
   including shader to declare, before the chunk is inserted:
     uTime, uShallow
   ============================================================ */

export const FULLSCREEN_VERT = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const GLSL_COMMON = `
uniform vec3  uSunDir;       // normalised on the CPU (astronomy.js)
uniform vec3  uMoonDir;

/* Per-frame constants (gl/lighting.js) */
uniform vec3  uPhase;        // dayW, sunsetW, nightW
uniform vec3  uPrimaryDir;   // sun, or the moon once the sun is well below the horizon
uniform vec3  uShaftDir;     // primary light refracted into the water, pointing back up
uniform vec3  uPrimaryCol;   // primary light colour for the phase blend
uniform float uEnvLight;     // overall scene light level, 0.15 night .. 1.0 day
uniform float uSkyAmbient;   // luminance of the zenith sky (moon fade)
uniform vec3  uCamOrigin;    // camera position
uniform float uCamPitch;     // pitch shear applied to view rays
uniform float uSubmergence;  // 0 in air, 1 under water

/* Moon fade thresholds, in sky luminance. The moon is fully visible
   when the sky behind it is darker than LO and invisible above HI.
   Night zenith ~0.02, golden-hour zenith ~0.20, day zenith ~0.29. */
#define MOON_FADE_LO 0.03
#define MOON_FADE_HI 0.14

/* Below this cosine to the moon, its halo (pow(md, 600) * 0.6)
   is under 1e-5 and the disc mask is zero, so the moon is skipped. */
#define MOON_CULL 0.98

/* ---------- lighting / celestial ---------- */
vec3 getSunDir(){
  return uSunDir;
}

vec3 getMoonDir(){
  return uMoonDir;
}

/* The Sun is vastly brighter: anywhere near the horizon or above, it dominates */
vec3 getPrimaryLight(){
  return uPrimaryDir;
}

/* Snell's window: the primary light refracted through the surface
   (IOR air / water), pointing back toward it from under water */
vec3 getShaftDir(){
  return uShaftDir;
}

/* Drags out the sunset and sunrise significantly */
void getPhaseWeights(out float dayW, out float sunsetW, out float nightW){
  dayW = uPhase.x;
  sunsetW = uPhase.y;
  nightW = uPhase.z;
}

/* Rec. 601 luminance */
float skyLuma(vec3 c){
  return dot(c, vec3(0.299, 0.587, 0.114));
}

/* Zenith colour of the sky for the current phase blend */
vec3 skyZenithCol(float dayW, float sunsetW, float nightW){
  vec3 dayZ = vec3(0.06, 0.32, 0.73);
  vec3 setZ = vec3(0.08, 0.22, 0.38); // Deep teal/blue zenith
  vec3 nigZ = vec3(0.01, 0.02, 0.05);
  return dayZ * dayW + setZ * sunsetW + nigZ * nightW;
}

/* Moon visibility driven by light intensity rather than sun angle.
   The ambient term is the brightness of the sky dome (zenith luminance),
   which stays high through golden hour and only drops once the night
   palette takes over. localLuma adds any extra glow behind the moon
   (sun halo, sunset burn) so it also washes out near the afterglow.
   Pass 0.0 when there is no per-pixel context (e.g. glints). */
float moonVisibility(float localLuma){
  return 1.0 - smoothstep(MOON_FADE_LO, MOON_FADE_HI, uSkyAmbient + localLuma);
}

vec3 getPrimaryLightCol(){
  return uPrimaryCol;
}

/* Overall scene light level: 0.15 at night, 1.0 in daylight */
float envLight(){
  return uEnvLight;
}

/* Schlick reflectance of the air/water interface (f0 = 0.02).
   cosI = cosine between the light and the surface normal, which for
   a flat sea is simply the light's elevation (dir.y). */
float waterFresnel(float cosI){
  return 0.02 + 0.98 * pow(1.0 - clamp(cosI, 0.0, 1.0), 5.0);
}

/* ---------- water constants shared by both passes ---------- */
/* Beer-Lambert absorption per unit length, by phase of day */
vec3 waterAbsorption(float dayW, float sunsetW, float nightW){
  vec3 abs_day = vec3(0.155, 0.045, 0.028);
  vec3 abs_set = vec3(0.120, 0.060, 0.035); // Less red absorption during sunset
  vec3 abs_nig = vec3(0.180, 0.050, 0.020);
  return abs_day * dayW + abs_set * sunsetW + abs_nig * nightW;
}

/* Colour of the underwater light shafts, by phase of day */
vec3 shaftColour(float dayW, float sunsetW, float nightW){
  vec3 shaft_day = vec3(0.42, 0.86, 0.98);
  vec3 shaft_set = vec3(1.00, 0.65, 0.25); // Golden shafts
  vec3 shaft_nig = vec3(0.25, 0.45, 0.80); // Bioluminescent / moonlit shafts
  return shaft_day * dayW + shaft_set * sunsetW + shaft_nig * nightW;
}

/* ---------- camera (one model for the ocean and the glass) ---------- */
float seabedDepth(){ return mix(-27.0, -12.0, uShallow); }

/* Pitch is applied as a shear on the ray, not a rotation, so the
   camera axes stay aligned with world x / y / -z. */
float camPitch(){
  return uCamPitch;
}

/* Camera height: the piecewise dive curve + idle bob + mouse lift */
float camHeight(){
  return uCamOrigin.y;
}

vec3 camOrigin(){
  return uCamOrigin;
}

/* uv = (fragCoord * 2 - res) / res.y */
vec3 camRay(vec2 uv){
  return normalize(vec3(uv.x, uv.y + camPitch(), -1.45));
}

/* 0 in air, 1 under water. Crosses over while the camera is within
   one unit of the waterline, which the splash veil (|camY| < 2) hides. */
float submergence(){
  return uSubmergence;
}

/* ---------- noise ---------- */
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  mat2 m = mat2(1.62, 1.18, -1.18, 1.62);
  for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = m * p; a *= 0.5; }
  return s;
}

/* ---------- sky ---------- */
vec3 sky(vec3 rd, bool renderClouds){
  float y = clamp(rd.y, -0.15, 1.0);
  vec3 sunDir = getSunDir();
  vec3 moonDir = getMoonDir();

  float dayW, sunsetW, nightW;
  getPhaseWeights(dayW, sunsetW, nightW);

  // 3-Stop Dynamic Palettes (Horizon, Mid-Sky, Zenith)
  vec3 dayM = vec3(0.38, 0.68, 0.94);
  vec3 dayH = vec3(0.82, 0.94, 1.00);

  vec3 setM = vec3(0.65, 0.30, 0.35); // Dusty rose/magenta transition
  vec3 setH = vec3(1.00, 0.40, 0.10); // Fiery orange horizon

  vec3 nigM = vec3(0.02, 0.05, 0.10);
  vec3 nigH = vec3(0.05, 0.12, 0.20);

  vec3 zenith = skyZenithCol(dayW, sunsetW, nightW);
  vec3 mid    = dayM * dayW + setM * sunsetW + nigM * nightW;
  vec3 horizon= dayH * dayW + setH * sunsetW + nigH * nightW;

  // Blend based on view height
  float hF = clamp(rd.y, 0.0, 1.0);
  vec3 baseSky = mix(horizon, mid, smoothstep(0.0, 0.35, hF));
  baseSky = mix(baseSky, zenith, smoothstep(0.15, 1.0, hF));
  vec3 col = baseSky;

  // Sun rendering - Traditional core
  float sd = max(dot(rd, sunDir), 0.0);
  vec3 sunHalo = vec3(1.00, 0.88, 0.66) * pow(sd, 1200.0) * 14.0 * dayW;
  sunHalo += vec3(1.00, 0.80, 0.52) * pow(sd, 22.0) * 0.38 * (dayW + sunsetW);
  sunHalo += vec3(0.95, 0.80, 0.60) * pow(sd, 3.0)  * 0.06 * (dayW + sunsetW);

  // Sun rendering - Sunset atmospheric horizontal stretching / bleeding
  vec3 squashRd = normalize(vec3(rd.x, rd.y * 3.5, rd.z));
  vec3 squashSun = normalize(vec3(sunDir.x, sunDir.y * 3.5, sunDir.z));
  float sdStretch = max(dot(squashRd, squashSun), 0.0);
  
  sunHalo += vec3(1.00, 0.35, 0.10) * pow(sdStretch, 120.0) * 8.0 * sunsetW; // Wide red/orange burn
  sunHalo += vec3(1.00, 0.80, 0.40) * pow(sdStretch, 350.0) * 3.0 * sunsetW; // Wide bright core
  col += sunHalo;

  // Moon rendering (Frutiger Aero Stylized: Glowing, glassy, pristine orb)
  float md = dot(rd, moonDir);

  // Visibility from light intensity: the sky dome's brightness plus any
  // sun glow at this pixel. Golden hour keeps the dome bright, so the
  // moon stays hidden until the night palette takes over.
  float visibility = moonVisibility(skyLuma(sunHalo));

  // Share of this pixel covered by the visible moon disc (masks the stars)
  float moonCover = 0.0;

  // Only directions near the moon can show its disc or halo
  if (visibility > 0.0 && md > MOON_CULL){
    float mRadius = 0.998; 
    float moonMask = smoothstep(mRadius - 0.0003, mRadius + 0.0003, md);
    
    // Reconstruct the 3D surface normal of the moon for smooth shading
    vec3 delta = rd - moonDir * md;
    float maxDelta = sqrt(max(0.0, 1.0 - mRadius * mRadius));
    vec3 normDelta = delta / max(maxDelta, 0.0001); 
    float nz = sqrt(max(0.0, 1.0 - dot(normDelta, normDelta)));
    vec3 moonNormal = normalize(normDelta + moonDir * nz);
    
    // Clearer phase definition: tighter smoothstep creates a distinct terminator line
    float ndotl = dot(moonNormal, sunDir);
    float diffuse = smoothstep(-0.08, 0.35, ndotl); 
    
    // Glossy Fresnel rim light
    float fresnel = pow(1.0 - max(dot(moonNormal, -rd), 0.0), 3.0);
    
    // Ethereal Aero colors: distinct contrast between lit and dark
    vec3 moonLit = vec3(0.95, 0.98, 1.0) + vec3(0.5, 0.75, 1.0) * pow(diffuse, 2.0); // Bright core
    vec3 moonDark = mix(baseSky * 0.4, vec3(0.02, 0.15, 0.35), 0.65); // Deep, distinct shadow
    
    vec3 moonSurface = mix(moonDark, moonLit, diffuse);
    
    // Rim light heavily favors the lit side to avoid outlining the dark side incorrectly during a crescent
    moonSurface += vec3(0.5, 0.85, 1.0) * fresnel * mix(0.1, 1.2, diffuse);
    
    // Bright atmospheric halo behind the moon
    vec3 moonHalo = vec3(0.4, 0.7, 1.0) * pow(max(md, 0.0), 600.0) * 0.6 * visibility;
    col += moonHalo;
    
    // Composite moon disk
    col = mix(col, moonSurface, moonMask * visibility);
    moonCover = moonMask * visibility;
  }

  // Stars rendering
  if (nightW > 0.0 && rd.y > 0.0) {
    float starNoise = hash21(rd.xz / max(rd.y, 0.01) * 250.0 + 12.34);
    float starMask = smoothstep(0.995, 1.0, starNoise);
    // (1.0 - moonCover) ensures stars never render ON top of the moon
    col += vec3(1.0) * starMask * nightW * smoothstep(0.0, 0.1, rd.y) * (1.0 - moonCover);
  }

  // Volumetric Clouds catching fire (Optimized out for reflections)
  if (renderClouds && rd.y > 0.004){
    vec2 cp = rd.xz / max(rd.y, 0.055);
    float drift = uTime * 0.0055;
    float f = fbm(cp * 0.52 + vec2(drift, drift * 0.35));
    f = smoothstep(0.40, 0.92, f);
    float band = smoothstep(0.0, 0.26, rd.y);
    
    vec3 cloudDay = mix(vec3(0.74, 0.83, 0.93), vec3(1.0), smoothstep(0.2, 1.0, f));
    // Sunset clouds: dark bellies, fiery gold tops
    vec3 cloudSunset = mix(vec3(0.3, 0.15, 0.2), vec3(1.0, 0.6, 0.2), smoothstep(0.1, 0.9, f));
    vec3 cloudNight = mix(vec3(0.05, 0.08, 0.12), vec3(0.15, 0.2, 0.3), smoothstep(0.2, 1.0, f));

    vec3 cloud = cloudDay * dayW + cloudSunset * sunsetW + cloudNight * nightW;
    cloud += vec3(1.0, 0.90, 0.72) * pow(sd, 8.0) * 0.30 * (dayW + sunsetW);
    cloud += vec3(0.6, 0.8, 1.0) * pow(max(md, 0.0), 8.0) * 0.20 * nightW * visibility;
    
    col = mix(col, cloud, f * band * 0.94);
  }
  return col;
}

/* ---------- refractive caustics ---------- */
float getCaustics(vec2 uv){
  uv *= 1.5;
  float t = uTime * 0.7;
  vec2 p = uv;
  float c = 0.0;
  
  // A rotation matrix breaks the perfect orthogonal grid alignment of the sine waves
  mat2 rot = mat2(0.754, -0.656, 0.656, 0.754); 
  
  for (int i = 0; i < 3; i++){
    p = rot * p;
    p = p + vec2(cos(t - p.x), sin(t + p.y));
    c += sin(p.x) * cos(p.y);
  }
  return pow(clamp(c * 0.5 + 0.5, 0.0, 1.0), 4.0);
}
`;
