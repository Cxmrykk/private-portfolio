import { Dive } from './dive.js';
import { createRenderer } from './gl/renderer.js';
import { scanGlass, syncBlurLayer } from './gl/glass-scan.js';
import { createBubbleBuffer, updateBubbles } from './gl/bubble-field.js';
import { getAstronomy } from './astronomy.js';

/* ============================================================
   THE OCEAN — orchestrator
   Two contexts (base canvas under the DOM, UI canvas above it)
   share one frame state; each does ocean → texture → glass.

   GPU budget:
   - Frames are capped at TARGET_FPS. The water moves slowly, so
     60 fps is indistinguishable from 120/144 Hz, and each frame
     is two full ocean passes.
   - A frame is only drawn when its inputs changed (clock, sliders,
     dive, scroll, pointer, glass layout). While paused and settled
     the GPU does no work at all.
   - Bubble positions depend only on time and the camera, so they
     are computed here once per drawn frame (bubble-field.js) and
     shared by both canvases, instead of per pixel in the shader.
   - Touch devices (coarse pointer) start with a smaller base-canvas
     budget and render scale. Phones have far weaker GPUs than their
     pixel density suggests, and starting low avoids the ~45 slow
     frames the downshift heuristic needs before it reacts.

   Assets:
   - The sand texture arrives asynchronously (gl/sand-texture.js).
     Its arrival is not part of the frame signature, so the renderer
     reports it via onAssetReady and the signature is invalidated,
     which makes a paused or reduced-motion page redraw with it.
   ============================================================ */

const TARGET_FPS = 60;
const FRAME_MS = 1000 / TARGET_FPS;
/* Slack so a 60 Hz display (16.67 ms) never loses frames to vsync jitter */
const FRAME_SLACK_MS = 2;

/* Absolute tolerance for "nothing changed" (px, seconds, 0..1 values) */
const SIG_EPS = 1e-3;

/* Base-canvas budget and render scale on touch devices */
const TOUCH_BASE_MAX_PIXELS = 1280 * 720;
const TOUCH_SCALE = 0.7;

