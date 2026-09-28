/* ============================================================
   SECTIONS — the scroll stops and their inner ranges
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
   ============================================================ */

/* CSS px kept between the navbar and a section's top */
const TOP_SPACE = 16;
/* CSS px kept between a section's bottom and the viewport's bottom */
const BOTTOM_SPACE = 24;

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

/* Returns [{ el, start, end }] in window scroll coordinates */
export function measureRanges(stops){
  const vh = window.innerHeight;
  const topSpace = headerSpace();
  const avail = Math.max(1, vh - topSpace - BOTTOM_SPACE);
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
