/**
 * State Persistence and Migration Tests
 * ======================================
 *
 * Tests for state loading, validation, and schema migrations.
 *
 * Migration Version 2 (RUNNER_TYPE_SEMANTICS_FIX_VERSION):
 * - Swaps Speed↔Endurance labels to fix semantic inversion
 * - Preserves user intent by converting stored labels to new semantics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SimulatorState, RunnerType } from '@/types';
import { STATE_SCHEMA_VERSION, RUNNER_TYPE_SEMANTICS_FIX_VERSION } from '@/types/state';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

// Replace global localStorage and alert
vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('alert', vi.fn());

// Import after mocking
import { loadState, saveState, clearState, softResetState } from './persistence';
import { getState, setState, resetState, getDefaultState } from './store';

// Helper to create empty weeks array (validation requires wks.length === tw)
function createEmptyWeeks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    w: i + 1,
    ph: 'base' as const,
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
  }));
}

describe('State Persistence', () => {
  beforeEach(() => {
    localStorageMock.clear();
    resetState();
  });

  afterEach(() => {
    localStorageMock.clear();
    resetState();
  });

  describe('Schema Migration', () => {
    describe('Version 1 → 2 (Runner Type Semantics Fix)', () => {
      it('should swap typ Speed → Endurance', () => {
        const v1State: Partial<SimulatorState> = {
          schemaVersion: 1,
          typ: 'Speed' as RunnerType,
          w: 1,
          tw: 16,
          v: 45,
          iv: 45,
          rpeAdj: 0,
          rd: 'half',
          epw: 5,
          rw: 5,
          wkm: 50,
          pbs: { k5: 1200 },
          rec: null,
          lt: null,
          vo2: null,
          initialLT: null,
          initialVO2: null,
          initialBaseline: 6000,
          currentFitness: 6000,
          forecastTime: 5800,
          b: 1.03, // Low b was labeled "Speed" in v1, should become "Endurance"
          wks: createEmptyWeeks(16),
          pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
          skip: [],
          timp: 0,
          expectedFinal: 47,
        };

        localStorageMock.setItem('marathonSimulatorState', JSON.stringify(v1State));

        const loaded = loadState();
        expect(loaded).toBe(true);

        const state = getState();
        expect(state.typ).toBe('Endurance');
        expect(state.schemaVersion).toBe(STATE_SCHEMA_VERSION);
      });

      it('should swap typ Endurance → Speed', () => {
        const v1State: Partial<SimulatorState> = {
          schemaVersion: 1,
          typ: 'Endurance' as RunnerType,
          w: 1,
          tw: 16,
          v: 45,
          iv: 45,
          rpeAdj: 0,
          rd: 'half',
          epw: 5,
          rw: 5,
          wkm: 50,
          pbs: { k5: 1200 },
          rec: null,
          lt: null,
          vo2: null,
          initialLT: null,
          initialVO2: null,
          initialBaseline: 6000,
          currentFitness: 6000,
          forecastTime: 5800,
          b: 1.15, // High b was labeled "Endurance" in v1, should become "Speed"
          wks: createEmptyWeeks(16),
          pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
          skip: [],
          timp: 0,
          expectedFinal: 47,
        };

        localStorageMock.setItem('marathonSimulatorState', JSON.stringify(v1State));

        const loaded = loadState();
        expect(loaded).toBe(true);

        const state = getState();
        expect(state.typ).toBe('Speed');
        expect(state.schemaVersion).toBe(STATE_SCHEMA_VERSION);
      });

      it('should keep typ Balanced unchanged', () => {
        const v1State: Partial<SimulatorState> = {
          schemaVersion: 1,
          typ: 'Balanced' as RunnerType,
          w: 1,
          tw: 16,
          v: 45,
          iv: 45,
          rpeAdj: 0,
          rd: 'half',
          epw: 5,
          rw: 5,
          wkm: 50,
          pbs: { k5: 1200 },
          rec: null,
          lt: null,
          vo2: null,
          initialLT: null,
          initialVO2: null,
          initialBaseline: 6000,
          currentFitness: 6000,
          forecastTime: 5800,
          b: 1.09,
          wks: createEmptyWeeks(16),
          pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
          skip: [],
          timp: 0,
          expectedFinal: 47,
        };

        localStorageMock.setItem('marathonSimulatorState', JSON.stringify(v1State));

        const loaded = loadState();
        expect(loaded).toBe(true);

        const state = getState();
        expect(state.typ).toBe('Balanced');
      });

      it('should swap calculatedRunnerType if present', () => {
        const v1State: Partial<SimulatorState> = {
          schemaVersion: 1,
          typ: 'Speed' as RunnerType,
          calculatedRunnerType: 'Speed' as RunnerType,
          w: 1,
          tw: 16,
          v: 45,
          iv: 45,
          rpeAdj: 0,
          rd: 'half',
          epw: 5,
          rw: 5,
          wkm: 50,
          pbs: { k5: 1200 },
          rec: null,
          lt: null,
          vo2: null,
          initialLT: null,
          initialVO2: null,
          initialBaseline: 6000,
          currentFitness: 6000,
          forecastTime: 5800,
          b: 1.03,
          wks: createEmptyWeeks(16),
          pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
          skip: [],
          timp: 0,
          expectedFinal: 47,
        };

        localStorageMock.setItem('marathonSimulatorState', JSON.stringify(v1State));

        const loaded = loadState();
        expect(loaded).toBe(true);

        const state = getState();
        expect(state.calculatedRunnerType).toBe('Endurance');
      });

      it('should swap onboarding.confirmedRunnerType if present', () => {
        const v1State: Partial<SimulatorState> = {
          schemaVersion: 1,
          typ: 'Endurance' as RunnerType,
          w: 1,
          tw: 16,
          v: 45,
          iv: 45,
          rpeAdj: 0,
          rd: 'half',
          epw: 5,
          rw: 5,
          wkm: 50,
          pbs: { k5: 1200 },
          rec: null,
          lt: null,
          vo2: null,
          initialLT: null,
          initialVO2: null,
          initialBaseline: 6000,
          currentFitness: 6000,
          forecastTime: 5800,
          b: 1.15,
          wks: createEmptyWeeks(16),
          pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
          skip: [],
          timp: 0,
          expectedFinal: 47,
          onboarding: {
            pbs: { k5: 1200 },
            runsPerWeek: 5,
            planDurationWeeks: 16,
            confirmedRunnerType: 'Endurance' as RunnerType,
          } as any,
        };

        localStorageMock.setItem('marathonSimulatorState', JSON.stringify(v1State));

        const loaded = loadState();
        expect(loaded).toBe(true);

        const state = getState();
        expect(state.typ).toBe('Speed');
        expect(state.onboarding?.confirmedRunnerType).toBe('Speed');
      });

      it('should not re-migrate already v2 state', () => {
        const v2State: Partial<SimulatorState> = {
          schemaVersion: 2,
          typ: 'Speed' as RunnerType, // Already correct - high b
          w: 1,
          tw: 16,
          v: 45,
          iv: 45,
          rpeAdj: 0,
          rd: 'half',
          epw: 5,
          rw: 5,
          wkm: 50,
          pbs: { k5: 1200 },
          rec: null,
          lt: null,
          vo2: null,
          initialLT: null,
          initialVO2: null,
          initialBaseline: 6000,
          currentFitness: 6000,
          forecastTime: 5800,
          b: 1.15,
          wks: createEmptyWeeks(16),
          pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
          skip: [],
          timp: 0,
          expectedFinal: 47,
        };

        localStorageMock.setItem('marathonSimulatorState', JSON.stringify(v2State));

        const loaded = loadState();
        expect(loaded).toBe(true);

        const state = getState();
        // Should NOT swap again - Speed stays Speed
        expect(state.typ).toBe('Speed');
      });
    });
  });

  describe('State Validation', () => {
    it('should reject corrupted state with invalid initialBaseline', () => {
      const corruptedState: Partial<SimulatorState> = {
        schemaVersion: 2,
        typ: 'Balanced' as RunnerType,
        w: 1,
        tw: 16,
        v: 45,
        iv: 45,
        rpeAdj: 0,
        rd: 'half',
        epw: 5,
        rw: 5,
        wkm: 50,
        pbs: { k5: 1200 },
        rec: null,
        lt: null,
        vo2: null,
        initialLT: null,
        initialVO2: null,
        initialBaseline: 100, // Less than 300 = corrupted
        currentFitness: 6000,
        forecastTime: 5800,
        b: 1.09,
        wks: createEmptyWeeks(16),
        pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
        skip: [],
        timp: 0,
        expectedFinal: 47,
      };

      localStorageMock.setItem('marathonSimulatorState', JSON.stringify(corruptedState));

      const loaded = loadState();
      expect(loaded).toBe(false);
    });

    it('should reject corrupted state with invalid VDOT', () => {
      const corruptedState: Partial<SimulatorState> = {
        schemaVersion: 2,
        typ: 'Balanced' as RunnerType,
        w: 1,
        tw: 16,
        v: 5, // VDOT < 10 = corrupted
        iv: 45,
        rpeAdj: 0,
        rd: 'half',
        epw: 5,
        rw: 5,
        wkm: 50,
        pbs: { k5: 1200 },
        rec: null,
        lt: null,
        vo2: null,
        initialLT: null,
        initialVO2: null,
        initialBaseline: 6000,
        currentFitness: 6000,
        forecastTime: 5800,
        b: 1.09,
        wks: createEmptyWeeks(16),
        pac: { e: 360, t: 300, i: 270, m: 310, r: 260 },
        skip: [],
        timp: 0,
        expectedFinal: 47,
      };

      localStorageMock.setItem('marathonSimulatorState', JSON.stringify(corruptedState));

      const loaded = loadState();
      expect(loaded).toBe(false);
    });
  });

  // s.v is owned by refreshBlendedFitness (blended-fitness.ts) and by the
  // detraining in advanceWeekToToday (welcome-back.ts). loadState must hand it
  // through untouched. A leftover 2026-04-13 "one-time" repair reset s.v toward
  // s.iv on every load whenever s.v < 0.9 x s.iv. Only the running init writes
  // s.iv, so triathlon / HYROX / cycling users carried the store default
  // iv = 50 and any run VDOT under 45 was inflated on every launch. In taper,
  // deload and run-blocking-injury weeks refreshBlendedFitness skips its s.v
  // write-back, so the inflated value stuck and fed the tri race forecast.
  describe('loadState leaves s.v untouched (refreshBlendedFitness owns it)', () => {
    function seedSaved(overrides: Partial<SimulatorState> & Record<string, unknown>) {
      // saveState serialises the whole store, so a blob written by a real app
      // carries the store default iv = 50 unless an init overwrote it.
      const blob = {
        ...getDefaultState(),
        planStartDate: '2026-06-01',
        initialBaseline: 6000,
        currentFitness: 6000,
        forecastTime: 5800,
        ...overrides,
      };
      localStorageMock.setItem('marathonSimulatorState', JSON.stringify(blob));
    }

    function weeks(count: number, ph: 'base' | 'taper' = 'base', wkGain: number[] = []) {
      return createEmptyWeeks(count).map((wk, i) => ({ ...wk, ph, wkGain: wkGain[i] ?? 0 }));
    }

    it('triathlon user with run VDOT below 45 keeps it (iv is only the store default)', () => {
      const tw = 12;
      const wks = weeks(tw);
      wks[10].ph = 'taper';
      wks[11].ph = 'taper';
      seedSaved({ eventType: 'triathlon', w: 11, tw, v: 40, wks } as any);
      expect(getDefaultState().iv).toBe(50); // the default the repair compared against

      expect(loadState()).toBe(true);
      expect(getState().v).toBe(40);
      expect(JSON.parse(localStorageMock.getItem('marathonSimulatorState')!).v).toBe(40);
    });

    it('HYROX user in week 1 keeps a run VDOT below 45 instead of being reset to 50', () => {
      seedSaved({ eventType: 'hyrox', w: 1, tw: 16, v: 38, wks: weeks(16) } as any);

      expect(loadState()).toBe(true);
      expect(getState().v).toBe(38);
    });

    it('running user more than 10% below onboarding VDOT keeps the live value', () => {
      // A runner whose blended VDOT has genuinely fallen (long layoff, injury
      // decay, onboarding seeded from an old PB). The repair used to rebuild
      // 52 minus its own detraining for weeks with wkGain <= 0, giving 51.4.
      seedSaved({ eventType: 'running', w: 3, tw: 16, iv: 52, v: 46, wks: weeks(16, 'taper', [0, 0.05]) } as any);

      expect(loadState()).toBe(true);
      expect(getState().v).toBe(46);
    });

    it('running user within 10% of onboarding VDOT is unchanged (behaviour lock)', () => {
      seedSaved({ eventType: 'running', w: 3, tw: 16, iv: 52, v: 47, wks: weeks(16) } as any);

      expect(loadState()).toBe(true);
      expect(getState().v).toBe(47);
      expect(getState().iv).toBe(52);
    });
  });

  // wk.actualTSS was an add-only running total that drifted from the activities
  // (audit B18). A week's load is derived by computeWeekActualTSS; loading saved
  // state strips the legacy key so no reader can ever pick it up.
  describe('loadState drops the retired wk.actualTSS running total', () => {
    it('removes a legacy actualTSS from every plan week and archived week, and persists the cleanup', () => {
      const wks = createEmptyWeeks(16).map((wk, i) => (i < 3 ? { ...wk, actualTSS: 240 + i } : wk));
      const blob = {
        ...getDefaultState(),
        planStartDate: '2026-06-01',
        initialBaseline: 6000,
        currentFitness: 6000,
        forecastTime: 5800,
        w: 3,
        tw: 16,
        wks,
        previousPlanWks: [{ planStartDate: '2026-01-05', weeks: [{ w: 1, actualTSS: 313 }], archivedAt: '2026-05-30T00:00:00Z' }],
      };
      localStorageMock.setItem('marathonSimulatorState', JSON.stringify(blob));

      expect(loadState()).toBe(true);
      const live = getState();
      expect(live.wks.some(wk => 'actualTSS' in wk)).toBe(false);
      expect('actualTSS' in live.previousPlanWks![0].weeks[0]).toBe(false);
      const saved = JSON.parse(localStorageMock.getItem('marathonSimulatorState')!);
      expect(saved.wks.some((wk: Record<string, unknown>) => 'actualTSS' in wk)).toBe(false);
    });
  });

  // "Reset plan" (preserve) vs "Wipe everything" (full): the only state-level
  // difference is whether the archived weekly history (previousPlanWks) survives
  // so the rebuilt plan can re-attach this week's activities.
  describe('softResetState — preserve vs wipe archive', () => {
    const archive = [{ planStartDate: '2026-06-01', weeks: [], archivedAt: '2026-06-10T00:00:00Z' }];

    function seedWithArchive() {
      setState({
        ...getState(),
        onboarding: { ...(getState().onboarding as any), name: 'Tristan' },
        previousPlanWks: archive,
      } as any);
    }

    it('preserveArchive carries previousPlanWks into the fresh state', () => {
      seedWithArchive();
      softResetState({ preserveArchive: true });
      const saved = JSON.parse(localStorageMock.getItem('marathonSimulatorState')!);
      expect(saved.previousPlanWks).toEqual(archive);
      expect(saved.hasCompletedOnboarding).toBe(false);
    });

    it('full wipe (no opts) drops previousPlanWks', () => {
      seedWithArchive();
      softResetState();
      const saved = JSON.parse(localStorageMock.getItem('marathonSimulatorState')!);
      expect(saved.previousPlanWks ?? []).toEqual([]);
    });
  });
});
