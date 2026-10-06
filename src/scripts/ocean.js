import { Dive } from './dive.js';
import { onFrame, wake } from './frame.js';
import { createRenderer } from './gl/renderer.js';
import { scanGlass, syncBlurLayer } from './gl/glass-scan.js';
import { createBubbleBuffer, updateBubbles } from './gl/bubble-field.js';
import { createFrameUniforms, updateFrameUniforms } from './gl/lighting.js';
import { loadSky } from './sky/sky-data.js';
import { createCelestial } from './sky/celestial.js';
import { setClockHour } from './clock-label.js';

/* ============================================================
   THE OCEAN — orchestrator
   Two contexts (base canvas under the DOM, UI canvas above it)
   share one frame state; each does ocean → texture → glass.

   Timing:
   - Drawing happens in the 'render' phase of the shared frame
     driver (frame.js), after the scroller and the dive controller
     have run for the same frame, so the glass matches the page.
     The driver also paces frames (~60 fps, divided down from the
     display's refresh rate).
   - Shaders compile asynchronously where supported; the first
     frame is drawn once both contexts report their programs ready
     and the sky data has loaded (or failed / timed out).

   Sky (sky/):
   - The time of day is Sydney's local time. The sun's arc is
     anchored to Sydney's real sunrise and sunset, and the moon's
     phase follows the real lunar phases, both from sky.json
     (published hourly by the deploy workflow).
   - Until sky.json arrives, or if it is unavailable, the sky uses
     a 6:00 / 18:00 day and a full moon, still on Sydney time.
   - Reduced motion: no continuous animation. A frame is drawn only
     when an input changed (scroll, sliders, resize, assets).

   Water controls:
   - Moving the time slider pins the time of day there for the
     rest of the visit; only Reset (or a reload) hands it back to
     the Sydney clock.
   - Reset restores every control to the default written in the
     HTML and resumes the animation.

   Settings pill (clock-label.js):
   - Its label shows state.dayTime, the time of day being rendered,
     so it follows the Sydney clock, the time slider, Pause and
     Reset together with the sky. Purely cosmetic.

   GPU budget:
   - A frame is only drawn when its inputs changed (clock, sliders,
     dive, scroll, pointer, glass layout).
   - Per-frame constants (light directions and colours, phase of
     day, camera) are computed once here (gl/lighting.js) and sent
     as uniforms rather than recomputed per pixel.
   - Bubble positions are computed and frustum-culled once per
     drawn frame (bubble-field.js) and shared by both canvases.
   - Touch devices (coarse pointer) use a smaller base-canvas budget
     and render scale; phones have far weaker GPUs than their pixel
     density suggests. The scale is fixed: there is no automatic
     downshift, so quality never drops mid-session.

   Main thread:
   - Only --light-blend is written, and only on the two overlays
     that use it (.atmosphere, #splash), after drawing, so it never
     restyles the whole document before the glass scan reads it.
   - Per-frame state (sun / moon directions, signature) reuses its
     buffers.
   ============================================================ */

/* Absolute tolerance for "nothing changed" (px, seconds, 0..1 values) */
const SIG_EPS = 1e-3;

/* Base-canvas budget and render scale on touch devices */
const TOUCH_BASE_MAX_PIXELS = 1280 * 720;
const TOUCH_SCALE = 0.7;

