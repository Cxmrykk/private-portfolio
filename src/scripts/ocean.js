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
    if (!paused) state.clock += dt;

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

    render();
    if (running) requestAnimationFrame(frame);
  }

  function syncScroll(){
    state.scroll = Math.min(window.scrollY / Math.max(window.innerHeight, 1), 1.5);
  }

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
