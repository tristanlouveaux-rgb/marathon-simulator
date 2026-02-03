/**
 * VDOT Calculations
 * Based on Daniels' Running Formula equations
 */

/**
 * Calculate VDOT from distance and time
 * @param meters - Distance in meters
 * @param seconds - Time in seconds
 * @returns VDOT value
 */
export function cv(meters: number, seconds: number): number {
  const tm = seconds / 60;
  const v = meters / tm;  // velocity in m/min
  const vo2 = -4.6 + 0.182258 * v + 0.000104 * v * v;
  const p = 0.8 + 0.1894393 * Math.exp(-0.012778 * tm) + 0.2989558 * Math.exp(-0.1932605 * tm);
  return Math.max(vo2 / p, 15);
}

/**
 * Calculate race time from VDOT and distance
 * Uses bisection method for reliable convergence at all VDOT levels (including 70+)
 * @param km - Distance in kilometers
 * @param vdot - VDOT value
 * @returns Time in seconds
 */
export function vt(km: number, vdot: number): number {
  const meters = km * 1000;
  let tLow = km * 2.5 * 60;   // 2:30/km pace (fast bound)
  let tHigh = km * 15 * 60;   // 15:00/km pace (slow bound)

  const tolerance = 0.05;
  const maxIterations = 50;

  for (let i = 0; i < maxIterations; i++) {
    const tMid = (tLow + tHigh) / 2;
    const vdotMid = cv(meters, tMid);

    if (Math.abs(vdot - vdotMid) < tolerance) return tMid;

    if (vdotMid < vdot) {
      tHigh = tMid;  // Need faster time
    } else {
      tLow = tMid;   // Need slower time
    }
  }

  return (tLow + tHigh) / 2;
}

/**
 * Alias: VDOT to time (expects km)
 * @param vdot - VDOT value
 * @param km - Distance in kilometers
 * @returns Time in seconds
 */
export function tv(vdot: number, km: number): number {
  return vt(km, vdot);
}

/**
 * Get race distance in meters from distance key
 * @param raceDist - Race distance key
 * @returns Distance in meters
 */
export function rd(raceDist: string): number {
  const distances: Record<string, number> = {
    '5k': 5000,
    '10k': 10000,
    'half': 21097,
    'marathon': 42195
  };
  return distances[raceDist] || 42195;
}

/**
 * Get race distance in kilometers from distance key
 * @param raceDist - Race distance key
 * @returns Distance in kilometers
 */
export function rdKm(raceDist: string): number {
  const distances: Record<string, number> = {
    '5k': 5,
    '10k': 10,
    'half': 21.097,
    'marathon': 42.195
  };
  return distances[raceDist] || 42.195;
}
