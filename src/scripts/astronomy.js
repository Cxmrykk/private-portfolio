/* ============================================================
   ASTRONOMY ENGINE — Hybrid Local/Stylized calculations
   Calculates the true real-world lunar phase based on the date,
   but maps the celestial orbit cleanly to the local 24-hour clock
   so the UI slider behaves predictably.
   ============================================================ */

export function getAstronomy(date, localDecimalHour) {
  // 1. Calculate the real-world moon phase
  // Known new moon: Jan 6, 2000, 18:14 UTC (Unix timestamp: 947182440000 ms)
  // Synodic month: 29.5305877 days = 2551442777 ms
  const msSinceNewMoon = date.getTime() - 947182440000;
  const lunarCycle = 2551442777; 
  
  let phase = (msSinceNewMoon % lunarCycle) / lunarCycle;
  if (phase < 0) phase += 1; // Safeguard for dates before 2000
  
  // Phase mapped to an angular offset (0 = New Moon, PI = Full Moon)
  const moonOffset = phase * Math.PI * 2;

  // 2. Stylized orbit mapped to the 24-hour clock
  // 6.0 = Sunrise, 12.0 = Noon, 18.0 = Sunset
  const sunA = ((localDecimalHour - 6.0) / 24.0) * Math.PI * 2;
  
  // The moon follows the exact same arc, just offset by the current phase of the month
  const moonA = sunA - moonOffset;

  // 3. Construct the Frutiger Aero stylized 3D vectors
  // This matches the exact visual arc from the original GLSL
  function getVec(a) {
    const x = Math.cos(a) * 0.8;
    const y = Math.sin(a);
    const z = -0.7;
    // Normalize the vector so it works perfectly in lighting equations
    const len = Math.sqrt(x*x + y*y + z*z);
    return [x / len, y / len, z / len];
  }

  return {
    sun: getVec(sunA),
    moon: getVec(moonA)
  };
}
