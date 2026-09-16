/* ============================================================
   PASS 1 — THE OCEAN
   WebGL2, procedural, above and below the surface.
   Renders the tone-mapped scene into a texture that the glass
   pass refracts and frosts. Bubbles are drawn here too, so
   they sit behind the glass rather than over it.
   ============================================================ */
import { GLSL_COMMON } from './common.glsl.js';

export const OCEAN_FRAG = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;
uniform float uScroll;
uniform float uChop;
uniform float uShallow;
uniform float uDive;

out vec4 fragColor;

${GLSL_COMMON}

/* ---------- wave field ---------- */
float waveField(vec2 p, float dist, int max_octaves, out vec2 grad){
  float h = 0.0;
  grad = vec2(0.0);
  float amp = 0.62, freq = 0.30, speed = 1.0, k = 1.60 * uChop;
  float ang = 0.0;
  vec2 warp = vec2(0.0);
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
  vec3 skyCol = sky(refl);

  float lightI = mix(0.15, 1.0, smoothstep(-0.1, 0.2, getSunDir().y));

  float f0 = 0.02;
  float fres = f0 + (1.0 - f0) * pow(clamp(1.0 - dot(-rd, n), 0.0, 1.0), 5.0);
  float crest = clamp(p.y * 0.95 + 0.45, 0.0, 1.0);

  vec3 deepD    = vec3(0.005, 0.080, 0.180);
  vec3 shallowD = vec3(0.030, 0.350, 0.480);
  vec3 bodyDeep = mix(deepD, shallowD, crest);
  float sss = pow(clamp(dot(n, getPrimaryLight()) * 0.5 + 0.5, 0.0, 1.0), 3.0) * crest;
  bodyDeep += vec3(0.12, 0.45, 0.35) * sss * 0.8 * lightI;

  vec3 rdRefr = refract(rd, n, 1.0 / 1.333);
  float floorY = -1.6;
  float tFloor = (floorY - p.y) / min(rdRefr.y, -0.01);
  vec3 pFloor = p + rdRefr * tFloor;

  float caustics = getCaustics(pFloor.xz);
  float sandRipples = sin(pFloor.x * 6.0 + sin(pFloor.z * 4.0)) * 0.05 + 0.95;
  vec3 sand = vec3(0.85, 0.80, 0.65) * sandRipples;
  vec3 floorC = sand + vec3(1.0, 0.95, 0.8) * caustics * 2.0 * lightI;

  float depthWalk = max(tFloor, 0.0);
  vec3 extinction = exp(-vec3(0.8, 0.25, 0.05) * depthWalk);
  
  // Ambient darkening during nighttime
  bodyDeep *= lightI;
  vec3 scatter = vec3(0.0, 0.4, 0.5) * (1.0 - extinction) * 0.3 * lightI;
  vec3 bodyShallow = floorC * extinction + scatter;

  vec3 body = mix(bodyDeep, bodyShallow, uShallow);

  vec3 hv = normalize(getPrimaryLight() - rd);
  float specMain = pow(clamp(dot(n, hv), 0.0, 1.0), 400.0) * 3.0 * lightI;

  float microFade = smoothstep(60.0, 15.0, dist);
  float spec = specMain;

  if (microFade > 0.01){
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    vec2 microUV = p.xz * 12.0 - uTime * 0.3;
    float micro = vnoise(rot * microUV) * 0.5 + 0.5;
    vec3 nGlint = normalize(n + vec3(micro * 0.15, 0.0, micro * 0.15) * microFade);
    float specGlint = pow(clamp(dot(nGlint, hv), 0.0, 1.0), 1200.0) * (3.0 * microFade) * lightI;
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
  col = mix(col, sky(vec3(rd.x, 0.004, rd.z)), fog);

  return col;
}

/* ---------- underwater ---------- */
float seabedDepth(){ return mix(-27.0, -12.0, uShallow); }

vec3 seabedColor(vec3 p){
  float lightI = mix(0.15, 1.0, smoothstep(-0.1, 0.2, getSunDir().y));
  vec2 q = p.xz;
  float grain  = fbm(q * 0.55);
  float ripple = sin(q.x * 1.7 + sin(q.y * 1.2) * 1.8) * 0.5 + 0.5;
  vec3 sand = mix(vec3(0.40, 0.38, 0.30), vec3(0.88, 0.84, 0.70),
                  clamp(grain * 0.65 + ripple * 0.35, 0.0, 1.0));
  float weed = smoothstep(0.52, 0.80, fbm(q * 0.22 + 7.3));
  sand = mix(sand, vec3(0.10, 0.24, 0.16), weed * 0.70);
  float rocks = smoothstep(0.74, 0.90, fbm(q * 0.95 + 21.0));
  sand = mix(sand, vec3(0.30, 0.32, 0.31), rocks * 0.55);
  vec3 s = p + getShaftDir() * ((0.0 - p.y) / getShaftDir().y);
  float c = getCaustics(s.xz * 0.38);
  sand += vec3(1.0, 0.95, 0.80) * c * 1.15 * exp(p.y * 0.035) * lightI;
  sand *= mix(0.3, 1.0, lightI);
  return sand;
}

vec3 renderUnder(vec3 ro, vec3 rd){
  float lightI = mix(0.15, 1.0, smoothstep(-0.1, 0.2, getSunDir().y));
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
      col = sky(normalize(refr)) * 1.06;
      float rim = 1.0 - clamp(dot(-rd, nd), 0.0, 1.0);
      col += vec3(0.50, 0.86, 0.96) * pow(rim, 6.0) * 0.55 * lightI;
    } else {
      vec3 rr = reflect(rd, nd);
      float down = clamp(-rr.y, 0.0, 1.0);
      col = mix(vec3(0.03, 0.16, 0.24), vec3(0.16, 0.30, 0.28), down);
      col += vec3(0.20, 0.45, 0.48) * getCaustics(p.xz * 0.45) * 0.35 * lightI;
    }
    col += vec3(0.30, 0.60, 0.62) * getCaustics(p.xz * 0.55) * 0.30 * lightI;
  } else if (rd.y < -0.035){
    float tb = (bedY - ro.y) / rd.y;
    t = min(tb, 240.0);
    col = (tb < 240.0) ? seabedColor(ro + rd * t) : vec3(0.02, 0.09, 0.14) * mix(0.2, 1.0, lightI);
  } else {
    t = 200.0;
    col = vec3(0.02, 0.09, 0.14) * mix(0.2, 1.0, lightI);
  }
  float td = min(t, 150.0);
  vec3 absorbC = vec3(0.155, 0.045, 0.028);
  vec3 ext = exp(-absorbC * td);
  float midY = ro.y + rd.y * td * 0.5;
  vec3 amb = vec3(0.045, 0.30, 0.42) * exp(clamp(midY, -70.0, 0.0) * 0.045);
  amb *= mix(0.2, 1.0, lightI);
  col = col * ext + amb * (1.0 - ext);
  float shaft = 0.0;
  float dith  = hash21(gl_FragCoord.xy * 0.37 + fract(uTime) * 91.0);
  float segLen = min(td, 60.0) / 10.0;
  for (int i = 0; i < 10; i++){
    vec3 sp = ro + rd * (segLen * (float(i) + dith));
    if (sp.y > -0.15) continue;
    vec3 q = sp + getShaftDir() * ((0.0 - sp.y) / getShaftDir().y);
    shaft += getCaustics(q.xz * 0.22) * exp(sp.y * 0.05);
  }
  shaft /= 10.0;
  float toSun = clamp(dot(rd, getShaftDir()), 0.0, 1.0);
  col += vec3(0.42, 0.86, 0.98) * shaft * (0.55 + 1.35 * pow(toSun, 2.2)) * 1.25 * lightI;
  return col;
}

