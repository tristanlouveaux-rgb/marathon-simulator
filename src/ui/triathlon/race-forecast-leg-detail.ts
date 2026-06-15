/**
 * Leg-breakdown drill-down ("how this leg's time was built").
 *
 * Opened by tapping a Swim / Bike / Run leg on the forecast cards. Renders the
 * projected leg time as a waterfall: base marker → course → heat → durability →
 * readiness → calibration, each row showing the cumulative time and the delta
 * the step applied. The last row reconciles to the leg time shown on the card,
 * because both come from the same `prediction.legWaterfall` (built in
 * race-prediction.triathlon.ts). Rows link to the matching forecast factor chip.
 *
 * Page chrome mirrors `forecast-chip-detail-view.ts` (the sibling drill-down).
 */

import { getState } from '@/state/store';
import type { SimulatorState } from '@/types/state';
import type { LegWaterfallStep, TriRacePrediction } from '@/types/triathlon';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { atmosphereGradient, buildSunGlint, buildRingBackground } from '../page-flair';
import { legSplitLine, legCommentary } from './race-forecast-card';
import { COURSE_PROFILES } from '@/data/triathlon-course-profiles';

type LegKey = 'swim' | 'bike' | 'run';

const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const FAINT = '#94A3B8';

const LEG_ACCENT: Record<LegKey, string> = {
  swim: '#3B82F6',
  bike: '#DC2626',
  run: '#16A34A',
};

const LEG_LABEL: Record<LegKey, string> = { swim: 'Swim', bike: 'Bike', run: 'Run' };

// Which forecast factor chip a step links to (keys match TriChipKey). The
// readiness step has its own detail view, not a chip, so it stays non-interactive.
const STEP_CHIP: Partial<Record<LegWaterfallStep['kind'], string>> = {
  base: 'capacity',
  ow: 'openwater',
  course: 'venue',
  heat: 'heat',
  durability: 'durability',
  calibration: 'calibration',
};

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDelta(sec: number): string {
  const a = Math.abs(Math.round(sec));
  const m = Math.floor(a / 60);
  const s = a % 60;
  const body = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  return `${sec >= 0 ? '+' : '−'}${body}`;
}

function legFinalSec(leg: LegKey, p: TriRacePrediction): number {
  return leg === 'swim' ? p.swimSec : leg === 'bike' ? p.bikeSec : p.runSec;
}

function legCurrentSec(leg: LegKey, p: TriRacePrediction): number | undefined {
  return leg === 'swim' ? p.currentSwimSec : leg === 'bike' ? p.currentBikeSec : p.currentRunSec;
}

/** One waterfall row. `prevSec` is the cumulative time before this step. */
function renderStepRow(step: LegWaterfallStep, prevSec: number | null, accent: string): string {
  const delta = prevSec != null ? step.toSec - prevSec : null;
  // Faster (negative) = green; slower (positive) = neutral grey. Keeps to one
  // non-neutral colour in the rows (the accent rail is the other).
  const deltaColor = delta != null && delta < 0 ? 'var(--c-ok)' : FAINT;
  const isBase = prevSec == null;
  const chip = STEP_CHIP[step.kind];
  const tappable = chip != null;

  // Caption line: delta (coloured) · provenance detail · "details →" affordance.
  const deltaPart = delta != null && delta !== 0
    ? `<span style="color:${deltaColor};font-variant-numeric:tabular-nums">${fmtDelta(delta)}</span>`
    : '';
  const detailPart = step.detail ? `<span style="color:${FAINT}">${step.detail}</span>` : '';
  const tapPart = tappable ? `<span style="color:${FAINT}">details →</span>` : '';
  const caption = [deltaPart, detailPart, tapPart].filter(Boolean).join('<span style="color:rgba(15,23,42,0.20)">  ·  </span>');

  return `
    <div ${tappable ? `data-leg-chip="${chip}" role="button" tabindex="0"` : ''} style="
      display:flex;align-items:center;gap:14px;padding:13px 4px;
      ${tappable ? 'cursor:pointer;' : ''}
      border-bottom:1px solid rgba(15,23,42,0.06)">
      <div style="width:7px;height:7px;border-radius:50%;background:${isBase ? accent : 'rgba(15,23,42,0.18)'};flex:0 0 auto"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;color:${TEXT_M};line-height:1.3">${step.label}</div>
        ${caption ? `<div style="font-size:11px;margin-top:2px">${caption}</div>` : ''}
      </div>
      <div style="font-size:15px;font-weight:500;color:${TEXT_M};font-variant-numeric:tabular-nums;flex:0 0 auto">${fmtDuration(step.toSec)}</div>
    </div>
  `;
}

