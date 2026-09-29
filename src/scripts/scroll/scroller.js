/* ============================================================
   SECTION SCROLLER — the scroll engine
   Owns the window scroll position while the page is driven by
   wheel / touch / keys (see inputs.js). Two kinds of motion:

     within   eased movement clamped to the active stop's range
              (sections.js); it can never leave the section
     hop      a timed glide to another stop, through the open
              water between sections; input is ignored meanwhile

   The water between stops is sized by sections.js (layoutGaps)
   on every refresh. When a resize changes it, the page is moved
   so the reader stays on the same spot of the same section.

   Anything else that scrolls the window (scrollbar drag, find in
   page, focus moving into view) is detected as an external
   scroll: the engine adopts that position, picks the nearest
   stop, and once things go quiet eases out of any gap between
   sections into the nearest one.
   ============================================================ */
import { getStops, layoutGaps, measureRanges, nearestStop, clamp } from './sections.js';

/* Per-frame easing at 60 fps: wheel / key steps, and touch flick glide */
const EASE_STEP  = 0.16;
const EASE_GLIDE = 0.075;

/* Standard hop duration grows with distance, within these bounds */
const HOP_MS = 1000;

/* The initial plunge from the surface (or returning to it) takes longer */
const DIVE_HOP_MS = 1400;

/* px of disagreement before a scroll counts as not ours */
const SYNC_TOLERANCE = 2;

/* Quiet time after an external scroll before leaving a gap */
const SETTLE_MS = 350;

