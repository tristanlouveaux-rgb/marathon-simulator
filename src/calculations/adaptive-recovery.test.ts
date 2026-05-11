import { describe, it, expect } from 'vitest';
import {
  defaultAdaptiveRecovery,
  confidenceFromN,
  getEffectiveKUser,
  recoveryShiftForCeiling,
  getEffectiveSafeUpper,
  computeBaselineStats,
  composeRecoveryZ,
  findObservedRecoveryHours,
  logSessionImpact,
  closeOutObservedRecovery,
  fitKUser,
  backfillHistoricalImpacts,
  K_USER_DEFAULT,
  K_USER_MIN,
  K_USER_MAX,
  CONF_MEDIUM_FLOOR,
  CONF_HIGH_FLOOR,
  CEILING_SHIFT_MAX,
} from './adaptive-recovery';
import type {
  AdaptiveRecovery,
  PhysiologyDayEntry,
  SessionImpactEntry,
  SimulatorState,
} from '@/types/state';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function isoOffset(daysFromToday: number, today = new Date('2026-05-01T12:00:00')): string {
  const d = new Date(today);
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().split('T')[0];
}

/** Build a `physiologyHistory` array centred on a session date with controlled
 * pre-baseline (28 days, mean=60ms HRV / 50bpm RHR) and post-session
 * trajectory (`postZ` controls how depressed the composite z is each day). */
