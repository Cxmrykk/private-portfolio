/* ============================================================
   Shared GLSL — fullscreen vertex stage and the helpers both
   passes need (camera, celestial light, water constants, noise,
   sky, caustics).
   GLSL_COMMON expects these uniforms to be declared by the
   including shader before the chunk is inserted:
     uTime, uMouse, uScroll, uDive, uShallow
   ============================================================ */

export const FULLSCREEN_VERT = `#version 300 es
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const GLSL_COMMON = `
uniform float uDayTime; // 0.0 to 24.0

/* ---------- lighting / celestial ---------- */
vec3 getSunDir(){
  float a = (uDayTime - 6.0) / 24.0 * 6.283185;
  return normalize(vec3(cos(a) * 0.8, sin(a), -0.7));
}

vec3 getMoonDir(){
  float a = (uDayTime - 6.0) / 24.0 * 6.283185 + 3.14159;
  return normalize(vec3(cos(a) * 0.8, sin(a), -0.7));
}

vec3 getPrimaryLight(){
  vec3 s = getSunDir();
  vec3 m = getMoonDir();
  return s.y > m.y ? s : m; // Whichever is higher in the sky
}

vec3 getShaftDir(){
  vec3 primary = getPrimaryLight();
  // Ray from light source to the water surface
  vec3 incident = -normalize(vec3(primary.x, max(primary.y, 0.001), primary.z));
  // Refract through water surface (normal points UP)
  // IOR air = 1.0, water = 1.333. Ratio = 0.75018
  vec3 refracted = refract(incident, vec3(0.0, 1.0, 0.0), 0.75018);
  // Return vector pointing BACK to the light source from underwater (Snell's Window)
  return -normalize(refracted);
}

/* Drags out the sunset and sunrise significantly */
void getPhaseWeights(out float dayW, out float sunsetW, out float nightW){
  float sunY = getSunDir().y;
  dayW = smoothstep(0.15, 0.60, sunY);
  nightW = 1.0 - smoothstep(-0.30, 0.0, sunY);
  sunsetW = max(0.0, 1.0 - (dayW + nightW));
}

vec3 getPrimaryLightCol(){
  float dayW, sunsetW, nightW;
  getPhaseWeights(dayW, sunsetW, nightW);

  vec3 dayCol = vec3(1.00, 0.97, 0.90);
  vec3 sunsetCol = vec3(1.00, 0.45, 0.15); // Fiery orange highlights
  vec3 nightCol = vec3(0.50, 0.70, 1.00);

  return dayCol * dayW + sunsetCol * sunsetW + nightCol * nightW;
}

/* Overall scene light level: 0.15 at night, 1.0 in daylight */
float envLight(){
  return mix(0.15, 1.0, smoothstep(-0.1, 0.2, getSunDir().y));
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
  float d = clamp(uDive, 0.0, 1.0);
  return mix(-0.085 - uScroll * 0.02, 0.0, smoothstep(0.0, 0.45, d))
       + smoothstep(0.30, 0.62, d) * (1.0 - smoothstep(0.70, 1.0, d) * 0.66) * 0.30
       + uMouse.y * 0.035;
}

/* Camera height: the piecewise dive curve + idle bob + mouse lift */
float camHeight(){
  float d = clamp(uDive, 0.0, 1.0);
  float y;
  if (d < 0.3){
    float t = d / 0.3; y = 3.3 - 7.3 * t * t;
  } else {
    float t = (d - 0.3) / 0.7; y = mix(-4.0, seabedDepth() + 1.5, t);
  }
  return y + sin(uTime * 0.42) * 0.16 + uMouse.y * 0.35;
}

vec3 camOrigin(){
  float sub = smoothstep(0.15, 0.60, clamp(uDive, 0.0, 1.0));
  return vec3(uMouse.x * 1.6 + sin(uTime * 0.23) * 0.6 * sub,
              camHeight(),
              -uTime * 0.78);
}

/* uv = (fragCoord * 2 - res) / res.y */
vec3 camRay(vec2 uv){
  return normalize(vec3(uv.x, uv.y + camPitch(), -1.45));
}

/* 0 in air, 1 under water. Crosses over while the camera is within
   one unit of the waterline, which the splash veil (|camY| < 2) hides. */
float submergence(){
  return 1.0 - smoothstep(-1.0, 1.0, camHeight());
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
vec3 sky(vec3 rd){
  float y = clamp(rd.y, -0.15, 1.0);
  vec3 sunDir = getSunDir();
  vec3 moonDir = getMoonDir();

  float dayW, sunsetW, nightW;
  getPhaseWeights(dayW, sunsetW, nightW);

  // 3-Stop Dynamic Palettes (Horizon, Mid-Sky, Zenith)
  vec3 dayZ = vec3(0.06, 0.32, 0.73);
  vec3 dayM = vec3(0.38, 0.68, 0.94);
  vec3 dayH = vec3(0.82, 0.94, 1.00);

  vec3 setZ = vec3(0.08, 0.22, 0.38); // Deep teal/blue zenith
  vec3 setM = vec3(0.65, 0.30, 0.35); // Dusty rose/magenta transition
  vec3 setH = vec3(1.00, 0.40, 0.10); // Fiery orange horizon

  vec3 nigZ = vec3(0.01, 0.02, 0.05);
  vec3 nigM = vec3(0.02, 0.05, 0.10);
  vec3 nigH = vec3(0.05, 0.12, 0.20);

  vec3 zenith = dayZ * dayW + setZ * sunsetW + nigZ * nightW;
  vec3 mid    = dayM * dayW + setM * sunsetW + nigM * nightW;
  vec3 horizon= dayH * dayW + setH * sunsetW + nigH * nightW;

  // Blend based on view height
  float hF = clamp(rd.y, 0.0, 1.0);
  vec3 col = mix(horizon, mid, smoothstep(0.0, 0.35, hF));
  col = mix(col, zenith, smoothstep(0.15, 1.0, hF));

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

  // Moon rendering
  float md = max(dot(rd, moonDir), 0.0);
  vec3 moonHalo = vec3(0.8, 0.9, 1.0) * pow(md, 2000.0) * 10.0;
  moonHalo += vec3(0.5, 0.7, 1.0) * pow(md, 100.0) * 0.5;
  col += moonHalo * nightW;

  // Stars rendering
  if (nightW > 0.0 && rd.y > 0.0) {
    float starNoise = hash21(rd.xz / max(rd.y, 0.01) * 250.0 + 12.34);
    float starMask = smoothstep(0.995, 1.0, starNoise);
    col += vec3(1.0) * starMask * nightW * smoothstep(0.0, 0.1, rd.y) * (1.0 - pow(md, 2.0));
  }

  // Volumetric Clouds catching fire
  if (rd.y > 0.004){
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
    cloud += vec3(0.6, 0.8, 1.0) * pow(md, 8.0) * 0.20 * nightW;
    
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
