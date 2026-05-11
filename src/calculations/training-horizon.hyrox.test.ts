import { describe, it, expect } from 'vitest';
import {
  applyHyroxStationHorizon,
  applyHyroxClassHorizon,
  applyHyroxRoxzoneHorizon,
  type HyroxHorizonInput,
} from './training-horizon.hyrox';
import {
  CARDIO_ERG_HORIZON_PARAMS,
  STRENGTH_ENDURANCE_HORIZON_PARAMS,
  GRIP_CARRY_HORIZON_PARAMS,
  ROXZONE_HORIZON_PARAMS,
  STATION_CLASS,
} from '@/constants/hyrox-horizon-params';

const baseInput = (overrides: Partial<HyroxHorizonInput> = {}): HyroxHorizonInput => ({
  baseline: 300,                     // 5:00 — generic
  weeks_remaining: 12,
  sessions_per_week: 3.5,
  ability_band: 'intermediate',
  experience_level: 'intermediate',
  ...overrides,
});

describe('applyHyroxStationHorizon — direction & basic shape', () => {
  it('returns a reduction (projected ≤ baseline) for time-based stations', () => {
    const r = applyHyroxStationHorizon('row_erg', baseInput());
    expect(r.improvement_pct).toBeGreaterThan(0);
    expect(r.projected).toBeLessThan(300);
    expect(r.projected).toBeGreaterThan(0);
  });

  it('floors improvement at 0% — race tomorrow + zero planned sessions does NOT predict regression', () => {
    const r = applyHyroxStationHorizon('row_erg', baseInput({
      weeks_remaining: 0.05,
      sessions_per_week: 0,
    }));
    expect(r.improvement_pct).toBeGreaterThanOrEqual(0);
    expect(r.projected).toBeLessThanOrEqual(300);
    expect(r.projected).toBeGreaterThanOrEqual(300 * 0.99);
  });

  it('returns 0% when weeks_remaining is 0 (race today / past)', () => {
    const r = applyHyroxStationHorizon('row_erg', baseInput({ weeks_remaining: 0 }));
    expect(r.improvement_pct).toBe(0);
    expect(r.projected).toBe(300);
  });

  it('caps at the class hard ceiling — exotic high-volume input cannot exceed max_gain_cap_pct', () => {
    // Beginner band has the largest max_gain. Ramp inputs to extreme to test cap.
    const r = applyHyroxStationHorizon('sled_push', baseInput({
      ability_band: 'total_beginner',
      sessions_per_week: 12,
      weeks_remaining: 52,
      adaptation_ratio: 3.0,
    }));
    expect(r.improvement_pct).toBeLessThanOrEqual(STRENGTH_ENDURANCE_HORIZON_PARAMS.max_gain_cap_pct);
  });
});

describe('applyHyroxStationHorizon — saturation & dose response', () => {
  it('week-factor saturates: longer horizon → larger gain (monotonic)', () => {
    const r4  = applyHyroxStationHorizon('row_erg', baseInput({ weeks_remaining: 4 }));
    const r12 = applyHyroxStationHorizon('row_erg', baseInput({ weeks_remaining: 12 }));
    const r26 = applyHyroxStationHorizon('row_erg', baseInput({ weeks_remaining: 26 }));
    expect(r4.improvement_pct).toBeLessThan(r12.improvement_pct);
    expect(r12.improvement_pct).toBeLessThan(r26.improvement_pct);
  });

  it('session-factor sigmoid: more sessions → larger gain', () => {
    const r1 = applyHyroxStationHorizon('row_erg', baseInput({ sessions_per_week: 1 }));
    const r3 = applyHyroxStationHorizon('row_erg', baseInput({ sessions_per_week: 3 }));
    const r5 = applyHyroxStationHorizon('row_erg', baseInput({ sessions_per_week: 5 }));
    expect(r1.improvement_pct).toBeLessThan(r3.improvement_pct);
    expect(r3.improvement_pct).toBeLessThan(r5.improvement_pct);
  });

  it('undertraining penalty: sessions_per_week < min_sessions reduces gain', () => {
    // intermediate min_sessions = 2.5
    const above = applyHyroxStationHorizon('row_erg', baseInput({ sessions_per_week: 2.5 }));
    const below = applyHyroxStationHorizon('row_erg', baseInput({ sessions_per_week: 0.5 }));
    expect(below.components.undertrain_penalty).toBeGreaterThan(above.components.undertrain_penalty);
  });

  it('experience level scales gain — beginner experience reduces, returning amplifies', () => {
    const intermediate = applyHyroxStationHorizon('row_erg', baseInput({ experience_level: 'intermediate' }));
    const beginner     = applyHyroxStationHorizon('row_erg', baseInput({ experience_level: 'beginner' }));
    const returning    = applyHyroxStationHorizon('row_erg', baseInput({ experience_level: 'returning' }));
    expect(beginner.improvement_pct).toBeLessThan(intermediate.improvement_pct);
    expect(returning.improvement_pct).toBeGreaterThan(intermediate.improvement_pct);
  });
});

