import { Dive } from './dive.js';
import { createRenderer } from './gl/renderer.js';
import { scanGlass, syncBlurLayer } from './gl/glass-scan.js';

/* ============================================================
   THE OCEAN — orchestrator
   Two contexts (base canvas under the DOM, UI canvas above it)
   share one frame state; each does ocean → texture → glass.
   ============================================================ */
export function initOcean(){
  const base = createRenderer('sea', { isUI: false });
  const ui   = createRenderer('ui-glass', { isUI: true });

  if (!base || !ui){
    document.body.classList.add('no-webgl');
    return;
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scale = window.innerWidth > 1500 ? 0.72 : 0.85;

  const state = {
    clock: 0,
    dayTime: 12.0,                   // 24-hour cycle: 12 = noon
    mouseX: 0, mouseY: 0,            // parallax, normalised -1..1
    cursorX: -1e4, cursorY: -1e4,    // pointer light, CSS px
    cursorOn: 0,
    scroll: 0, chop: 1.0, shallow: 0.0, dive: 0
  };
  const target = { x: 0, y: 0, cx: -1e4, cy: -1e4, on: 0 };
  let shallowTarget = 0.0;
  let last = performance.now();
  let running = !reduced, paused = false;
  let slow = 0, downshifted = false;

  let manualTimeOverride = false;
  let overrideTimeout = null;
  const ctrlTime = document.getElementById('ctrl-time');

  function updateCSSColors(dayTime) {
    const sunY = Math.sin((dayTime - 6.0) / 24.0 * Math.PI * 2) * 0.8;
    
    // Sync to shader's widened twilight zone
    const dayW = Math.max(0, Math.min(1, (sunY - 0.15) / (0.6 - 0.15)));
    const nightW = 1.0 - Math.max(0, Math.min(1, (sunY - (-0.3)) / (0.0 - (-0.3))));
    const sunsetW = Math.max(0, 1.0 - (dayW + nightW));

    const lerp = (c1, c2, c3, w1, w2, w3) => c1.map((v, i) => Math.round(v * w1 + c2[i] * w2 + c3[i] * w3));
    
    // 3-stop palettes mapped identically to common.glsl.js
    const dayZ = [15, 82, 186];  const dayM = [97, 173, 240];  const dayH = [209, 240, 255];
    const setZ = [20, 56, 97];   const setM = [166, 77, 89];   const setH = [255, 102, 26]; // Deep teal zenith, rosy mid, fiery horizon
    const nigZ = [3, 5, 13];     const nigM = [5, 13, 25];     const nigH = [13, 31, 51];

    const z = lerp(dayZ, setZ, nigZ, dayW, sunsetW, nightW);
    const m = lerp(dayM, setM, nigM, dayW, sunsetW, nightW);
    const h = lerp(dayH, setH, nigH, dayW, sunsetW, nightW);

    document.documentElement.style.setProperty('--sky-zenith', `rgb(${z[0]},${z[1]},${z[2]})`);
    document.documentElement.style.setProperty('--sky-mid', `rgb(${m[0]},${m[1]},${m[2]})`);
    document.documentElement.style.setProperty('--sky-horizon', `rgb(${h[0]},${h[1]},${h[2]})`);
    document.documentElement.style.setProperty('--light-blend', (dayW + sunsetW).toFixed(3));
  }

  function render(){
    const layers = scanGlass();
    syncBlurLayer(layers.ui);
    state.dive = Dive.value;
    const dpr = window.devicePixelRatio || 1;
    base.draw(state, layers.base, Math.min(dpr, 1.5) * scale);
    ui.draw(state, layers.ui, Math.min(dpr, 2));  // full DPR: crisp rims, mostly discarded
  }

  function frame(now){
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (!paused) {
      state.clock += dt;
      if (!manualTimeOverride) {
        state.dayTime = (state.dayTime + dt * 0.6) % 24.0; // 0.6 hours per sec (40s for full loop)
        if (ctrlTime) ctrlTime.value = state.dayTime * 100;
      }
    }

    if (dt > 0.032){ slow++; } else { slow = Math.max(0, slow - 1); }
    if (slow > 45 && !downshifted){ downshifted = true; scale = 0.5; }

    state.mouseX += (target.x - state.mouseX) * 0.045;
    state.mouseY += (target.y - state.mouseY) * 0.045;
    state.cursorX += (target.cx - state.cursorX) * 0.18;
    state.cursorY += (target.cy - state.cursorY) * 0.18;
    state.cursorOn += (target.on - state.cursorOn) * 0.08;

    const sTarget = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1.5);
    state.scroll += (sTarget - state.scroll) * 0.08;
    state.shallow += (shallowTarget - state.shallow) * 0.04;

    updateCSSColors(state.dayTime);
    render();
    if (running) requestAnimationFrame(frame);
  }

  function syncScroll(){
    state.scroll = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1.5);
  }

  updateCSSColors(state.dayTime);
  render();
  window.addEventListener('resize', () => { if (!running) render(); });
  window.addEventListener('scroll', () => { if (!running){ syncScroll(); render(); } }, { passive: true });
  Dive.onUpdate(() => { if (!running){ syncScroll(); render(); } });

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
    if (document.hidden){ running = false; }
    else if (!reduced && !paused){ running = true; last = performance.now(); requestAnimationFrame(frame); }
  });

  if (!reduced) requestAnimationFrame(frame);

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
        updateCSSColors(state.dayTime);
        render();
      }
    });
  }

  if (ctrlChop){
    ctrlChop.addEventListener('input', (e) => {
      state.chop = parseFloat(e.target.value) / 100;
      if (!running || paused) render();
    });
  }

  if (ctrlShallow){
    ctrlShallow.addEventListener('input', (e) => {
      shallowTarget = parseFloat(e.target.value) / 100;
      if (!running || paused){
        state.shallow = shallowTarget;
        render();
      }
    });
  }

  if (ctrlPlay){
    ctrlPlay.addEventListener('click', () => {
      paused = !paused;
      ctrlPlay.setAttribute('aria-pressed', String(paused));
      ctrlPlay.textContent = paused ? 'Resume Animation' : 'Pause Animation';
      if (!paused && !running && !document.hidden && !reduced){
        running = true;
        last = performance.now();
        requestAnimationFrame(frame);
      }
    });
  }
}
