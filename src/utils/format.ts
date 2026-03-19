/**
 * Format seconds as time string (h:mm:ss or mm:ss)
 * @param seconds - Time in seconds
 * @returns Formatted time string
 */
export function ft(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Format pace as min:sec/km (or /mi when pref = 'mi').
 * Input is always sec/km; conversion to sec/mi is done internally.
 */
export function fp(secPerKm: number, pref: UnitPref = 'km'): string {
  if (!secPerKm || isNaN(secPerKm)) return '--';
  const sec = pref === 'mi' ? secPerKm * KM_TO_MI_PACE : secPerKm;
  const unit = pref === 'mi' ? '/mi' : '/km';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}${unit}`;
}

/**
 * Format pace as min:sec/km (or /mi when pref = 'mi').
 * Input is always sec/km; conversion to sec/mi is done internally.
 */
export function formatPace(secPerKm: number, pref: UnitPref = 'km'): string {
  if (!secPerKm || isNaN(secPerKm)) return '--';
  const sec = pref === 'mi' ? secPerKm * KM_TO_MI_PACE : secPerKm;
  const unit = pref === 'mi' ? '/mi' : '/km';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}${unit}`;
}

/**
 * Format workout time as h:mm:ss or mm:ss
 * @param seconds - Time in seconds
 * @returns Formatted time string
 */
export function formatWorkoutTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '--';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Format distance with appropriate units
 * @param meters - Distance in meters
 * @returns Formatted distance string
 */
export function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)}km`;
  }
  return `${meters}m`;
}

const KM_TO_MI = 0.621371;
const KM_TO_MI_PACE = 1.60934; // multiply sec/km by this to get sec/mi

export type UnitPref = 'km' | 'mi';

/**
 * Format a distance given in kilometres using the user's unit preference.
 * @param km - Distance in kilometres
 * @param pref - Unit preference ('km' or 'mi', default 'km')
 * @param decimals - Decimal places (default 1)
 */
export function formatKm(km: number, pref: UnitPref = 'km', decimals = 1): string {
  if (pref === 'mi') {
    return `${(km * KM_TO_MI).toFixed(decimals)} mi`;
  }
  return `${km.toFixed(decimals)} km`;
}

/**
 * Format percentage
 * @param value - Decimal value (e.g., 0.15 for 15%)
 * @param decimals - Number of decimal places
 * @returns Formatted percentage string
 */
export function formatPercent(value: number, decimals: number = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Convert km distances and /km pace strings in workout description strings for display.
 * "1km warm up (4:49/km+) ~1.2km" → "0.6 mi warm up (7:45/mi+) ~0.7 mi" when pref='mi'.
 * Apply AFTER injectPaces so injected pace tokens are also converted.
 * No-op when pref='km'.
 */
export function fmtDesc(desc: string, pref: UnitPref): string {
  if (pref !== 'mi') return desc;
  // Convert pace strings first: "4:49/km" → "7:45/mi" (before km→mi so "km" in "/km" isn't caught)
  let result = desc.replace(/(\d+):(\d+)\/km/g, (_, m, s) => {
    const secPerKm = parseInt(m) * 60 + parseInt(s);
    const secPerMi = secPerKm * KM_TO_MI_PACE;
    const mOut = Math.floor(secPerMi / 60);
    const sOut = Math.round(secPerMi % 60);
    return `${mOut}:${String(sOut).padStart(2, '0')}/mi`;
  });
  // Convert distance values: "4.8km" → "3.0 mi"
  result = result.replace(/(\d+(?:\.\d+)?)\s*km/gi, (_, n) => {
    const mi = parseFloat(n) * KM_TO_MI;
    return `${mi % 1 === 0 ? mi.toFixed(0) : mi.toFixed(1)} mi`;
  });
  return result;
}

/** Format an ISO date string (YYYY-MM-DD) as DD/MM (UK format). */
export function fmtDateUK(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  return `${parts[2]}/${parts[1]}`;
}
