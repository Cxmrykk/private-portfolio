/* ============================================================
   DYED GLASS — Funky Seasons tint for any glass panel
   Insert after GLSL_COMMON (uses skyLuma) in the glass pass.

   Pure absorption (background x dye^path) turns orange or pink
   glass over a blue ocean into mud, and goes black at night. So
   the panel is treated like dyed opal / gel instead:

     face     light frost + luminance-preserving colourise, so the
              water's motion shows through in the dye's hue, plus
              an in-scatter glow that keeps the colour alive at night
     bevels   true Beer-Lambert: the refracted path lengthens toward
              the rim, so edges read deeper and more saturated
     glints   light passing through the far rim takes the dye
     outside  the cast shadow is coloured and the focused rim light
              spills in the dye colour onto the water beside it

   dye = linear 0..1 colour, tk = strength (0 = clear, no-op).
   ============================================================ */

export const GLSL_TINT = `
#define TINT_FROST        1.4   // extra frost mip levels on the face
#define TINT_FACE         0.62  // colourise weight of the face
#define TINT_GLOW         0.12  // in-scatter glow of the dye
#define TINT_GLOW_FLOOR   0.35  // share of the glow kept in darkness
#define TINT_SHADE        0.10  // darken the face a touch for text contrast
#define TINT_RIM_DEPTH    1.25  // Beer-Lambert thickness at the outer rim
#define TINT_RIM_GLOW     0.35  // dye share of the reflective rim highlight
#define TINT_SHADOW_PASS  0.55  // how much dyed light leaks into the shadow
#define TINT_SPILL        1.35  // brightness of the coloured rim caustic

float tintFrostLod(float frostLod, float tk){
  return max(frostLod, TINT_FROST * tk);
}

/* s  = bevel coordinate (0 flat face .. 1 silhouette)
   sT = sine of the refracted angle inside the glass
   lI = local light level (daylight x underwater dapple) */
vec3 tintBody(vec3 body, vec3 dye, float tk, float face, float s, float sT, float lI){
  if (tk <= 0.0) return body;

  float dl = max(skyLuma(dye), 0.05);

  /* colourise: keep the background's brightness, take the dye's hue */
  vec3 dyed = dye * (skyLuma(body) / dl);
  vec3 b = mix(body, dyed, TINT_FACE * tk);

  /* in-scatter: the dye glowing with light caught inside the slab */
  b += dye * TINT_GLOW * tk * (TINT_GLOW_FLOOR + (1.0 - TINT_GLOW_FLOOR) * lI);

  /* readability under the card text */
  b *= 1.0 - TINT_SHADE * tk * face;

  /* Beer-Lambert through the bevel: path ~ 1 / cos(refracted angle) */
  float path = TINT_RIM_DEPTH * s / sqrt(max(1.0 - sT * sT, 0.05));
  vec3  T = pow(max(dye, vec3(0.02)), vec3(path));
  return mix(b, b * T, tk);
}

/* Reflective rim highlight picks up a jewel-like edge in the dye */
vec3 tintRim(vec3 rimC, vec3 dye, float tk){
  if (tk <= 0.0) return rimC;
  float dl = max(skyLuma(dye), 0.05);
  vec3 jewel = dye * (skyLuma(rimC) / dl) * 1.15;
  return mix(rimC, jewel, TINT_RIM_GLOW * tk);
}

/* Per-unit-thickness transmission handed to glassGlint() */
vec3 tintGlassCol(vec3 baseCol, vec3 dye, float tk){
  return mix(baseCol, dye, tk);
}

/* Multiplier for the background under the cast shadow: dyed glass
   passes its own colour, so the shadow is tinted, not grey. */
vec3 tintShadow(float shadow, vec3 dye, float tk){
  vec3 block = mix(vec3(1.0), vec3(1.0) - dye * TINT_SHADOW_PASS, tk);
  return vec3(1.0) - shadow * block;
}

/* Colour of the light focused by the rim onto the water beside it */
vec3 tintSpill(vec3 dye, float tk){
  return mix(vec3(1.0), dye * TINT_SPILL, tk);
}
`;
