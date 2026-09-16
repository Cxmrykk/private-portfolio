import { Dive } from './dive.js';

/* ============================================================
   THE OCEAN — WebGL2, procedural, above and below the surface
   + Hyperrealistic Frutiger Aero UI Overlay Renderer
   ============================================================ */
export function initOcean() {
  /* ---- vertex: a single full-screen triangle, no buffers needed ---- */
  const VERT = `#version 300 es
  void main(){
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  /* ---- fragment ---- */
  const FRAG = `#version 300 es
  precision highp float;

  uniform vec2  uRes;
  uniform float uTime;
  uniform vec2  uMouse;
  uniform float uScroll;
  uniform float uChop;
  uniform float uShallow;
  uniform float uDive;
  uniform int   uLayerRender; // 0 = Base Layer, 1 = High-Z UI Transparent Layer

  // UI Glass Parameters
  #define MAX_GLASS 60
  uniform int   uGlassCount;
  uniform vec4  uGlassRects[MAX_GLASS];  // x, y, width, height (in canvas pixels)
  uniform vec4  uGlassParams[MAX_GLASS]; // r: radius, g: type, b: hover state, a: opacity

  out vec4 fragColor;

  #define SUN   normalize(vec3(0.34, 0.20, -0.92))
  #define SHAFT normalize(vec3(0.254, 0.682, -0.686))

  /* ---------- noise functions ---------- */
  float hash21(vec2 p) {
    vec3 p3  = fract(vec3(p.xyx) * 0.1031);
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

  /* ---------- refractive caustics ---------- */
  float getCaustics(vec2 uv) {
    uv *= 1.5;
    float t = uTime * 0.7;
    vec2 p = uv;
    float c = 0.0;
    for (int i = 0; i < 3; i++) {
      p = p + vec2(cos(t - p.x), sin(t + p.y));
      c += sin(p.x) * cos(p.y);
    }
    return pow(clamp(c * 0.5 + 0.5, 0.0, 1.0), 4.0);
  }

  /* ---------- surface shading ---------- */
  vec3 shadeOcean(vec3 p, vec3 rd, vec3 n, float dist){
    vec3 refl = reflect(rd, n);
    refl.y = max(refl.y, 0.015);
    vec3 skyCol = sky(refl);

    float f0 = 0.02;
    float fres = f0 + (1.0 - f0) * pow(clamp(1.0 - dot(-rd, n), 0.0, 1.0), 5.0);
    float crest = clamp(p.y * 0.95 + 0.45, 0.0, 1.0);

    vec3 deepD    = vec3(0.005, 0.080, 0.180);
    vec3 shallowD = vec3(0.030, 0.350, 0.480);
    vec3 bodyDeep = mix(deepD, shallowD, crest);
    float sss = pow(clamp(dot(n, SUN) * 0.5 + 0.5, 0.0, 1.0), 3.0) * crest;
    bodyDeep += vec3(0.12, 0.45, 0.35) * sss * 0.8;

    vec3 rdRefr = refract(rd, n, 1.0 / 1.333);
    float floorY = -1.6;
    float tFloor = (floorY - p.y) / min(rdRefr.y, -0.01);
    vec3 pFloor = p + rdRefr * tFloor;

    float caustics = getCaustics(pFloor.xz);
    float sandRipples = sin(pFloor.x * 6.0 + sin(pFloor.z * 4.0)) * 0.05 + 0.95;
    vec3 sand = vec3(0.85, 0.80, 0.65) * sandRipples;
    vec3 floorC = sand + vec3(1.0, 0.95, 0.8) * caustics * 2.0;

    float depthWalk = max(tFloor, 0.0);
    vec3 extinction = exp(-vec3(0.8, 0.25, 0.05) * depthWalk);
    vec3 scatter = vec3(0.0, 0.4, 0.5) * (1.0 - extinction) * 0.3;
    vec3 bodyShallow = floorC * extinction + scatter;

    vec3 body = mix(bodyDeep, bodyShallow, uShallow);

    vec3 hv = normalize(SUN - rd);
    float specMain = pow(clamp(dot(n, hv), 0.0, 1.0), 400.0) * 3.0;

    float microFade = smoothstep(60.0, 15.0, dist);
    float spec = specMain;

    if (microFade > 0.01) {
      mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
      vec2 microUV = p.xz * 12.0 - uTime * 0.3;
      float micro = vnoise(rot * microUV) * 0.5 + 0.5;
      vec3 nGlint = normalize(n + vec3(micro * 0.15, 0.0, micro * 0.15) * microFade);
      float specGlint = pow(clamp(dot(nGlint, hv), 0.0, 1.0), 1200.0) * (3.0 * microFade);
      spec += specGlint;
    }

    float steep = 1.0 - n.y;
    mat2 foamRot = mat2(0.8, -0.6, 0.6, 0.8);
    float foamNoise = vnoise(foamRot * (p.xz * 3.5 + uTime * 0.4));
    float foam = smoothstep(0.15, 0.35, steep) * smoothstep(0.20, 0.85, crest) * (foamNoise * 0.8 + 0.2);

    vec3 col = mix(body, skyCol, fres);
    col += vec3(1.0, 0.95, 0.85) * spec;
    col = mix(col, vec3(0.9, 0.95, 1.0), foam * 0.5 * uChop);

    float fog = 1.0 - exp(-dist * 0.0035);
    col = mix(col, sky(vec3(rd.x, 0.004, rd.z)), fog);

    return col;
  }

  /* ---------- UNDERWATER ---------- */
  float seabedDepth(){ return mix(-27.0, -12.0, uShallow); }

  vec3 seabedColor(vec3 p){
    vec2 q = p.xz;
    float grain  = fbm(q * 0.55);
    float ripple = sin(q.x * 1.7 + sin(q.y * 1.2) * 1.8) * 0.5 + 0.5;
    vec3 sand = mix(vec3(0.40, 0.38, 0.30), vec3(0.88, 0.84, 0.70),
                    clamp(grain * 0.65 + ripple * 0.35, 0.0, 1.0));
    float weed = smoothstep(0.52, 0.80, fbm(q * 0.22 + 7.3));
    sand = mix(sand, vec3(0.10, 0.24, 0.16), weed * 0.70);
    float rocks = smoothstep(0.74, 0.90, fbm(q * 0.95 + 21.0));
    sand = mix(sand, vec3(0.30, 0.32, 0.31), rocks * 0.55);
    vec3 s = p + SHAFT * ((0.0 - p.y) / SHAFT.y);
    float c = getCaustics(s.xz * 0.38);
    sand += vec3(1.0, 0.95, 0.80) * c * 1.15 * exp(p.y * 0.035);
    return sand;
  }

  vec3 renderUnder(vec3 ro, vec3 rd){
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
        col += vec3(0.50, 0.86, 0.96) * pow(rim, 6.0) * 0.55;
      } else {
        vec3 rr = reflect(rd, nd);
        float down = clamp(-rr.y, 0.0, 1.0);
        col = mix(vec3(0.03, 0.16, 0.24), vec3(0.16, 0.30, 0.28), down);
        col += vec3(0.20, 0.45, 0.48) * getCaustics(p.xz * 0.45) * 0.35;
      }
      col += vec3(0.30, 0.60, 0.62) * getCaustics(p.xz * 0.55) * 0.30;
    } else if (rd.y < -0.035){
      float tb = (bedY - ro.y) / rd.y;
      t = min(tb, 240.0);
      col = (tb < 240.0) ? seabedColor(ro + rd * t) : vec3(0.02, 0.09, 0.14);
    } else {
      t = 200.0;
      col = vec3(0.02, 0.09, 0.14);
    }
    float td = min(t, 150.0);
    vec3 absorbC = vec3(0.155, 0.045, 0.028);
    vec3 ext = exp(-absorbC * td);
    float midY = ro.y + rd.y * td * 0.5;
    vec3 amb = vec3(0.045, 0.30, 0.42) * exp(clamp(midY, -70.0, 0.0) * 0.045);
    col = col * ext + amb * (1.0 - ext);
    float shaft = 0.0;
    float dith  = hash21(gl_FragCoord.xy * 0.37 + fract(uTime) * 91.0);
    float segLen = min(td, 60.0) / 10.0;
    for (int i = 0; i < 10; i++){
      vec3 sp = ro + rd * (segLen * (float(i) + dith));
      if (sp.y > -0.15) continue;
      vec3 q = sp + SHAFT * ((0.0 - sp.y) / SHAFT.y);
      shaft += getCaustics(q.xz * 0.22) * exp(sp.y * 0.05);
    }
    shaft /= 10.0;
    float toSun = clamp(dot(rd, SHAFT), 0.0, 1.0);
    col += vec3(0.42, 0.86, 0.98) * shaft * (0.55 + 1.35 * pow(toSun, 2.2)) * 1.25;
    return col;
  }

  void main(){
    // Performance Optimization: Instantly drop non-UI pixels for the transparent UI canvas
    if (uLayerRender == 1) {
        bool inGlass = false;
        for (int i = 0; i < MAX_GLASS; i++) {
            if (i >= uGlassCount) break;
            vec4 rect = uGlassRects[i];
            float r = uGlassParams[i].x;
            vec2 center = rect.xy + rect.zw * 0.5;
            vec2 p = gl_FragCoord.xy - center;
            vec2 distV = abs(p) - rect.zw * 0.5 + vec2(r);
            float dist = min(max(distV.x, distV.y), 0.0) + length(max(distV, 0.0)) - r;
            if (dist < 4.0) { // Slight margin for shadow bounds
                inGlass = true; break;
            }
        }
        if (!inGlass) discard;
    }

    vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
    float d = clamp(uDive, 0.0, 1.0);
    float sub = smoothstep(0.15, 0.60, d); 
    float bedY = seabedDepth();
    
    float camY;
    if (d < 0.3) {
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

    /* ============================================================
       FRUTIGER AERO UI OVERLAYS - Pass 1: Accumulate Refraction
       ============================================================ */
    vec2 refrOffset = vec2(0.0);

    for (int i = 0; i < MAX_GLASS; i++) {
      if (i >= uGlassCount) break;
      
      float r = uGlassParams[i].x;
      float type = uGlassParams[i].y;
      float op = uGlassParams[i].w;
      
      // Only translucent panel objects refract the background
      if (type >= 0.5) continue; 
      
      vec4 rect = uGlassRects[i];
      vec2 center = rect.xy + rect.zw * 0.5;
      vec2 p = gl_FragCoord.xy - center;
      
      vec2 distV = abs(p) - rect.zw * 0.5 + vec2(r);
      float dist = min(max(distV.x, distV.y), 0.0) + length(max(distV, 0.0)) - r;

      if (dist < 1.0) {
          vec2 signP = sign(p);
          vec2 gGrad = vec2(0.0);
          if (max(distV.x, distV.y) > 0.0) {
              gGrad = signP * normalize(max(distV, 0.0));
          } else {
              gGrad = distV.x > distV.y ? vec2(signP.x, 0.0) : vec2(0.0, signP.y);
          }
          float bevel = smoothstep(1.0, -10.0, dist);
          refrOffset -= (gGrad * (1.0 - bevel)) * 0.03 * op;
      }
    }

    rd.xy += refrOffset;
    rd = normalize(rd);

    /* --- Trace Base Environment --- */
    vec3 finalCol = vec3(0.0);

    if (uLayerRender == 0) {
        if (ro.y < waveHeight(ro.xz, 5) - 0.02){
          finalCol = renderUnder(ro, rd);
        } else {
          vec3 p; float t = traceOcean(ro, rd, p);
          if (t < 0.0){
            finalCol = sky(rd);
          } else {
            vec2 g; waveField(p.xz, t, 14, g);
            vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
            finalCol = shadeOcean(p, rd, n, t);
          }
        }
        
        float expo = mix(1.28, 1.58, sub);
        finalCol = 1.0 - exp(-finalCol * expo);
        finalCol = pow(finalCol, vec3(0.86));
        finalCol = mix(vec3(dot(finalCol, vec3(0.299, 0.587, 0.114))), finalCol, mix(1.12, 1.04, sub));
        finalCol *= 1.0 - 0.45 * sub * smoothstep(0.55, 1.85, length(uv));
    }

    /* ============================================================
       APPLY UI MATERIALS - Pass 2: Sequential Bottom-to-Top Blend
       ============================================================ */
    vec3 pmColor = vec3(0.0);
    float pmAlpha = 0.0;

    // PRE-CALCULATE DYNAMIC UNDERWATER LIGHT FIELD (Caustics & God-rays)
    float diveFadeLight = smoothstep(0.0, 0.5, uDive);
    float globalCaustics = 0.0;
    float globalShafts = 0.0;
    
    if (diveFadeLight > 0.0) {
        vec2 cUV = (gl_FragCoord.xy / uRes.y) * 2.5 + vec2(uTime * 0.03, -uScroll * 0.2);
        globalCaustics = getCaustics(cUV);
        
        vec2 shaftDir = normalize(vec2(SHAFT.x, SHAFT.y));
        float shaftPhase = dot((gl_FragCoord.xy / uRes.y), vec2(shaftDir.x, -shaftDir.y)) * 6.0 + uTime * 0.6;
        globalShafts = pow(sin(shaftPhase) * 0.5 + 0.5, 2.0) * pow(sin(shaftPhase * 2.3 + 1.0) * 0.5 + 0.5, 1.5);
    }

    // Process UI items
    for (int i = 0; i < MAX_GLASS; i++) {
        if (i >= uGlassCount) break;
        
        vec4 rect = uGlassRects[i];
        float r = uGlassParams[i].x;
        float type = uGlassParams[i].y;
        float hover = uGlassParams[i].z;
        float op = uGlassParams[i].w;

        vec2 center = rect.xy + rect.zw * 0.5;
        vec2 gSize = rect.zw;
        vec2 p = gl_FragCoord.xy - center;
        
        vec2 distV = abs(p) - rect.zw * 0.5 + vec2(r);
        float dist = min(max(distV.x, distV.y), 0.0) + length(max(distV, 0.0)) - r;

        float glassMask = smoothstep(1.0, -0.5, dist) * op;

        if (glassMask > 0.0) {
            vec2 localUV = (gl_FragCoord.xy - rect.xy) / gSize; 
            vec3 glassCol = vec3(0.0);
            float currentAlpha = 1.0;
            
            vec2 signP = sign(p);
            vec2 gGrad = vec2(0.0);
            if (max(distV.x, distV.y) > 0.0) {
                gGrad = signP * normalize(max(distV, 0.0));
            } else {
                gGrad = distV.x > distV.y ? vec2(signP.x, 0.0) : vec2(0.0, signP.y);
            }
            float bevel = smoothstep(1.0, -10.0, dist);
            // Normal map logic: flat face faces straight out (0,0,1), edges tilt outwards.
            vec3 gNormal = normalize(vec3(gGrad * (1.0 - bevel), 2.5));

            if (type < 0.5) {
                vec3 cTop = vec3(1.0); float aTop = 0.86;
                vec3 cMid = vec3(1.0); float aMid = 0.60;
                vec3 cBot = vec3(0.87, 0.95, 1.0); float aBot = 0.66;
                vec3 gradC = localUV.y > 0.54 ? mix(cMid, cTop, (localUV.y - 0.54)/0.46) : mix(cBot, cMid, localUV.y/0.54);
                float gradA = localUV.y > 0.54 ? mix(aMid, aTop, (localUV.y - 0.54)/0.46) : mix(aBot, aMid, localUV.y/0.54);
                
                vec3 uTop = vec3(0.92, 0.99, 1.0); float uaTop = 0.84;
                vec3 uMid = vec3(0.80, 0.94, 0.99); float uaMid = 0.60;
                vec3 uBot = vec3(0.71, 0.90, 0.97); float uaBot = 0.66;
                gradC = mix(gradC, localUV.y > 0.54 ? mix(uMid, uTop, (localUV.y - 0.54)/0.46) : mix(uBot, uMid, localUV.y/0.54), diveFadeLight);
                gradA = mix(gradA, localUV.y > 0.54 ? mix(uaMid, uaTop, (localUV.y - 0.54)/0.46) : mix(uaBot, uaMid, localUV.y/0.54), diveFadeLight);

                if (uLayerRender == 0) {
                    glassCol = mix(finalCol, gradC, gradA);
                    currentAlpha = 1.0; 
                } else {
                    glassCol = gradC;
                    currentAlpha = gradA;
                }
            } else if (type < 1.5) {
                vec3 c1 = vec3(0.56, 0.86, 1.00);
                vec3 c2 = vec3(0.18, 0.65, 0.91);
                vec3 c3 = vec3(0.05, 0.46, 0.75);
                vec3 c4 = vec3(0.04, 0.37, 0.63);
                glassCol = localUV.y > 0.52 ? mix(c2, c1, (localUV.y - 0.52)/0.48) : mix(c4, c3, localUV.y/0.52);
                if (hover > 0.5) glassCol = mix(glassCol, vec3(1.0), 0.12);
            } else if (type < 2.5) {
                vec3 topG = vec3(1.0);
                vec3 midG = vec3(0.85, 0.94, 0.99);
                vec3 botG = vec3(0.74, 0.89, 0.97);
                glassCol = localUV.y > 0.5 ? mix(midG, topG, (localUV.y - 0.5)/0.5) : mix(botG, midG, localUV.y/0.5);
                if (hover > 0.5) glassCol = mix(glassCol, vec3(1.0), 0.2);
            } else if (type < 3.5) {
                vec3 topGr = vec3(0.93, 0.99, 0.88);
                vec3 botGr = vec3(0.80, 0.94, 0.70);
                glassCol = mix(botGr, topGr, localUV.y);
            } else {
                glassCol = mix(vec3(0.81, 0.92, 0.98), vec3(1.0), localUV.y);
            }

            // Inner Shadow
            float innerDark = smoothstep(0.0, -6.0, dist) * smoothstep(0.4, 0.0, localUV.y);
            glassCol *= mix(1.0, 0.7, innerDark);

            // Parabolic Cap (Frutiger Aero top reflection)
            float maxCapHeight = min(gSize.y * 0.44, type < 0.5 ? 60.0 : 25.0);
            float edgeCapHeight = maxCapHeight * 0.65;
            float capDip = maxCapHeight - edgeCapHeight;
            float currentCapHeight = maxCapHeight - capDip * pow(abs(localUV.x - 0.5) * 2.0, 2.0);
            float distFromTop = gSize.y * (1.0 - localUV.y);
            if (distFromTop < currentCapHeight) {
                float capT = 1.0 - (distFromTop / currentCapHeight);
                float capAlpha = mix(0.0, 0.7, capT);
                glassCol = mix(glassCol, vec3(1.0), capAlpha);
            }

            // Border
            float border = smoothstep(0.0, -1.0, dist) - smoothstep(-1.5, -3.0, dist);
            glassCol = mix(glassCol, vec3(1.0), border * (type < 0.5 ? 0.8 : 0.4));

            // INTEGRATION WITH NATURAL LIGHT PHYSICS (Fixing the Glass Material)
            vec3 uiLightDir = normalize(vec3(SUN.x * 0.8, 0.7, 0.8));
            vec3 viewDir = vec3(0.0, 0.0, 1.0); // Looking straight at UI
            vec3 halfDir = normalize(uiLightDir + viewDir);
            
            float ndoth = clamp(dot(gNormal, halfDir), 0.0, 1.0);
            float ndotv = clamp(dot(gNormal, viewDir), 0.0, 1.0);
            
            // 1. Sharp Specular Glint (Simulating bright point-light from the sun)
            float specPower = mix(200.0, 100.0, diveFadeLight); // Very sharp above water, slightly softer below
            float specBase = pow(ndoth, specPower) * (type < 0.5 ? 0.8 : 0.4);
            
            // 2. Edge Mask (0.0 on the flat face of the panel, increases as the bevel curves)
            float isEdge = length(gNormal.xy);
            
            // 3. Dynamic underwater light (Caustics & God-rays)
            // Strictly applied to the physical edges of the glass, giving it a prismatic volume
            // without blooming out and washing away the text on the flat surface.
            float dynamicLight = (globalCaustics * 1.0 + globalShafts * 1.5) * isEdge;
            
            // 4. Fresnel Sheen (Makes edges catch ambient light naturally)
            float fresnel = pow(1.0 - ndotv, 4.0) * (type < 0.5 ? 0.5 : 0.2);
            
            vec3 specColorSurf = vec3(1.0, 0.98, 0.95);
            vec3 specColorUnder = vec3(0.6, 0.9, 1.0);
            vec3 envColor = mix(specColorSurf, specColorUnder, diveFadeLight);
            
            // Combine the lighting strictly as an additive specular overlay
            vec3 spec = envColor * (specBase + dynamicLight * diveFadeLight + fresnel);

            // Subtle ambient bounce from the seabed underwater (illuminates bottom edges of glass)
            if (diveFadeLight > 0.0) {
                float bottomEdge = clamp(-gNormal.y, 0.0, 1.0);
                spec += vec3(0.15, 0.45, 0.6) * bottomEdge * 0.5 * diveFadeLight;
            }

            if (uLayerRender == 0) {
                glassCol += spec;
                finalCol = mix(finalCol, glassCol, glassMask);
            } else {
                // Correct Bottom-to-Top Pre-Multiplied Alpha Blending
                float srcA = currentAlpha * glassMask;
                vec3 srcC = glassCol * srcA + spec * glassMask; 
                pmColor = srcC + pmColor * (1.0 - srcA);
                pmAlpha = srcA + pmAlpha * (1.0 - srcA);
            }
        }
    }

    if (uLayerRender == 1) {
        fragColor = vec4(pmColor, pmAlpha);
    } else {
        fragColor = vec4(clamp(finalCol, 0.0, 1.0), 1.0);
    }
  }`;

  function compile(gl, type, src){
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
      console.error(gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  // Generate independent rendering contexts that share the unified physics loop
  function createRenderer(canvasId, isUI) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    
    const gl = canvas.getContext('webgl2', {
      antialias: true, 
      alpha: isUI, 
      depth: false, stencil: false,
      powerPreference: 'high-performance'
    });

    if (!gl) return null;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)){
      console.error(gl.getProgramInfoLog(prog));
      return null;
    }
    gl.useProgram(prog);
    gl.bindVertexArray(gl.createVertexArray());

    const MAX_GLASS = 60;
    const glassRectsData = new Float32Array(MAX_GLASS * 4);
    const glassParamsData = new Float32Array(MAX_GLASS * 4);

    const U = {
      res:         gl.getUniformLocation(prog, 'uRes'),
      time:        gl.getUniformLocation(prog, 'uTime'),
      mouse:       gl.getUniformLocation(prog, 'uMouse'),
      scroll:      gl.getUniformLocation(prog, 'uScroll'),
      chop:        gl.getUniformLocation(prog, 'uChop'),
      shallow:     gl.getUniformLocation(prog, 'uShallow'),
      dive:        gl.getUniformLocation(prog, 'uDive'),
      glassRects:  gl.getUniformLocation(prog, 'uGlassRects'),
      glassParams: gl.getUniformLocation(prog, 'uGlassParams'),
      glassCount:  gl.getUniformLocation(prog, 'uGlassCount'),
      layerRender: gl.getUniformLocation(prog, 'uLayerRender')
    };

    function resize(w, h){
      if (canvas.width !== w || canvas.height !== h){
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }

    function draw(elsArray, clock, mx, my, scroll, chop, shallowCurrent, diveValue, scaleX, scaleY) {
      gl.useProgram(prog);
      
      let count = 0;
      const h = canvas.height;

      for (let i = 0; i < elsArray.length; i++) {
        if (count >= MAX_GLASS) break;
        const { el, style, op } = elsArray[i];
        const rect = el.getBoundingClientRect();
        
        if (rect.bottom < -150 || rect.top > window.innerHeight + 150) continue;
        
        let idx = count * 4;
        glassRectsData[idx]   = rect.left * scaleX;
        glassRectsData[idx+1] = h - (rect.bottom * scaleY); 
        glassRectsData[idx+2] = rect.width * scaleX;
        glassRectsData[idx+3] = rect.height * scaleY;
        
        let br = parseFloat(style.borderRadius) || 0;
        if (style.borderRadius.includes('%') || br > Math.min(rect.width, rect.height) / 2) {
            br = Math.min(rect.width, rect.height) / 2;
        }
        glassParamsData[idx] = br * scaleX;
        
        let type = 0.0; 
        if (el.classList.contains('btn')) {
            type = el.classList.contains('ghost') ? 2.0 : 1.0;
        } else if (el.classList.contains('result')) {
            type = 3.0; 
        } else if (el.tagName.toLowerCase() === 'b') {
            type = 4.0; 
        }
        glassParamsData[idx+1] = type;
        glassParamsData[idx+2] = el.matches(':hover') ? 1.0 : 0.0;
        glassParamsData[idx+3] = op; 
        
        count++;
      }

      gl.uniform1i(U.glassCount, count);
      gl.uniform4fv(U.glassRects, glassRectsData);
      gl.uniform4fv(U.glassParams, glassParamsData);
      
      gl.uniform2f(U.res, canvas.width, canvas.height);
      gl.uniform1f(U.time, clock);
      gl.uniform2f(U.mouse, mx, my);
      gl.uniform1f(U.scroll, scroll);
      gl.uniform1f(U.chop, chop);
      gl.uniform1f(U.shallow, shallowCurrent);
      gl.uniform1f(U.dive, diveValue);
      gl.uniform1i(U.layerRender, isUI ? 1 : 0);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    return { canvas, resize, draw };
  }

  const baseRenderer = createRenderer('sea', false);
  const uiRenderer = createRenderer('ui-glass', true);

  if (!baseRenderer || !uiRenderer) {
    document.body.classList.add('no-webgl');
    return;
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scale = window.innerWidth > 1500 ? 0.72 : 0.85;
  let chop = 1.0, target = { x: 0, y: 0 }, mouse = { x: 0, y: 0 };
  let shallowTarget = 0.0, shallowCurrent = 0.0;
  let scroll = 0, clock = 0, last = performance.now();
  let running = !reduced, paused = false;

  function updateGlassAndDraw() {
    const rawEls = document.querySelectorAll('.glass, .btn, .card .result, .chips b');
    let baseEls = [];
    let uiEls = [];
    
    rawEls.forEach(el => {
      let style = window.getComputedStyle(el);
      let op = parseFloat(style.opacity);
      if (isNaN(op)) op = 1.0;
      if (op === 0 || style.visibility === 'hidden') return; 

      let z = parseInt(style.zIndex);
      if (isNaN(z)) {
        if (el.closest('header') || el.closest('.sea-controls')) z = 100;
        else z = 1;
      }
      
      let item = { el, style, z, op };
      if (z >= 20) uiEls.push(item);
      else baseEls.push(item);
    });

    baseEls.sort((a, b) => a.z - b.z);
    uiEls.sort((a, b) => a.z - b.z);

    // Synchronize underlying DOM CSS blur layer dynamically to obscure text sliding below UI
    const blurLayer = document.getElementById('ui-blur-layer');
    if (blurLayer) {
      while (blurLayer.children.length < uiEls.length) {
        const box = document.createElement('div');
        box.style.position = 'absolute';
        box.style.backdropFilter = 'blur(12px)';
        box.style.webkitBackdropFilter = 'blur(12px)';
        blurLayer.appendChild(box);
      }
      for (let i = 0; i < blurLayer.children.length; i++) {
        if (i < uiEls.length) {
          const { el, style } = uiEls[i];
          const rect = el.getBoundingClientRect();
          const box = blurLayer.children[i];
          box.style.display = 'block';
          // Fix: Retain exact subpixel boundaries natively delivered by getBoundingClientRect.
          // This prevents the DOM blur layer boxes from misaligning/peeking out from underneath 
          // the WebGL rendering logic coordinate space which is natively utilizing these raw floats.
          box.style.left = rect.left + 'px';
          box.style.top = rect.top + 'px';
          box.style.width = rect.width + 'px';
          box.style.height = rect.height + 'px';
          box.style.borderRadius = style.borderRadius;
        } else {
          blurLayer.children[i].style.display = 'none';
        }
      }
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * scale;
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    const scaleX = w / window.innerWidth;
    const scaleY = h / window.innerHeight;

    baseRenderer.resize(w, h);
    baseRenderer.draw(baseEls, clock, mouse.x, mouse.y, scroll, chop, shallowCurrent, Dive.value, scaleX, scaleY);

    uiRenderer.resize(w, h);
    uiRenderer.draw(uiEls, clock, mouse.x, mouse.y, scroll, chop, shallowCurrent, Dive.value, scaleX, scaleY);
  }

  let slow = 0, downshifted = false;

  function frame(now){
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!paused) clock += dt;

    if (dt > 0.032){ slow++; } else { slow = Math.max(0, slow - 1); }
    if (slow > 45 && !downshifted){ downshifted = true; scale = 0.5; }

    mouse.x += (target.x - mouse.x) * 0.045;
    mouse.y += (target.y - mouse.y) * 0.045;

    const sTarget = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1.5);
    scroll += (sTarget - scroll) * 0.08;

    shallowCurrent += (shallowTarget - shallowCurrent) * 0.04;

    updateGlassAndDraw();
    if (running) requestAnimationFrame(frame);
  }

  updateGlassAndDraw();
  window.addEventListener('resize', () => { if (!running) updateGlassAndDraw(); });

  window.addEventListener('scroll', () => { if (!running) updateGlassAndDraw(); }, { passive: true });

  window.addEventListener('pointermove', (e) => {
    target.x = (e.clientX / window.innerWidth) * 2 - 1;
    target.y = -((e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden){ running = false; }
    else if (!reduced && !paused){ running = true; last = performance.now(); requestAnimationFrame(frame); }
  });

  Dive.onUpdate(() => { if (!running) { scroll = Math.min(window.scrollY / Math.max(window.innerHeight,1), 1.5); updateGlassAndDraw(); } });

  if (reduced){ updateGlassAndDraw(); } else { requestAnimationFrame(frame); }

  /* ---- water controls ---- */
  const ctrlChop = document.getElementById('ctrl-chop');
  const ctrlShallow = document.getElementById('ctrl-shallow');
  const ctrlPlay = document.getElementById('ctrl-play');

  if (ctrlChop) {
    ctrlChop.addEventListener('input', (e) => {
      chop = parseFloat(e.target.value) / 100;
      if (!running || paused) updateGlassAndDraw();
    });
  }

  if (ctrlShallow) {
    ctrlShallow.addEventListener('input', (e) => {
      shallowTarget = parseFloat(e.target.value) / 100;
      if (!running || paused) {
        shallowCurrent = shallowTarget; 
        updateGlassAndDraw();
      }
    });
  }

  if (ctrlPlay) {
    ctrlPlay.addEventListener('click', () => {
      paused = !paused;
      ctrlPlay.setAttribute('aria-pressed', String(paused));
      ctrlPlay.textContent = paused ? 'Resume Animation' : 'Pause Animation';
      if (!paused && !running && !document.hidden && !reduced) {
        running = true;
        last = performance.now();
        requestAnimationFrame(frame);
      }
    });
  }
}
