/* ============================================================
   DIVE CONTROLLER — maps scroll position to camera depth
   ============================================================ */
export const Dive = (function () {
  const splash  = document.getElementById('splash');
  const body    = document.body;
  const shallowSlider = document.getElementById('ctrl-shallow');

  /* The first (surface-breaking) dive phase ends when this section
     reaches the top of the viewport. */
  const ANCHOR_ID = 'projects';

  let target = 0, current = 0, camY = 3.3, raf = null, under = false;
  const listeners = [];

  /* dynamically calculate seabed based on UI slider */
  function getBedY() {
    const shallow = shallowSlider ? parseFloat(shallowSlider.value) / 100 : 0;
    return -27.0 * (1 - shallow) + -12.0 * shallow;
  }

  /* piecewise depth mapping:
     Phase 1 (0.0 - 0.3): scroll to #projects, dive from 3.3 to -4.0 (a satisfying initial plunge)
     Phase 2 (0.3 - 1.0): scroll to bottom, dive from -4.0 to a safe margin above floor */
  function camFromDive(d) {
    if (d < 0.3) {
      const t = d / 0.3;
      return 3.3 - 7.3 * t * t;
    } else {
      const t = (d - 0.3) / 0.7;
      const floorY = getBedY() + 1.5; // stop 1.5 units above the actual seabed
      return -4.0 + (floorY - (-4.0)) * t;
    }
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

  function loop() {
    current += (target - current) * 0.085;
    if (Math.abs(target - current) < 0.0004) current = target;
    apply();
    raf = (current === target) ? null : requestAnimationFrame(loop);
  }

  function measure() {
    const anchorEl = document.getElementById(ANCHOR_ID);
    const anchorTop = anchorEl ? anchorEl.offsetTop : window.innerHeight;
    const scrollY = window.scrollY;

    if (scrollY <= anchorTop) {
      /* Phase 1: top of page to the #projects section */
      target = 0.3 * (scrollY / Math.max(1, anchorTop));
    } else {
      /* Phase 2: #projects section down to the absolute bottom footer */
      const maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight);
      const remaining = scrollY - anchorTop;
      const totalRemaining = maxScroll - anchorTop;

      if (totalRemaining > 0) {
        target = 0.3 + 0.7 * Math.min(1, remaining / totalRemaining);
      } else {
        target = 0.3; // fallback if body is somehow too short
      }
    }

    if (raf === null) raf = requestAnimationFrame(loop);
  }

  window.addEventListener('scroll', measure, { passive: true });
  window.addEventListener('resize', measure);
  window.addEventListener('load', measure);

  /* Project cards arrive asynchronously and change the page height
     after 'load' has fired; re-measure whenever the layout grows. */
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => measure()).observe(document.body);
  }

  /* re-apply the camera depth if user drags the proximity slider */
  if (shallowSlider) {
    shallowSlider.addEventListener('input', () => {
      if (raf === null) raf = requestAnimationFrame(loop);
    });
  }

  /* wait a tick for DOM layout to get an accurate offsetTop for the anchor */
  setTimeout(() => {
    measure();
    current = target;
    apply();
  }, 0);

  return {
    get value(){ return current; },
    get camY(){ return camY; },
    onUpdate(fn){ listeners.push(fn); }
  };
})();