function renderLegBody(leg: LegKey, p: TriRacePrediction, s: SimulatorState): string {
  const accent = LEG_ACCENT[leg];
  const steps = p.legWaterfall?.[leg] ?? [];
  const finalSec = legFinalSec(leg, p);
  const distance = s.triConfig?.distance ?? '70.3';
  const split = legSplitLine(leg, finalSec, distance, s.unitPref, leg === 'bike' ? p.bikeAvgWatts : undefined);

  const currentSec = legCurrentSec(leg, p);
  const gap = currentSec != null ? currentSec - finalSec : null;
  const gapLine = gap != null && Math.abs(gap) >= 30
    ? `<span style="color:${gap > 0 ? 'var(--c-ok)' : FAINT}">${gap > 0 ? '−' : '+'}${fmtDuration(Math.abs(gap))} vs today</span>`
    : '';

  if (steps.length === 0) {
    return `
      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:20px;text-align:center">
        <div style="font-size:14px;color:${TEXT_S};line-height:1.5">No breakdown yet. Set this discipline's marker (CSS, FTP, or VDOT) to see how the leg time is built.</div>
      </div>`;
  }

  let prev: number | null = null;
  const rows = steps.map(step => {
    const html = renderStepRow(step, prev, accent);
    prev = step.toSec;
    return html;
  }).join('');

  // Plain-language "why" for this leg's course character. Derived from the
  // venue's physical attributes (swim type, profile, wind, climate, elevation)
  // and the direction of the course delta. Returns '' when the attributes can't
  // credibly explain the gap, so we never speculate. Shared swim/bike/run.
  const profile = COURSE_PROFILES[s.onboarding?.selectedTriathlonId ?? ''] ?? null;
  const courseDelta = (p.courseFactors ?? [])
    .filter(f => f.leg === leg)
    .reduce((sum, f) => sum + (f.deltaSec ?? 0), 0);
  const note = legCommentary(leg, courseDelta, profile);

  return `
    <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:6px 18px 4px">
      ${rows}
      <div style="display:flex;align-items:center;gap:14px;padding:15px 4px 13px">
        <div style="width:7px;height:7px;border-radius:50%;background:${accent};flex:0 0 auto"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:${TEXT_M}">Projected leg time</div>
          <div style="font-size:11px;color:${FAINT};margin-top:2px;font-variant-numeric:tabular-nums">${split}${gapLine ? '  ·  ' + gapLine : ''}</div>
        </div>
        <div style="font-size:19px;font-weight:600;color:${TEXT_M};font-variant-numeric:tabular-nums;flex:0 0 auto">${fmtDuration(finalSec)}</div>
      </div>
    </div>
    ${note ? `
      <div style="display:flex;gap:10px;align-items:flex-start;margin-top:14px;padding:14px 16px;background:rgba(255,255,255,0.6);border:1px solid rgba(0,0,0,0.05);border-radius:12px">
        <div style="width:3px;align-self:stretch;border-radius:2px;background:${accent};flex:0 0 auto"></div>
        <div style="font-size:13px;color:${TEXT_S};line-height:1.5">${note}</div>
      </div>
    ` : ''}
    <div style="font-size:11px;color:${FAINT};line-height:1.5;text-align:center;padding:14px 10px 0">
      Each step shows the cumulative time after it is applied. Tap a factor row to open its detail.
    </div>
  `;
}

export function renderTriLegBreakdown(leg: LegKey): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const p = s.triConfig?.prediction ?? predictTriathlonRace(s);
  if (!p) {
    import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
    return;
  }

  const finalSec = legFinalSec(leg, p);
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map(n => n[0]?.toUpperCase() || '').join('');

  container.innerHTML = `
    <style>
      @keyframes triLbdFloatUp { from { opacity:0; } to { opacity:1; } }
      .tri-lbd-fade { opacity:0; animation:triLbdFloatUp 0.55s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="tri-lbd-view" class="safe-top-bleed" style="position:relative;min-height:100vh;background:${atmosphereGradient('sky')};font-family:var(--f);overflow-x:hidden">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('tri-lbd', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div class="tri-lbd-fade" style="animation-delay:0.02s;padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <button id="tri-lbd-back-btn" style="background:transparent;border:none;font-size:14px;color:${TEXT_S};cursor:pointer;padding:0;font-family:var(--f)">← Back</button>
          <button id="tri-lbd-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <div class="tri-lbd-fade" style="animation-delay:0.06s;text-align:center;padding:20px 20px 16px">
          <div style="font-size:11px;color:${TEXT_S};font-weight:500">Leg breakdown</div>
          <div style="font-size:30px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.1;margin-top:6px">${LEG_LABEL[leg]}</div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">How ${fmtDuration(finalSec)} is built</div>
        </div>

        <div class="tri-lbd-fade" style="animation-delay:0.12s;padding:0 16px">
          ${renderLegBody(leg, p, s)}
        </div>

      </div>

      ${renderTabBar('forecast')}
    </div>
  `;

  document.getElementById('tri-lbd-back-btn')?.addEventListener('click', () => {
    import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  });
  document.getElementById('tri-lbd-account-btn')?.addEventListener('click', () => {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Factor rows drill into the matching forecast chip detail page.
  document.querySelectorAll<HTMLElement>('[data-leg-chip]').forEach(el => {
    const open = () => {
      const key = el.dataset.legChip;
      if (!key) return;
      import('./forecast-chip-detail-view').then(m => m.renderTriForecastChipDetail(key as Parameters<typeof m.renderTriForecastChipDetail>[0]));
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });

  wireTabBarHandlers(navigateTab);
}

/**
 * Wire leg-time cells on the forecast cards to open this drill-down. Both the
 * Forecast-tab marquee and the Stats card add `data-leg-tap="swim|bike|run"`;
 * call this after rendering either surface.
 */
export function wireTriLegBreakdownTaps(): void {
  document.querySelectorAll<HTMLElement>('[data-leg-tap]').forEach(el => {
    const open = () => {
      const leg = el.dataset.legTap as LegKey | undefined;
      if (leg) renderTriLegBreakdown(leg);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('../home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('../main-view').then(m => m.renderMainView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderTriathlonStatsView());
  else if (tab === 'forecast') import('./forecast-view').then(m => m.renderTriathlonForecastView());
  else if (tab === 'account') import('../account-view').then(m => m.renderAccountView());
}