export function initOcean(){
  /* Set once the first frame has been drawn; canvas resize / asset
     callbacks that arrive earlier (or after a failed init) are ignored. */
  let ready = false;

  const coarse = window.matchMedia('(pointer: coarse)').matches;

  const base = createRenderer('sea', {
    isUI: false,
    maxPixels: coarse ? TOUCH_BASE_MAX_PIXELS : undefined,
    onResize: requestStaticRedraw,
    onAssetReady: requestStaticRedraw
  });
  const ui = createRenderer('ui-glass', {
    isUI: true,
    onResize: requestStaticRedraw,
    onAssetReady: requestStaticRedraw
  });

  if (!base || !ui){
    document.body.classList.add('no-webgl');
    return;
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scale = coarse ? TOUCH_SCALE : (window.innerWidth > 1500 ? 0.72 : 0.85);

  function getLocalDecimalHour() {
    const d = new Date();
    return d.getHours() + (d.getMinutes() / 60) + (d.getSeconds() / 3600) + (d.getMilliseconds() / 3600000);
  }

  const state = {
    clock: 0,
    date: new Date(),
    dayTime: getLocalDecimalHour(),  // Mapped reliably to the 24h clock for the slider
    sunDir: [0, 1, 0],               // Updated dynamically from astronomy.js
    moonDir: [0, -1, 0],
    mouseX: 0, mouseY: 0,            // parallax, normalised -1..1
    cursorX: -1e4, cursorY: -1e4,    // pointer light, CSS px
    cursorOn: 0,
    scroll: 0, chop: 1.0, shallow: 0.0, dive: 0,
    bubbles: createBubbleBuffer()    // camera-relative xyz + radius, per bubble
  };
  
  const target = { x: 0, y: 0, cx: -1e4, cy: -1e4, on: 0 };
  let shallowTarget = 0.0;
  let last = performance.now();
  let running = false, paused = false;
  let slow = 0, downshifted = false;

  /* The one pending animation-frame request. Every scheduling path goes
     through startLoop()/stopLoop(), so at most one loop can ever exist.
     (Previously, a callback queued before the tab was hidden survived
     the hide and ran alongside the new one on return, adding a whole
     extra render loop on every tab switch.) */
  let rafId = 0;

  /* Inputs of the last frame actually drawn; see frameSignature() */
  let lastSig = null;

  /* Last CSS sky palette written, so unchanged values aren't re-set */
  let cssKey = '';

  let manualTimeOverride = false;
  let overrideTimeout = null;
  const ctrlTime = document.getElementById('ctrl-time');

  /* Something outside the frame signature changed (a canvas resized,
     the sand texture arrived). Invalidate the signature so the running
     loop draws the next frame even while paused; if the loop is not
     running, draw one now. */
  function requestStaticRedraw(){
    if (!ready) return;
    lastSig = null;
    if (!running) render(true);
  }

  function updateCSSColors(sunY) {
    // Sync to shader's widened twilight zone
    const dayW = Math.max(0, Math.min(1, (sunY - 0.15) / (0.6 - 0.15)));
    const nightW = 1.0 - Math.max(0, Math.min(1, (sunY - (-0.30)) / (0.0 - (-0.30))));
    const sunsetW = Math.max(0, 1.0 - (dayW + nightW));

    const lerp = (c1, c2, c3, w1, w2, w3) => c1.map((v, i) => Math.round(v * w1 + c2[i] * w2 + c3[i] * w3));
    
    // 3-stop palettes mapped identically to common.glsl.js
    const dayZ = [15, 82, 186];  const dayM = [97, 173, 240];  const dayH = [209, 240, 255];
    const setZ = [20, 56, 97];   const setM = [166, 77, 89];   const setH = [255, 102, 26];
    const nigZ = [3, 5, 13];     const nigM = [5, 13, 25];     const nigH = [13, 31, 51];

    const z = lerp(dayZ, setZ, nigZ, dayW, sunsetW, nightW);
    const m = lerp(dayM, setM, nigM, dayW, sunsetW, nightW);
    const h = lerp(dayH, setH, nigH, dayW, sunsetW, nightW);
    const blend = (dayW + sunsetW).toFixed(3);

    /* Writing custom properties on <html> invalidates style for the
       whole page, so only do it when a value actually changed. */
    const key = z.join() + '|' + m.join() + '|' + h.join() + '|' + blend;
    if (key === cssKey) return;
    cssKey = key;

    document.documentElement.style.setProperty('--sky-zenith', `rgb(${z[0]},${z[1]},${z[2]})`);
    document.documentElement.style.setProperty('--sky-mid', `rgb(${m[0]},${m[1]},${m[2]})`);
    document.documentElement.style.setProperty('--sky-horizon', `rgb(${h[0]},${h[1]},${h[2]})`);
    document.documentElement.style.setProperty('--light-blend', blend);
  }

  /* Everything that can change what either canvas shows. If none of it
     moved since the last drawn frame, the new frame would be identical.
     (Bubbles depend only on clock, dive, shallow and mouse, which are
     all already in here.) */
  function frameSignature(layers, dpr){
    const sig = [
      state.clock, state.dayTime,
      state.mouseX, state.mouseY,
      state.cursorX, state.cursorY, state.cursorOn,
      state.scroll, state.chop, state.shallow, state.dive,
      window.innerWidth, window.innerHeight, dpr, scale
    ];
    for (const list of [layers.base, layers.ui]){
      sig.push(list.length);
      for (const it of list){
        const r = it.rect;
        sig.push(r.left, r.top, r.width, r.height, it.op, it.z);
      }
    }
    return sig;
  }

  function sameSignature(a, b){
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++){
      if (Math.abs(a[i] - b[i]) > SIG_EPS) return false;
    }
    return true;
  }

  /* force = true for event-driven redraws (resize, sliders while
     stopped) so they never get skipped. */
  function render(force = false){
    const layers = scanGlass();
    state.dive = Dive.value;
    const dpr = window.devicePixelRatio || 1;

    const sig = frameSignature(layers, dpr);
    if (!force && sameSignature(sig, lastSig)) return;
    lastSig = sig;

    /* After state.dive is current: the bubble field uses the same
       camera the shaders build from these uniforms. */
    updateBubbles(state, state.bubbles);

    syncBlurLayer(layers.ui);
    base.draw(state, layers.base, Math.min(dpr, 1.5) * scale);
    ui.draw(state, layers.ui, Math.min(dpr, 2)); 
  }

  function frame(now){
    rafId = 0;

    /* Frame-rate cap: on high-refresh displays, skip vsyncs until a
       full frame interval has passed since the last drawn frame. */
    if (now - last < FRAME_MS - FRAME_SLACK_MS){
      if (running) rafId = requestAnimationFrame(frame);
      return;
    }

    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (!paused) {
      state.clock += dt;
      if (!manualTimeOverride) {
        state.date = new Date();
        state.dayTime = getLocalDecimalHour(); // Driven by actual local clock
        if (ctrlTime) {
          ctrlTime.value = state.dayTime * 100;
        }
      }
    }

    // Process positional orbits
    const astro = getAstronomy(state.date, state.dayTime);
    state.sunDir = astro.sun;
    state.moonDir = astro.moon;

    if (dt > 0.032){ slow++; } else { slow = Math.max(0, slow - 1); }
    if (slow > 45 && !downshifted){ downshifted = true; scale = 0.5; }

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

    updateCSSColors(state.sunDir[1]);
    render(false);
    if (running) rafId = requestAnimationFrame(frame);
  }

  function startLoop(){
    running = true;
    if (rafId !== 0) return;          // a frame is already queued
    last = performance.now() - FRAME_MS; // let the first frame draw immediately
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop(){
    running = false;
    if (rafId !== 0){
      cancelAnimationFrame(rafId);    // drop the queued frame, don't just orphan it
      rafId = 0;
    }
  }

  function syncScroll(){
    state.scroll = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1.5);
  }

  // Initial Astronomical Load
  const initAstro = getAstronomy(state.date, state.dayTime);
  state.sunDir = initAstro.sun;
  state.moonDir = initAstro.moon;
  
  updateCSSColors(state.sunDir[1]);
  render(true);
  ready = true;
  
  window.addEventListener('resize', requestStaticRedraw);
  window.addEventListener('scroll', () => { if (!running){ syncScroll(); render(true); } }, { passive: true });
  Dive.onUpdate(() => { if (!running){ syncScroll(); render(true); } });

  window.addEventListener('pointermove', (e) => {
    target.x = (e.clientX / window.innerWidth) * 2 - 1;
    target.y = -((e.clientY / window.innerHeight) * 2 - 1);
    if (state.cursorOn < 0.01){ state.cursorX = e.clientX; state.cursorY = e.clientY; }
    target.cx = e.clientX; target.cy = e.clientY; target.on = 1;
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => { target.on = 0; });
  window.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') target.on = 0; }, { passive: true });
  window.addEventListener('pointercancel', () => { target.on = 0; }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden){ stopLoop(); }
    else if (!reduced && !paused){ startLoop(); }
  });

  if (!reduced) startLoop();

  /* ---- water controls ---- */
  const ctrlChop = document.getElementById('ctrl-chop');
  const ctrlShallow = document.getElementById('ctrl-shallow');
  const ctrlPlay = document.getElementById('ctrl-play');

  if (ctrlTime) {
    ctrlTime.value = state.dayTime * 100;
    
    ctrlTime.addEventListener('input', (e) => {
      state.dayTime = parseFloat(e.target.value) / 100;
      manualTimeOverride = true;
      clearTimeout(overrideTimeout);
      
      // Auto-resume cycle 5 seconds after they finish dragging
      overrideTimeout = setTimeout(() => { manualTimeOverride = false; }, 5000);
      
      if (!running || paused) {
        const astro = getAstronomy(state.date, state.dayTime);
        state.sunDir = astro.sun;
        state.moonDir = astro.moon;
        updateCSSColors(state.sunDir[1]);
        render(true);
      }
    });
  }

  if (ctrlChop){
    ctrlChop.addEventListener('input', (e) => {
      state.chop = parseFloat(e.target.value) / 100;
      if (!running || paused) render(true);
    });
  }

  if (ctrlShallow){
    ctrlShallow.addEventListener('input', (e) => {
      shallowTarget = parseFloat(e.target.value) / 100;
      if (!running || paused){
        state.shallow = shallowTarget;
        render(true);
      }
    });
  }

  if (ctrlPlay){
    ctrlPlay.addEventListener('click', () => {
      paused = !paused;
      ctrlPlay.setAttribute('aria-pressed', String(paused));
      ctrlPlay.textContent = paused ? 'Resume Animation' : 'Pause Animation';
      if (!paused && !running && !document.hidden && !reduced){
        startLoop();
      }
    });
  }
}
