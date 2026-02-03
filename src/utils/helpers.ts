import type { RaceDistance } from '@/types';

/**
 * Get race distance in meters from distance key
 * @param raceDist - Race distance key
 * @returns Distance in meters
 */
export function getDistanceMeters(raceDist: RaceDistance): number {
  const distances: Record<RaceDistance, number> = {
    '5k': 5000,
    '10k': 10000,
    'half': 21097,
    'marathon': 42195
  };
  return distances[raceDist];
}

/**
 * Get race distance in kilometers from distance key
 * @param raceDist - Race distance key
 * @returns Distance in kilometers
 */
export function getDistanceKm(raceDist: RaceDistance): number {
  const distances: Record<RaceDistance, number> = {
    '5k': 5,
    '10k': 10,
    'half': 21.1,
    'marathon': 42.2
  };
  return distances[raceDist];
}

/**
 * Capitalize first letter of string
 * @param str - Input string
 * @returns Capitalized string
 */
export function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Day names array (Monday = 0)
 */
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Short day names array
 */
export const DAY_NAMES_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Get day name from day index
 * @param dayIndex - Day index (0 = Monday)
 * @returns Day name
 */
export function getDayName(dayIndex: number): string {
  return DAY_NAMES[dayIndex] || 'Unknown';
}

/**
 * Clamp a number between min and max
 * @param value - Value to clamp
 * @param min - Minimum value
 * @param max - Maximum value
 * @returns Clamped value
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Generate a unique ID
 * @returns Unique ID number
 */
export function generateId(): number {
  return Date.now() + Math.random();
}
