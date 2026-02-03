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
 * Format pace as min:sec/km
 * @param secPerKm - Pace in seconds per km
 * @returns Formatted pace string
 */
export function fp(secPerKm: number): string {
  if (!secPerKm || isNaN(secPerKm)) return '--';
  return `${Math.floor(secPerKm / 60)}:${String(Math.floor(secPerKm % 60)).padStart(2, '0')}/km`;
}

/**
 * Format pace as min:sec/km (alias with more descriptive name)
 * @param secPerKm - Pace in seconds per km
 * @returns Formatted pace string
 */
export function formatPace(secPerKm: number): string {
  if (!secPerKm || isNaN(secPerKm)) return '--';
  const minutes = Math.floor(secPerKm / 60);
  const seconds = Math.floor(secPerKm % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}/km`;
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

/**
 * Format percentage
 * @param value - Decimal value (e.g., 0.15 for 15%)
 * @param decimals - Number of decimal places
 * @returns Formatted percentage string
 */
export function formatPercent(value: number, decimals: number = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}
