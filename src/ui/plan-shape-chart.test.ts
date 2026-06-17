// @vitest-environment jsdom
/**
 * Stats plan-shape card — geometry + you-are-here marker regression guard.
 *
 * Playwright screenshots verify the look; this pins the structure that makes the
 * marker safe per Tristan's constraints:
 *   - the you-are-here dot is a TRUE circle (equal px width/height), never an SVG
 *     <circle> that the preserveAspectRatio="none" viewBox would squash;
 *   - the "Peak · wk" pill sits at the top and the "Now · wk" pill at the bottom,
 *     so the two pills occupy disjoint vertical zones and can never overlap;
 *   - the marker is hidden when the current week is outside the plan;
 *   - tri/HYROX draw a stacked ramp with a now-rule but NO dot (a stacked area has
 *     no single line to pin one to).
 * Numbers come from the canonical derivers, shared with onboarding's coach-contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setState, getDefaultState, getState, updateState } from '@/state/store';
import { seedReviewerDemo } from '@/state/demo-data';
import { renderPlanShapeCard } from './plan-shape-chart';

function triWeeks(): any[] {
  const phases = ['base', 'base', 'build', 'build', 'peak', 'taper'] as const;
  const scale = [0.6, 0.7, 0.85, 0.95, 1.0, 0.55];
  return phases.map((ph, i) => ({
    ph,
    triWorkouts: [
      { n: 'Swim', d: '', t: 'swim', discipline: 'swim', aerobic: 30 * scale[i], anaerobic: 0, estimatedDurationMin: 45 },
      { n: 'Bike', d: '', t: 'bike', discipline: 'bike', aerobic: 70 * scale[i], anaerobic: 10 * scale[i], estimatedDurationMin: 90 },
      { n: 'Run', d: '', t: 'run', discipline: 'run', aerobic: 45 * scale[i], anaerobic: 5 * scale[i], estimatedDurationMin: 50 },
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

describe('plan-shape stats card — running', () => {
  beforeEach(() => { setState(getDefaultState() as any); });

  it('draws the load arc with a Peak pill, a Now pill, and a true-circle dot mid-plan', () => {
    expect(seedReviewerDemo()).toBe(true);
    const weeks = getState().wks?.length ?? 0;
    expect(weeks).toBeGreaterThan(4);
    // Put the athlete mid-plan.
    updateState({ w: Math.max(2, Math.round(weeks / 2)) });

    const html = renderPlanShapeCard(getState());
    expect(html).toContain('Training load across your plan');
    expect(html).toMatch(/Peak · wk \d+/);
    expect(html).toMatch(/Now · wk \d+/);

    // Top pill at top:0; Now pill anchored to the bottom — disjoint zones.
    expect(html).toMatch(/class="psc-pill"[^>]*style="top:0/);
    expect(html).toMatch(/class="psc-pill"[^>]*style="bottom:6px/);

    // The dot is a real HTML circle: equal width/height, border-radius:50%, and
    // NOT an SVG <circle> (which the squashed viewBox would turn into an ellipse).
    expect(html).toContain('class="psc-now-dot"');
    expect(html).toContain('width:11px; height:11px; border-radius:50%');
    expect(html).not.toContain('<circle');
  });

  it('hides the you-are-here marker when the current week is outside the plan', () => {
    expect(seedReviewerDemo()).toBe(true);
    const weeks = getState().wks?.length ?? 0;
    updateState({ w: weeks + 3 }); // plan complete → no "now"

    const html = renderPlanShapeCard(getState());
    expect(html).toMatch(/Peak · wk \d+/);          // arc still drawn
    expect(html).not.toContain('Now · wk');          // but no now marker
    expect(html).not.toContain('class="psc-now-dot"');
  });

  it('renders nothing for just-track (no phased plan)', () => {
    setState({ ...getDefaultState(), trackOnly: true, wks: [] } as any);
    expect(renderPlanShapeCard(getState())).toBe('');
  });
});

describe('plan-shape stats card — triathlon / HYROX', () => {
  beforeEach(() => { setState(getDefaultState() as any); });

  it('triathlon draws a stacked swim/bike/run ramp with a now-rule but no dot', () => {
    setState({ ...getDefaultState(), eventType: 'triathlon', tw: 6, w: 3, wks: triWeeks() } as any);
    const html = renderPlanShapeCard(getState());
    expect(html).toContain('by discipline');
    expect(html).toContain('<path');          // stacked load bands
    expect(html).toContain('Swim');
    expect(html).toContain('Bike');
    expect(html).toMatch(/Now · wk 3/);
    expect(html).toContain('class="psc-now-rule"');
    expect(html).not.toContain('class="psc-now-dot"'); // no single line to pin a dot to
  });

  it('HYROX draws a run-vs-stations ramp', () => {
    setState({ ...getDefaultState(), eventType: 'hyrox', tw: 5, w: 2, wks: hyroxWeeks() } as any);
    const html = renderPlanShapeCard(getState());
    expect(html).toContain('<path');
    expect(html).toContain('Running');
    expect(html).toContain('Stations');
    expect(html).toMatch(/Now · wk 2/);
  });
});
