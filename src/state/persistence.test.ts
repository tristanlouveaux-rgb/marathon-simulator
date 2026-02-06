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
import { loadState, saveState, clearState } from './persistence';
import { getState, setState, resetState } from './store';

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
});
