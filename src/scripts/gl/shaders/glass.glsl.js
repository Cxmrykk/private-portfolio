/* ============================================================
   PASS 2 — GLASS
   Samples the ocean texture and composites every panel,
   bottom-to-top. uLayerRender 0 writes the base canvas
   (ocean + low-z glass); 1 writes the transparent UI canvas
   (premultiplied alpha) that sits above the DOM.
   Physical sun / moon / shaft glints live in glint.glsl.js.
   Per-panel dye (Funky Seasons) lives in tint.glsl.js.

   Gel buttons (type 1) are dyed glass too: their blue gradient
   is the panel's dye, not a flat fill laid over the water. The
   refracted water takes the blue, the bevels deepen it, and the
   shadow, rim light and glints all come out blue.

   The per-pixel lighting shared by all panels (light position on
   screen, colours, underwater dapple, half-vectors, view ray) is
   set up lazily, on the first panel whose reach covers the pixel.
   On the base canvas most pixels touch no panel and now only pay
   for the ocean fetch and the cursor glow.
   ============================================================ */
import { GLSL_COMMON } from './common.glsl.js';
import { GLSL_GLINT } from './glint.glsl.js';
import { GLSL_TINT } from './tint.glsl.js';

export const GLASS_FRAG = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;
uniform vec3  uCursor;      // x, y in canvas px (y up); z = pointer presence 0..1
uniform float uPx;          // canvas pixels per CSS pixel
uniform float uScroll;
uniform float uDive;
uniform float uShallow;     // seabed depth (shared GLSL)
uniform int   uLayerRender; // 0 = base layer, 1 = UI layer
uniform sampler2D uOcean;

#define MAX_GLASS 60
#define IOR 1.52            // crown glass
uniform int  uGlassCount;
uniform vec4 uGlassRects[MAX_GLASS];  // x, y, w, h  (canvas px, y up)
uniform vec4 uGlassParams[MAX_GLASS]; // radius, type, padding, opacity
uniform vec4 uGlassTints[MAX_GLASS];  // dye r, g, b (0..1), strength (0 = clear)

out vec4 fragColor;

${GLSL_COMMON}
${GLSL_GLINT}
${GLSL_TINT}

/* rounded-rect signed distance with outward gradient */
float sdRect(vec2 p, vec2 hs, float r, out vec2 grad){
  vec2 q = abs(p) - hs + vec2(r);
  float d = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  vec2 s = sign(p);
  if (max(q.x, q.y) > 0.0) grad = s * normalize(max(q, 0.0));
  else grad = (q.x > q.y) ? vec2(s.x, 0.0) : vec2(0.0, s.y);
  return d;
}

vec2 lightScreenPos(float d){
  float pitch = camPitch();
  float k = (GLINT_GAIN > 0.0) ? submergence() : smoothstep(0.15, 0.60, d);
  vec3 D = normalize(mix(getPrimaryLight(), getShaftDir(), k));
  vec2 uv = D.xy / max(-D.z, 0.05) * 1.45;
  uv.y -= pitch;
  return (uv * uRes.y + uRes) * 0.5;
}

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 envReflect(vec3 R, float dive){
  vec3 skyC = sky(normalize(vec3(R.x * 0.9, max(R.y, 0.0) * 0.85 + 0.06, -0.5)), false);
  skyC = pow(1.0 - exp(-skyC * 1.28), vec3(0.86));
  vec3 up    = mix(vec3(luma(skyC)), skyC, 0.30);
  vec3 down  = mix(vec3(0.22, 0.26, 0.30), vec3(0.62, 0.68, 0.74), clamp(R.y + 1.0, 0.0, 1.0));
  vec3 above = mix(down, up, smoothstep(-0.30, 0.15, R.y));
  vec3 below = mix(vec3(0.10, 0.20, 0.26), vec3(0.70, 0.88, 0.94), clamp(R.y * 0.6 + 0.5, 0.0, 1.0));
  below = mix(vec3(luma(below)), below, 0.45);
  return mix(above, below, dive);
}

/* tint:  for the gel button (type 1), the dye gradient of the glass
          itself; main() hands it to the tint pipeline at full strength.
   tintW: share of a flat colour laid over the refraction (0 = none). */
