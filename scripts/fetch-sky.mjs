/* ============================================================
   FETCH SKY — writes sky.json for Sydney from the USNO API
   Run by .github/workflows/deploy.yml every hour (and on push);
   the file is deployed next to index.html in the Pages artifact,
   never committed.

     node scripts/fetch-sky.mjs <output path>

   Data (U.S. Naval Observatory, Astronomical Applications API;
   public domain, no key):
     days        sunrise / sunset for Sydney, from DAYS_BEFORE days
                 back to DAYS_AFTER days ahead (Sydney dates), as
                 UTC instants. /api/rstt/oneday, asked for in
                 Sydney's own UTC offset for each date, so the local
                 date is the one requested and DST is applied.
     moonPhases  the primary phases (new, first quarter, full, last
                 quarter) around today, as UTC instants.
                 /api/moon/phases/date. The client interpolates
                 between them, so the phase is right to the minute
                 between hourly runs.

   Failure handling: each part that cannot be fetched (after
   retries) is taken from the currently deployed sky.json
   (PREVIOUS_SKY_URL) instead. If neither works, that part is
   written empty and the page falls back to its defaults. The
   file is always written, so a USNO outage never blocks a deploy.

   Format (version 1):
   {
     "version": 1,
     "generated": ISO,
     "source": "...",
     "location": { name, lat, lon, timeZone },
     "days": [ { "date": "YYYY-MM-DD", "sunrise": ISO, "sunset": ISO } ],
     "moonPhases": [ { "phase": 0 | 0.25 | 0.5 | 0.75, "time": ISO } ]
   }
   ============================================================ */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const LOCATION = Object.freeze({
  name: 'Sydney, Australia',
  lat: -33.8688,
  lon: 151.2093,
  timeZone: 'Australia/Sydney'
});

const API = 'https://aa.usno.navy.mil/api';
/* Optional user ID the USNO asks API scripts to send (<= 8 alphanumerics) */
const API_ID = 'merrcam';

const DAYS_BEFORE = 1;
const DAYS_AFTER = 6;

/* Four lunations of primary phases: ~40 days back, ~78 days ahead */
const MOON_LOOKBACK_DAYS = 40;
const MOON_PHASE_COUNT = 16;

const REQUEST_TIMEOUT_MS = 20000;
const RETRIES = 3;
const PAUSE_MS = 250;   // between requests, to be polite

const DAY_MS = 86400000;
const PHASE_STEP = 0.25;
/* A quarter lunation lasts ~6.6 to ~8.1 days */
const MIN_QUARTER_MS = 5 * DAY_MS;
const MAX_QUARTER_MS = 10 * DAY_MS;

const PHASE_VALUES = Object.freeze({
  'New Moon': 0,
  'First Quarter': 0.25,
  'Full Moon': 0.5,
  'Last Quarter': 0.75
});

const outPath = resolve(process.argv[2] || 'sky.json');
const previousUrl = process.env.PREVIOUS_SKY_URL || '';

/* ---------- helpers ---------- */
function warn(msg){
  /* Shows as an annotation on the workflow run */
  console.log(`::warning::${msg}`);
}

function sleep(ms){
  return new Promise((r) => setTimeout(r, ms));
}

function pad(n){
  return String(n).padStart(2, '0');
}

function ymd(c){
  return `${c.y}-${pad(c.m)}-${pad(c.d)}`;
}

function iso(ms){
  return new Date(ms).toISOString();
}

function wrap01(x){
  return x - Math.floor(x);
}

/* "HH:MM" (anything after the minutes is ignored) */
function parseClock(s){
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

async function getJson(url){
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++){
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const json = await res.json();
      if (json && json.error) throw new Error(`API error for ${url}: ${JSON.stringify(json.error)}`);
      return json;
    } catch (err){
      lastErr = err;
      if (attempt < RETRIES) await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

/* ---------- Sydney calendar ---------- */
const zoneFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: LOCATION.timeZone,
  hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric'
});

function zoneParts(ms){
  const p = {};
  for (const part of zoneFormat.formatToParts(ms)) p[part.type] = part.value;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    h: Number(p.hour) % 24, min: Number(p.minute), s: Number(p.second)
  };
}

/* Sydney's UTC offset at an instant, in minutes */
function offsetMinutes(ms){
  const p = zoneParts(ms);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
}

