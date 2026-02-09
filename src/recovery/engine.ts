/**
 * recovery/engine.ts
 * ==================
 * Recovery scoring engine. Computes recovery status from sleep, readiness, and HRV data.
 * Drives the UI pill + adjustment modal — NOT a new load engine.
 */

export interface RecoveryEntry {
  date: string;              // YYYY-MM-DD
  sleepScore: number;        // 0-100
  readiness?: number;        // 0-100 (Garmin)
  hrvStatus?: 'balanced' | 'low' | 'unbalanced' | 'strained';
  source: 'garmin' | 'manual';
}

export type RecoveryLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface RecoveryStatus {
  level: RecoveryLevel;
  shouldPrompt: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const SLEEP_GREEN = 70;
const SLEEP_RED = 30;
const SLEEP_TREND_THRESHOLD = 50; // Days with sleep < 50 count as "low"

const READINESS_GREEN = 60;
const READINESS_ORANGE = 40;
const READINESS_RED = 30;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Compute recovery status from today's entry and recent history.
 *
 * @param today  Today's recovery entry (null if no data)
 * @param history Rolling history (last 7 days, newest first)
 */
export function computeRecoveryStatus(
  today: RecoveryEntry | null,
  history: RecoveryEntry[]
): RecoveryStatus {
  // No data → green, no prompt
  if (!today) {
    return { level: 'green', shouldPrompt: false, reasons: [] };
  }

  const reasons: string[] = [];
  let level: RecoveryLevel = 'green';

  // --- Sleep score ---
  if (today.sleepScore < SLEEP_RED) {
    level = escalate(level, 'red');
    reasons.push(`Very poor sleep (${today.sleepScore}/100)`);
  } else if (today.sleepScore < SLEEP_GREEN) {
    level = escalate(level, 'yellow');
    reasons.push(`Poor sleep (${today.sleepScore}/100)`);
  }

  // --- Readiness (Garmin) ---
  if (today.readiness != null) {
    if (today.readiness < READINESS_RED) {
      level = escalate(level, 'red');
      reasons.push(`Very low readiness (${today.readiness}/100)`);
    } else if (today.readiness < READINESS_ORANGE) {
      level = escalate(level, 'orange');
      reasons.push(`Low readiness (${today.readiness}/100)`);
    } else if (today.readiness < READINESS_GREEN) {
      level = escalate(level, 'yellow');
      reasons.push(`Below-average readiness (${today.readiness}/100)`);
    }
  }

  // --- HRV status (Garmin) ---
  if (today.hrvStatus) {
    if (today.hrvStatus === 'strained') {
      level = escalate(level, 'red');
      reasons.push('HRV strained');
    } else if (today.hrvStatus === 'low' || today.hrvStatus === 'unbalanced') {
      level = escalate(level, 'orange');
      reasons.push(`HRV ${today.hrvStatus}`);
    }
  }

  // --- Trend escalation: yellow → orange if 2 of last 3 days were low ---
  if (level === 'yellow') {
    const recentDays = history.slice(0, 3); // includes today potentially
    const lowDayCount = recentDays.filter(d => d.sleepScore < SLEEP_TREND_THRESHOLD).length;
    // Also count today
    const todayIsLow = today.sleepScore < SLEEP_TREND_THRESHOLD ? 1 : 0;
    // Avoid double-counting if today is already in history
    const todayInHistory = recentDays.some(d => d.date === today.date);
    const totalLow = todayInHistory ? lowDayCount : lowDayCount + todayIsLow;

    if (totalLow >= 2) {
      level = 'orange';
      reasons.push('2 of last 3 days low');
    }
  }

  const shouldPrompt = level !== 'green';

  return { level, shouldPrompt, reasons };
}

/**
 * Map manual sleep quality to a numeric score.
 */
export function sleepQualityToScore(quality: 'great' | 'good' | 'poor' | 'terrible'): number {
  const map = { great: 90, good: 70, poor: 45, terrible: 25 };
  return map[quality];
}

/**
 * Stub for future Garmin integration.
 */
export function createGarminRecoveryEntry(
  date: string,
  sleepScore: number,
  readiness?: number,
  hrvStatus?: RecoveryEntry['hrvStatus']
): RecoveryEntry {
  return { date, sleepScore, readiness, hrvStatus, source: 'garmin' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<RecoveryLevel, number> = {
  green: 0,
  yellow: 1,
  orange: 2,
  red: 3,
};

function escalate(current: RecoveryLevel, candidate: RecoveryLevel): RecoveryLevel {
  return LEVEL_ORDER[candidate] > LEVEL_ORDER[current] ? candidate : current;
}