void material(float type, vec2 lu, out vec3 tint, out float tintW, out float frostLod, out float shadowW, out float bevK, out float thick){
  tint = vec3(1.0);
  if (type < 0.5){
    tintW = 0.0;
    frostLod = 0.0;
    shadowW = 0.22;
    bevK = 0.30;
    thick = 1.6;
  } else if (type < 1.5){
    /* Classic two-tone aqua gel: light upper half, deeper lower half.
       Clamped, since the cast shadow evaluates it outside the panel. */
    float y = clamp(lu.y, 0.0, 1.0);
    vec3 c1 = vec3(0.56, 0.86, 1.00), c2 = vec3(0.18, 0.65, 0.91);
    vec3 c3 = vec3(0.05, 0.46, 0.75), c4 = vec3(0.04, 0.37, 0.63);
    tint = y > 0.52 ? mix(c2, c1, (y - 0.52) / 0.48) : mix(c4, c3, y / 0.52);
    tintW = 0.0;
    frostLod = 0.6;
    shadowW = 0.26;
    bevK = 0.50;
    thick = 1.2;
  } else if (type < 2.5){
    tintW = 0.0;
    frostLod = 0.0;
    shadowW = 0.16;
    bevK = 0.50;
    thick = 1.2;
  } else {
    tintW = 0.0;
    frostLod = 0.0;
    shadowW = 0.08;
    bevK = 0.22;
    thick = 1.2;
  }
}

