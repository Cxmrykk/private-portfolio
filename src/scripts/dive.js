/* ============================================================
   DIVE CONTROLLER — maps scroll position to camera depth
   ============================================================ */
export const Dive = (function () {
  const splash  = document.getElementById('splash');
  const readout = document.getElementById('depth');
  const body    = document.body;
  const shallowSlider = document.getElementById('ctrl-shallow');

  let target = 0, current = 0, camY = 3.3, raf = null, under = false, lastTxt = '';
  const listeners = [];

  /* dynamically calculate seabed based on UI slider */
  function getBedY() {
    const shallow = shallowSlider ? parseFloat(shallowSlider.value) / 100 : 0;
    return -27.0 * (1 - shallow) + -12.0 * shallow;
  }

  /* piecewise depth mapping:
     Phase 1 (0.0 - 0.3): scroll to #work, dive from 3.3 to -0.5m (just submerged)
     Phase 2 (0.3 - 1.0): scroll to bottom, dive from -0.5m to safe margin above floor */
  function camFromDive(d) {
    if (d < 0.3) {
      const t = d / 0.3;
      return 3.3 - 3.8 * t * t;
    } else {
      const t = (d - 0.3) / 0.7;
      const floorY = getBedY() + 1.5; // stop 1.5 units above the actual seabed
      return -0.5 + (floorY - (-0.5)) * t;
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

    if (readout) {
      const txt = camY > 0 ? 'Surface' : (-camY * 1.55).toFixed(1) + ' m';
      if (txt !== lastTxt) { readout.textContent = txt; lastTxt = txt; }
    }

    for (let i = 0; i < listeners.length; i++) listeners[i](current);
  }

  function loop() {
    current += (target - current) * 0.085;
    if (Math.abs(target - current) < 0.0004) current = target;
    apply();
    raf = (current === target) ? null : requestAnimationFrame(loop);
  }

  function measure() {
    const workEl = document.getElementById('work');
    const workTop = workEl ? workEl.offsetTop : window.innerHeight;
    const scrollY = window.scrollY;

    if (scrollY <= workTop) {
      /* Phase 1: Top of page to the #work section */
      target = 0.3 * (scrollY / Math.max(1, workTop));
    } else {
      /* Phase 2: #work section down to the absolute bottom footer */
      const maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight);
      const remaining = scrollY - workTop;
      const totalRemaining = maxScroll - workTop;
      
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

  /* recalculate depth readout if user drags the proximity slider */
  if (shallowSlider) {
    shallowSlider.addEventListener('input', () => {
      if (raf === null) raf = requestAnimationFrame(loop);
    });
  }

  /* wait a tick for DOM layout to get accurate offsetTop for the #work element */
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
