/**
 * Format a probability percentage for display. Caps at the boundaries so we
 * never render `0%` (reads as impossible) or `100%` (reads as guaranteed) for
 * a Monte Carlo estimate. Accepts either a fraction (0..1) or a percent
 * (0..100).
 */
export function fmtProbPct(value: number, opts?: { isFraction?: boolean }): string {
  if (!Number.isFinite(value)) return '--';
  const pct = opts?.isFraction === false ? value : (value <= 1 ? value * 100 : value);
  if (pct < 5)  return '<5%';
  if (pct > 95) return '>95%';
  return `${Math.round(pct)}%`;
}

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
 * Seconds as "m:ss", or "h:mm:ss" from an hour, rounded to the nearest whole
 * second before the split so the minute carries: 119.6 s reads "2:00", never
 * "1:60". For fractional model times (HYROX doubles and Pro station times,
 * goal back-calculation targets, forecast totals), matching the HYROX
 * forecast surfaces, which round to the nearest second. ft floors instead; a
 * number already shown through ft elsewhere stays on ft.
 */
export function ftRounded(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--';
  return ft(Math.round(seconds));
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
 * The display value of a model pace: the whole second, rounded to nearest.
 * Model paces are s.lt, s.pac (gp(v, lt): the threshold pace IS the LT, and
 * easy, marathon, interval and repetition are fixed multiples of it), every
 * pace derived from them (workout description paces, HYROX run pace, the
 * triathlon run paces) and gp(vdot) paces. They stay unrounded in the model:
 * the PB age weight moves the derived LT a little every day, and rounding a
 * model input turns that drift into overnight jumps (2026-10-12). Display
 * rounds once, here, so the LT headline and the Threshold pace (one number)
 * always read the same whole second, and no formatter is handed a fraction
 * (no "4:60" from formatters that round the seconds, no fractional seconds).
 */
export function displayPaceSec(secPerKm: number): number {
  return Math.round(secPerKm);
}

/**
 * A model pace (displayPaceSec) as "m:ss/km" or "m:ss/mi". The mile pace
 * converts the whole-second km pace and rounds to the whole second with the
 * minute carried, which is what fmtDesc does to the km paces written into
 * workout descriptions, so a pace card and a session description agree in
 * either unit.
 */
export function fpModel(secPerKm: number, pref: UnitPref = 'km'): string {
  if (!secPerKm || isNaN(secPerKm)) return '--';
  const km = displayPaceSec(secPerKm);
  const sec = pref === 'mi' ? Math.round(km * KM_TO_MI_PACE) : km;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}${pref === 'mi' ? '/mi' : '/km'}`;
}

/** Model pace (displayPaceSec) as "m:ss", no unit: for workout descriptions
 *  and other km strings that carry their own "/km" suffix. */
export function fmtModelPaceKm(secPerKm: number): string {
  const sec = displayPaceSec(secPerKm);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
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
    // Round the whole mile pace, then split, so the minute carries (a pace
    // of 7:59.6/mi reads 8:00/mi, never 7:60/mi). Same rule as fpModel.
    const secPerMi = Math.round(secPerKm * KM_TO_MI_PACE);
    const mOut = Math.floor(secPerMi / 60);
    const sOut = secPerMi % 60;
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

/**
 * A duration in prose: whole minutes under an hour ("36 minutes", "1 minute"),
 * h:mm from an hour ("1:05", "2:45"). Rounds to the minute first, so 59.6 min
 * reads "1:00". For sentences such as "Long runs reach about 36 minutes, short
 * of the 2:45 marathon-readiness long run": "0:36" reads as a clock time or a
 * pace, not a duration.
 */
export function fmtDurationMin(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