export function initOcean(){
  let ready = false;       // both contexts compiled and the first frame drawn
  let failed = false;
  let forceNext = false;   // draw the next frame even if the signature matches

  const coarse = window.matchMedia('(pointer: coarse)').matches;

  const base = createRenderer('sea', {
    isUI: false,
    maxPixels: coarse ? TOUCH_BASE_MAX_PIXELS : undefined,
    onResize: requestRedraw,
    onAssetReady: requestRedraw
  });
  const ui = createRenderer('ui-glass', {
    isUI: true,
    onResize: requestRedraw,
    onAssetReady: requestRedraw
  });

  if (!base || !ui){
    document.body.classList.add('no-webgl');
    return;
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* Continuous animation; reduced motion draws on change only */
  const running = !reduced;
  const scale = coarse ? TOUCH_SCALE : (window.innerWidth > 1500 ? 0.72 : 0.85);

  /* Sydney's clock with the default sky until sky.json arrives */
  let celestial = createCelestial(null);
  let skyPending = true;

  const now0 = Date.now();
  const state = {
    clock: 0,
    now: now0,                          // instant the sky is computed for (ms)
    dayTime: celestial.localHour(now0), // Sydney local hour, 0..24 (the time slider)
    sunDir: [0, 1, 0],                  // Written in place by celestial.js
    moonDir: [0, -1, 0],
    mouseX: 0, mouseY: 0,               // parallax, normalised -1..1
    cursorX: -1e4, cursorY: -1e4,       // pointer light, CSS px
    cursorOn: 0,
    scroll: 0, chop: 1.0, shallow: 0.0, dive: 0,
    bubbles: createBubbleBuffer(),      // camera-relative xyz + radius, visible bubbles first
    bubbleCount: 0,
    frame: createFrameUniforms()        // per-frame shader constants (gl/lighting.js)
  };

  /* celestial.js writes straight into state.sunDir / state.moonDir */
  const astro = { sun: state.sunDir, moon: state.moonDir };

  /* Reused view description for bubble culling */
  const bubbleView = { origin: state.frame.camOrigin, pitch: 0, aspect: 1 };

  const target = { x: 0, y: 0, cx: -1e4, cy: -1e4, on: 0 };
  let shallowTarget = 0.0;
  let paused = false;

  /* Set once the visitor picks a time; stays until Reset or a reload */
  let manualTimeOverride = false;
  const ctrlTime = document.getElementById('ctrl-time');
  let ctrlTimeValue = NaN;   // last value written to the time slider

  /* --light-blend consumers; written only when the value changes */
  const blendTargets = [document.querySelector('.atmosphere'), document.getElementById('splash')].filter(Boolean);
  let blendKey = '';

  /* Frame signature: two reused arrays, swapped when a frame is drawn */
  let sig = [], lastSig = [];
  let sigValid = false;

  /* Something outside the frame signature changed (a canvas resized,
     the sand texture arrived, a slider moved while static). */
  function requestRedraw(){
    if (failed) return;
    forceNext = true;
    wake();
  }

  function fail(){
    failed = true;
    document.body.classList.add('no-webgl');
  }

  /* Same (linear) twilight ramps the CSS overlays have always used */
  function writeLightBlend(){
    const sunY = state.sunDir[1];
    const dayW = Math.max(0, Math.min(1, (sunY - 0.15) / (0.6 - 0.15)));
    const nightW = 1.0 - Math.max(0, Math.min(1, (sunY - (-0.30)) / (0.0 - (-0.30))));
    const sunsetW = Math.max(0, 1.0 - (dayW + nightW));
    const blend = (dayW + sunsetW).toFixed(3);
    if (blend === blendKey) return;
    blendKey = blend;
    for (const el of blendTargets) el.style.setProperty('--light-blend', blend);
  }

  function syncTimeSlider(){
    if (!ctrlTime) return;
    const v = Math.round(state.dayTime * 100);
    if (v === ctrlTimeValue) return;
    ctrlTimeValue = v;
    ctrlTime.value = v;
  }

  /* The Settings pill shows the time of day being rendered.
     Writes only when the minute changes (clock-label.js). */
  function syncClockLabel(){
    setClockHour(state.dayTime);
  }

  /* Sun and moon directions for the current instant and time of day */
  function updateSky(){
    celestial.write(state.now, state.dayTime, astro);
  }

  /* Everything that can change what either canvas shows, written
     into `sig`. Returns true if it differs from the last drawn frame. */
  function signatureChanged(layers, dpr){
    const s = sig;
    let n = 0;
    s[n++] = state.clock; s[n++] = state.dayTime;
    s[n++] = state.mouseX; s[n++] = state.mouseY;
    s[n++] = state.cursorX; s[n++] = state.cursorY; s[n++] = state.cursorOn;
    s[n++] = state.scroll; s[n++] = state.chop; s[n++] = state.shallow; s[n++] = state.dive;
    s[n++] = window.innerWidth; s[n++] = window.innerHeight; s[n++] = dpr; s[n++] = scale;

    const lists = [layers.base, layers.ui];
    for (let l = 0; l < 2; l++){
      const list = lists[l];
      s[n++] = list.length;
      for (let i = 0; i < list.length; i++){
        const it = list[i];
        const r = it.rect;
        s[n++] = r.left; s[n++] = r.top; s[n++] = r.width; s[n++] = r.height;
        s[n++] = it.op; s[n++] = it.z;
      }
    }
    s.length = n;

    if (!sigValid || lastSig.length !== n) return true;
    for (let i = 0; i < n; i++){
      if (Math.abs(s[i] - lastSig[i]) > SIG_EPS) return true;
    }
    return false;
  }

  function commitSignature(){
    const t = lastSig;
    lastSig = sig;
    sig = t;
    sigValid = true;
  }

  function render(force){
    const layers = scanGlass();
    state.dive = Dive.value;
    const dpr = window.devicePixelRatio || 1;

    if (!signatureChanged(layers, dpr) && !force) return;
    commitSignature();

    /* After state.dive is current: the uniforms and the bubble field
       use the same camera the shaders used to build per pixel. */
    updateFrameUniforms(state, state.frame);
    bubbleView.pitch = state.frame.camPitch;
    bubbleView.aspect = base.aspect();
    state.bubbleCount = updateBubbles(state, state.bubbles, bubbleView);

    syncBlurLayer(layers.ui);
    base.draw(state, layers.base, Math.min(dpr, 1.5) * scale);
    ui.draw(state, layers.ui, Math.min(dpr, 2));
  }

  function syncScroll(){
    state.scroll = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1.5);
  }

  /* Follow the Sydney clock (unless the visitor picked a time) */
  function followClock(){
    state.now = Date.now();
    state.dayTime = celestial.localHour(state.now);
    syncTimeSlider();
    syncClockLabel();
  }

  /* Advance the animated state by dt seconds */
  function advance(dt){
    if (!paused) {
      state.clock += dt;
      if (!manualTimeOverride) followClock();
    }

    // Process positional orbits
    updateSky();

    /* Frame-rate independent easing, calibrated so each factor behaves
       exactly as the old per-frame value did at 60 fps. */
    const ease = (k) => 1 - Math.pow(1 - k, dt * 60);

    state.mouseX += (target.x - state.mouseX) * ease(0.045);
    state.mouseY += (target.y - state.mouseY) * ease(0.045);
    state.cursorX += (target.cx - state.cursorX) * ease(0.18);
    state.cursorY += (target.cy - state.cursorY) * ease(0.18);
    state.cursorOn += (target.on - state.cursorOn) * ease(0.08);

    const sTarget = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1.5);
    state.scroll += (sTarget - state.scroll) * ease(0.08);
    state.shallow += (shallowTarget - state.shallow) * ease(0.04);
  }

  /* Frame driver, 'render' phase */
  function onRender(now, dt){
    if (failed) return false;

    if (!ready){
      const b = base.status(), u = ui.status();
      if (b === 'failed' || u === 'failed'){ fail(); return false; }
      /* still compiling, or still waiting for sky.json: poll */
      if (b !== 'ready' || u !== 'ready' || skyPending) return true;

      ready = true;
      updateSky();
      syncScroll();
      render(true);
      forceNext = false;
      writeLightBlend();
      return running;
    }

    if (running){
      advance(dt);
    } else {
      /* Static: follow scroll and sliders, no clock */
      syncScroll();
      updateSky();
    }

    render(forceNext);
    forceNext = false;
    writeLightBlend();
    return running;
  }

  /* The pill starts out showing the time the sky starts out at */
  syncClockLabel();

  /* ---- sky data: Sydney sunrise / sunset and moon phases ---- */
  loadSky().then((data) => {
    if (data) celestial = createCelestial(data);
    skyPending = false;
    if (!manualTimeOverride) followClock();
    requestRedraw();
  });

  onFrame('render', onRender);

  /* ---- pointer ---- */
  window.addEventListener('pointermove', (e) => {
    target.x = (e.clientX / window.innerWidth) * 2 - 1;
    target.y = -((e.clientY / window.innerHeight) * 2 - 1);
    if (state.cursorOn < 0.01){ state.cursorX = e.clientX; state.cursorY = e.clientY; }
    target.cx = e.clientX; target.cy = e.clientY; target.on = 1;
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => { target.on = 0; });
  window.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') target.on = 0; }, { passive: true });
  window.addEventListener('pointercancel', () => { target.on = 0; }, { passive: true });

  window.addEventListener('resize', requestRedraw);

  /* ---- water controls ---- */
  const ctrlChop = document.getElementById('ctrl-chop');
  const ctrlShallow = document.getElementById('ctrl-shallow');
  const ctrlPlay = document.getElementById('ctrl-play');
  const ctrlReset = document.getElementById('ctrl-reset');

  function setPaused(next){
    paused = next;
    if (!ctrlPlay) return;
    ctrlPlay.setAttribute('aria-pressed', String(paused));
    ctrlPlay.textContent = paused ? 'Resume' : 'Pause';
  }

  /* Put a slider back to its HTML default and let every listener
     (this module, the dive controller) react as if the user moved it */
  function resetSlider(input){
    if (!input) return;
    input.value = input.defaultValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  if (ctrlTime) {
    syncTimeSlider();

    /* The picked time stays until Reset or a reload */
    ctrlTime.addEventListener('input', (e) => {
      state.dayTime = parseFloat(e.target.value) / 100;
      ctrlTimeValue = Math.round(state.dayTime * 100);
      manualTimeOverride = true;
      syncClockLabel();
      requestRedraw();
    });
  }

  if (ctrlChop){
    ctrlChop.addEventListener('input', (e) => {
      state.chop = parseFloat(e.target.value) / 100;
      requestRedraw();
    });
  }

  if (ctrlShallow){
    ctrlShallow.addEventListener('input', (e) => {
      shallowTarget = parseFloat(e.target.value) / 100;
      if (!running || paused) state.shallow = shallowTarget;
      requestRedraw();
    });
  }

  if (ctrlPlay){
    ctrlPlay.addEventListener('click', () => {
      setPaused(!paused);
      requestRedraw();
    });
  }

  if (ctrlReset){
    ctrlReset.addEventListener('click', () => {
      /* Resume first, so the reef slider eases back rather than snapping */
      setPaused(false);

      /* Time of day: back to the Sydney clock (also resets the pill) */
      manualTimeOverride = false;
      followClock();

      resetSlider(ctrlChop);
      resetSlider(ctrlShallow);
      requestRedraw();
    });
  }
}
