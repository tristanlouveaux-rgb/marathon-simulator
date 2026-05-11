import { describe, it, expect } from 'vitest';
import {
  detectRepsFromLaps,
  detectRunRepsFromStream,
  detectBikeRepsFromPower,
  detectRepsFromHRStream,
  detectReps,
  type RawLap,
} from './rep-detection';

// ─── Lap-based detection ────────────────────────────────────────────────────

describe('detectRepsFromLaps — running', () => {
  it('finds 8 reps in a textbook 8×400m track session', () => {
    // 8 reps of 400m @ 75s, separated by 200m jogs at slow pace.
    // First lap is a warmup mile, last lap is a cooldown.
    const laps: RawLap[] = [
      { lapIndex: 1, durationSec: 540, distanceM: 1600 },              // warmup
      ...Array.from({ length: 8 }).flatMap((_, i): RawLap[] => [
        { lapIndex: 2 + i * 2, durationSec: 75, distanceM: 400, avgHR: 180 + i },
        { lapIndex: 3 + i * 2, durationSec: 90, distanceM: 200, avgHR: 145 },
      ]),
      { lapIndex: 18, durationSec: 540, distanceM: 1600 },             // cooldown
    ];
    const r = detectRepsFromLaps(laps, 'run');
    expect(r).not.toBeNull();
    expect(r!.source).toBe('strava-laps');
    expect(r!.reps).toHaveLength(8);
    expect(r!.reps[0].distanceM).toBe(400);
    // Reps sorted chronologically — first detected rep should have lapIndex 2.
    expect(r!.reps.map(rp => rp.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('returns null on uniform 1km auto-lap (no rep structure visible)', () => {
    // 10 km easy run with auto-1km lapping; every lap is ~1000m at ~5:00/km.
    const laps: RawLap[] = Array.from({ length: 10 }).map((_, i): RawLap => ({
      lapIndex: i + 1,
      durationSec: 300 + (i % 2 === 0 ? 2 : -2), // tiny jitter
      distanceM: 1000,
    }));
    expect(detectRepsFromLaps(laps, 'run')).toBeNull();
  });

  it('returns null when fewer than MIN_REPS laps', () => {
    const laps: RawLap[] = [
      { lapIndex: 1, durationSec: 70, distanceM: 400 },
      { lapIndex: 2, durationSec: 70, distanceM: 400 },
    ];
    expect(detectRepsFromLaps(laps, 'run')).toBeNull();
  });

  it('skips transition beeps (durations < 15s)', () => {
    const laps: RawLap[] = [
      { lapIndex: 1, durationSec: 8, distanceM: 30 },                  // accidental press
      { lapIndex: 2, durationSec: 75, distanceM: 400 },
      { lapIndex: 3, durationSec: 90, distanceM: 200 },
      { lapIndex: 4, durationSec: 76, distanceM: 400 },
      { lapIndex: 5, durationSec: 90, distanceM: 200 },
      { lapIndex: 6, durationSec: 77, distanceM: 400 },
      { lapIndex: 7, durationSec: 90, distanceM: 200 },
      { lapIndex: 8, durationSec: 75, distanceM: 400 },
    ];
    const r = detectRepsFromLaps(laps, 'run');
    expect(r).not.toBeNull();
    expect(r!.reps).toHaveLength(4);
    expect(r!.reps.every(rp => rp.distanceM === 400)).toBe(true);
  });
});

describe('detectRepsFromLaps — bike', () => {
  it('attaches avgWatts on bike sport', () => {
    // Pace: warmup 200 s/km (slow); reps 125 s/km (fast 28.8km/h); recoveries 180 s/km.
    // Largest sorted-pace gap: 125 → 180 → reps cluster cleanly.
    const laps: RawLap[] = [
      { lapIndex: 1, durationSec: 1200, distanceM: 6000, avgWatts: 150 }, // warmup, 200 s/km
      { lapIndex: 2, durationSec: 300,  distanceM: 2400, avgWatts: 280 }, // rep
      { lapIndex: 3, durationSec: 180,  distanceM: 1000, avgWatts: 160 }, // recovery
      { lapIndex: 4, durationSec: 300,  distanceM: 2400, avgWatts: 285 }, // rep
      { lapIndex: 5, durationSec: 180,  distanceM: 1000, avgWatts: 160 }, // recovery
      { lapIndex: 6, durationSec: 300,  distanceM: 2400, avgWatts: 282 }, // rep
      { lapIndex: 7, durationSec: 180,  distanceM: 1000, avgWatts: 160 }, // recovery
      { lapIndex: 8, durationSec: 300,  distanceM: 2400, avgWatts: 290 }, // rep
    ];
    const r = detectRepsFromLaps(laps, 'bike');
    expect(r).not.toBeNull();
    expect(r!.reps).toHaveLength(4);
    expect(r!.reps[0].avgWatts).toBeGreaterThanOrEqual(280);
  });
});

// ─── Stream-based fallback ──────────────────────────────────────────────────

describe('detectRunRepsFromStream', () => {
  it('finds reps in an alternating fast/slow pace stream', () => {
    // 5 reps × 60s @ 3:20/km (200 sec/km) separated by 60s @ 6:00/km (360 sec/km).
    const distData: number[] = [0];
    const timeData: number[] = [0];
    let dist = 0, time = 0;
    for (let i = 0; i < 5; i++) {
      // Fast 60s (200 sec/km → 5 m/s)
      for (let s = 0; s < 60; s++) { time++; dist += 5; distData.push(dist); timeData.push(time); }
      // Slow 60s (360 sec/km → ~2.78 m/s)
      for (let s = 0; s < 60; s++) { time++; dist += 2.78; distData.push(dist); timeData.push(time); }
    }
    const r = detectRunRepsFromStream(distData, timeData);
    expect(r).not.toBeNull();
    expect(r!.source).toBe('auto-detected');
    expect(r!.reps.length).toBeGreaterThanOrEqual(3);
    expect(r!.reps.length).toBeLessThanOrEqual(5);
  });

  it('returns null on a steady easy run', () => {
    const distData: number[] = [];
    const timeData: number[] = [];
    let dist = 0;
    for (let s = 0; s < 1800; s++) {
      timeData.push(s);
      dist += 3.0; // steady ~5:33/km
      distData.push(dist);
    }
    expect(detectRunRepsFromStream(distData, timeData)).toBeNull();
  });
});

describe('detectBikeRepsFromPower', () => {
  it('detects 4×4min @ FTP power blocks', () => {
    const wattsData: number[] = [];
    const timeData: number[] = [];
    let t = 0;
    // 5min warmup @ 130W
    for (let s = 0; s < 300; s++) { wattsData.push(130); timeData.push(t++); }
    // 4 reps of 4min @ 280W with 3min @ 130W rest between
    for (let r = 0; r < 4; r++) {
      for (let s = 0; s < 240; s++) { wattsData.push(280); timeData.push(t++); }
      for (let s = 0; s < 180; s++) { wattsData.push(130); timeData.push(t++); }
    }
    const out = detectBikeRepsFromPower(wattsData, timeData);
    expect(out).not.toBeNull();
    expect(out!.reps.length).toBe(4);
    expect(out!.reps[0].avgWatts).toBeGreaterThan(270);
  });

  it('returns null on a steady FTP test (constant power)', () => {
    const wattsData: number[] = Array.from({ length: 1800 }, () => 250);
    const timeData: number[] = Array.from({ length: 1800 }, (_, i) => i);
    expect(detectBikeRepsFromPower(wattsData, timeData)).toBeNull();
  });
});

// ─── HR-only stream detection (treadmill / no-power fallback) ───────────────

describe('detectRepsFromHRStream', () => {
  it('detects 4×5min @ threshold from a clean HR profile', () => {
    // Profile: 8 min warm-up at 130 bpm, then 4× [5 min at 175 bpm + 3 min at 135 bpm], cooldown.
    const hr: number[] = [];
    const t: number[] = [];
    let now = 0;
    for (let s = 0; s < 480; s++) { hr.push(130); t.push(now++); } // warm-up
    for (let r = 0; r < 4; r++) {
      for (let s = 0; s < 300; s++) { hr.push(175); t.push(now++); } // work
      for (let s = 0; s < 180; s++) { hr.push(135); t.push(now++); } // recover
    }
    for (let s = 0; s < 240; s++) { hr.push(125); t.push(now++); } // cooldown

    const out = detectRepsFromHRStream(hr, t);
    expect(out).not.toBeNull();
    expect(out!.source).toBe('auto-detected');
    expect(out!.reps.length).toBe(4);
    expect(out!.reps[0].avgHR).toBeGreaterThanOrEqual(170);
    expect(out!.reps[0].durationSec).toBeGreaterThanOrEqual(150); // ≥ MIN_HR_REP_DURATION_SEC
    // No distance signal in HR-only mode.
    expect(out!.reps[0].distanceM).toBe(0);
    expect(out!.reps[0].paceSecKm).toBeNull();
  });

  it('returns null on a uniform easy run (no rep structure)', () => {
    // 60 minutes at 140 bpm with ±2 bpm noise — should not register reps.
    const hr: number[] = [];
    const t: number[] = [];
    for (let s = 0; s < 3600; s++) {
      hr.push(140 + (Math.sin(s / 30) * 2));
      t.push(s);
    }
    expect(detectRepsFromHRStream(hr, t)).toBeNull();
  });

  it('returns null when peak − baseline spread < MIN_HR_SPREAD_BPM', () => {
    // 30-min session, baseline 145, "interval" peaks only 153 bpm — too narrow.
    const hr: number[] = [];
    const t: number[] = [];
    let now = 0;
    for (let s = 0; s < 600; s++) { hr.push(145); t.push(now++); }
    for (let r = 0; r < 3; r++) {
      for (let s = 0; s < 240; s++) { hr.push(153); t.push(now++); }
      for (let s = 0; s < 120; s++) { hr.push(146); t.push(now++); }
    }
    expect(detectRepsFromHRStream(hr, t)).toBeNull();
  });

  it('rejects too-short reps (< MIN_HR_REP_DURATION_SEC)', () => {
    // 30s on / 30s off ×8 — HR can't catch the cadence, won't sustain above
    // threshold for the 90s minimum. Expect null.
    const hr: number[] = [];
    const t: number[] = [];
    let now = 0;
    for (let s = 0; s < 600; s++) { hr.push(130); t.push(now++); }
    for (let r = 0; r < 8; r++) {
      for (let s = 0; s < 30; s++) { hr.push(170); t.push(now++); }
      for (let s = 0; s < 30; s++) { hr.push(140); t.push(now++); }
    }
    expect(detectRepsFromHRStream(hr, t)).toBeNull();
  });

  it('returns null for streams shorter than 5 minutes', () => {
    const hr = Array.from({ length: 200 }).map(() => 150);
    const t = Array.from({ length: 200 }).map((_, i) => i);
    expect(detectRepsFromHRStream(hr, t)).toBeNull();
  });
});

// ─── Top-level orchestrator ─────────────────────────────────────────────────

describe('detectReps — top-level routing', () => {
  it('prefers laps for run', () => {
    const laps: RawLap[] = Array.from({ length: 8 }).flatMap((_, i): RawLap[] => [
      { lapIndex: i * 2 + 1, durationSec: 75, distanceM: 400 },
      { lapIndex: i * 2 + 2, durationSec: 90, distanceM: 200 },
    ]);
    const r = detectReps('run', { laps });
    expect(r?.source).toBe('strava-laps');
  });

  it('prefers power stream over laps for bike', () => {
    // Provide both: uniform 1km laps (which laps detection rejects) plus a
    // clean power stream. Should pick up the stream-detected reps.
    const laps: RawLap[] = Array.from({ length: 10 }).map((_, i): RawLap => ({
      lapIndex: i + 1, durationSec: 100, distanceM: 1000, avgWatts: 200,
    }));
    const wattsData: number[] = [];
    const timeData: number[] = [];
    let t = 0;
    for (let s = 0; s < 200; s++) { wattsData.push(150); timeData.push(t++); }
    for (let r = 0; r < 5; r++) {
      for (let s = 0; s < 60; s++) { wattsData.push(300); timeData.push(t++); }
      for (let s = 0; s < 60; s++) { wattsData.push(150); timeData.push(t++); }
    }
    const out = detectReps('bike', { laps, wattsData, timeData });
    expect(out?.source).toBe('auto-detected');
  });

  it('returns null for unsupported sport (swim)', () => {
    expect(detectReps('swim' as any, {})).toBeNull();
  });
});
