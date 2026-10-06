/* ============================================================
   CELESTIAL — Sydney's clock, sun arc and moon phase
   Replaces astronomy.js. Built from validated sky data
   (sky-data.js), or from null for the defaults.

   Clock
     localHour(ms) is the decimal hour in the sky data's time zone
     (Australia/Sydney). The UTC offset comes from Intl and is
     re-checked once a minute, so DST changes are picked up without
     calling Intl every frame.

   Sun
     The stylised arc is kept, but it is anchored to the real
     sunrise and sunset of the Sydney date being shown:
       sunrise → angle 0 (horizon), sunset → PI (horizon),
       the night maps the rest of the circle.
     The phase weights in the shaders key off the sun's height, so
     golden hour and night now land at Sydney's real times.

   Moon
     The phase (0 new .. 0.5 full .. 1) is interpolated between the
     fetched primary phases, a quarter per interval. Outside their
     range it is extrapolated from the nearest one at the mean
     synodic month. The moon rides the sun's arc, offset by the
     phase, as before.

   write(ms, dayTime, out) fills out.sun / out.moon ([x, y, z],
   normalised) in place, so the per-frame call allocates nothing.
   ============================================================ */
import { SKY_DEFAULTS } from './sky-data.js';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const OFFSET_RECHECK_MS = 60000;

/* Mean synodic month: 29.530589 days */
const SYNODIC_MS = 2551442877;
const PHASE_STEP = 0.25;

/* The Frutiger Aero stylised arc, normalised so it works directly
   in lighting equations */
function writeVec(a, v){
  const x = Math.cos(a) * 0.8;
  const y = Math.sin(a);
  const z = -0.7;
  const len = Math.sqrt(x * x + y * y + z * z);
  v[0] = x / len;
  v[1] = y / len;
  v[2] = z / len;
}

function wrap01(x){
  return x - Math.floor(x);
}

function wrapHour(ms){
  return (((ms % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS;
}

/* "YYYY-MM-DD" of a ms value already shifted into local time */
function dateKey(localMs){
  return new Date(localMs).toISOString().slice(0, 10);
}

/* UTC offset (ms) of a time zone at an instant */
function makeOffsetFn(timeZone){
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  });
  return function offsetAt(ms){
    const p = {};
    for (const part of fmt.formatToParts(ms)) p[part.type] = part.value;
    const asUTC = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute), Number(p.second)
    );
    return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000) * 60000;
  };
}

/* Sun angle on the arc for local hour h */
function sunAngle(h, rise, set){
  if (h >= rise && h <= set) return Math.PI * (h - rise) / (set - rise);
  const night = 24 - (set - rise);
  const t = (((h - set) % 24) + 24) % 24;
  return Math.PI + Math.PI * (t / night);
}

export function createCelestial(data){
  const timeZone = data ? data.timeZone : SKY_DEFAULTS.timeZone;
  const days = data ? data.days : [];
  const phases = data ? data.phases : [];
  const offsetAt = makeOffsetFn(timeZone);

  const dayByDate = new Map();
  for (const d of days) dayByDate.set(d.date, d);

  /* ---------- clock ---------- */
  let offset = 0;
  let offsetFrom = Infinity;
  let offsetUntil = -Infinity;

  function offsetNow(ms){
    if (ms < offsetFrom || ms >= offsetUntil){
      offset = offsetAt(ms);
      offsetFrom = ms;
      offsetUntil = ms + OFFSET_RECHECK_MS;
    }
    return offset;
  }

  function localHour(ms){
    return wrapHour(ms + offsetNow(ms));
  }

  /* ---------- sun ---------- */
  let sunKey = '';
  let rise = SKY_DEFAULTS.sunrise;
  let set = SKY_DEFAULTS.sunset;

  /* The day for a date, or the nearest one if the data has gone stale */
  function pickDay(key){
    const exact = dayByDate.get(key);
    if (exact || !days.length) return exact || null;
    const target = Date.parse(key + 'T00:00:00Z');
    let best = null, bestGap = Infinity;
    for (const d of days){
      const gap = Math.abs(Date.parse(d.date + 'T00:00:00Z') - target);
      if (gap < bestGap){ bestGap = gap; best = d; }
    }
    return best;
  }

  function updateSunTimes(ms){
    const key = dateKey(ms + offsetNow(ms));
    if (key === sunKey) return;
    sunKey = key;

    const day = pickDay(key);
    rise = SKY_DEFAULTS.sunrise;
    set = SKY_DEFAULTS.sunset;
    if (!day) return;

    const r = wrapHour(day.rise + offsetAt(day.rise));
    const s = wrapHour(day.set + offsetAt(day.set));
    if (s > r){ rise = r; set = s; }
  }

  /* ---------- moon ---------- */
  let phaseIndex = 0;

  function moonPhase(ms){
    const n = phases.length;
    if (!n) return SKY_DEFAULTS.moonPhase;

    const first = phases[0], last = phases[n - 1];
    if (ms < first.t) return wrap01(first.p - (first.t - ms) / SYNODIC_MS);
    if (ms >= last.t) return wrap01(last.p + (ms - last.t) / SYNODIC_MS);

    let i = phaseIndex;
    if (!(i < n - 1 && phases[i].t <= ms && ms < phases[i + 1].t)){
      i = 0;
      while (i < n - 2 && phases[i + 1].t <= ms) i++;
      phaseIndex = i;
    }
    const a = phases[i], b = phases[i + 1];
    return wrap01(a.p + PHASE_STEP * (ms - a.t) / (b.t - a.t));
  }

  /* ---------- directions ---------- */
  /* ms: the real instant (picks the date's sunrise / sunset and the
     moon phase). dayTime: the local hour shown, which the time
     slider may have moved away from ms. */
  function write(ms, dayTime, out){
    updateSunTimes(ms);
    const sunA = sunAngle(dayTime, rise, set);
    const moonA = sunA - moonPhase(ms) * Math.PI * 2;
    writeVec(sunA, out.sun);
    writeVec(moonA, out.moon);
    return out;
  }

  return { timeZone, localHour, write };
}