function easeInOutCubic(t){
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createScroller(){
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  let stops = getStops();
  layoutGaps(stops);
  let ranges = measureRanges(stops);

  let currentY = window.scrollY;   // position on screen
  let targetY = currentY;          // where within-motion is heading
  let written = currentY;          // last value this engine wrote
  let active = nearestStop(ranges, currentY).index;
  let easeK = EASE_STEP;

  /* { index, from, to, edge, t0, dur }; edge 'start' | 'end' | null */
  let hop = null;

  let raf = 0, lastFrame = 0, settleTimer = 0;

  function reduced(){ return motionQuery.matches; }

  function write(y){
    written = y;
    window.scrollTo(0, y);
  }

  /* ---------- animation loop ---------- */
  function tick(now){
    raf = 0;
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 1 / 60;
    lastFrame = now;

    if (hop){
      const t = hop.dur > 0 ? Math.min(1, Math.max(0, now - hop.t0) / hop.dur) : 1;
      currentY = hop.from + (hop.to - hop.from) * easeInOutCubic(t);
      if (t >= 1){
        active = hop.index;
        currentY = targetY = hop.to;
        hop = null;
      }
    } else {
      const k = reduced() ? 1 : 1 - Math.pow(1 - easeK, dt * 60);
      currentY += (targetY - currentY) * k;
      if (Math.abs(targetY - currentY) < 0.5) currentY = targetY;
    }

    write(currentY);

    if (hop || currentY !== targetY) raf = requestAnimationFrame(tick);
    else lastFrame = 0;
  }

  function kick(){
    if (raf) return;
    lastFrame = 0;
    raf = requestAnimationFrame(tick);
  }

  /* ---------- layout ---------- */
  function edgeY(index, edge){
    const r = ranges[index];
    return edge === 'end' ? r.end : r.start;
  }

  /* Re-size the gaps and re-measure every stop. clampNow pulls the
     page back inside the active range if the layout moved it out. */
  function refresh(clampNow = true){
    /* Where the reader is inside the active stop, so a change in the
       water above it doesn't carry them somewhere else. */
    const prev = ranges[active];
    const offset = prev ? currentY - prev.start : 0;

    stops = getStops();
    const moved = layoutGaps(stops);
    ranges = measureRanges(stops);
    if (!ranges.length) return;
    active = Math.min(active, ranges.length - 1);

    if (hop){
      const r = ranges[hop.index];
      hop.to = hop.edge ? edgeY(hop.index, hop.edge) : clamp(hop.to, r.start, r.end);
      targetY = hop.to;
      if (moved){
        /* The glide's start point no longer exists; land now */
        active = hop.index;
        currentY = hop.to;
        hop = null;
        write(currentY);
      }
      return;
    }

    const r = ranges[active];
    if (moved){
      currentY = targetY = clamp(r.start + offset, r.start, r.end);
      write(currentY);
      return;
    }
    if (!clampNow) return;

    const y = clamp(targetY, r.start, r.end);
    if (y !== targetY){
      targetY = y;
      easeK = EASE_STEP;
      kick();
    }
  }

  /* ---------- hops ---------- */
  function startHop(index, y, edge){
    const dist = Math.abs(y - currentY);
    let dur = 0;
    
    if (!reduced()) {
      if (active === 0 || index === 0) {
        // Grand transition to/from the hero component at the surface
        dur = DIVE_HOP_MS;
      } else {
        // Fast, snappy transitions for the rest of the deep water components
        dur = HOP_MS;
        //dur = clamp(300 + dist * 0.15, HOP_MIN_MS, HOP_MAX_MS);
      }
    }

    hop = { index, from: currentY, to: y, edge, t0: performance.now(), dur };
    targetY = y;
    kick();
  }

  /* edge: land at the stop's 'start' (top) or 'end' (bottom) */
  function hopTo(index, edge = 'start'){
    refresh(false);
    if (index < 0 || index >= ranges.length) return false;
    const y = edgeY(index, edge);
    if (!hop && index === active && Math.abs(y - currentY) < 1) return false;
    startHop(index, y, edge);
    return true;
  }

  /* Next stop down (dir 1) lands on its top; next stop up (-1)
     lands on its bottom, so the reader continues where they were. */
  function hopBy(dir){
    if (hop) return false;
    return hopTo(active + dir, dir > 0 ? 'start' : 'end');
  }

  /* Instant jump (initial deep link) */
  function jump(index, edge = 'start'){
    refresh(false);
    if (index < 0 || index >= ranges.length) return;
    hop = null;
    active = index;
    currentY = targetY = edgeY(index, edge);
    write(currentY);
  }

  function stopIndexFor(el){
    stops = getStops();
    const stop = el.closest('[data-stop]') || el.querySelector('[data-stop]');
    return stop ? stops.indexOf(stop) : -1;
  }

  /* Hop to the stop containing (or contained by) an element */
  function goTo(el, { instant = false } = {}){
    const i = stopIndexFor(el);
    if (i < 0) return false;
    if (instant){ jump(i, 'start'); return true; }
    return hopTo(i, 'start');
  }

  /* ---------- within-section motion ---------- */
  function atEdge(dir){
    if (!ranges.length) return true;
    const r = ranges[active];
    return dir > 0 ? targetY >= r.end - 0.5 : targetY <= r.start + 0.5;
  }

  /* Eased step, clamped to the active section */
  function scrollBy(dy, ease = EASE_STEP){
    if (hop || !ranges.length) return;
    const r = ranges[active];
    targetY = clamp(targetY + dy, r.start, r.end);
    easeK = ease;
    kick();
  }

  /* 1:1 finger tracking, clamped to the active section */
  function dragBy(dy){
    if (hop || !ranges.length) return;
    const r = ranges[active];
    targetY = clamp(targetY + dy, r.start, r.end);
    currentY = targetY;
    write(currentY);
  }

  /* Momentum after a flick; still clamped, so it never hops */
  function glide(dist){
    scrollBy(dist, EASE_GLIDE);
  }

  /* A finger landed: catch any glide in place */
  function stop(){
    if (hop) return;
    targetY = currentY;
  }

  /* ---------- external scrolls ---------- */
  function settle(){
    if (hop) return;
    refresh(false);
    if (!ranges.length) return;
    const y = window.scrollY;
    const { index, distance } = nearestStop(ranges, y);
    active = index;
    if (distance <= 1) return;
    const r = ranges[index];
    startHop(index, clamp(y, r.start, r.end), null);
  }

  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (Math.abs(y - written) <= SYNC_TOLERANCE) return;

    /* Someone else moved the page: adopt the position */
    hop = null;
    currentY = targetY = written = y;
    active = nearestStop(ranges, y).index;

    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  }, { passive: true });

  window.addEventListener('resize', () => refresh());
  window.addEventListener('load', () => refresh());

  /* Fonts swapping in or text reflowing changes section heights, and
     with them the gaps. Re-sizing a gap resizes the body too, but the
     second pass finds nothing to change, so this settles at once. */
  if ('ResizeObserver' in window){
    new ResizeObserver(() => refresh()).observe(document.body);
  }

  /* Reloaded part-way down the page: ease into the nearest section */
  settle();

  return {
    count: () => ranges.length,
    isHopping: () => hop !== null,
    atEdge,
    scrollBy,
    dragBy,
    glide,
    stop,
    hopBy,
    hopTo,
    goTo
  };
}
