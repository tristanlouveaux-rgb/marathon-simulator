import { describe, it, expect } from 'vitest';
import { detectMarkerBumps, snapshotNotifiedMarkers } from './tri-marker-bumps';
import type { SimulatorState } from '@/types/state';

function state(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
    wks: [],
    triConfig: { distance: 'ironman' },
    ...overrides,
  } as unknown as SimulatorState;
}

describe('detectMarkerBumps', () => {
  it('first observation (no notifiedMarkers snapshot yet) → no bumps surfaced', () => {
    const s = state({
      v: 50,
      triConfig: {
        distance: 'ironman',
        bike: { ftp: 295 },
        swim: { cssSecPer100m: 110 },
      } as any,
    });
    expect(detectMarkerBumps(s)).toEqual([]);
  });

  it('FTP crosses +5W threshold → bump surfaced', () => {
    const s = state({
      v: 50,
      triConfig: {
        distance: 'ironman',
        bike: { ftp: 305 },
        swim: { cssSecPer100m: 110 },
        notifiedMarkers: { ftp: 295, cssSecPer100m: 110, vdot: 50 },
      } as any,
    });
    const bumps = detectMarkerBumps(s);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].marker).toBe('ftp');
    expect(bumps[0].from).toBe(295);
    expect(bumps[0].to).toBe(305);
    expect(bumps[0].improvement).toBe(10);
    expect(bumps[0].toastText).toContain('295W → 305W');
  });

  it('FTP +4W (below 5W threshold) → no bump', () => {
    const s = state({
      v: 50,
      triConfig: {
        distance: 'ironman',
        bike: { ftp: 299 },
        notifiedMarkers: { ftp: 295, vdot: 50 },
      } as any,
    });
    expect(detectMarkerBumps(s)).toEqual([]);
  });

  it('CSS improves by 5+ sec/100m → bump surfaced (lower is better)', () => {
    const s = state({
      v: 50,
      triConfig: {
        distance: 'ironman',
        swim: { cssSecPer100m: 100 },
        notifiedMarkers: { cssSecPer100m: 110, vdot: 50 },
      } as any,
    });
    const bumps = detectMarkerBumps(s);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].marker).toBe('css');
    expect(bumps[0].improvement).toBe(10);
    expect(bumps[0].toastText).toContain('1:50/100m → 1:40/100m');
  });

  it('VDOT +1 → bump surfaced', () => {
    const s = state({
      v: 51.2,
      triConfig: {
        distance: 'ironman',
        notifiedMarkers: { vdot: 50.0 },
      } as any,
    });
    const bumps = detectMarkerBumps(s);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].marker).toBe('vdot');
    expect(bumps[0].improvement).toBeCloseTo(1.2, 1);
  });

  it('regression (FTP went DOWN) is silent — no negative-direction toast', () => {
    const s = state({
      v: 50,
      triConfig: {
        distance: 'ironman',
        bike: { ftp: 280 },
        notifiedMarkers: { ftp: 300, vdot: 50 },
      } as any,
    });
    expect(detectMarkerBumps(s)).toEqual([]);
  });

  it('multiple markers cross threshold simultaneously → multiple bumps', () => {
    const s = state({
      v: 52,
      triConfig: {
        distance: 'ironman',
        bike: { ftp: 305 },
        swim: { cssSecPer100m: 100 },
        notifiedMarkers: { ftp: 295, cssSecPer100m: 110, vdot: 50 },
      } as any,
    });
    const bumps = detectMarkerBumps(s);
    expect(bumps).toHaveLength(3);  // FTP +10, CSS -10s, VDOT +2
    expect(bumps.map(b => b.marker).sort()).toEqual(['css', 'ftp', 'vdot']);
  });
});

describe('snapshotNotifiedMarkers', () => {
  it('writes current marker values onto state', () => {
    const s = state({
      v: 52,
      triConfig: {
        distance: 'ironman',
        bike: { ftp: 305 },
        swim: { cssSecPer100m: 100 },
      } as any,
    });
    snapshotNotifiedMarkers(s);
    expect(s.triConfig!.notifiedMarkers).toEqual({
      ftp: 305,
      cssSecPer100m: 100,
      vdot: 52,
    });
  });

  it('handles missing markers gracefully', () => {
    const s = state({
      triConfig: { distance: 'ironman' } as any,
    });
    snapshotNotifiedMarkers(s);
    expect(s.triConfig!.notifiedMarkers).toEqual({
      ftp: undefined,
      cssSecPer100m: undefined,
      vdot: undefined,
    });
  });
});