/* ---------- bubbles ---------- */
vec3 addBubbles(vec3 col, vec2 fc, float amount){
  if (amount <= 0.001) return col;
  float aspect = uRes.x / uRes.y;
  vec2 p = fc / uRes.y;
  for (int i = 0; i < 18; i++){
    float fi = float(i);
    float h1 = hash21(vec2(fi, 1.7));
    float h2 = hash21(vec2(fi, 9.3));
    float h3 = hash21(vec2(fi, 4.1));
    float h4 = hash21(vec2(fi, 6.6));
    float rad   = mix(0.006, 0.028, h2 * h2);
    float speed = 0.035 + rad * 2.4;
    float cyc   = fract(uTime * speed + h1);
    float y     = mix(-0.08, 1.10, cyc);
    float x     = h4 * aspect + (h3 - 0.5) * 0.18 * cyc
                + sin(uTime * 1.1 + h1 * 25.0) * rad * 0.6;
    vec2  d = p - vec2(x, y);
    float r = length(d);
    if (r > rad) continue;
    float t = r / rad;
    float life = smoothstep(-0.08, 0.02, y) * (1.0 - smoothstep(0.96, 1.10, y));
    float edge = 1.0 - smoothstep(0.94, 1.0, t);
    float ring = smoothstep(0.55, 0.92, t) * edge;
    float fill = (1.0 - smoothstep(0.0, 0.9, t)) * 0.10;
    vec2  hp = d / rad - vec2(-0.32, 0.34);
    float hi = exp(-dot(hp, hp) * 10.0) * edge;
    float a  = amount * life;
    col = mix(col, vec3(0.78, 0.94, 1.0), a * (ring * 0.55 + fill));
    col += vec3(1.0) * hi * 0.65 * a;
  }
  return clamp(col, 0.0, 1.0);
}