describe('applyHyroxStationHorizon — taper bonus', () => {
  it('full taper window adds the full taper bonus', () => {
    // Default HYROX_TAPER_WEEKS = 1.5; horizon ≥ taper window → full bonus.
    const r = applyHyroxStationHorizon('row_erg', baseInput({
      weeks_remaining: 12,
    }));
    expect(r.components.taper_bonus).toBeCloseTo(CARDIO_ERG_HORIZON_PARAMS.taper_bonus_pct.intermediate, 2);
  });

  it('race in <1 week scales the taper bonus down (not full bonus)', () => {
    const r = applyHyroxStationHorizon('row_erg', baseInput({
      weeks_remaining: 0.5,
    }));
    // 0.5 / 1.5 = 0.333 → taper_bonus = 3.0 * 0.333 ≈ 1.0
    expect(r.components.taper_bonus).toBeLessThan(CARDIO_ERG_HORIZON_PARAMS.taper_bonus_pct.intermediate);
    expect(r.components.taper_bonus).toBeGreaterThan(0);
  });

  // The user-facing invariant: setting a plan one week out should not promise a
  // big race-day movement. Inside the taper window the build-phase fitness
  // contribution (week_factor) collapses to zero, so any remaining gain is
  // the taper bonus alone — fitness coming forward as fatigue clears, not new
  // adaptation. Mujika 2002: real performance gains during a 1–3 week taper
  // come from fatigue removal, not new training.
  //
  // Assertion: taper-race gain is materially smaller than build-race gain
  // (week_factor zeroed out), AND its absolute size is bounded by the taper
  // bonus alone (no sneaky additional contributions).
  it('race inside the taper window yields meaningfully less gain than a build-phase race', () => {
    const taperRace = applyHyroxStationHorizon('row_erg', baseInput({
      weeks_remaining: 1.0,                  // inside HYROX_TAPER_WEEKS = 1.5
      sessions_per_week: 3.5,
    }));
    const buildRace = applyHyroxStationHorizon('row_erg', baseInput({
      weeks_remaining: 8.0,                  // well outside taper window
      sessions_per_week: 3.5,
    }));
    // Build-phase gain comprises full week_factor + full taper bonus; taper
    // race only the taper bonus. Build must be at least 40% larger.
    expect(buildRace.improvement_pct).toBeGreaterThan(taperRace.improvement_pct * 1.4);
    // Taper race gain must not exceed full taper bonus — bounds the residual.
    expect(taperRace.improvement_pct).toBeLessThanOrEqual(
      CARDIO_ERG_HORIZON_PARAMS.taper_bonus_pct.intermediate + 0.01,
    );
  });

  it('race tomorrow with full sessions floors near zero (no fake speedup)', () => {
    const r = applyHyroxStationHorizon('row_erg', baseInput({
      weeks_remaining: 0.05,                 // ~1 day
      sessions_per_week: 4.0,                // even with strong dose
    }));
    // Inside-taper: only a small fraction of taper bonus survives, no
    // build-phase gain. Total must remain < 1% reduction (1% of 300s = 3s).
    expect(r.improvement_pct).toBeLessThan(1.0);
  });
});

