/* ============================================================
   0. DIVE CONTROLLER — maps scroll position to camera depth
   ============================================================ */
const Dive = (function () {
  const splash  = document.getElementById('splash');
  const readout = document.getElementById('depth');
  const body    = document.body;

  let target = 0, current = 0, camY = 3.3, raf = null, under = false, lastTxt = '';
  const listeners = [];

  /* must match the camera curve inside the fragment shader */
  function camFromDive(d){ return 3.3 - 17.0 * d * d; }

  function apply(){
    camY = camFromDive(current);

    /* white-water veil while breaking the surface */
    if (splash){
      const s = Math.max(0, 1 - Math.abs(camY) / 2.0);
      splash.style.opacity = (s * s * 0.7).toFixed(3);
    }

    /* hysteresis so the class does not flicker on the boundary */
    if (!under && camY < 0.15){ under = true;  body.classList.add('is-underwater'); }
    else if (under && camY > 0.9){ under = false; body.classList.remove('is-underwater'); }

    if (readout){
      const txt = camY > 0 ? 'Surface' : (-camY * 1.55).toFixed(1) + ' m';
      if (txt !== lastTxt){ readout.textContent = txt; lastTxt = txt; }
    }

    for (let i = 0; i < listeners.length; i++) listeners[i](current);
  }

  function loop(){
    current += (target - current) * 0.085;
    if (Math.abs(target - current) < 0.0004) current = target;
    apply();
    raf = (current === target) ? null : requestAnimationFrame(loop);
  }

  function measure(){
    const span = Math.max(window.innerHeight * 1.25, 1);
    target = Math.min(1, Math.max(0, window.scrollY / span));
    if (raf === null) raf = requestAnimationFrame(loop);
  }

  window.addEventListener('scroll', measure, { passive: true });
  window.addEventListener('resize', measure);

  measure();
  current = target;
  apply();

  return {
    get value(){ return current; },
    get camY(){ return camY; },
    onUpdate(fn){ listeners.push(fn); }
  };
})();

/* ============================================================
   1. THE OCEAN — WebGL2, procedural, above and below the surface
   ============================================================ */
