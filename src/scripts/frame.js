/* ============================================================
   FRAME DRIVER — the page's one requestAnimationFrame loop
   Every per-frame job registers here in one of three phases,
   which always run in this order within a frame:

     scroll   the section scroller writes the window scroll
     camera   the dive controller reads it and moves the camera
     render   the ocean reads panel rects and draws both canvases

   So the glass is always drawn for the scroll position the page
   is painted at. (With separate loops, the ocean's callback
   usually ran before the scroller's, and every panel trailed its
   own text by one frame of motion.)

   Pacing: callbacks run on "paced" frames only, one every
   `divisor` display refreshes, so the scene runs at the refresh
   rate divided down to ~60 fps or more:
     60 / 75 / 90 Hz        every refresh
     120 / 144 / 165 Hz     every second refresh
     240 Hz                 every fourth
   The refresh interval is estimated from recent frame deltas
   (25th percentile, so dropped frames don't skew it) and re-checked
   while the loop runs, e.g. when the window moves to another
   display. A late frame is never followed by a skipped one.

   Callbacks receive (now, dt), dt in seconds (<= 0.05) since the
   previous paced frame, and return true to keep the loop alive.
   The loop stops once every callback returns false; wake()
   restarts it.
   ============================================================ */

const TARGET_FPS = 60;
const MAX_DT = 0.05;
const PHASES = ['scroll', 'camera', 'render'];

/* Refresh-rate estimate */
const SAMPLE_COUNT = 32;     // ring buffer of raw frame deltas
const FIRST_ESTIMATE = 8;    // samples before the first estimate
const RE_ESTIMATE = 64;      // samples between later estimates
const MAX_SAMPLE_MS = 100;   // longer gaps (hidden tab, idle) are not samples
const LATE_FACTOR = 1.5;     // a delta this many refreshes long counts as late

const callbacks = { scroll: [], camera: [], render: [] };

const samples = new Float64Array(SAMPLE_COUNT);
const sorted = new Float64Array(SAMPLE_COUNT);
let sampleCount = 0, sampleHead = 0, sinceEstimate = 0, estimated = false;
let vsyncMs = 1000 / TARGET_FPS;
let divisor = 1;

let rafId = 0;
let lastRaw = 0;     // previous rAF timestamp while the loop ran continuously
let lastPaced = 0;   // previous paced frame
let skip = 0;        // refreshes still to skip before the next paced frame

function estimate(){
  const view = sorted.subarray(0, sampleCount);
  view.set(samples.subarray(0, sampleCount));
  view.sort();
  vsyncMs = view[Math.floor(sampleCount * 0.25)];
  divisor = Math.max(1, Math.floor(1000 / vsyncMs / TARGET_FPS + 0.1));
  estimated = true;
}

function record(raw){
  samples[sampleHead] = raw;
  sampleHead = (sampleHead + 1) % SAMPLE_COUNT;
  if (sampleCount < SAMPLE_COUNT) sampleCount++;
  sinceEstimate++;
  if (sinceEstimate >= (estimated ? RE_ESTIMATE : FIRST_ESTIMATE)){
    sinceEstimate = 0;
    estimate();
  }
}

function loop(now){
  rafId = 0;

  if (lastRaw > 0){
    const raw = now - lastRaw;
    if (raw > 0 && raw < MAX_SAMPLE_MS) record(raw);
    if (raw > vsyncMs * LATE_FACTOR) skip = 0;   // already late: draw now
  }
  lastRaw = now;

  if (skip > 0){
    skip--;
    rafId = requestAnimationFrame(loop);
    return;
  }
  skip = divisor - 1;

  const dt = lastPaced > 0
    ? Math.min(Math.max(now - lastPaced, 0) / 1000, MAX_DT)
    : 1 / TARGET_FPS;
  lastPaced = now;

  let again = false;
  for (let p = 0; p < PHASES.length; p++){
    const list = callbacks[PHASES[p]];
    for (let i = 0; i < list.length; i++){
      try {
        if (list[i](now, dt)) again = true;
      } catch (err){
        console.error(err);
      }
    }
  }

  if (again && !rafId) rafId = requestAnimationFrame(loop);
  if (!rafId){
    /* Going idle: the next wake starts a fresh, unskipped frame */
    lastRaw = 0;
    lastPaced = 0;
    skip = 0;
  }
}

/* Make sure a frame is coming */
export function wake(){
  if (rafId) return;
  rafId = requestAnimationFrame(loop);
}

/* phase: 'scroll' | 'camera' | 'render'. fn(now, dt) -> keep running? */
export function onFrame(phase, fn){
  const list = callbacks[phase];
  if (!list) throw new Error(`Unknown frame phase "${phase}"`);
  list.push(fn);
  wake();
}
