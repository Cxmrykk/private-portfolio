/* ============================================================
   PASS 2 — GLASS
   Samples the ocean texture and composites every panel,
   bottom-to-top. uLayerRender 0 writes the base canvas
   (ocean + low-z glass); 1 writes the transparent UI canvas
   (premultiplied alpha) that sits above the DOM.
   ============================================================ */
import { GLSL_COMMON } from './common.glsl.js';

export const GLASS_FRAG = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;
uniform vec3  uCursor;      // x, y in canvas px (y up); z = pointer presence 0..1
uniform float uPx;          // canvas pixels per CSS pixel
uniform float uScroll;
uniform float uDive;
uniform int   uLayerRender; // 0 = base layer, 1 = UI layer
uniform sampler2D uOcean;

#define MAX_GLASS 60
#define GLASS_BUBBLES 5     // bubbles trapped in each panel/card; 0 to disable
#define IOR 1.52            // crown glass
uniform int  uGlassCount;
uniform vec4 uGlassRects[MAX_GLASS];  // x, y, w, h  (canvas px, y up)
uniform vec4 uGlassParams[MAX_GLASS]; // radius, type, hover, opacity

out vec4 fragColor;

${GLSL_COMMON}

/* rounded-rect signed distance with outward gradient */
float sdRect(vec2 p, vec2 hs, float r, out vec2 grad){
  vec2 q = abs(p) - hs + vec2(r);
  float d = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  vec2 s = sign(p);
  if (max(q.x, q.y) > 0.0) grad = s * normalize(max(q, 0.0));
  else grad = (q.x > q.y) ? vec2(s.x, 0.0) : vec2(0.0, s.y);
  return d;
}

/* where the environment's light sits on screen, in canvas px:
   the sun above the surface, the light shaft once submerged.
   Uses the ocean pass's camera pitch so it matches the sky. */
vec2 lightScreenPos(float d){
  float pitch = mix(-0.085 - uScroll * 0.02, 0.0, smoothstep(0.0, 0.45, d))
              + smoothstep(0.30, 0.62, d) * (1.0 - smoothstep(0.70, 1.0, d) * 0.66) * 0.30
              + uMouse.y * 0.035;
  vec3 D = normalize(mix(SUN, SHAFT, smoothstep(0.15, 0.60, d)));
  vec2 uv = D.xy / max(-D.z, 0.05) * 1.45;
  uv.y -= pitch;
  return (uv * uRes.y + uRes) * 0.5;
}

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

/* what the glass reflects. Kept nearly neutral so Fresnel adds light,
   not colour: above the surface a bright pale sky when the reflected
   ray goes up and a grey-blue floor when it goes down; once submerged,
   a desaturated water field that brightens toward the surface */
vec3 envReflect(vec3 R, float dive){
  vec3 skyC = sky(normalize(vec3(R.x * 0.9, max(R.y, 0.0) * 0.85 + 0.06, -0.5)));
  skyC = pow(1.0 - exp(-skyC * 1.28), vec3(0.86));
  vec3 up    = mix(vec3(luma(skyC)), skyC, 0.30);
  vec3 down  = mix(vec3(0.22, 0.26, 0.30), vec3(0.62, 0.68, 0.74), clamp(R.y + 1.0, 0.0, 1.0));
  vec3 above = mix(down, up, smoothstep(-0.30, 0.15, R.y));
  vec3 below = mix(vec3(0.10, 0.20, 0.26), vec3(0.70, 0.88, 0.94), clamp(R.y * 0.6 + 0.5, 0.0, 1.0));
  below = mix(vec3(luma(below)), below, 0.45);
  return mix(above, below, dive);
}

/* per-type material
   type 0: clear panel     type 1: gel button
   type 2: clear button    type 3: thin clear card
   tintW    — how much of the slab is its own colour. 0 for clear glass:
              the scene passes through untouched. Only the gel pill is coloured.
   frostLod — mip level sampled on the face (0: optically clear)
   shadowW  — strength of the shadow below the slab
   gel      — 1 for buttons (no bubbles)
   bevK     — bevel radius as a fraction of the element's half-size
   thick    — slab thickness in bevel radii (drives the refraction) */
