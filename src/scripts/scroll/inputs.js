/* ============================================================
   SCROLL INPUTS — wheel, touch and keyboard → the scroller
   Two scrolling contexts:

     within   input moves the page inside the current section and
              stops dead at its edges
     hop      a NEW gesture that begins at an edge and pushes
              outward jumps to the neighbouring section

   A gesture that reaches an edge part-way (a long wheel spin,
   trackpad inertia, a touch flick, a held arrow key) can never
   hop; it has to end first. That is what stops a long section
   from accidentally throwing the reader into the next one.

   Wheel gestures are delimited by a short quiet gap, touch
   gestures by the finger, key gestures by auto-repeat.
   The water controls are left alone (their sliders need drags).
   ============================================================ */

/* Quiet time that ends a wheel gesture (trackpad inertia included) */
const GESTURE_GAP_MS = 200;

/* Outward push needed at an edge before a hop fires */
const WHEEL_HOP_PX = 40;
const TOUCH_HOP_PX = 60;

/* Inward travel after which a touch that began at an edge is no
   longer allowed to hop */
const TOUCH_DISARM_PX = 16;

/* Touch flick → glide distance (px per px/ms of release velocity) */
const GLIDE_MS = 325;
/* Finger held still this long before lifting: no glide */
const TOUCH_STALE_MS = 90;

const LINE_PX = 16;
const ARROW_STEP = 80;
const PAGE_SHARE = 0.85;

const EXEMPT = '.sea-controls';
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const SPACE_ACTIVATES = 'button, summary, [role="button"], input, select, textarea';

function closest(target, selector){
  return target instanceof Element ? target.closest(selector) : null;
}

function wheelPixels(e){
  if (e.deltaMode === 1) return e.deltaY * LINE_PX;
  if (e.deltaMode === 2) return e.deltaY * window.innerHeight;
  return e.deltaY;
}

/* ---------- wheel / trackpad ---------- */
function bindWheel(scroller){
  let last = -Infinity;
  let armedDown = false, armedUp = false;
  let blocked = false;
  let pressure = 0, pressureDir = 0;

  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || scroller.count() === 0) return;           // pinch-zoom
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;       // horizontal / back-swipe
    e.preventDefault();

    const now = performance.now();
    if (now - last > GESTURE_GAP_MS){
      /* a new gesture: remember which edges it started on */
      blocked = scroller.isHopping();
      armedDown = scroller.atEdge(1);
      armedUp = scroller.atEdge(-1);
      pressure = 0; pressureDir = 0;
    }
    last = now;

    if (blocked) return;
    if (scroller.isHopping()){ blocked = true; return; }

    const dy = wheelPixels(e);
    if (dy === 0) return;
    const dir = dy > 0 ? 1 : -1;

    if (!scroller.atEdge(dir)){
      scroller.scrollBy(dy);
      armedDown = armedUp = false;   // moved within: this gesture can't hop
      pressure = 0;
      return;
    }

    /* at an edge: only a gesture that started here may hop */
    if (!(dir > 0 ? armedDown : armedUp)) return;
    if (dir !== pressureDir){ pressure = 0; pressureDir = dir; }
    pressure += Math.abs(dy);
    if (pressure >= WHEEL_HOP_PX){
      pressure = 0;
      if (scroller.hopBy(dir)) blocked = true;  // swallow the rest of this gesture
    }
  }, { passive: false });
}

/* ---------- touch ---------- */
function bindTouch(scroller){
  /* { startY, lastY, lastT, v, moved, mode, edgeDown, edgeUp }
     mode: 'scroll' (ours) | 'blocked' (swallowed until lift) */
  let touch = null;

  window.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1 || scroller.count() === 0 || closest(e.target, EXEMPT)){
      touch = null;   // pinch-zoom and the water controls stay native
      return;
    }
    const t = e.touches[0];
    const blocked = scroller.isHopping();
    if (!blocked) scroller.stop();
    touch = {
      startY: t.clientY, lastY: t.clientY, lastT: e.timeStamp,
      v: 0, moved: 0,
      mode: blocked ? 'blocked' : 'scroll',
      edgeDown: scroller.atEdge(1),
      edgeUp: scroller.atEdge(-1)
    };
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!touch) return;
    if (e.touches.length > 1){ touch = null; return; }
    if (e.cancelable) e.preventDefault();

    const y = e.touches[0].clientY;
    const dt = Math.max(1, e.timeStamp - touch.lastT);
    const dy = touch.lastY - y;               // > 0 moves the page down
    touch.v = 0.8 * (dy / dt) + 0.2 * touch.v;
    touch.lastY = y;
    touch.lastT = e.timeStamp;

    if (touch.mode !== 'scroll') return;
    if (scroller.isHopping()){ touch.mode = 'blocked'; return; }
    if (dy === 0) return;

    const dir = dy > 0 ? 1 : -1;
    if (scroller.atEdge(dir)){
      const armed = dir > 0 ? touch.edgeDown : touch.edgeUp;
      const pull = (touch.startY - y) * dir;
      if (armed && pull > TOUCH_HOP_PX && scroller.hopBy(dir)) touch.mode = 'blocked';
      return;
    }

    scroller.dragBy(dy);
    touch.moved += Math.abs(dy);
    if (touch.moved > TOUCH_DISARM_PX) touch.edgeDown = touch.edgeUp = false;
  }, { passive: false });

  window.addEventListener('touchend', (e) => {
    if (!touch || e.touches.length) return;
    const t = touch;
    touch = null;
    if (t.mode !== 'scroll') return;
    if (e.timeStamp - t.lastT > TOUCH_STALE_MS) return;
    if (Math.abs(t.v) > 0.05) scroller.glide(t.v * GLIDE_MS);
  }, { passive: true });

  window.addEventListener('touchcancel', () => { touch = null; }, { passive: true });
}

/* ---------- keyboard ---------- */
function bindKeys(scroller){
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (scroller.count() === 0) return;
    if (closest(e.target, EDITABLE) || closest(e.target, EXEMPT)) return;

    const page = window.innerHeight * PAGE_SHARE;
    let dir = 0, step = 0;

    switch (e.key){
      case 'ArrowDown': dir = 1;  step = ARROW_STEP; break;
      case 'ArrowUp':   dir = -1; step = ARROW_STEP; break;
      case 'PageDown':  dir = 1;  step = page; break;
      case 'PageUp':    dir = -1; step = page; break;
      case ' ':
      case 'Spacebar':
        if (closest(e.target, SPACE_ACTIVATES)) return;  // Space presses buttons
        dir = e.shiftKey ? -1 : 1; step = page;
        break;
      case 'Home':
        e.preventDefault();
        scroller.hopTo(0, 'start');
        return;
      case 'End':
        e.preventDefault();
        scroller.hopTo(scroller.count() - 1, 'end');
        return;
      default:
        return;
    }

    e.preventDefault();
    if (scroller.isHopping()) return;

    if (scroller.atEdge(dir)){
      if (!e.repeat) scroller.hopBy(dir);   // a held key never hops
      return;
    }
    scroller.scrollBy(dir * step);
  });
}

export function bindScrollInputs(scroller){
  bindWheel(scroller);
  bindTouch(scroller);
  bindKeys(scroller);
}