function addDays(c, k){
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + k));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/* ---------- sun ---------- */
async function fetchDay(c){
  /* Sydney's offset at 12:00 local (02:00 UTC) on that date. DST
     changes at 02:00 / 03:00 local, well before sunrise. */
  const offMin = offsetMinutes(Date.UTC(c.y, c.m - 1, c.d, 2));
  const tz = offMin / 60;

  const query = new URLSearchParams({
    date: ymd(c),
    coords: `${LOCATION.lat},${LOCATION.lon}`,
    tz: String(tz),
    ID: API_ID
  });
  const json = await getJson(`${API}/rstt/oneday?${query}`);
  const data = json && json.properties && json.properties.data;
  if (!data || !Array.isArray(data.sundata)) throw new Error(`No sun data for ${ymd(c)}`);
  if (data.tz !== undefined && Number(data.tz) !== tz){
    throw new Error(`Unexpected time zone ${data.tz} for ${ymd(c)} (asked for ${tz})`);
  }

  const at = (phen) => {
    const entry = data.sundata.find((e) => e && e.phen === phen);
    const t = entry && parseClock(entry.time);
    if (!t) throw new Error(`No ${phen} time for ${ymd(c)}`);
    return Date.UTC(c.y, c.m - 1, c.d, t.h, t.min) - offMin * 60000;
  };

  const rise = at('Rise');
  const set = at('Set');
  if (!(set > rise && set - rise < DAY_MS)) throw new Error(`Implausible sun times for ${ymd(c)}`);

  return { date: ymd(c), sunrise: iso(rise), sunset: iso(set) };
}

async function fetchDays(today){
  const days = [];
  for (let k = -DAYS_BEFORE; k <= DAYS_AFTER; k++){
    const c = addDays(today, k);
    try {
      days.push(await fetchDay(c));
    } catch (err){
      warn(`Sun data for ${ymd(c)}: ${err.message}`);
    }
    await sleep(PAUSE_MS);
  }
  return days;
}

/* ---------- moon ---------- */
function checkPhases(phases){
  if (phases.length < 2) throw new Error('Too few moon phases');
  for (let i = 1; i < phases.length; i++){
    const a = phases[i - 1], b = phases[i];
    const step = wrap01(b.phase - a.phase);
    const gap = b.ms - a.ms;
    if (Math.abs(step - PHASE_STEP) > 1e-6 || gap < MIN_QUARTER_MS || gap > MAX_QUARTER_MS){
      throw new Error(`Moon phases out of sequence at ${iso(b.ms)}`);
    }
  }
}

async function fetchMoon(today){
  const start = addDays(today, -MOON_LOOKBACK_DAYS);
  const query = new URLSearchParams({
    date: ymd(start),
    nump: String(MOON_PHASE_COUNT),
    ID: API_ID
  });
  const json = await getJson(`${API}/moon/phases/date?${query}`);
  if (!json || !Array.isArray(json.phasedata)) throw new Error('No moon phase data');

  const phases = json.phasedata.map((e) => {
    const phase = PHASE_VALUES[e && e.phase];
    const t = e && parseClock(e.time);
    if (phase === undefined || !t) throw new Error(`Unrecognised phase entry ${JSON.stringify(e)}`);
    return { phase, ms: Date.UTC(Number(e.year), Number(e.month) - 1, Number(e.day), t.h, t.min) };
  }).sort((a, b) => a.ms - b.ms);

  checkPhases(phases);
  return phases.map((x) => ({ phase: x.phase, time: iso(x.ms) }));
}

/* ---------- fallback: the deployed file ---------- */
async function fetchPrevious(){
  if (!previousUrl) return null;
  try {
    const json = await getJson(previousUrl);
    return json && json.version === 1 ? json : null;
  } catch (err){
    warn(`Previous sky.json unavailable: ${err.message}`);
    return null;
  }
}

/* ---------- main ---------- */
async function main(){
  const now = Date.now();
  const p = zoneParts(now);
  const today = { y: p.y, m: p.m, d: p.d };

  let days = await fetchDays(today);

  let moonPhases = null;
  try {
    moonPhases = await fetchMoon(today);
  } catch (err){
    warn(`Moon phases: ${err.message}`);
  }

  if (!days.length || !moonPhases){
    const prev = await fetchPrevious();
    if (!days.length){
      days = prev && Array.isArray(prev.days) ? prev.days : [];
      warn(days.length ? 'Sun data reused from the deployed sky.json' : 'No sun data; the page will use its defaults');
    }
    if (!moonPhases){
      moonPhases = prev && Array.isArray(prev.moonPhases) ? prev.moonPhases : [];
      warn(moonPhases.length ? 'Moon phases reused from the deployed sky.json' : 'No moon phases; the page will use its defaults');
    }
  }

  const sky = {
    version: 1,
    generated: iso(now),
    source: 'U.S. Naval Observatory, Astronomical Applications API',
    location: LOCATION,
    days,
    moonPhases
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(sky, null, 2) + '\n');
  console.log(`Wrote ${outPath}: ${days.length} days, ${moonPhases.length} moon phases`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