void material(float type, vec2 lu, float hover, float dive,
              out vec3 tint, out float tintW, out float frostLod, out float shadowW,
              out float gel, out float bevK, out float thick){
  gel = 0.0;
  tint = vec3(1.0);
  if (type < 0.5){
    tintW = 0.0;
    frostLod = 0.0;
    shadowW = 0.22;
    bevK = 0.30;
    thick = 1.6;
  } else if (type < 1.5){
    vec3 c1 = vec3(0.56, 0.86, 1.00), c2 = vec3(0.18, 0.65, 0.91);
    vec3 c3 = vec3(0.05, 0.46, 0.75), c4 = vec3(0.04, 0.37, 0.63);
    tint = lu.y > 0.52 ? mix(c2, c1, (lu.y - 0.52) / 0.48) : mix(c4, c3, lu.y / 0.52);
    if (hover > 0.5) tint = mix(tint, vec3(1.0), 0.12);
    tintW = 0.80;
    frostLod = 0.6;
    shadowW = 0.26;
    gel = 1.0;
    bevK = 0.50;
    thick = 1.2;
  } else if (type < 2.5){
    tintW = 0.0;
    frostLod = 0.0;
    shadowW = 0.16;
    gel = 1.0;
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

  /* UI layer: drop every pixel not near a panel (or its shadow) */
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

  /* ---- the environment's light ----
     warm sun above the surface, cool shaft light below; underwater
     the intensity shimmers gently with the caustic field. The glass
     itself throws near-white highlights whatever the light's colour. */
  vec3  V      = vec3(0.0, 0.0, 1.0);
  vec2  sunPx  = lightScreenPos(dive);
  vec3  sunCol = mix(vec3(1.00, 0.97, 0.90), vec3(0.72, 0.95, 1.00), diveFade);
  vec3  hiCol  = mix(sunCol, vec3(1.0), 0.7);
  float dapple = getCaustics(fc * texel * vec2(uRes.x / uRes.y, 1.0) * 4.5 + vec2(0.0, uScroll * 0.4));
  float lightI = mix(1.0, 0.82 + 0.50 * dapple, diveFade);
  vec3  Ls     = normalize(vec3(sunPx - fc, 900.0 * uPx)); // the light as a screen-space point
  vec3  Hsun   = normalize(Ls + V);
  vec3  Ls2    = normalize(vec3(fc - sunPx, 900.0 * uPx)); // the light seen off the inside of the back face
  vec3  Hsun2  = normalize(Ls2 + V);
  float sunNear = exp(-length(sunPx - fc) / (1100.0 * uPx));  // brighter near the light
  float oShare = (uLayerRender == 0) ? 1.0 : 0.45; // transmitted light that is our ocean vs the DOM

  /* cursor: a soft highlight that rides the bevel, a faint glow on the face */
  float curD = length(uCursor.xy - fc);
  float curW = exp(-curD / (320.0 * uPx)) * uCursor.z;
  vec3  Lc = normalize(vec3(uCursor.xy - fc, 300.0 * uPx));
  vec3  Hc = normalize(Lc + V);

  /* geometry, in canvas px */
  float shadowReach = 14.0 * uPx;
  float reach = shadowReach + 8.0 * uPx;

  vec3  col = vec3(0.0);
  float alpha = 0.0;
  float covered = 0.0;
  if (uLayerRender == 0) col = texture(uOcean, fc * texel).rgb;

  for (int i = 0; i < MAX_GLASS; i++){
    if (i >= uGlassCount) break;
    vec4  rect  = uGlassRects[i];
    float r     = uGlassParams[i].x;
    float type  = uGlassParams[i].y;
    float hover = uGlassParams[i].z;
    float op    = uGlassParams[i].w;

    vec2 hs = rect.zw * 0.5;
    vec2 center = rect.xy + hs;
    vec2 p = fc - center;

    vec2 q = abs(p) - hs;
    if (max(q.x, q.y) > reach) continue;

    vec2  grad; float dist = sdRect(p, hs, r, grad);
    float inside = 1.0 - smoothstep(-0.5, 0.5, dist);
    float mask = inside * op;
    vec2  lu = (fc - rect.xy) / rect.zw;
    vec2  pn = p / hs;                                        // -1..1 across the face
    vec2  L2 = normalize(sunPx - center + vec2(0.0, 0.001));  // panel-to-light, in the plane

    vec3 tint; float tintW, frostLod, shadowW, gel, bevK, thick;
    material(type, lu, hover, diveFade, tint, tintW, frostLod, shadowW, gel, bevK, thick);
    float lI   = lightI * (1.0 + 0.15 * hover);
    float lift = (type > 0.5 && type < 1.5) ? 0.0 : 0.04 * hover;   // clear glass on hover: a touch brighter
    float bev  = clamp(min(hs.x, hs.y) * bevK, 6.0 * uPx, 30.0 * uPx);

    /* ---- shadow cast away from the light, and the caustic the slab focuses on its far side ---- */
    if (shadowW > 0.0){
      vec2  gS; float dS = sdRect(p + L2 * 3.0 * uPx, hs, r, gS);
      float outsideW = op * (1.0 - inside);
      float shadow = (1.0 - smoothstep(-1.0, shadowReach, dS)) * shadowW * outsideW;
      float focus  = exp(-pow((dS - 5.0 * uPx) / (4.0 * uPx), 2.0))
                   * clamp(dot(gS, -L2), 0.0, 1.0) * shadowW * 0.9 * outsideW * lI;
      col *= 1.0 - shadow;
      col += sunCol * focus;
      if (uLayerRender == 1) alpha = shadow + alpha * (1.0 - shadow);
    }

    if (mask <= 0.0005) continue;

    /* ---- bevel geometry: a quarter-round of radius bev at the rim.
            s is the sine of the angle of incidence: 0 on the flat face,
            1 at the silhouette, where the surface turns away from us ---- */
    float s    = smoothstep(-bev, 0.0, dist);
    float face = 1.0 - s;
    float sI   = min(s, 0.985);
    float cI   = sqrt(1.0 - sI * sI);
    vec3  N    = vec3(grad * sI, cI);
    float fres = 0.04 + 0.96 * pow(1.0 - cI, 5.0);            // Schlick
    float facing = dot(grad, L2) * 0.5 + 0.5;                  // 1 on the side of the rim that faces the light

    /* ---- Snell: the ray bends toward the normal on entry, crosses the slab,
            leaves through the flat back face and continues to the scene behind.
            Near the silhouette the exit angle grazes and the scene compresses
            hard, as it does at the edge of a sphere; the shift saturates
            smoothly so it never explodes. ---- */
    float sT    = sI / IOR;
    float tanT  = sT / sqrt(1.0 - sT * sT);
    float tanI  = sI / cI;
    float raw   = thick * tanT + 0.6 * tanI;
    float shift = bev * 3.4 * (1.0 - exp(-raw / 3.4));
    float disp  = 0.05 * s * (0.4 + 0.6 * facing);             // rainbow on the lit side of the bevel
    vec2  base  = (center + p * 0.96) * texel;                  // thick pane: the scene looks a touch larger
    vec2  refr  = -grad * shift * texel;
    float lod   = frostLod * face;

    vec3 rimS = vec3(textureLod(uOcean, base + refr * (1.0 - disp), lod).r,
                     textureLod(uOcean, base + refr,                lod).g,
                     textureLod(uOcean, base + refr * (1.0 + disp), lod).b);
    vec3 rim0 = textureLod(uOcean, base, lod).rgb;
    /* a lower slab already covers this pixel: keep its colour, add only the refraction delta */
    vec3 bg = mix(rimS, col + (rimS - rim0), covered);

    /* ---- what passes through. Clear glass adds no colour: tintW is 0 for
            everything but the gel pill, so body is simply the scene ---- */
    float wT = tintW, wO = (1.0 - tintW) * oShare;
    float srcA = wT + wO;
    vec3  body = (tint * wT + bg * wO) / srcA;

    /* the scene inside a thick slab looks a shade crisper than the scene outside */
    body = mix(body, (body - 0.5) * 1.08 + 0.5, face * (1.0 - tintW));
    body += lift * face;

    /* the only colour the glass contributes: a trace of cyan in the thickest part of the bevel */
    body *= pow(vec3(0.975, 1.0, 1.0), vec3(3.0 * s * s));

    /* ---- the face is very slightly pillowed and reflects the broad light of the
            sky: a soft white sheen that sits toward the light and fades across ---- */
    vec3  Nf    = normalize(vec3(pn * 0.10, 1.0));
    float sheen = pow(clamp(dot(Nf, Hsun), 0.0, 1.0), 6.0) * 0.16 * lI * (0.4 + 0.6 * sunNear) * face;
    body += hiCol * sheen;

    /* ---- caustics playing over the face once underwater ---- */
    body += hiCol * dapple * 0.06 * diveFade * face;

    /* ---- bubbles trapped in the glass (panels and cards) ---- */
    if (gel < 0.5){
      for (int b = 0; b < GLASS_BUBBLES; b++){
        float fb = float(b) * 7.0 + float(i) * 13.0;
        vec2  bc = rect.xy + rect.zw * mix(vec2(0.08), vec2(0.92),
                                           vec2(hash21(vec2(fb, 1.3)), hash21(vec2(fb, 7.7))));
        float br = mix(2.0, 4.5, hash21(vec2(fb, 4.4))) * uPx;
        vec2  d  = fc - bc;
        float rr = length(d) / br;
        if (rr < 1.0){
          float edge = 1.0 - smoothstep(0.90, 1.0, rr);
          float ring = smoothstep(0.55, 0.92, rr) * edge;
          float dark = ring * clamp(-dot(d / br, L2) * 0.5 + 0.3, 0.0, 1.0);
          vec2  hp = d / br - L2 * 0.45;
          float hi = exp(-dot(hp, hp) * 9.0) * edge;
          body *= 1.0 - dark * 0.22;
          body = mix(body, vec3(1.0), (ring * 0.35 + hi * 0.70) * lI);
        }
      }
    }

    /* ---- thickness: just inside the rim the compressed scene sits a shade
            darker, more so on the side away from the light ---- */
    float band = smoothstep(0.12, 0.50, s) * (1.0 - smoothstep(0.50, 0.92, s));
    body *= 1.0 - band * 0.16 * (1.0 - 0.5 * facing);

    /* ---- Fresnel of a neutral environment: adds light, not colour ---- */
    vec3  R = reflect(-V, N);
    vec3  env = envReflect(R, diveFade);
    if (uLayerRender == 0){
      vec3 ssr = textureLod(uOcean, clamp(fc * texel + R.xy * 0.10, 0.0, 1.0), 1.5).rgb;
      env = mix(env, ssr, 0.25);
    }
    body = mix(body, env, fres);

    /* ---- the rim: light trapped in the rounded edge. A luminous band on the
            outer third of the bevel, pale where it mirrors the sky, dim where
            it mirrors the floor, white where it faces the light ---- */
    float rimGlow = smoothstep(0.62, 0.97, s);
    vec3  rimC = mix(env, hiCol, 0.45 * facing * (0.5 + 0.5 * lI));
    body = mix(body, rimC, rimGlow * 0.60);

    /* a hair of shadow at the very silhouette separates the bright rim from the scene */
    float sil = exp(-pow((dist + 0.5 * uPx) / (0.8 * uPx), 2.0));
    body *= 1.0 - sil * 0.18;

    /* ---- highlights: Blinn lobes on the bevel where it faces the light, with
            a broad bloom around them, and a fainter one on the far rim where
            the light reflects off the inside of the back face ---- */
    float ndh   = clamp(dot(N, Hsun),  0.0, 1.0);
    float ndh2  = clamp(dot(N, Hsun2), 0.0, 1.0);
    float specS = (pow(ndh, 90.0) * 1.10 + pow(ndh, 12.0) * 0.22 + pow(ndh, 3.0) * 0.06) * s;
    float specB = (pow(ndh2, 60.0) * 0.30 + pow(ndh2, 10.0) * 0.06) * s;
    float specL = (specS + specB) * lI * (0.45 + 0.55 * sunNear);

    /* cursor: a highlight on the bevel and a soft glow on the face */
    float specC   = pow(clamp(dot(N, Hc), 0.0, 1.0), 40.0) * 0.35 * curW * s;
    float curFace = curW * 0.06 * face;

    vec3  spec = hiCol * (specL + specC) + vec3(1.0) * curFace;

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
    /* additive light over transparency becomes an opaque bright pixel, which keeps premultiplied colour valid */
    alpha = clamp(max(alpha, max(col.r, max(col.g, col.b))), 0.0, 1.0);
    fragColor = vec4(min(col, vec3(1.0)), alpha);
  } else {
    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
}`;