function buildPhysiology(
  sessionDate: string,
  postTrajectory: { hrv: number; rhr: number }[],   // entries for T+1 .. T+4
): PhysiologyDayEntry[] {
  const history: PhysiologyDayEntry[] = [];
  // Baseline 28 days: hrv ~60ms with sd ~5, rhr ~50bpm with sd ~3
  for (let i = 28; i >= 1; i--) {
    history.push({
      date: addDays(sessionDate, -i),
      hrvRmssd: 60 + (i % 5 - 2),     // 58..62 cycling for sd
      restingHR: 50 + (i % 3 - 1),    // 49..51 cycling
    });
  }
  // Session day itself — irrelevant to baseline (baseline excludes T)
  history.push({ date: sessionDate, hrvRmssd: 55, restingHR: 52 });
  // Post-session trajectory (T+1..T+4)
  for (let i = 0; i < postTrajectory.length; i++) {
    history.push({
      date: addDays(sessionDate, i + 1),
      hrvRmssd: postTrajectory[i].hrv,
      restingHR: postTrajectory[i].rhr,
    });
  }
  return history;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// ─── Confidence + effective values ──────────────────────────────────────────

describe('confidenceFromN', () => {
  it('classifies the four bands at the documented floors', () => {
    expect(confidenceFromN(0)).toBe('none');
    expect(confidenceFromN(7)).toBe('none');
    expect(confidenceFromN(8)).toBe('low');
    expect(confidenceFromN(15)).toBe('low');
    expect(confidenceFromN(16)).toBe('medium');
    expect(confidenceFromN(29)).toBe('medium');
    expect(confidenceFromN(30)).toBe('high');
    expect(confidenceFromN(100)).toBe('high');
  });
});

describe('getEffectiveKUser', () => {
  it('returns population default when adaptiveRecovery is undefined', () => {
    expect(getEffectiveKUser(undefined)).toBe(K_USER_DEFAULT);
  });
  it('returns population default at none/low even if kUserHours is learned', () => {
    const ar: AdaptiveRecovery = { kUserHours: 6, confidence: 'low', sessionsObserved: 10, emaHalfLifeWeeks: 4 };
    expect(getEffectiveKUser(ar)).toBe(K_USER_DEFAULT);
  });
  it('returns learned kUserHours at medium and high', () => {
    expect(getEffectiveKUser({ kUserHours: 6.5, confidence: 'medium', sessionsObserved: 16, emaHalfLifeWeeks: 4 })).toBe(6.5);
    expect(getEffectiveKUser({ kUserHours: 9.2, confidence: 'high', sessionsObserved: 32, emaHalfLifeWeeks: 4 })).toBe(9.2);
  });
});

describe('recoveryShiftForCeiling', () => {
  it('is zero below confidence = high', () => {
    expect(recoveryShiftForCeiling(undefined)).toBe(0);
    expect(recoveryShiftForCeiling({ kUserHours: 6, confidence: 'medium', sessionsObserved: 16, emaHalfLifeWeeks: 4 })).toBe(0);
  });
  it('lifts ceiling for fast recoverers, cuts it for slow ones', () => {
    expect(recoveryShiftForCeiling({ kUserHours: 6, confidence: 'high', sessionsObserved: 30, emaHalfLifeWeeks: 4 })).toBeCloseTo(0.05, 5);
    expect(recoveryShiftForCeiling({ kUserHours: 10, confidence: 'high', sessionsObserved: 30, emaHalfLifeWeeks: 4 })).toBeCloseTo(-0.05, 5);
  });
  it('clamps the slow-recoverer side at -CEILING_SHIFT_MAX', () => {
    // At K_USER_MAX=13: raw shift = (8-13)*0.025 = -0.125, clamped to -0.10.
    expect(recoveryShiftForCeiling({ kUserHours: K_USER_MAX, confidence: 'high', sessionsObserved: 30, emaHalfLifeWeeks: 4 })).toBe(-CEILING_SHIFT_MAX);
  });
  it('does not clamp the fast-recoverer side under current bounds (asymmetric by design)', () => {
    // At K_USER_MIN=5: raw shift = (8-5)*0.025 = 0.075, well within the +0.10 cap.
    // The asymmetry matches the population intuition: fast recoverers gain less
    // headroom than slow recoverers lose, since the slow side carries injury risk.
    expect(recoveryShiftForCeiling({ kUserHours: K_USER_MIN, confidence: 'high', sessionsObserved: 30, emaHalfLifeWeeks: 4 })).toBeCloseTo(0.075, 5);
  });
  it('getEffectiveSafeUpper composes with the base tier value', () => {
    const ar: AdaptiveRecovery = { kUserHours: 6, confidence: 'high', sessionsObserved: 30, emaHalfLifeWeeks: 4 };
    expect(getEffectiveSafeUpper(1.40, ar)).toBeCloseTo(1.45, 5);
  });
});

// ─── Baseline + composite z ─────────────────────────────────────────────────

describe('computeBaselineStats', () => {
  it('returns null fields when history is empty', () => {
    const b = computeBaselineStats([], '2026-05-01');
    expect(b.hrvMean).toBeNull();
    expect(b.rhrMean).toBeNull();
  });
  it('uses the 28 days strictly before the session, not after', () => {
    const sessionDate = '2026-05-01';
    const history = buildPhysiology(sessionDate, [
      { hrv: 90, rhr: 40 }, { hrv: 90, rhr: 40 }, { hrv: 90, rhr: 40 }, { hrv: 90, rhr: 40 },
    ]);
    const b = computeBaselineStats(history, sessionDate);
    // Mean should be ~60 (pre) not skewed by the 90s post-session
    expect(b.hrvMean).toBeGreaterThan(58);
    expect(b.hrvMean).toBeLessThan(62);
  });
});

describe('composeRecoveryZ', () => {
  const baseline = { hrvMean: 60, hrvSd: 5, rhrMean: 50, rhrSd: 3 };
  it('returns positive z when both signals are above baseline', () => {
    const result = composeRecoveryZ({ date: 'x', hrvRmssd: 65, restingHR: 47 }, baseline);
    expect(result).not.toBeNull();
    expect(result!.z).toBeGreaterThan(0);
    expect(result!.signals).toEqual(['hrv', 'rhr']);
  });
  it('returns negative z when HRV is suppressed and RHR elevated', () => {
    const result = composeRecoveryZ({ date: 'x', hrvRmssd: 50, restingHR: 56 }, baseline);
    expect(result!.z).toBeLessThan(-1);
  });
  it('handles single-signal days', () => {
    const r = composeRecoveryZ({ date: 'x', hrvRmssd: 60 }, baseline);
    expect(r!.signals).toEqual(['hrv']);
  });
  it('returns null when no signal is available', () => {
    expect(composeRecoveryZ({ date: 'x' }, baseline)).toBeNull();
    expect(composeRecoveryZ(undefined, baseline)).toBeNull();
  });
});

// ─── Observed recovery hours ────────────────────────────────────────────────

describe('findObservedRecoveryHours', () => {
  it('reports 24h when day-after physiology already at baseline', () => {
    const history = buildPhysiology('2026-04-20', [
      { hrv: 60, rhr: 50 },  // T+1 — at baseline
      { hrv: 60, rhr: 50 },
      { hrv: 60, rhr: 50 },
      { hrv: 60, rhr: 50 },
    ]);
    const result = findObservedRecoveryHours(history, '2026-04-20');
    expect(result).not.toBeNull();
    expect(result!.hours).toBe(24);
    expect(result!.censored).toBe(false);
  });
  it('reports 72h when recovery shows up on T+3', () => {
    const history = buildPhysiology('2026-04-20', [
      { hrv: 50, rhr: 56 },   // T+1 — depressed
      { hrv: 53, rhr: 54 },   // T+2 — still depressed
      { hrv: 60, rhr: 50 },   // T+3 — back to baseline
      { hrv: 60, rhr: 50 },
    ]);
    const result = findObservedRecoveryHours(history, '2026-04-20');
    expect(result!.hours).toBe(72);
    expect(result!.censored).toBe(false);
  });
  it('right-censors at 96h when recovery never shows up in the window', () => {
    const history = buildPhysiology('2026-04-20', [
      { hrv: 48, rhr: 58 }, { hrv: 48, rhr: 58 }, { hrv: 48, rhr: 58 }, { hrv: 48, rhr: 58 },
    ]);
    const result = findObservedRecoveryHours(history, '2026-04-20');
    expect(result!.hours).toBe(96);
    expect(result!.censored).toBe(true);
  });
  it('returns null when there is no usable baseline', () => {
    const result = findObservedRecoveryHours([{ date: '2026-04-19' }, { date: '2026-04-21' }], '2026-04-20');
    expect(result).toBeNull();
  });
});

// ─── Session impact log management ──────────────────────────────────────────

function makeEntry(overrides: Partial<SessionImpactEntry> & { date: string; garminId: string }): SessionImpactEntry {
  return {
    tss: 100,
    ctlAtTime: 60,
    recoveryMultAtTime: 1.0,
    recoveryAdjAtTime: 1.0,
    predictedHours: 100 / 60 * 8,  // = 13.33h
    signalsUsed: [],
    source: 'live',
    fitWeight: 1.0,
    ...overrides,
  };
}

describe('logSessionImpact', () => {
  it('appends and de-dupes by garminId', () => {
    const s: Pick<SimulatorState, 'sessionImpactLog'> = {};
    logSessionImpact(s, makeEntry({ garminId: 'A', date: isoOffset(-2) }));
    logSessionImpact(s, makeEntry({ garminId: 'B', date: isoOffset(-1) }));
    logSessionImpact(s, makeEntry({ garminId: 'A', date: isoOffset(-2), tss: 999 }));
    expect(s.sessionImpactLog).toHaveLength(2);
    expect(s.sessionImpactLog!.find(e => e.garminId === 'A')!.tss).toBe(999);
  });
  it('prunes entries older than 90 days', () => {
    const s: Pick<SimulatorState, 'sessionImpactLog'> = {};
    logSessionImpact(s, makeEntry({ garminId: 'old', date: isoOffset(-100) }));
    logSessionImpact(s, makeEntry({ garminId: 'new', date: isoOffset(-1) }));
    expect(s.sessionImpactLog!.map(e => e.garminId)).toEqual(['new']);
  });
});

describe('closeOutObservedRecovery', () => {
  it('only closes entries past the 96h observation cap', () => {
    const sessionDate = isoOffset(-2);  // only 2 days ago — too soon
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'physiologyHistory'> = {
      physiologyHistory: buildPhysiology(sessionDate, [
        { hrv: 60, rhr: 50 }, { hrv: 60, rhr: 50 }, { hrv: 60, rhr: 50 }, { hrv: 60, rhr: 50 },
      ]),
    };
    logSessionImpact(s, makeEntry({ garminId: 'A', date: sessionDate }));
    expect(closeOutObservedRecovery(s, isoOffset(0))).toBe(0);
    expect(s.sessionImpactLog![0].observedHours).toBeUndefined();
  });
  it('closes a session past the cap with the right observed hours', () => {
    const sessionDate = isoOffset(-5);
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'physiologyHistory'> = {
      physiologyHistory: buildPhysiology(sessionDate, [
        { hrv: 50, rhr: 56 }, { hrv: 60, rhr: 50 }, { hrv: 60, rhr: 50 }, { hrv: 60, rhr: 50 },
      ]),
    };
    logSessionImpact(s, makeEntry({ garminId: 'A', date: sessionDate }));
    const closed = closeOutObservedRecovery(s, isoOffset(0));
    expect(closed).toBe(1);
    expect(s.sessionImpactLog![0].observedHours).toBe(48);   // depressed on T+1, recovered T+2
    expect(s.sessionImpactLog![0].rightCensored).toBe(false);
  });
});

// ─── Fitter ─────────────────────────────────────────────────────────────────

describe('fitKUser', () => {
  it('with no data, returns the population default (held by the prior)', () => {
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'> = {};
    const ar = fitKUser(s);
    expect(ar.kUserHours).toBe(K_USER_DEFAULT);
    expect(ar.confidence).toBe('none');
  });

  it('fast recoverer (observed = 0.7 × predicted) settles below 8 with N=20 sessions', () => {
    const today = new Date('2026-05-01T12:00:00');
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'> = {};
    for (let i = 1; i <= 20; i++) {
      logSessionImpact(s, makeEntry({
        garminId: `S${i}`,
        date: isoOffset(-i, today),
        predictedHours: 10,
        observedHours: 7,
      }));
    }
    const ar = fitKUser(s, { now: today });
    expect(ar.confidence).toBe('medium');
    expect(ar.kUserHours).toBeGreaterThan(K_USER_MIN);
    expect(ar.kUserHours).toBeLessThan(7.5);  // pulled down toward 8 × 0.7 = 5.6
    expect(ar.sessionsObserved).toBe(20);
  });

  it('slow recoverer (observed = 1.4 × predicted) settles above 8 with N=20', () => {
    const today = new Date('2026-05-01T12:00:00');
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'> = {};
    for (let i = 1; i <= 20; i++) {
      logSessionImpact(s, makeEntry({
        garminId: `S${i}`,
        date: isoOffset(-i, today),
        predictedHours: 10,
        observedHours: 14,
      }));
    }
    const ar = fitKUser(s, { now: today });
    expect(ar.confidence).toBe('medium');
    expect(ar.kUserHours).toBeGreaterThan(8.5);
  });

  it('clamps the result to [K_USER_MIN, K_USER_MAX]', () => {
    const today = new Date('2026-05-01T12:00:00');
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'> = {};
    for (let i = 1; i <= 50; i++) {
      logSessionImpact(s, makeEntry({
        garminId: `S${i}`,
        date: isoOffset(-i, today),
        predictedHours: 10,
        observedHours: 0.5,  // ratio 0.05 — would push k far below 1
      }));
    }
    const ar = fitKUser(s, { now: today });
    expect(ar.kUserHours).toBe(K_USER_MIN);
  });

  it('historical evidence is weighted at 0.7 — pure historical pulls less than pure live', () => {
    const today = new Date('2026-05-01T12:00:00');
    const sLive: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'> = {};
    const sHist: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'> = {};
    for (let i = 1; i <= 20; i++) {
      const args = { date: isoOffset(-i, today), predictedHours: 10, observedHours: 6 };
      logSessionImpact(sLive, makeEntry({ ...args, garminId: `L${i}`, source: 'live', fitWeight: 1.0 }));
      logSessionImpact(sHist, makeEntry({ ...args, garminId: `H${i}`, source: 'historical-backfill', fitWeight: 0.7 }));
    }
    const live = fitKUser(sLive, { now: today });
    const hist = fitKUser(sHist, { now: today });
    // Both pull k below 8, but historical pulls less hard (closer to 8).
    expect(live.kUserHours).toBeLessThan(hist.kUserHours);
  });

  it('confidence reaches high at 30 closed sessions', () => {
    const today = new Date('2026-05-01T12:00:00');
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'> = {};
    for (let i = 1; i <= 30; i++) {
      logSessionImpact(s, makeEntry({
        garminId: `S${i}`,
        date: isoOffset(-i, today),
        predictedHours: 10,
        observedHours: 8,
      }));
    }
    const ar = fitKUser(s, { now: today });
    expect(ar.confidence).toBe('high');
    expect(ar.sessionsObserved).toBeGreaterThanOrEqual(CONF_HIGH_FLOOR);
  });

  it('records a history entry with date / k / n on update', () => {
    const today = new Date('2026-05-01T12:00:00');
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'> = {};
    for (let i = 1; i <= 16; i++) {
      logSessionImpact(s, makeEntry({
        garminId: `S${i}`,
        date: isoOffset(-i, today),
        predictedHours: 10,
        observedHours: 9,
      }));
    }
    const ar = fitKUser(s, { now: today });
    expect(ar.history).toBeDefined();
    expect(ar.history![ar.history!.length - 1].n).toBe(16);
    expect(ar.history![ar.history!.length - 1].date).toBe('2026-05-01');
  });
});

// ─── Defaults ───────────────────────────────────────────────────────────────

describe('defaultAdaptiveRecovery', () => {
  it('returns sane defaults', () => {
    const ar = defaultAdaptiveRecovery();
    expect(ar.kUserHours).toBe(K_USER_DEFAULT);
    expect(ar.confidence).toBe('none');
    expect(ar.sessionsObserved).toBe(0);
    expect(ar.emaHalfLifeWeeks).toBe(4);
  });
});

// ─── Historical backfill ────────────────────────────────────────────────────

describe('backfillHistoricalImpacts', () => {
  it('skips sessions with no usable post-session physiology', () => {
    const sessionDate = '2026-04-01';
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'physiologyHistory' | 'adaptiveRecovery'> = {
      physiologyHistory: [],  // no data at all
    };
    const result = backfillHistoricalImpacts(s, [{
      garminId: 'X', date: sessionDate, tss: 100, ctlAtTime: 60,
      recoveryMultAtTime: 1.0, recoveryAdjAtTime: 1.0,
    }]);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(s.sessionImpactLog ?? []).toHaveLength(0);
  });

  it('adds a closed-out historical entry with the right weight and predicted', () => {
    const sessionDate = '2026-04-01';
    const s: Pick<SimulatorState, 'sessionImpactLog' | 'physiologyHistory' | 'adaptiveRecovery'> = {
      physiologyHistory: buildPhysiology(sessionDate, [
        { hrv: 60, rhr: 50 }, { hrv: 60, rhr: 50 }, { hrv: 60, rhr: 50 }, { hrv: 60, rhr: 50 },
      ]),
    };
    const result = backfillHistoricalImpacts(s, [{
      garminId: 'X', date: sessionDate, tss: 100, ctlAtTime: 50,
      recoveryMultAtTime: 1.0, recoveryAdjAtTime: 1.0,
    }]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
    const entry = s.sessionImpactLog![0];
    expect(entry.source).toBe('historical-backfill');
    expect(entry.fitWeight).toBeCloseTo(0.7, 5);
    expect(entry.observedHours).toBe(24);
    expect(entry.predictedHours).toBeCloseTo(8 * 100 / 50 * 1 * 1, 5);  // 16h
  });
});
