import { describe, it, expect } from 'vitest';
import { generateWeekWorkouts } from './generator';
import { getMutableState } from '@/state/store';
import type { Workout } from '@/types';

/**
 * Integration coverage for the ISSUE-295 ease-back wiring inside generateWeekWorkouts:
 * the generator must honour wk.acwrChoice (keep ramping vs ease back) and skip the
 * final taper (race) week. The ladder maths itself is unit-tested in acwr-ease-back.test.ts;
 * here we prove the gating actually changes the committed workouts.
 */

const QUALITY_TYPES = new Set(['threshold', 'vo2', 'progressive', 'marathon_pace', 'float']);
const countQuality = (ws: Workout[]) => ws.filter(w => QUALITY_TYPES.has(w.t)).length;

/** Seed the upcoming high-ACWR week with stamped ease-back inputs + a choice. */
function seedHighWeek(weekIndex: number, opts: { acwrChoice?: 'keep' | 'ease'; chronic: number; safeUpper: number }) {
  const s = getMutableState() as any;
  s.wks = [];
  for (let i = 0; i < weekIndex; i++) s.wks[i] = {};
  const wk = s.wks[weekIndex - 1];
  wk.scheduledAcwrStatus = 'high';
  wk.scheduledChronicTSS = opts.chronic;
  wk.scheduledSafeUpper = opts.safeUpper;
  if (opts.acwrChoice) wk.acwrChoice = opts.acwrChoice;
  else delete wk.acwrChoice;
  // Keep the generation path deterministic and independent of any prior test's volume signals.
  delete s.detectedWeeklyKm;
  delete s.athleteArchetype;
}

/** Generate a marathon build week with acwrStatus='high'. Low chronic forces a real overshoot. */
function genWeek(weekIndex: number, totalWeeks: number, acwrChoice?: 'keep' | 'ease') {
  seedHighWeek(weekIndex, { acwrChoice, chronic: 150, safeUpper: 1.3 }); // L_max = 195 TSS
  return generateWeekWorkouts(
    'build', 4, 'marathon', 'Balanced', [], undefined, null, undefined,
    'intermediate', undefined, 360, weekIndex, totalWeeks, 50, 0, undefined, 'high',
  );
}

describe('generateWeekWorkouts — ACWR ease-back gating (ISSUE-295)', () => {
  it('keep ramping retains quality sessions; ease back strips them', () => {
    const keep = genWeek(8, 16, 'keep');
    const ease = genWeek(8, 16, undefined); // unset → eased (safe default)

    expect(countQuality(keep)).toBeGreaterThan(0);          // a build week has quality
    expect(countQuality(ease)).toBeLessThan(countQuality(keep)); // ease converts quality → easy
  });

  it('ease back never drops a session (it converts/trims, the long run survives)', () => {
    const keep = genWeek(8, 16, 'keep');
    const ease = genWeek(8, 16, undefined);
    // The ladder strips intensity and trims volume but never removes a session.
    expect(ease.length).toBe(keep.length);
    // The long run is still present in the eased week.
    expect(ease.some(w => w.t === 'long')).toBe(true);
  });

  it('does not ease the final taper (race) week — primer is protected', () => {
    const raceWeekEase = genWeek(16, 16, undefined); // taper would apply, but build phase here
    // Use the taper phase explicitly for the race-week guard:
    seedHighWeek(16, { chronic: 150, safeUpper: 1.3 });
    const raceWeek = generateWeekWorkouts(
      'taper', 4, 'marathon', 'Balanced', [], undefined, null, undefined,
      'intermediate', undefined, 360, 16, 16, 50, 0, undefined, 'high',
    );
    const keepRaceWeek = (() => {
      seedHighWeek(16, { acwrChoice: 'keep', chronic: 150, safeUpper: 1.3 });
      return generateWeekWorkouts(
        'taper', 4, 'marathon', 'Balanced', [], undefined, null, undefined,
        'intermediate', undefined, 360, 16, 16, 50, 0, undefined, 'high',
      );
    })();
    // On the race week, ease-back is exempt → eased output equals keep output (no stripping).
    expect(countQuality(raceWeek)).toBe(countQuality(keepRaceWeek));
    void raceWeekEase;
  });
});