void main(){
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  float d = clamp(uDive, 0.0, 1.0);
  float sub = smoothstep(0.15, 0.60, d);
  float bedY = seabedDepth();

  float camY;
  if (d < 0.3){
    float t = d / 0.3; camY = 3.3 - 7.3 * t * t;
  } else {
    float t = (d - 0.3) / 0.7; camY = mix(-4.0, bedY + 1.5, t);
  }
  camY += sin(uTime * 0.42) * 0.16;
  uv += vec2(sin(uv.y * 7.0 + uTime * 0.9), cos(uv.x * 6.0 + uTime * 0.75)) * 0.0045 * sub;

  vec3 ro = vec3(uMouse.x * 1.6 + sin(uTime * 0.23) * 0.6 * sub,
                 camY + uMouse.y * 0.35,
                 -uTime * 0.78);
  float pitch = mix(-0.085 - uScroll * 0.02, 0.0, smoothstep(0.0, 0.45, d))
              + smoothstep(0.30, 0.62, d) * (1.0 - smoothstep(0.70, 1.0, d) * 0.66) * 0.30
              + uMouse.y * 0.035;
  vec3 rd = normalize(vec3(uv.x, uv.y + pitch, -1.45));

  vec3 col;
  if (ro.y < waveHeight(ro.xz, 5) - 0.02){
    col = renderUnder(ro, rd);
  } else {
    vec3 p; float t = traceOcean(ro, rd, p);
    if (t < 0.0){
      col = sky(rd);
    } else {
      vec2 g; waveField(p.xz, t, 14, g);
      vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
      col = shadeOcean(p, rd, n, t);
    }
  }

  /* tone map here so the texture already holds display colour */
  float expo = mix(1.28, 1.58, sub);
  col = 1.0 - exp(-col * expo);
  col = pow(col, vec3(0.86));
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, mix(1.12, 1.04, sub));
  col *= 1.0 - 0.45 * sub * smoothstep(0.55, 1.85, length(uv));

  col = addBubbles(col, gl_FragCoord.xy, smoothstep(0.10, 0.32, d));

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
