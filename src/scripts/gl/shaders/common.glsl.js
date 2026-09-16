/* ============================================================
   Shared GLSL — fullscreen vertex stage and the helpers both
   passes need (noise, sky, caustics).
   GLSL_COMMON expects `uniform float uTime;` to be declared by
   the including shader before the chunk is inserted.
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
  return normalize(vec3(primary.x, max(primary.y, 0.05), primary.z));
}

vec3 getPrimaryLightCol(){
  float sunY = getSunDir().y;
  vec3 dayCol = vec3(1.00, 0.97, 0.90);
  vec3 sunsetCol = vec3(1.00, 0.60, 0.30);
  vec3 nightCol = vec3(0.60, 0.80, 1.00);

  float dayW = smoothstep(-0.1, 0.2, sunY);
  float sunsetW = smoothstep(-0.2, 0.1, sunY) * (1.0 - smoothstep(0.1, 0.4, sunY));
  float nightW = 1.0 - smoothstep(-0.2, 0.0, sunY);

  return dayCol * dayW + sunsetCol * sunsetW + nightCol * nightW;
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

  // Dynamic palettes
  vec3 dayZenith = vec3(0.10, 0.40, 0.80);
  vec3 dayHorizon = vec3(0.76, 0.92, 0.99);

  vec3 sunsetZenith = vec3(0.15, 0.25, 0.60);
  vec3 sunsetHorizon = vec3(1.00, 0.45, 0.15);

  vec3 nightZenith = vec3(0.01, 0.02, 0.05);
  vec3 nightHorizon = vec3(0.05, 0.10, 0.15);

  // Time weightings
  float sunY = sunDir.y;
  float dayW = smoothstep(-0.1, 0.2, sunY);
  float sunsetW = smoothstep(-0.2, 0.1, sunY) * (1.0 - smoothstep(0.1, 0.4, sunY));
  float nightW = 1.0 - smoothstep(-0.2, 0.0, sunY);

  vec3 zenith = dayZenith * dayW + sunsetZenith * sunsetW + nightZenith * nightW;
  vec3 horizon = dayHorizon * dayW + sunsetHorizon * sunsetW + nightHorizon * nightW;

  vec3 col = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.60));

  // Sun rendering
  float sd = max(dot(rd, sunDir), 0.0);
  vec3 sunHalo = vec3(1.00, 0.88, 0.66) * pow(sd, 1200.0) * 14.0 * dayW;
  sunHalo += vec3(1.00, 0.60, 0.20) * pow(sd, 200.0) * 2.0 * sunsetW;
  sunHalo += vec3(1.00, 0.80, 0.52) * pow(sd, 22.0)   * 0.38 * (dayW + sunsetW);
  sunHalo += vec3(0.95, 0.80, 0.60) * pow(sd, 3.0)    * 0.06 * (dayW + sunsetW);
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

  // Volumetric Clouds
  if (rd.y > 0.004){
    vec2 cp = rd.xz / max(rd.y, 0.055);
    float drift = uTime * 0.0055;
    float f = fbm(cp * 0.52 + vec2(drift, drift * 0.35));
    f = smoothstep(0.40, 0.92, f);
    float band = smoothstep(0.0, 0.26, rd.y);
    
    vec3 cloudDay = mix(vec3(0.74, 0.83, 0.93), vec3(1.0), smoothstep(0.2, 1.0, f));
    vec3 cloudSunset = mix(vec3(0.4, 0.2, 0.3), vec3(1.0, 0.6, 0.4), smoothstep(0.2, 1.0, f));
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
  for (int i = 0; i < 3; i++){
    p = p + vec2(cos(t - p.x), sin(t + p.y));
    c += sin(p.x) * cos(p.y);
  }
  return pow(clamp(c * 0.5 + 0.5, 0.0, 1.0), 4.0);
}
`;
