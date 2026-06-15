import { describe, it, expect } from 'vitest';
import { resolveMtlAdherence } from './mtl';
import { resolveTriDisciplineAdherence } from './fitness-model.triathlon';

/**
 * Mirror of the running CTL-gap re-anchor (SCIENCE_LOG §BR) for HYROX (single MTL scalar) and
 * triathlon (per-discipline). Both reuse the pure ctlAdherenceRatio and follow the same reduce-only,
 * excused-week, converge-on-completion contract.
 */

// ── HYROX ───────────────────────────────────────────────────────────────────
function hyroxWeek(w: number, sessions: Array<{ mtl: number; done: boolean }>, extra: any = {}) {
  return {
    w, ph: 'build', rated: {}, skip: [], cross: [],
    triWorkouts: sessions.map((s, i) => ({
      id: `w${w}-${i}`, discipline: 'station', musculoTendonLoad: s.mtl,
      matchedActivityId: s.done ? `act-${w}-${i}` : undefined,
    })),
    ...extra,
  };
}

function hyroxState(weeks: any[]): any {
  return { eventType: 'hyrox', wks: weeks, w: weeks.length };
}

describe('resolveMtlAdherence — HYROX MTL-gap', () => {
  it('is behind when the athlete completed only part of the prescribed MTL', () => {
    const wks = [
      hyroxWeek(1, [{ mtl: 100, done: true }, { mtl: 100, done: true }]),
      hyroxWeek(2, [{ mtl: 100, done: true }, { mtl: 100, done: false }]), // did 100 of 200
    ];
    const r = resolveMtlAdherence(hyroxState(wks), 2);
    expect(r.valid).toBe(true);
    expect(r.ratio).toBeLessThan(1);
    expect(r.pctOfPlanned).toBe(50);
  });

  it('is on-plan (ratio ≈ 1) when everything prescribed was completed', () => {
    const wks = [
      hyroxWeek(1, [{ mtl: 100, done: true }]),
      hyroxWeek(2, [{ mtl: 120, done: true }, { mtl: 80, done: true }]),
    ];
    const r = resolveMtlAdherence(hyroxState(wks), 2);
    expect(r.ratio).toBeCloseTo(1, 6);
    expect(r.pctOfPlanned).toBe(100);
  });

  it('is excused on injury / detrainApplied / taper weeks', () => {
    const base = [hyroxWeek(1, [{ mtl: 100, done: true }])];
    for (const extra of [{ injuryState: { active: true } }, { detrainApplied: true }, { ph: 'taper' }]) {
      const wks = [...base, hyroxWeek(2, [{ mtl: 100, done: false }], extra)];
      expect(resolveMtlAdherence(hyroxState(wks), 2).valid).toBe(false);
    }
  });

  it('does not fire for non-HYROX modes', () => {
    const wks = [hyroxWeek(1, [{ mtl: 100, done: false }])];
    expect(resolveMtlAdherence({ eventType: 'running', wks, w: 1 } as any, 1).valid).toBe(false);
    expect(resolveMtlAdherence({ eventType: 'triathlon', wks, w: 1 } as any, 1).valid).toBe(false);
  });
});

// ── Triathlon (per-discipline) ───────────────────────────────────────────────
function triWeek(w: number, sessions: Array<{ disc: 'swim' | 'bike' | 'run'; load: number; done: boolean }>, extra: any = {}) {
  return {
    w, ph: 'build', rated: {}, skip: [], cross: [],
    triWorkouts: sessions.map((s, i) => ({
      id: `w${w}-${s.disc}-${i}`, discipline: s.disc,
      aerobic: s.load, anaerobic: 0,
      matchedActivityId: s.done ? `act-${w}-${i}` : undefined,
    })),
    ...extra,
  };
}

function triState(weeks: any[]): any {
  return { eventType: 'triathlon', wks: weeks, w: weeks.length };
}

describe('resolveTriDisciplineAdherence — per-discipline tri re-anchor', () => {
  it('flags only the disciplines that fell behind, not the ones kept up', () => {
    const wks = [
      triWeek(1, [{ disc: 'swim', load: 60, done: true }, { disc: 'bike', load: 100, done: true }]),
      triWeek(2, [
        { disc: 'swim', load: 60, done: false }, // skipped swim
        { disc: 'bike', load: 100, done: true },  // kept bike
        { disc: 'run', load: 80, done: true },    // kept run
      ]),
    ];
    const r = resolveTriDisciplineAdherence(triState(wks), 2);
    expect(r.valid).toBe(true);
    expect(r.byDiscipline.swim).toBeLessThan(1);   // behind → present
    expect(r.byDiscipline.bike).toBeUndefined();   // on-plan → absent (reduce-only)
    expect(r.byDiscipline.run).toBeUndefined();
    expect(r.pctByDiscipline.swim).toBe(0);
    expect(r.pctByDiscipline.bike).toBe(100);
  });

  it('a discipline not prescribed this week is simply skipped', () => {
    const wks = [
      triWeek(1, [{ disc: 'bike', load: 100, done: true }]),
      triWeek(2, [{ disc: 'bike', load: 100, done: false }]), // no swim/run at all
    ];
    const r = resolveTriDisciplineAdherence(triState(wks), 2);
    expect(r.byDiscipline.swim).toBeUndefined();
    expect(r.byDiscipline.run).toBeUndefined();
    expect(r.byDiscipline.bike).toBeLessThan(1);
  });

  it('is excused on taper / detrainApplied / injury weeks', () => {
    const base = [triWeek(1, [{ disc: 'run', load: 80, done: true }])];
    for (const extra of [{ ph: 'taper' }, { detrainApplied: true }, { injuryState: { active: true } }]) {
      const wks = [...base, triWeek(2, [{ disc: 'run', load: 80, done: false }], extra)];
      expect(resolveTriDisciplineAdherence(triState(wks), 2).valid).toBe(false);
    }
  });

  it('does not fire for non-triathlon modes', () => {
    const wks = [triWeek(1, [{ disc: 'run', load: 80, done: false }])];
    expect(resolveTriDisciplineAdherence({ eventType: 'hyrox', wks, w: 1 } as any, 1).valid).toBe(false);
  });
});