(function () {
  const canvas = document.getElementById('sea');
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    powerPreference: 'high-performance'
  });

  if (!gl) { document.body.classList.add('no-webgl'); return; }

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
  uniform float uChop;     // 0.55 calm .. 1.0 choppy
  uniform float uShallow;  // 0.0 deep ocean .. 1.0 shallow refractive reef
  uniform float uDive;     // 0.0 above the swell .. 1.0 at depth

  out vec4 fragColor;

  #define SUN   normalize(vec3(0.34, 0.20, -0.92))
  /* Sunlight refracted through the surface bends toward the vertical,
     so the underwater shafts are much steeper than the sun itself. */
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

  /* ---------- wave field ----------
     Sum of sines pushed through exp() to sharpen crests, with continuous
     screen-space LOD so sub-pixel waves fade out instead of aliasing. */
  float waveField(vec2 p, float dist, int max_octaves, out vec2 grad){
    float h = 0.0;
    grad = vec2(0.0);
    float amp = 0.62, freq = 0.30, speed = 1.0, k = 1.60 * uChop;
    float ang = 0.0;
    vec2 warp = vec2(0.0);

    float pixel_width = max(dist * 0.0025, 0.001);

    for (int i = 0; i < 14; i++){
      if (i >= max_octaves) break;

      float wave_width = 1.0 / freq;
      float lod = smoothstep(pixel_width, pixel_width * 3.0, wave_width);
      if (lod < 0.001) break;

      ang += 2.39996;                               // golden angle offset
      vec2 d = vec2(cos(ang), sin(ang));
      float ph = dot(p + warp, d) * freq + uTime * speed * freq * 2.4;

      float s  = sin(ph);
      float w  = exp(k * s - k);                    // sharp crest, flat trough
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
    vec2 g;
    return waveField(p, 0.0, max_octaves, g);
  }

  /* ---------- sky ---------- */
  vec3 sky(vec3 rd){
    float y = clamp(rd.y, -0.15, 1.0);
    vec3 horizon = vec3(0.76, 0.92, 0.99);
    vec3 zenith  = vec3(0.10, 0.40, 0.80);
    vec3 col = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.60));

    float sd = max(dot(rd, SUN), 0.0);
    col += vec3(1.00, 0.88, 0.66) * pow(sd, 1200.0) * 14.0;   // sun disc
    col += vec3(1.00, 0.80, 0.52) * pow(sd, 22.0)   * 0.38;   // glow
    col += vec3(0.95, 0.80, 0.60) * pow(sd, 3.0)    * 0.06;   // wide haze

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

  /* ---------- ray marching, from above ---------- */
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

  /* ---------- the underside of the surface, traced from below ---------- */
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

  /* ---------- surface shading, seen from above ---------- */
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

    float microFade = smoothstep(50.0, 10.0, dist);
    float spec = specMain;

    if (microFade > 0.01) {
      mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
      vec2 microUV = p.xz * 12.0 - uTime * 0.3;
      float micro = vnoise(rot * microUV) * 0.5 + 0.5;
      vec3 nGlint = normalize(n + vec3(micro * 0.15, 0.0, micro * 0.15) * microFade);
      float specGlint = pow(clamp(dot(nGlint, hv), 0.0, 1.0), 1500.0) * (8.0 * microFade);
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

  /* ============================================================
     UNDERWATER
     ============================================================ */
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

    /* caustics are the surface pattern projected down the refracted sun */
    vec3 s = p + SHAFT * ((0.0 - p.y) / SHAFT.y);
    float c = getCaustics(s.xz * 0.38);
    sand += vec3(1.0, 0.95, 0.80) * c * 1.15 * exp(p.y * 0.035);

    return sand;
  }

  vec3 renderUnder(vec3 ro, vec3 rd){
    float bedY = seabedDepth();
    vec3 col;
    float t;

    if (rd.y > 0.035){
      /* looking up at the underside: Snell's window and total internal reflection */
      t = min(traceUnderside(ro, rd), 260.0);
      vec3 p = ro + rd * t;
      vec2 g;
      waveField(p.xz, t, 10, g);
      vec3 n  = normalize(vec3(-g.x, 1.0, -g.y));
      vec3 nd = -n;

      vec3 refr = refract(rd, nd, 1.333);
      if (dot(refr, refr) > 1e-4){
        col = sky(normalize(refr)) * 1.06;
        float rim = 1.0 - clamp(dot(-rd, nd), 0.0, 1.0);
        col += vec3(0.50, 0.86, 0.96) * pow(rim, 6.0) * 0.55;   // compressed horizon ring
      } else {
        vec3 rr = reflect(rd, nd);
        float down = clamp(-rr.y, 0.0, 1.0);
        col  = mix(vec3(0.03, 0.16, 0.24), vec3(0.16, 0.30, 0.28), down);
        col += vec3(0.20, 0.45, 0.48) * getCaustics(p.xz * 0.45) * 0.35;
      }
      /* light dancing along the underside of the swell */
      col += vec3(0.30, 0.60, 0.62) * getCaustics(p.xz * 0.55) * 0.30;

    } else if (rd.y < -0.035){
      float tb = (bedY - ro.y) / rd.y;
      t = min(tb, 240.0);
      col = (tb < 240.0) ? seabedColor(ro + rd * t) : vec3(0.02, 0.09, 0.14);

    } else {
      t = 200.0;
      col = vec3(0.02, 0.09, 0.14);
    }

    /* Beer-Lambert absorption: red dies first, blue-green survives */
    float td = min(t, 150.0);
    vec3 absorbC = vec3(0.155, 0.045, 0.028);
    vec3 ext = exp(-absorbC * td);
    float midY = ro.y + rd.y * td * 0.5;
    vec3 amb = vec3(0.045, 0.30, 0.42) * exp(clamp(midY, -70.0, 0.0) * 0.045);
    col = col * ext + amb * (1.0 - ext);

    /* volumetric god rays: march the view ray, project each sample up the
       refracted sun direction and sample the same caustic pattern */
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
    vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;

    float d    = clamp(uDive, 0.0, 1.0);
    float sub  = smoothstep(0.30, 0.75, d);
    float camY = 3.3 - 17.0 * d * d + sin(uTime * 0.42) * 0.16;

    /* gentle refractive wobble once submerged */
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
      vec3 p;
      float t = traceOcean(ro, rd, p);
      if (t < 0.0){
        col = sky(rd);
      } else {
        vec2 g;
        waveField(p.xz, t, 14, g);
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
        col = shadeOcean(p, rd, n, t);
      }
    }

    /* HDR exposure, gamma, saturation, plus an underwater vignette */
    float expo = mix(1.28, 1.58, sub);
    col = 1.0 - exp(-col * expo);
    col = pow(col, vec3(0.86));
    col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, mix(1.12, 1.04, sub));
    col *= 1.0 - 0.45 * sub * smoothstep(0.55, 1.85, length(uv));

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }`;

  function compile(type, src){
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
      console.error(gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs){ document.body.classList.add('no-webgl'); return; }

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)){
    console.error(gl.getProgramInfoLog(prog));
    document.body.classList.add('no-webgl');
    return;
  }
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());

  const U = {
    res:     gl.getUniformLocation(prog, 'uRes'),
    time:    gl.getUniformLocation(prog, 'uTime'),
    mouse:   gl.getUniformLocation(prog, 'uMouse'),
    scroll:  gl.getUniformLocation(prog, 'uScroll'),
    chop:    gl.getUniformLocation(prog, 'uChop'),
    shallow: gl.getUniformLocation(prog, 'uShallow'),
    dive:    gl.getUniformLocation(prog, 'uDive')
  };

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scale = window.innerWidth > 1500 ? 0.72 : 0.85;
  let chop = 1.0, target = { x: 0, y: 0 }, mouse = { x: 0, y: 0 };
  let shallowTarget = 0.0, shallowCurrent = 0.0;
  let scroll = 0, clock = 0, last = performance.now();
  let running = !reduced, paused = false;

  function resize(){
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * scale;
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h){
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function draw(){
    gl.uniform2f(U.res, canvas.width, canvas.height);
    gl.uniform1f(U.time, clock);
    gl.uniform2f(U.mouse, mouse.x, mouse.y);
    gl.uniform1f(U.scroll, scroll);
    gl.uniform1f(U.chop, chop);
    gl.uniform1f(U.shallow, shallowCurrent);
    gl.uniform1f(U.dive, Dive.value);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let slow = 0, downshifted = false;

  function frame(now){
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!paused) clock += dt;

    if (dt > 0.032){ slow++; } else { slow = Math.max(0, slow - 1); }
    if (slow > 45 && !downshifted){ downshifted = true; scale = 0.5; resize(); }

    mouse.x += (target.x - mouse.x) * 0.045;
    mouse.y += (target.y - mouse.y) * 0.045;

    const sTarget = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1.5);
    scroll += (sTarget - scroll) * 0.08;

    shallowCurrent += (shallowTarget - shallowCurrent) * 0.04;

    draw();
    if (running) requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener('resize', () => { resize(); if (!running) draw(); });

  window.addEventListener('pointermove', (e) => {
    target.x = (e.clientX / window.innerWidth) * 2 - 1;
    target.y = -((e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden){ running = false; }
    else if (!reduced && !paused){ running = true; last = performance.now(); requestAnimationFrame(frame); }
  });

  /* when the animation loop is stopped, still repaint as the dive changes */
  Dive.onUpdate(() => { if (!running) { scroll = Math.min(window.scrollY / Math.max(window.innerHeight,1), 1.5); draw(); } });

  if (reduced){ draw(); } else { requestAnimationFrame(frame); }

  /* ---- water controls ---- */
  const buttons = document.querySelectorAll('.sea-controls button');
  buttons.forEach(btn => btn.addEventListener('click', () => {
    const mode = btn.dataset.sea;
    const group = btn.dataset.group;

    if (group === 'play' && mode === 'pause'){
      paused = !paused;
      btn.setAttribute('aria-pressed', String(paused));
      if (!paused && !running && !document.hidden && !reduced){
        running = true; last = performance.now(); requestAnimationFrame(frame);
      }
      return;
    }

    document.querySelectorAll(`.sea-controls button[data-group="${group}"]`).forEach(b => {
      b.setAttribute('aria-pressed', String(b === btn));
    });

    if (group === 'chop') {
      chop = mode === 'calm' ? 0.55 : 1.0;
    } else if (group === 'depth') {
      shallowTarget = mode === 'shallow' ? 1.0 : 0.0;
    }

    if (!running) draw();
  }));
})();

/* ============================================================
   2. Bubbles
   ============================================================ */
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = document.getElementById('bubbles');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 22; i++){
    const b = document.createElement('b');
    const size = 6 + Math.random() * 44;
    b.style.width = b.style.height = size + 'px';
    b.style.left = (Math.random() * 100) + 'vw';
    b.style.setProperty('--drift', (Math.random() * 140 - 70) + 'px');
    b.style.animationDuration = (11 + Math.random() * 18) + 's';
    b.style.animationDelay = (-Math.random() * 30) + 's';
    b.style.opacity = '';
    frag.appendChild(b);
  }
  host.appendChild(frag);
})();

/* ============================================================
   3. Sidebar gadget: validation-loss sparkline (Canvas 2D)
   ============================================================ */
(function () {
  const c = document.getElementById('spark');
  if (!c) return;
  const loss = [0.94,0.81,0.72,0.66,0.60,0.55,0.51,0.47,0.44,0.41,0.39,0.36,
                0.34,0.32,0.31,0.29,0.28,0.27,0.26,0.25,0.24,0.23,0.22,0.21];

  function render(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const padX = 12, padY = 14;
    const max = Math.max(...loss), min = Math.min(...loss);
    const pt = (i) => [
      padX + (i / (loss.length - 1)) * (w - padX * 2),
      padY + (1 - (loss[i] - min) / (max - min)) * (h - padY * 2)
    ];

    ctx.strokeStyle = 'rgba(10,80,130,.13)';
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++){
      const y = padY + (g / 4) * (h - padY * 2);
      ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(w - padX, y); ctx.stroke();
    }

    const line = ctx.createLinearGradient(0, 0, w, 0);
    line.addColorStop(0, '#0a6fb0'); line.addColorStop(1, '#3fc0f0');

    const area = ctx.createLinearGradient(0, 0, 0, h);
    area.addColorStop(0, 'rgba(63,192,240,.42)');
    area.addColorStop(1, 'rgba(63,192,240,0)');

    ctx.beginPath();
    loss.forEach((_, i) => { const [x, y] = pt(i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.save();
    ctx.lineTo(w - padX, h - padY); ctx.lineTo(padX, h - padY); ctx.closePath();
    ctx.fillStyle = area; ctx.fill();
    ctx.restore();

    ctx.beginPath();
    loss.forEach((_, i) => { const [x, y] = pt(i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = line; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();

    const [lx, ly] = pt(loss.length - 1);
    ctx.beginPath(); ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = '#0a6fb0'; ctx.lineWidth = 2; ctx.stroke();
  }

  render();
  let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 150); });
})();