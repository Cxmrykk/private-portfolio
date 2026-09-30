/* ============================================================
   DIVE CONTROLLER — maps scroll position to camera depth
   The depth curve itself lives in gl/camera.js, shared with the
   CPU-side bubble field and the per-frame shader uniforms.

   Runs in the 'camera' phase of the shared frame driver
   (frame.js): after the scroller has written this frame's scroll
   position, before the ocean draws. The easing is time-based, so
   it behaves the same on 60 Hz and high-refresh displays.

   Layout metrics (the anchor's offset, the page height) only
   change with layout, so they are measured on resize / load /
   body resize rather than on every scroll.
   ============================================================ */
import { diveHeight } from './gl/camera.js';
import { onFrame, wake } from './frame.js';

export const Dive = (function () {
  const splash  = document.getElementById('splash');
  const body    = document.body;
  const shallowSlider = document.getElementById('ctrl-shallow');

  /* The first (surface-breaking) dive phase ends when this section
     reaches the top of the viewport. */
  const ANCHOR_ID = 'projects';

  /* Per-frame easing factor at 60 fps */
  const EASE = 0.085;

  let current = 0, camY = 3.3, under = false;
  let anchorTop = window.innerHeight;
  let maxScroll = 1;
  let dirty = true;     // apply() needed even if `current` did not move
  let started = false;  // initial measurement done
  const listeners = [];

  /* Reef proximity straight from the UI slider (0..1) */
  function getShallow() {
    return shallowSlider ? parseFloat(shallowSlider.value) / 100 : 0;
  }

  /* piecewise depth mapping (see diveHeight in gl/camera.js):
     Phase 1 (0.0 - 0.3): scroll to #projects, dive from 3.3 to -4.0 (a satisfying initial plunge)
     Phase 2 (0.3 - 1.0): scroll to bottom, dive from -4.0 to 1.5 units above the seabed */
  function camFromDive(d) {
    return diveHeight(d, getShallow());
  }

  function apply() {
    camY = camFromDive(current);

    /* white-water veil while breaking the surface */
    if (splash) {
      const s = Math.max(0, 1 - Math.abs(camY) / 2.0);
      splash.style.opacity = (s * s * 0.7).toFixed(3);
    }

    /* hysteresis so the class does not flicker on the boundary */
    if (!under && camY < 0.15) { under = true;  body.classList.add('is-underwater'); }
    else if (under && camY > 0.9) { under = false; body.classList.remove('is-underwater'); }

    for (let i = 0; i < listeners.length; i++) listeners[i](current);
  }

  function measure() {
    const anchorEl = document.getElementById(ANCHOR_ID);
    anchorTop = anchorEl ? anchorEl.offsetTop : window.innerHeight;
    maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight);
    wake();
  }

  function targetFor(scrollY) {
    if (scrollY <= anchorTop) {
      /* Phase 1: top of page to the #projects section */
      return 0.3 * (scrollY / Math.max(1, anchorTop));
    }
    /* Phase 2: #projects section down to the absolute bottom footer */
    const remaining = scrollY - anchorTop;
    const totalRemaining = maxScroll - anchorTop;
    if (totalRemaining > 0) return 0.3 + 0.7 * Math.min(1, remaining / totalRemaining);
    return 0.3; // fallback if body is somehow too short
  }

  /* Frame driver, 'camera' phase */
  function update(now, dt) {
    if (!started) return false;

    const target = targetFor(window.scrollY);
    const before = current;
    const k = 1 - Math.pow(1 - EASE, dt * 60);
    current += (target - current) * k;
    if (Math.abs(target - current) < 0.0004) current = target;

    if (current !== before || dirty) {
      dirty = false;
      apply();
    }
    return current !== target;
  }

  onFrame('camera', update);

  /* External scrolls (scrollbar, find in page) need a frame too;
     the scroller's own writes already have one. */
  window.addEventListener('scroll', wake, { passive: true });
  window.addEventListener('resize', measure);
  window.addEventListener('load', measure);

  /* Late layout changes (web fonts swapping in, text reflow, section
     gaps being re-sized) change the page height after 'load'. */
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => measure()).observe(document.body);
  }

  /* re-apply the camera depth if user drags the proximity slider */
  if (shallowSlider) {
    shallowSlider.addEventListener('input', () => {
      dirty = true;
      wake();
    });
  }

  /* wait a tick for DOM layout to get an accurate offsetTop for the anchor */
  setTimeout(() => {
    measure();
    current = targetFor(window.scrollY);
    started = true;
    dirty = false;
    apply();
  }, 0);

  return {
    get value(){ return current; },
    get camY(){ return camY; },
    onUpdate(fn){ listeners.push(fn); }
  };
})();
