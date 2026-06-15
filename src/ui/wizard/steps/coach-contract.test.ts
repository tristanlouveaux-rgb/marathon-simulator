// @vitest-environment jsdom
/**
 * Render smoke + regression guard for the coach-contract step across all three
 * plan modes (running / triathlon / HYROX).
 *
 * Playwright screenshots verify the look; this verifies the wiring: each mode
 * renders without throwing, the showcase mocks are present (readiness ring, the
 * real m-slider-glass), and the tri/HYROX stacked load ramps draw from the
 * stored triWorkouts. Also pins the two copy fixes: no "Compromised running",
 * and the rebalance copy says "sessions" (not "runs") in tri/HYROX.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setState, getDefaultState } from '@/state/store';
import { renderCoachContract } from './coach-contract';
import type { OnboardingState } from '@/types/onboarding';

/** A few plan weeks carrying per-discipline triWorkouts with canonical-TSS load
 *  (aerobic+anaerobic), ramping base → peak then tapering. */
function triWeeks(): any[] {
  const phases = ['base', 'base', 'build', 'build', 'peak', 'taper'] as const;
  const scale = [0.6, 0.7, 0.85, 0.95, 1.0, 0.55];
  return phases.map((ph, i) => ({
    ph,
    triWorkouts: [
      { n: 'Swim', d: '', t: 'swim', discipline: 'swim', aerobic: 30 * scale[i], anaerobic: 0, estimatedDurationMin: 45 },
      { n: 'Bike', d: '', t: 'bike', discipline: 'bike', aerobic: 70 * scale[i], anaerobic: 10 * scale[i], estimatedDurationMin: 90 },
      { n: 'Run', d: '', t: 'run', discipline: 'run', aerobic: 45 * scale[i], anaerobic: 5 * scale[i], estimatedDurationMin: 50 },
      // bricks appear in build/peak — exercise the 4th band
      ...(ph === 'build' || ph === 'peak'
        ? [{ n: 'Brick', d: '', t: 'brick', discipline: 'brick', aerobic: 60 * scale[i], anaerobic: 12 * scale[i], estimatedDurationMin: 80 }]
        : []),
    ],
  }));
}

function hyroxWeeks(): any[] {
  const phases = ['base', 'build', 'build', 'peak', 'taper'] as const;
  const scale = [0.6, 0.85, 0.95, 1.0, 0.55];
  return phases.map((ph, i) => ({
    ph,
    triWorkouts: [
      { n: 'Run', d: '', t: 'run', discipline: 'run', aerobic: 60 * scale[i], anaerobic: 8 * scale[i], estimatedDurationMin: 55 },
      { n: 'Stations', d: '', t: 'station', discipline: 'station', aerobic: 40 * scale[i], anaerobic: 20 * scale[i], estimatedDurationMin: 45 },
    ],
  }));
}

function render(onboarding: Partial<OnboardingState>, stateOver: Record<string, unknown> = {}): string {
  setState({ ...getDefaultState(), ...stateOver } as any);
  const el = document.createElement('div');
  renderCoachContract(el, onboarding as OnboardingState);
  return el.innerHTML;
}

describe('coach-contract — all modes render', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('running renders the showcase with a readiness ring and a touchable slider', () => {
    const html = render(
      { trainingMode: 'running', name: 'Sample', recurringActivities: [{ sport: 'Cycling', durationMin: 60, frequency: 1, intensity: 'moderate' }] as any },
      { tw: 16 },
    );
    expect(html).toContain('Built to flex around you');
    expect(html).toContain('cc-rdn-grad');       // readiness ring gradient
    expect(html).toContain('id="cc-adj"');         // touchable slider
    expect(html).toContain('m-slider-glass');      // real app slider class
    expect(html).toContain('cc-ring');             // page-flair ring background present
    expect(html).toContain('class="cc-eff"');      // easier/harder pacing toggle
    expect(html).toContain('Harder');
    expect(html).toContain('Illness mode');        // life-events: illness
    expect(html).toContain('Holiday mode');        // life-events: holiday
  });

  it('triathlon renders a stacked-by-discipline ramp + three engines', () => {
    const html = render(
      { trainingMode: 'triathlon', name: 'Sample', triDistance: '70.3', triBike: { ftp: 240 } as any, triSwim: { cssSecPer100m: 95 } as any },
      { tw: 16, wks: triWeeks(), pac: { e: 300, t: 250, i: 230, m: 270, r: 220 } },
    );
    expect(html).toContain('stacked by discipline');
    expect(html).toContain('<path');               // the smoothed stacked load bands
    expect(html).toContain('Brick');              // 4th band present (build/peak bricks)
    expect(html).toContain('hours a week');        // weekly-hours figure in caption
    expect(html).toContain('Why does it vary?');  // tappable explainer
    expect(html).toContain('Your three engines');
    expect(html).toContain('240 W');              // FTP row
    expect(html).toContain('Built to flex around you');
    // mode-correct copy
    expect(html).not.toContain('Compromised running');
  });

  it('HYROX renders a run-vs-stations ramp and no "Compromised running"', () => {
    const html = render(
      { trainingMode: 'hyrox', name: 'Sample', previousHyroxTimeSec: 4920 },
      { tw: 16, wks: hyroxWeeks(), pac: { e: 300, t: 250, i: 230, m: 270, r: 220 } },
    );
    expect(html).toContain('running and stations');
    expect(html).toContain('<path');
    expect(html).toContain('Built to flex around you');
    expect(html).not.toContain('Compromised running');
  });

  it('tri/HYROX rebalance copy says "sessions", running says "runs"', () => {
    const run = render({ trainingMode: 'running', name: 'S' }, { tw: 12 });
    const tri = render({ trainingMode: 'triathlon', name: 'S' }, { tw: 12, wks: triWeeks() });
    expect(run).toMatch(/trim the runs around it/);
    expect(tri).toMatch(/trim the sessions around it/);
  });
});
