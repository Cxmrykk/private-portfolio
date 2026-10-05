/* ============================================================
   DATES — years shown on the page
   Any element marked [data-year] gets the current year from the
   visitor's clock, so nothing on the page is hard-coded to one.
   ============================================================ */

export function initDates(){
  const year = String(new Date().getFullYear());
  for (const el of document.querySelectorAll('[data-year]')){
    el.textContent = year;
  }
}
