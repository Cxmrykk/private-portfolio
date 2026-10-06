/* ============================================================
   SKY DATA — loads and validates sky.json
   sky.json is written every hour by the deploy workflow
   (scripts/fetch-sky.mjs) and published next to index.html.
   It holds Sydney's sunrise / sunset for a few days and the
   moon's primary phases around today, all as UTC instants.

   The fetch is bounded by FETCH_TIMEOUT_MS and revalidates with
   the server (Pages caches for ~10 minutes otherwise). Anything
   missing or malformed resolves to null, or drops just that part;
   celestial.js then falls back to SKY_DEFAULTS.

   Local dev: `npm run sky` writes src/public/sky.json, which the
   Vite dev server serves at the same path.
   ============================================================ */

const SKY_URL = './sky.json';
const FETCH_TIMEOUT_MS = 4000;

const DAY_MS = 86400000;
const PHASE_STEP = 0.25;
/* A quarter lunation lasts ~6.6 to ~8.1 days */
const MIN_QUARTER_MS = 5 * DAY_MS;
const MAX_QUARTER_MS = 10 * DAY_MS;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Used for anything sky.json does not provide */
export const SKY_DEFAULTS = Object.freeze({
  timeZone: 'Australia/Sydney',
  sunrise: 6,       // local decimal hours
  sunset: 18,
  moonPhase: 0.5    // 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter
});

function isTimeZone(tz){
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_){
    return false;
  }
}

function instant(s){
  return typeof s === 'string' ? Date.parse(s) : NaN;
}

function wrap01(x){
  return x - Math.floor(x);
}

function validDays(list){
  const days = [];
  if (!Array.isArray(list)) return days;
  for (const d of list){
    if (!d || typeof d.date !== 'string' || !DATE_RE.test(d.date)) continue;
    const rise = instant(d.sunrise);
    const set = instant(d.sunset);
    if (!Number.isFinite(rise) || !Number.isFinite(set)) continue;
    if (!(set > rise && set - rise < DAY_MS)) continue;
    days.push({ date: d.date, rise, set });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}

/* All-or-nothing: interpolation needs an unbroken sequence */
function validPhases(list){
  if (!Array.isArray(list)) return [];
  const phases = [];
  for (const e of list){
    const p = e ? Number(e.phase) : NaN;
    const t = e ? instant(e.time) : NaN;
    if (!Number.isFinite(t) || !(p === 0 || p === 0.25 || p === 0.5 || p === 0.75)) return [];
    phases.push({ p, t });
  }
  phases.sort((a, b) => a.t - b.t);
  if (phases.length < 2) return [];
  for (let i = 1; i < phases.length; i++){
    const step = wrap01(phases[i].p - phases[i - 1].p);
    const gap = phases[i].t - phases[i - 1].t;
    if (Math.abs(step - PHASE_STEP) > 1e-6 || gap < MIN_QUARTER_MS || gap > MAX_QUARTER_MS) return [];
  }
  return phases;
}

/* Returns { timeZone, days: [{ date, rise, set }], phases: [{ p, t }] }
   (instants in ms), or null if nothing usable is left. */
export function validateSky(raw){
  if (!raw || raw.version !== 1) return null;

  const tz = raw.location && raw.location.timeZone;
  if (typeof tz !== 'string' || !isTimeZone(tz)) return null;

  const days = validDays(raw.days);
  const phases = validPhases(raw.moonPhases);
  if (!days.length && !phases.length) return null;

  return { timeZone: tz, days, phases };
}

/* Resolves to validated sky data, or null on any failure */
export async function loadSky(){
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : 0;
  try {
    const res = await fetch(SKY_URL, {
      cache: 'no-cache',
      signal: ctrl ? ctrl.signal : undefined
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = validateSky(await res.json());
    if (!data) throw new Error('sky.json holds no usable data');
    return data;
  } catch (err){
    console.warn('Sky data unavailable; using the default sky.', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
