/* ============================================================
   IN-PAGE LINKS — move the page, never the URL
   Clicks on "#id" links are handled here: the page hops to the
   section holding the target, focus moves there for keyboard and
   screen-reader users, and no #fragment is written to the address
   bar. A URL that arrives with a fragment is honoured once and
   then cleaned. Modified clicks (new tab / window) are left alone.
   ============================================================ */

const NATIVELY_FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

/* Move focus without letting the browser scroll it into view;
   the scroller is already animating there. */
function focusQuietly(el){
  if (!el.matches(NATIVELY_FOCUSABLE)) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

function targetOf(href){
  let id = href.slice(1);
  try { id = decodeURIComponent(id); } catch (_) { /* keep raw */ }
  return id ? document.getElementById(id) : null;
}

export function bindAnchorLinks(scroller){
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const link = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
    if (!link) return;

    e.preventDefault();   // no #hash in the URL
    const target = targetOf(link.getAttribute('href'));
    if (!target) return;

    scroller.goTo(target);
    focusQuietly(target);
  });

  /* Opened with a fragment (old link, bookmark): go there, then drop it */
  if (window.location.hash){
    const target = targetOf(window.location.hash);
    if (target) scroller.goTo(target, { instant: true });
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}