describe('Class differentiation', () => {
  it('strength-endurance has higher beginner max_gain than cardio', () => {
    expect(STRENGTH_ENDURANCE_HORIZON_PARAMS.max_gain_pct.total_beginner)
      .toBeGreaterThan(CARDIO_ERG_HORIZON_PARAMS.max_gain_pct.total_beginner);
  });

  it('grip_carry is the most conservative class at intermediate', () => {
    expect(GRIP_CARRY_HORIZON_PARAMS.max_gain_pct.intermediate)
      .toBeLessThan(CARDIO_ERG_HORIZON_PARAMS.max_gain_pct.intermediate);
    expect(GRIP_CARRY_HORIZON_PARAMS.max_gain_pct.intermediate)
      .toBeLessThan(STRENGTH_ENDURANCE_HORIZON_PARAMS.max_gain_pct.intermediate);
  });

  it('every station maps to a class', () => {
    const stations: Array<keyof typeof STATION_CLASS> = [
      'ski_erg', 'row_erg', 'sled_push', 'sled_pull',
      'burpee_broad_jumps', 'sandbag_lunges', 'wall_balls', 'farmer_carry',
    ];
    for (const s of stations) {
      expect(STATION_CLASS[s]).toBeDefined();
    }
  });

  it('row_erg and ski_erg use cardio class; sled_push uses strength_endurance', () => {
    const cardio = applyHyroxStationHorizon('row_erg', baseInput({ baseline: 300 }));
    const cardio2 = applyHyroxClassHorizon('cardio_erg', baseInput({ baseline: 300 }));
    expect(cardio.improvement_pct).toBeCloseTo(cardio2.improvement_pct, 6);

    const strength = applyHyroxStationHorizon('sled_push', baseInput({ baseline: 300 }));
    const strength2 = applyHyroxClassHorizon('strength_endurance', baseInput({ baseline: 300 }));
    expect(strength.improvement_pct).toBeCloseTo(strength2.improvement_pct, 6);
  });
});

describe('applyHyroxRoxzoneHorizon', () => {
  it('uses the RoxZone curve and returns a reduction', () => {
    const r = applyHyroxRoxzoneHorizon(baseInput({ baseline: 390 })); // intermediate seed
    expect(r.improvement_pct).toBeGreaterThan(0);
    expect(r.improvement_pct).toBeLessThanOrEqual(ROXZONE_HORIZON_PARAMS.max_gain_cap_pct);
    expect(r.projected).toBeLessThan(390);
  });

  it('floors at 0% when no time remains', () => {
    const r = applyHyroxRoxzoneHorizon(baseInput({ weeks_remaining: 0 }));
    expect(r.improvement_pct).toBe(0);
  });
});

describe('Adherence penalty', () => {
  it('subtracts adherence_penalty_pct from improvement', () => {
    const clean = applyHyroxStationHorizon('row_erg', baseInput());
    const penalised = applyHyroxStationHorizon('row_erg', baseInput({ adherence_penalty_pct: 2 }));
    expect(penalised.improvement_pct).toBeLessThan(clean.improvement_pct);
  });

  it('cannot push improvement below 0 (floor still applies)', () => {
    const r = applyHyroxStationHorizon('row_erg', baseInput({
      adherence_penalty_pct: 100,  // absurdly high
    }));
    expect(r.improvement_pct).toBe(0);
  });
});

describe('Adaptation ratio', () => {
  it('< 1.0 scales gain down (slow responder)', () => {
    const neutral = applyHyroxStationHorizon('row_erg', baseInput({ adaptation_ratio: 1.0 }));
    const slow    = applyHyroxStationHorizon('row_erg', baseInput({ adaptation_ratio: 0.5 }));
    expect(slow.improvement_pct).toBeLessThan(neutral.improvement_pct);
  });

  it('> 1.0 scales gain up (fast responder), but still bounded by cap', () => {
    const neutral = applyHyroxStationHorizon('row_erg', baseInput({ adaptation_ratio: 1.0 }));
    const fast    = applyHyroxStationHorizon('row_erg', baseInput({ adaptation_ratio: 1.5 }));
    expect(fast.improvement_pct).toBeGreaterThan(neutral.improvement_pct);
    expect(fast.improvement_pct).toBeLessThanOrEqual(CARDIO_ERG_HORIZON_PARAMS.max_gain_cap_pct);
  });
});
