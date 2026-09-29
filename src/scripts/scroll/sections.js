/* ============================================================
   SECTIONS — the scroll stops, their inner ranges and the
   open water between them
   Every [data-stop] element is one stop. Each stop owns a range
   of window scroll positions [start, end]:

     fits in the viewport   start == end, section centred in the
                            space below the fixed navbar
     taller than it         start = section top just under the
                            navbar, end = section bottom just
                            above the viewport's bottom edge

   The first stop always starts at the very top of the page (the
   surface), and the last one runs to the very bottom so the
   footer is reachable from inside it.

   Gaps: the water between two neighbouring stops is sized here
   (layoutGaps) instead of being a fixed screen height. The ranges
   above say exactly how much page shows above a stop when it is
   entered and below a stop when it is left, so each gap is the
   smallest distance that still keeps the neighbour (plus its glass
   shadow and text glow) off screen. Small, centred sections get
   more water; tall ones only need to clear the navbar. The value
   is written as --stop-gap on the lower stop (see layout.css).
   ============================================================ */

/* CSS px kept between the navbar and a section's top */
const TOP_SPACE = 16;
/* CSS px kept between a section's bottom and the viewport's bottom */
const BOTTOM_SPACE = 24;
/* CSS px a section paints beyond its box: the glass pass's shadow
   and rim light (~22 px) and the larger text shadows. Kept off
   screen along with the section itself. */
const BLEED = 40;

export function clamp(x, lo, hi){
  return Math.min(hi, Math.max(lo, x));
}

export function getStops(){
  return Array.from(document.querySelectorAll('[data-stop]'));
}

export function maxScroll(){
  return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
}

/* Viewport space taken by the fixed navbar, plus breathing room */
function headerSpace(){
  const bar = document.querySelector('header.bar');
  if (!bar) return TOP_SPACE;
  return Math.max(0, bar.getBoundingClientRect().bottom) + TOP_SPACE;
}

/* The framing every stop is measured against */
function viewport(){
  const vh = window.innerHeight;
  const topSpace = headerSpace();
  const avail = Math.max(1, vh - topSpace - BOTTOM_SPACE);
  return { vh, topSpace, avail };
}

/* Half the unused space around a section that fits: how far the
   centring pushes it away from the frame's top and bottom. */
function centringSlack(h, avail){
  return Math.max(0, (avail - h) / 2);
}

/* Hidden probe sized to the large viewport (browser toolbars
   collapsed). The difference to innerHeight is how much more page
   can come into view while a mobile toolbar slides away, before
   the resize that re-measures everything arrives. */
let probe = null;
function largeViewportHeight(){
  if (!probe){
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    const s = probe.style;
    s.position = 'fixed';
    s.top = '0';
    s.left = '0';
    s.width = '0';
    s.visibility = 'hidden';
    s.pointerEvents = 'none';
    s.height = '100vh';
    s.height = '100lvh';   // ignored where unsupported; 100vh stays
    document.body.appendChild(probe);
  }
  return probe.offsetHeight || window.innerHeight;
}

/* Sizes the water between every pair of neighbouring stops.
   For stops A (above) and B (below):
     below A   page visible under A's bottom while A is at its end
     above B   page visible over B's top while B is at its start
   The gap must exceed both, plus BLEED and the toolbar allowance.
   Returns true if any gap changed (the layout moved). */
export function layoutGaps(stops){
  if (stops.length < 2) return false;

  const { vh, topSpace, avail } = viewport();
  const toolbar = Math.max(0, largeViewportHeight() - vh);
  const sy = window.scrollY;

  /* Read everything first, then write, so the loop never forces
     a layout between measurements. */
  const boxes = stops.map(el => el.getBoundingClientRect());
  const margins = stops.map(el => parseFloat(window.getComputedStyle(el).marginTop) || 0);

  const values = [];
  for (let i = 1; i < stops.length; i++){
    const a = boxes[i - 1], b = boxes[i];

    /* The first stop is pinned to scroll 0 when it fits, so the page
       under it runs to the bottom of the first screen. */
    const below = (i === 1)
      ? Math.max(BOTTOM_SPACE, vh - (a.bottom + sy))
      : BOTTOM_SPACE + centringSlack(a.height, avail);
    const above = topSpace + centringSlack(b.height, avail);
    const need = Math.max(below, above) + BLEED + toolbar;

    /* Distance the layout would leave between them with no margin */
    const natural = (b.top - a.bottom) - margins[i];
    values.push(Math.max(0, Math.ceil(need - natural)) + 'px');
  }

  let changed = false;
  for (let i = 1; i < stops.length; i++){
    const v = values[i - 1];
    if (stops[i].style.getPropertyValue('--stop-gap') !== v){
      stops[i].style.setProperty('--stop-gap', v);
      changed = true;
    }
  }
  return changed;
}

/* Returns [{ el, start, end }] in window scroll coordinates */
export function measureRanges(stops){
  const { vh, topSpace, avail } = viewport();
  const max = maxScroll();
  const sy = window.scrollY;
  const last = stops.length - 1;

  return stops.map((el, i) => {
    const box = el.getBoundingClientRect();
    const top = box.top + sy;
    const h = box.height;
    const fits = h <= avail;

    let start = fits ? top - topSpace - (avail - h) / 2 : top - topSpace;
    let end = fits ? start : top + h - vh + BOTTOM_SPACE;

    if (i === 0){ start = 0; if (fits) end = 0; }
    if (i === last) end = max;

    start = clamp(start, 0, max);
    end = clamp(end, start, max);
    return { el, start, end };
  });
}

/* Stop whose range is closest to scroll position y.
   distance is 0 when y lies inside that range. */
export function nearestStop(ranges, y){
  let index = 0, distance = Infinity;
  for (let i = 0; i < ranges.length; i++){
    const r = ranges[i];
    const d = y < r.start ? r.start - y : (y > r.end ? y - r.end : 0);
    if (d < distance){ distance = d; index = i; }
  }
  return { index, distance };
}
