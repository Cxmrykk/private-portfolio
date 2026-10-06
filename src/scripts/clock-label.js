/* ============================================================
   CLOCK LABEL — the Settings pill shows the time of day
   Writes "6:13 PM, Sydney NSW" into every [data-clock] element
   (the label inside the Settings toggle).

   Two sources, one display:

     ocean   ocean.js calls setClockHour() with the time of day it
             is rendering (state.dayTime, 0..24). That is Sydney's
             clock normally, and wherever the visitor has put the
             Time of Day slider otherwise, so the label always
             matches the sun and moon on screen. It is cosmetic:
             the label simply follows the sky.

     timer   until ocean.js reports in (or if it never does, e.g.
             WebGL is unavailable) the label shows Sydney's real
             time, refreshed on the minute. A timer aimed at the
             next minute boundary rather than a polling interval,
             so the page is otherwise idle. Coming back to a hidden
             tab refreshes at once, since timers are throttled
             there. Once the ocean has taken over, the timer stops
             painting.

   Accessibility: the toggle's visible text is a time, so its
   aria-label keeps the word "Settings" and appends the time.
   ============================================================ */

const TIME_ZONE = 'Australia/Sydney';
const PLACE = 'Sydney NSW';
const BUTTON_NAME = 'Settings';

const MINUTE_MS = 60000;
const DAY_MINUTES = 1440;
/* Aim a few ms past the boundary so the new minute is definitely in */
const BOUNDARY_SLACK_MS = 50;

/* en-US gives "6:13 PM" (en-AU would give a lowercase "pm") */
const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
});

let targets = [];
let text = '';
let timer = 0;
let external = false;   // ocean.js is driving the label

function paint(next){
  if (next === text) return;
  text = next;

  for (const el of targets){
    el.textContent = text;
    /* The control is the button around the label */
    const control = el.closest('button, [role="button"]');
    if (control) control.setAttribute('aria-label', `${BUTTON_NAME}, ${text}`);
  }
}

/* "6:13 PM, Sydney NSW" for a decimal hour (0..24) */
function formatHour(hour){
  const minutes = ((Math.floor(hour * 60) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h24 = Math.floor(minutes / 60);
  const mm = String(minutes % 60).padStart(2, '0');
  const h12 = h24 % 12 || 12;
  const period = h24 >= 12 ? 'PM' : 'AM';
  return `${h12}:${mm} ${period}, ${PLACE}`;
}

/* The time of day being shown, as a decimal hour (0..24).
   Cheap to call every frame: nothing is written unless the minute changed. */
export function setClockHour(hour){
  if (!targets.length || !Number.isFinite(hour)) return;
  external = true;
  clearTimeout(timer);
  paint(formatHour(hour));
}

function realTime(){
  return `${timeFormat.format(Date.now())}, ${PLACE}`;
}

export function initClockLabel(){
  targets = Array.from(document.querySelectorAll('[data-clock]'));
  if (!targets.length) return;

  function schedule(){
    clearTimeout(timer);
    const wait = MINUTE_MS - (Date.now() % MINUTE_MS) + BOUNDARY_SLACK_MS;
    timer = setTimeout(tick, wait);
  }

  function tick(){
    if (external) return;   // the ocean is driving; stay out of the way
    paint(realTime());
    schedule();
  }

  /* Timers are throttled in background tabs: refresh on return */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });

  tick();
}
