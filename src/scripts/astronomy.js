/* ============================================================
   ASTRONOMY ENGINE — Hybrid Local/Stylized calculations
   Calculates the true real-world lunar phase based on the date,
   but maps the celestial orbit cleanly to the local 24-hour clock
   so the UI slider behaves predictably.

   Writes into `out` ({ sun: [x,y,z], moon: [x,y,z] }) so the
   per-frame call allocates nothing. Both vectors are normalised;
   the shaders use them as-is.
   ============================================================ */

/* Known new moon: Jan 6, 2000, 18:14 UTC */
const NEW_MOON_MS = 947182440000;
/* Synodic month: 29.5305877 days */
const LUNAR_CYCLE_MS = 2551442777;

/* The Frutiger Aero stylised arc from the original GLSL, normalised
   so it works directly in lighting equations */
function writeVec(a, v) {
  const x = Math.cos(a) * 0.8;
  const y = Math.sin(a);
  const z = -0.7;
  const len = Math.sqrt(x * x + y * y + z * z);
  v[0] = x / len;
  v[1] = y / len;
  v[2] = z / len;
}

export function getAstronomy(date, localDecimalHour, out = { sun: [0, 0, 0], moon: [0, 0, 0] }) {
  // 1. Real-world moon phase
  const msSinceNewMoon = date.getTime() - NEW_MOON_MS;
  let phase = (msSinceNewMoon % LUNAR_CYCLE_MS) / LUNAR_CYCLE_MS;
  if (phase < 0) phase += 1; // Safeguard for dates before 2000

  // Phase mapped to an angular offset (0 = New Moon, PI = Full Moon)
  const moonOffset = phase * Math.PI * 2;

  // 2. Stylized orbit mapped to the 24-hour clock
  // 6.0 = Sunrise, 12.0 = Noon, 18.0 = Sunset
  const sunA = ((localDecimalHour - 6.0) / 24.0) * Math.PI * 2;

  // The moon follows the exact same arc, offset by the current phase of the month
  const moonA = sunA - moonOffset;

  writeVec(sunA, out.sun);
  writeVec(moonA, out.moon);
  return out;
}
