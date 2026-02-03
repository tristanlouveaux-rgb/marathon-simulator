/**
 * Injury-Specific Prescriptions - The "Medical" Brain
 *
 * This module defines injury-specific protocols that determine which activities
 * are safe, banned, or recommended for each injury type.
 */

import type { InjuryProtocol, InjuryType } from '@/types/injury';
import type { SportKey } from '@/types';

/**
 * Master injury protocol dictionary
 *
 * Each injury type has:
 * - bannedActivities: Activities that must be avoided (could worsen injury)
 * - allowedActivities: Activities that are safe to perform
 * - priorityActivities: Recommended activities for recovery
 * - bannedWorkoutTypes: Run workout types to avoid
 */
export const INJURY_PROTOCOLS: Record<InjuryType, InjuryProtocol> = {
  achilles: {
    injuryType: 'achilles',
    displayName: 'Achilles Tendinopathy',
    bannedActivities: ['walking', 'hiking', 'stair_climbing', 'jump_rope', 'basketball', 'soccer', 'rugby', 'tennis'],
    allowedActivities: ['swimming', 'cycling', 'rowing', 'elliptical', 'yoga', 'pilates', 'strength'],
    priorityActivities: ['cycling', 'swimming', 'rowing'],
    bannedWorkoutTypes: ['hill_repeats', 'intervals', 'vo2', 'race_pace'],
    recoveryNotes: 'Avoid eccentric loading on the Achilles. No uphill walking or explosive movements. Cycling is ideal for maintaining fitness.',
    typicalRecoveryWeeks: { min: 6, max: 12 },
  },

  runners_knee: {
    injuryType: 'runners_knee',
    displayName: "Runner's Knee (Patellofemoral Pain)",
    bannedActivities: ['stair_climbing', 'hiking', 'skiing', 'climbing', 'jump_rope', 'crossfit'],
    allowedActivities: ['swimming', 'cycling', 'elliptical', 'rowing', 'yoga', 'pilates', 'strength'],
    priorityActivities: ['elliptical', 'cycling', 'swimming'],
    bannedWorkoutTypes: ['hill_repeats', 'long'],  // Avoid downhill and extended knee flexion
    recoveryNotes: 'Avoid downhill running and deep knee flexion. Flat cycling and elliptical preserve fitness with minimal knee stress. Keep bike seat high.',
    typicalRecoveryWeeks: { min: 4, max: 8 },
  },

  stress_fracture: {
    injuryType: 'stress_fracture',
    displayName: 'Stress Fracture',
    bannedActivities: [
      'extra_run', 'hiking', 'stair_climbing', 'jump_rope', 'basketball', 'soccer',
      'rugby', 'tennis', 'martial_arts', 'boxing', 'crossfit', 'dancing', 'skating',
      'elliptical', 'skiing', 'climbing', 'walking'
    ],
    allowedActivities: ['swimming', 'cycling', 'rowing', 'yoga', 'pilates', 'strength'],
    priorityActivities: ['swimming', 'cycling'],  // Pool running if available
    bannedWorkoutTypes: ['easy', 'long', 'threshold', 'vo2', 'race_pace', 'intervals', 'mixed', 'progressive', 'hill_repeats', 'marathon_pace'],
    recoveryNotes: 'ZERO impact activities. Pool running (aqua jogging) and swimming are the only safe cardio options. Complete rest from all weight-bearing exercise.',
    typicalRecoveryWeeks: { min: 6, max: 16 },
  },

  shin_splints: {
    injuryType: 'shin_splints',
    displayName: 'Shin Splints (MTSS)',
    bannedActivities: ['jump_rope', 'basketball', 'soccer', 'rugby', 'stair_climbing', 'hiking'],
    allowedActivities: ['swimming', 'cycling', 'elliptical', 'rowing', 'yoga', 'pilates', 'strength'],
    priorityActivities: ['cycling', 'elliptical', 'swimming'],
    bannedWorkoutTypes: ['intervals', 'vo2', 'hill_repeats'],
    recoveryNotes: 'Reduce running volume by 50%. Avoid hard surfaces and hills. Gradually return with focus on soft surfaces.',
    typicalRecoveryWeeks: { min: 2, max: 6 },
  },

  plantar_fasciitis: {
    injuryType: 'plantar_fasciitis',
    displayName: 'Plantar Fasciitis',
    bannedActivities: ['walking', 'hiking', 'stair_climbing', 'jump_rope', 'dancing', 'basketball'],
    allowedActivities: ['swimming', 'cycling', 'rowing', 'elliptical', 'yoga', 'pilates', 'strength'],
    priorityActivities: ['cycling', 'swimming', 'rowing'],
    bannedWorkoutTypes: ['long', 'hill_repeats'],
    recoveryNotes: 'Limit time on feet. Morning stretching crucial. Cycling maintains fitness without plantar stress.',
    typicalRecoveryWeeks: { min: 6, max: 18 },
  },

  it_band: {
    injuryType: 'it_band',
    displayName: 'IT Band Syndrome',
    bannedActivities: ['hiking', 'stair_climbing', 'skiing', 'cycling'],  // Note: cycling can aggravate IT band
    allowedActivities: ['swimming', 'elliptical', 'rowing', 'yoga', 'pilates', 'strength'],
    priorityActivities: ['swimming', 'elliptical', 'rowing'],
    bannedWorkoutTypes: ['long', 'hill_repeats'],  // Avoid downhill
    recoveryNotes: 'Avoid repetitive knee flexion at 30 degrees (cycling can aggravate). Swimming and elliptical are safest.',
    typicalRecoveryWeeks: { min: 4, max: 8 },
  },

  hamstring: {
    injuryType: 'hamstring',
    displayName: 'Hamstring Strain',
    bannedActivities: ['soccer', 'rugby', 'basketball', 'martial_arts', 'crossfit', 'jump_rope'],
    allowedActivities: ['swimming', 'cycling', 'elliptical', 'rowing', 'yoga', 'pilates', 'walking'],
    priorityActivities: ['cycling', 'swimming', 'elliptical'],
    bannedWorkoutTypes: ['intervals', 'vo2', 'race_pace', 'hill_repeats'],
    recoveryNotes: 'Avoid explosive movements and high-speed running. Gradual return with easy pace only.',
    typicalRecoveryWeeks: { min: 2, max: 8 },
  },

  hip_flexor: {
    injuryType: 'hip_flexor',
    displayName: 'Hip Flexor Strain',
    bannedActivities: ['cycling', 'stair_climbing', 'hiking', 'martial_arts', 'soccer'],
    allowedActivities: ['swimming', 'elliptical', 'rowing', 'yoga', 'pilates', 'walking'],
    priorityActivities: ['swimming', 'elliptical'],
    bannedWorkoutTypes: ['hill_repeats', 'intervals'],
    recoveryNotes: 'Avoid hip flexion under load. No cycling (hip flexor engagement). Swimming with pull buoy is ideal.',
    typicalRecoveryWeeks: { min: 2, max: 6 },
  },

  general: {
    injuryType: 'general',
    displayName: 'General Injury/Pain',
    bannedActivities: [],
    allowedActivities: ['swimming', 'cycling', 'elliptical', 'rowing', 'yoga', 'pilates', 'strength', 'walking'],
    priorityActivities: ['swimming', 'cycling', 'yoga'],
    bannedWorkoutTypes: [],
    recoveryNotes: 'Reduce training load. Listen to body. Cross-train to maintain fitness while recovering.',
    typicalRecoveryWeeks: { min: 1, max: 4 },
  },
};

