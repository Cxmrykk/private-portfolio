/* ============================================================
   GLASS GLINTS — real light paths through a bevelled slab
   Insert after GLSL_COMMON in the glass pass.

   The scene's lights (sun, moon, underwater shafts) always sit in
   front of the camera, i.e. BEHIND the glass. A flat face can never
   mirror them, so everything here lands on the bevels:

     near rim  Fresnel reflection of the source; keeps its colour.
     far rim   the view ray refracts in through the bevel, out through
               the flat back face, and looks straight at the source:
               source colour x glass absorption, with one IOR per
               colour channel for the prismatic fringe. Past the
               critical angle the path cuts out by itself (TIR).

   Sources are analytic lobes in world space, so they work while the
   sun is off screen (most of the day), follow uDayTime, and slide
   along the bevel as scrolling changes each pixel's view ray.

   GLINT_GAIN 0.0 reproduces the pre-glint glass exactly.
   ============================================================ */

export const GLSL_GLINT = `
#define GLINT_GAIN   1.0   // master gain for every term in this file
#define SUN_HDR      3.0   // sky()'s sun is authored to survive tone mapping at
#define MOON_HDR     2.0   //   100%; a 4-40% reflection needs the radiance it stands for
#define SHAFT_HDR    1.0
#define GLASS_PLANE  1.5   // world distance of the UI plane, for beam coupling
#define GLASS_F0     0.0426 // ((1.52 - 1) / (1.52 + 1))^2

/* Filled once per pixel by setupLights() */
vec3  gSunDir, gSunCol, gMoonDir, gMoonCol, gShaftDir, gShaftCol;
float gSunCore, gSunStretch, gSunGlit, gMoonGlit, gSub;

/* Gaussian lobe around a direction; c = cos(angle to the source).
   var0 is the source's own angular variance (1/n for a pow(c, n) lobe),
   blur2 the variance swept by one pixel of bevel. Widening the lobe by
   the footprint and scaling by sqrt(var0 / v) conserves energy along
   the bevel, so a sub-pixel glint neither sparkles nor vanishes. */
float lobe(float c, float var0, float blur2){
  float v = var0 + blur2;
  return exp(-(1.0 - c) / v) * sqrt(var0 / v);
}

void setupLights(vec3 rd){
  float dayW, sunsetW, nightW;
  getPhaseWeights(dayW, sunsetW, nightW);

  gSub = submergence();
  float air = 1.0 - gSub;

  /* ---- above water: sun + moon as two lights, so nothing pops
          when the primary light changes hands at the horizon ---- */
  gSunDir  = getSunDir();
  gMoonDir = getMoonDir();
  float sunUp  = smoothstep(-0.12, 0.03, gSunDir.y);
  float moonUp = smoothstep(-0.12, 0.03, gMoonDir.y);
  float litW   = dayW + sunsetW;
  vec3  sunTint = (vec3(1.00, 0.97, 0.90) * dayW + vec3(1.00, 0.45, 0.15) * sunsetW) / max(litW, 1e-3);

  gSunCol     = sunTint * litW * sunUp * air * SUN_HDR;
  gSunCore    = dayW / max(litW, 1e-3);           // sky(): hard core by day only
  gSunStretch = sunsetW * sunUp * air * SUN_HDR;  // sky(): squashed burn at sunset

  /* Same light-intensity fade sky() uses for the moon disc, so the glass
     never reflects a moon the sky is not drawing. */
  gMoonCol    = vec3(0.55, 0.75, 1.00) * moonVisibility(0.0) * moonUp * air * MOON_HDR;

  /* glitter path: the source mirrored in the sea, weighted by the
     water's own Fresnel reflectance at that elevation */
  gSunGlit  = waterFresnel(max(gSunDir.y, 0.0));
  gMoonGlit = waterFresnel(max(gMoonDir.y, 0.0));

  /* ---- under water: the refracted shaft ---- */
  gShaftDir = vec3(0.0, 1.0, 0.0);
  gShaftCol = vec3(0.0);
  if (gSub > 0.001){
    gShaftDir = getShaftDir();
    float sy  = max(gShaftDir.y, 0.3);
    vec3  ro  = camOrigin();

    /* Beer-Lambert over the slanted path from the surface to the camera */
    float depth = max(-ro.y, 0.0);
    vec3  ext = exp(-waterAbsorption(dayW, sunsetW, nightW) * depth / sy);

    /* beam coupling: walk from this pixel's spot on the UI plane up the
       shaft to the surface and read the same caustic field the ocean
       integrates for its god rays (same frequency, same drift) */
    vec3  P = ro + rd * (GLASS_PLANE / max(-rd.z, 0.2));
    vec3  q = P + gShaftDir * (max(-P.y, 0.0) / sy);
    vec2  drift = vec2(sin(P.y * 0.15 + uTime * 0.4), cos(P.y * 0.15 + uTime * 0.3)) * 0.6;
    float beam = getCaustics(q.xz * 0.15 + drift);

    /* what makes it through the surface: grazing light mostly reflects */
    float entry = 1.0 - waterFresnel(max(getPrimaryLight().y, 0.0));
    float inten = mix(0.15, 1.25, envLight()) + nightW * 0.15;

    gShaftCol = shaftColour(dayW, sunsetW, nightW) * ext * inten * entry
              * (0.35 + 2.2 * beam) * gSub * SHAFT_HDR;
  }
}

/* One celestial body + its reflection in the sea, seen in direction d */
vec3 celestial(vec3 d, float blur2, vec3 dir, vec3 col, float glit,
               float core, float coreVar, float halo, float haloVar){
  float c = dot(d, dir);
  vec3  L = col * (core * lobe(c, coreVar, blur2) + halo * lobe(c, haloVar, blur2));

  /* glitter: rough water smears the mirror image into a column that is
     narrow in azimuth and tall in elevation */
  vec3  e  = vec3(1.0, 0.45, 1.0);
  float cg = dot(normalize(d * e), normalize(vec3(dir.x, -dir.y, dir.z) * e));
  L += col * glit * 3.0 * lobe(cg, 1.0 / 60.0, blur2);
  return L;
}

/* Radiance arriving from the scene's light sources along direction d */
vec3 sourceRadiance(vec3 d, float blur2){
  vec3 L = vec3(0.0);

  if (gSub < 0.999){
    /* sun: the same lobes sky() draws */
    L += celestial(d, blur2, gSunDir, gSunCol, gSunGlit,
                   14.0 * gSunCore, 1.0 / 1200.0, 0.38, 1.0 / 22.0);
    L += gSunCol * 0.06 * lobe(dot(d, gSunDir), 1.0 / 3.0, blur2);

    if (gSunStretch > 0.001){
      vec3  sq = vec3(1.0, 3.5, 1.0);
      float cs = dot(normalize(d * sq), normalize(gSunDir * sq));
      L += vec3(1.00, 0.35, 0.10) * 8.0 * gSunStretch * lobe(cs, 1.0 / 120.0, blur2);
      L += vec3(1.00, 0.80, 0.40) * 3.0 * gSunStretch * lobe(cs, 1.0 / 350.0, blur2);
    }

    if (max(gMoonCol.r, max(gMoonCol.g, gMoonCol.b)) > 0.001){
      L += celestial(d, blur2, gMoonDir, gMoonCol, gMoonGlit,
                     10.0, 1.0 / 2000.0, 0.5, 1.0 / 100.0);
    }
  }

  if (gSub > 0.001){
    /* the sun through a moving surface: a smeared disc inside Snell's
       window plus a broad skirt, so up-facing bevels shimmer with the beams */
    float c = dot(d, gShaftDir);
    L += gShaftCol * (8.0 * lobe(c, 1.0 / 70.0, blur2) + 0.8 * lobe(c, 1.0 / 6.0, blur2));
  }
  return L;
}

/* rd        world view ray for this pixel
   N         bevel normal (z toward the viewer; screen x/y == world x/y)
   slopeRate radians the normal turns per canvas pixel across the bevel
   glassCol  transmission colour of the material per unit thickness
   Returns linear radiance; the caller tone-maps it. */
vec3 glassGlint(vec3 rd, vec3 N, float slopeRate, vec3 glassCol){
  float cv = dot(N, -rd);
  if (cv < 0.02) return vec3(0.0);

  float F1 = GLASS_F0 + (1.0 - GLASS_F0) * pow(1.0 - cv, 5.0);

  /* a mirror turns the ray twice as fast as the normal; half a pixel
     either side -> sigma = slopeRate. The prism path turns a bit faster. */
  float blurR = slopeRate * slopeRate;
  float blurT = blurR * 1.5625;

  /* near rim: external reflection */
  vec3 L = F1 * sourceRadiance(reflect(rd, N), blurR);

  /* far rim: in through the bevel, out through the flat back face.
     Flint-like dispersion around the crown index; kept air-relative so
     the glints line up with the bevel refraction already on screen. */
  vec3 iors = vec3(1.505, 1.520, 1.540);
  for (int k = 0; k < 3; k++){
    float n  = iors[k];
    vec3  t1 = refract(rd, N, 1.0 / n);
    vec3  t2 = refract(t1, vec3(0.0, 0.0, 1.0), n);
    if (dot(t2, t2) < 1e-4) continue;                 // total internal reflection

    float F2   = GLASS_F0 + (1.0 - GLASS_F0) * pow(1.0 - clamp(-t2.z, 0.0, 1.0), 5.0);
    float path = 1.0 / max(-t1.z, 0.25);              // slab thickness = 1
    float a    = pow(glassCol[k], path);              // Beer-Lambert through the glass
    L[k] += (1.0 - F1) * (1.0 - F2) * a * sourceRadiance(t2, blurT)[k];
  }
  return L * GLINT_GAIN;
}
`;
