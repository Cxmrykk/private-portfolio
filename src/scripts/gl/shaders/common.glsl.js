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
#define SUN   normalize(vec3(0.34, 0.20, -0.92))
#define SHAFT normalize(vec3(0.254, 0.682, -0.686))

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
  vec3 horizon = vec3(0.76, 0.92, 0.99);
  vec3 zenith  = vec3(0.10, 0.40, 0.80);
  vec3 col = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.60));

  float sd = max(dot(rd, SUN), 0.0);
  col += vec3(1.00, 0.88, 0.66) * pow(sd, 1200.0) * 14.0;
  col += vec3(1.00, 0.80, 0.52) * pow(sd, 22.0)   * 0.38;
  col += vec3(0.95, 0.80, 0.60) * pow(sd, 3.0)    * 0.06;

  if (rd.y > 0.004){
    vec2 cp = rd.xz / max(rd.y, 0.055);
    float drift = uTime * 0.0055;
    float f = fbm(cp * 0.52 + vec2(drift, drift * 0.35));
    f = smoothstep(0.40, 0.92, f);
    float band = smoothstep(0.0, 0.26, rd.y);
    vec3 cloud = mix(vec3(0.74, 0.83, 0.93), vec3(1.0), smoothstep(0.2, 1.0, f));
    cloud += vec3(1.0, 0.90, 0.72) * pow(sd, 8.0) * 0.30;
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