/**
 * Get the protocol for a specific injury type
 */
export function getInjuryProtocol(injuryType: InjuryType): InjuryProtocol {
  return INJURY_PROTOCOLS[injuryType] || INJURY_PROTOCOLS.general;
}

/**
 * Check if an activity is allowed for an injury type
 */
export function isActivityAllowed(injuryType: InjuryType, activity: SportKey): boolean {
  const protocol = getInjuryProtocol(injuryType);

  // If activity is explicitly banned, not allowed
  if (protocol.bannedActivities.includes(activity)) {
    return false;
  }

  // If activity is in allowed list, it's allowed
  if (protocol.allowedActivities.includes(activity)) {
    return true;
  }

  // For stress fracture, anything not explicitly allowed is banned
  if (injuryType === 'stress_fracture') {
    return false;
  }

  // Default: allow if not explicitly banned
  return true;
}

/**
 * Check if a workout type is allowed for an injury type
 */
export function isWorkoutTypeAllowed(injuryType: InjuryType, workoutType: string): boolean {
  const protocol = getInjuryProtocol(injuryType);
  return !protocol.bannedWorkoutTypes.includes(workoutType);
}

/**
 * Get priority replacement activities for an injury
 */
export function getPriorityActivities(injuryType: InjuryType): SportKey[] {
  const protocol = getInjuryProtocol(injuryType);
  return protocol.priorityActivities;
}

/**
 * Get a recommended replacement activity for a banned workout
 */
export function getReplacementActivity(injuryType: InjuryType): SportKey | null {
  const priorities = getPriorityActivities(injuryType);
  return priorities.length > 0 ? priorities[0] : null;
}

/**
 * Constants for injury-related thresholds
 */
export const INJURY_THRESHOLDS = {
  ACUTE_SPIKE_DELTA: 2,           // Pain increase triggering emergency shutdown
  ACUTE_SPIKE_HOURS: 24,          // Time window for acute spike detection
  CHRONIC_PLATEAU_DAYS: 5,        // Days of stable pain to trigger rehab block
  CHRONIC_PLATEAU_VARIANCE: 1,    // Max variance to consider "stable"
  EMERGENCY_SHUTDOWN_HOURS: 48,   // Rest period after acute spike
  TEST_RUN_MAX_PAIN: 2,           // Max pain to pass a test run
  PAIN_IMPROVING_THRESHOLD: -1,   // Pain delta to consider "improving"
  PAIN_WORSENING_THRESHOLD: 1,    // Pain delta to consider "worsening"
};

/**
 * Test run protocol constants
 */
export const TEST_RUN_PROTOCOL = {
  intervals: [
    { type: 'run' as const, durationMinutes: 3 },
    { type: 'walk' as const, durationMinutes: 2 },
    { type: 'run' as const, durationMinutes: 3 },
    { type: 'walk' as const, durationMinutes: 2 },
    { type: 'run' as const, durationMinutes: 3 },
  ],
  totalDurationMinutes: 13,
  description: 'Diagnostic Run: 3x (3min Run / 2min Walk)',
  completionCriteria: {
    maxPainAllowed: INJURY_THRESHOLDS.TEST_RUN_MAX_PAIN,
    requiresNoSwelling: true,
    requiresNormalGait: true,
  },
};
