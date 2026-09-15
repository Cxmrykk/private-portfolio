/* ============================================================
   DIVE CONTROLLER — maps scroll position to camera depth
   ============================================================ */
export const Dive = (function () {
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