void main(){
  vec2  fc = gl_FragCoord.xy;
  vec2  texel = 1.0 / uRes;
  float margin = 28.0 * uPx;

  if (uLayerRender == 1){
    bool near = false;
    for (int i = 0; i < MAX_GLASS; i++){
      if (i >= uGlassCount) break;
      vec4 rect = uGlassRects[i];
      vec2 q = abs(fc - rect.xy - rect.zw * 0.5) - rect.zw * 0.5;
      if (max(q.x, q.y) < margin){ near = true; break; }
    }
    if (!near) discard;
  }

  float dive = clamp(uDive, 0.0, 1.0);
  float diveFade = smoothstep(0.0, 0.5, dive);

  vec3  V = vec3(0.0, 0.0, 1.0);
  float oShare = (uLayerRender == 0) ? 1.0 : 0.45;

  /* Cursor light: the base layer adds its glow to every pixel */
  float curD = length(uCursor.xy - fc);
  float curW = exp(-curD / (320.0 * uPx)) * uCursor.z;

  float shadowReach = 14.0 * uPx;
  float reach = shadowReach + 8.0 * uPx;

  /* Per-pixel lighting shared by every panel; filled in on the first
     panel within reach (see perPixelReady below). */
  bool  perPixelReady = false;
  vec2  sunPx = vec2(0.0);
  vec3  sunCol = vec3(0.0);
  vec3  hiCol = vec3(0.0);
  float dapple = 0.0;
  float lightI = 0.0;
  vec3  Hsun = V;
  vec3  Hsun2 = V;
  float sunNear = 0.0;
  vec3  rd = vec3(0.0, 0.0, -1.0);
  float glintExpo = 1.28;
  vec3  Hc = V;
  bool  lightsReady = false;

  vec3  col = vec3(0.0);
  float alpha = 0.0;
  float covered = 0.0;
  
  if (uLayerRender == 0){
    col = texture(uOcean, fc * texel).rgb;
    col += vec3(0.5, 0.8, 1.0) * curW * 0.12;
  }

  for (int i = 0; i < MAX_GLASS; i++){
    if (i >= uGlassCount) break;
    vec4  rect  = uGlassRects[i];
    float r     = uGlassParams[i].x;
    float type  = uGlassParams[i].y;
    float op    = uGlassParams[i].w;
    vec3  dye   = uGlassTints[i].rgb;
    float tk    = uGlassTints[i].a;

    vec2 hs = rect.zw * 0.5;
    vec2 center = rect.xy + hs;
    vec2 p = fc - center;

    vec2 q = abs(p) - hs;
    if (max(q.x, q.y) > reach) continue;

    if (!perPixelReady){
      perPixelReady = true;

      sunPx = lightScreenPos(dive);
      float envLightI = envLight();
      sunCol = mix(getPrimaryLightCol(), vec3(0.72, 0.95, 1.00) * envLightI, diveFade);
      hiCol  = mix(sunCol, vec3(1.0), 0.7);

      /* Underwater dapple. Every use is scaled by diveFade, so above
         the surface the caustic field has no effect; skip evaluating it. */
      dapple = (diveFade > 0.0)
        ? getCaustics(fc * texel * vec2(uRes.x / uRes.y, 1.0) * 4.5 + vec2(0.0, uScroll * 0.4))
        : 0.0;
      lightI = mix(1.0, 0.82 + 0.50 * dapple, diveFade) * envLightI;

      vec3 Ls  = normalize(vec3(sunPx - fc, 900.0 * uPx));
      Hsun     = normalize(Ls + V);
      vec3 Ls2 = normalize(vec3(fc - sunPx, 900.0 * uPx));
      Hsun2    = normalize(Ls2 + V);
      sunNear  = exp(-length(sunPx - fc) / (1100.0 * uPx));

      rd = camRay((fc * 2.0 - uRes) / uRes.y);
      glintExpo = mix(1.28, 1.58, smoothstep(0.15, 0.60, dive));

      vec3 Lc = normalize(vec3(uCursor.xy - fc, 300.0 * uPx));
      Hc = normalize(Lc + V);
    }

    vec2  grad; float dist = sdRect(p, hs, r, grad);
    float inside = 1.0 - smoothstep(-0.5, 0.5, dist);
    float mask = inside * op;
    vec2  lu = (fc - rect.xy) / rect.zw;
    vec2  pn = p / hs;                                        
    vec2  L2 = normalize(sunPx - center + vec2(0.0, 0.001));  

    vec3 tint; float tintW, frostLod, shadowW, bevK, thick;
    material(type, lu, tint, tintW, frostLod, shadowW, bevK, thick);

    /* Gel buttons: the blue gradient is the glass's own dye, so it
       drives the refraction colour, bevel absorption, shadow and glints */
    if (type > 0.5 && type < 1.5){
      dye = tint;
      tk = 1.0;
    }

    float lI   = lightI;
    float bev  = clamp(min(hs.x, hs.y) * bevK, 6.0 * uPx, 30.0 * uPx);

    if (shadowW > 0.0){
      vec2  gS; float dS = sdRect(p + L2 * 3.0 * uPx, hs, r, gS);
      float outsideW = op * (1.0 - inside);
      float shadow = (1.0 - smoothstep(-1.0, shadowReach, dS)) * shadowW * outsideW;
      float focus  = exp(-pow((dS - 5.0 * uPx) / (4.0 * uPx), 2.0))
                   * clamp(dot(gS, -L2), 0.0, 1.0) * shadowW * 0.9 * outsideW * lI;
      col *= tintShadow(shadow, dye, tk);
      col += sunCol * focus * tintSpill(dye, tk);
      if (uLayerRender == 1) alpha = shadow + alpha * (1.0 - shadow);
    }

    if (mask <= 0.0005) continue;

    float s    = smoothstep(-bev, 0.0, dist);
    float face = 1.0 - s;
    float sI   = min(s, 0.985);
    float cI   = sqrt(1.0 - sI * sI);
    vec3  N    = vec3(grad * sI, cI);
    float fres = 0.04 + 0.96 * pow(1.0 - cI, 5.0);            
    float facing = dot(grad, L2) * 0.5 + 0.5;                  

    float sT    = sI / IOR;
    float tanT  = sT / sqrt(1.0 - sT * sT);
    float tanI  = sI / cI;
    float raw   = thick * tanT + 0.6 * tanI;
    float shift = bev * 3.4 * (1.0 - exp(-raw / 3.4));
    float disp  = 0.05 * s * (0.4 + 0.6 * facing);             
    vec2  base  = (center + p * 0.96) * texel;                  
    vec2  refr  = -grad * shift * texel;
    float lod   = tintFrostLod(frostLod, tk) * face;

    vec3 rimS = vec3(textureLod(uOcean, base + refr * (1.0 - disp), lod).r,
                     textureLod(uOcean, base + refr,                lod).g,
                     textureLod(uOcean, base + refr * (1.0 + disp), lod).b);
    vec3 rim0 = textureLod(uOcean, base, lod).rgb;
    vec3 bg = mix(rimS, col + (rimS - rim0), covered);

    float wT = tintW, wO = (1.0 - tintW) * oShare;
    float srcA = wT + wO;
    vec3  body = (tint * wT + bg * wO) / srcA;

    body = mix(body, (body - 0.5) * 1.08 + 0.5, face * (1.0 - tintW));
    body *= pow(vec3(0.975, 1.0, 1.0), vec3(3.0 * s * s));

    /* dyed glass: colourised face, in-scatter glow, absorbing bevels */
    body = tintBody(body, dye, tk, face, s, sT, lI);

    vec3  Nf    = normalize(vec3(pn * 0.10, 1.0));
    float sheen = pow(clamp(dot(Nf, Hsun), 0.0, 1.0), 6.0) * 0.16 * lI * (0.4 + 0.6 * sunNear) * face;
    body += hiCol * sheen;
    body += hiCol * dapple * 0.06 * diveFade * face;

    float band = smoothstep(0.12, 0.50, s) * (1.0 - smoothstep(0.50, 0.92, s));
    body *= 1.0 - band * 0.16 * (1.0 - 0.5 * facing);

    vec3  R = reflect(-V, N);
    vec3  env = envReflect(R, diveFade);
    if (uLayerRender == 0){
      vec3 ssr = textureLod(uOcean, clamp(fc * texel + R.xy * 0.10, 0.0, 1.0), 1.5).rgb;
      env = mix(env, ssr, 0.25);
    }
    body = mix(body, env, fres);

    float rimGlow = smoothstep(0.62, 0.97, s);
    vec3  rimC = tintRim(mix(env, hiCol, 0.45 * facing * (0.5 + 0.5 * lI)), dye, tk);
    body = mix(body, rimC, rimGlow * 0.60);

    float sil = exp(-pow((dist + 0.5 * uPx) / (0.8 * uPx), 2.0));
    body *= 1.0 - sil * 0.18;

    float ndh   = clamp(dot(N, Hsun),  0.0, 1.0);
    float ndh2  = clamp(dot(N, Hsun2), 0.0, 1.0);
    float specS = (pow(ndh, 90.0) * 1.10 + pow(ndh, 12.0) * 0.22 + pow(ndh, 3.0) * 0.06) * s;
    float specB = (pow(ndh2, 60.0) * 0.30 + pow(ndh2, 10.0) * 0.06) * s;
    float specL = (specS + specB) * lI * (0.45 + 0.55 * sunNear);

    float specC   = pow(clamp(dot(N, Hc), 0.0, 1.0), 40.0) * 0.50 * curW * s;
    float curFace = curW * 0.10 * face;

    vec3  spec = hiCol * (specL + specC) + vec3(1.0) * curFace;

    if (GLINT_GAIN > 0.0 && s > 0.30){
      if (!lightsReady){ setupLights(rd); lightsReady = true; }

      float tS   = clamp((dist + bev) / bev, 0.0, 1.0);
      float rate = max(6.0 * tS * (1.0 - tS) / (bev * cI), 0.01);

      vec3 glassCol = tintGlassCol((tintW > 0.0) ? tint : vec3(0.84, 0.95, 0.91), dye, tk);
      vec3 g = glassGlint(rd, N, rate, glassCol) * smoothstep(0.30, 0.45, s);

      vec3 gD = pow(1.0 - exp(-g * glintExpo), vec3(0.86));
      spec += gD * (1.0 - clamp(body + spec, 0.0, 1.0));
    }

    if (uLayerRender == 0){
      col = mix(col, body + spec, mask);
    } else {
      float sa = srcA * mask;
      vec3  sc = body * sa + spec * mask;
      col   = sc + col * (1.0 - sa);
      alpha = sa + alpha * (1.0 - sa);
    }
    if (type < 0.5 || type > 2.5) covered = max(covered, mask);
  }

  if (uLayerRender == 1){
    alpha = clamp(max(alpha, max(col.r, max(col.g, col.b))), 0.0, 1.0);
    fragColor = vec4(min(col, vec3(1.0)), alpha);
  } else {
    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
}`;
