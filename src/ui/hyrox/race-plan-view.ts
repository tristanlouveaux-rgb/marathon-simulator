/**
 * HYROX race plan sub-page, a drill-down from the Forecast tab.
 *
 * Every leg in race order with the goal split, the race clock at the end of
 * the leg and the forecast's own split (muted); a Checkpoints view lists the
 * clock after each run. Numbers come from buildHyroxRacePlan
 * (hyrox-race-plan.ts), whose forecast columns are predictHyroxRace's own.
 *
 * Pattern: the page skeleton is renderHyroxChipDetail
 * (forecast-chip-detail-view.ts), the rows the Race order grid
 * (forecast-view.ts renderRaceOrderTable), the toggle the Race order /
 * Station order control. Neutrals only, no section capitals.
 *
 * Side: tracking (forecast column) and planning (goal splits).
 */

import { getState } from '@/state/store';
import type { SimulatorState } from '@/types/state';
import { renderTabBar, wireTabBarHandlers, type TabId } from '@/ui/tab-bar';
import { atmosphereGradient, buildSunGlint, buildRingBackground } from '@/ui/page-flair';
import { predictHyroxRace, type HyroxPrediction } from '@/calculations/race-prediction.hyrox';
import { buildHyroxRacePlan, type HyroxRacePlan, type HyroxRacePlanLeg } from '@/calculations/hyrox-race-plan';
import { ftRounded } from '@/utils/format';

const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const CARD = 'background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:16px';
const GRID = 'display:grid;grid-template-columns:minmax(0,1fr) 52px 64px 52px;align-items:center;column-gap:10px';
const GRID_NO_FC = 'display:grid;grid-template-columns:minmax(0,1fr) 52px 64px;align-items:center;column-gap:10px';

function fmt(sec: number): string {
  return Number.isFinite(sec) && sec > 0 ? ftRounded(sec) : '';
}

/** "3 min", "40 sec": a shortfall in plain words. */
function fmtShortfall(sec: number): string {
  const t = Math.round(sec);
  return t < 60 ? `${t} sec` : `${Math.round(t / 60)} min`;
}

/** The one plain line for a goal the floors cannot reach; '' otherwise. */
export function racePlanFeasibilityLine(plan: Pick<HyroxRacePlan, 'feasibility' | 'planSec' | 'shortfallSec'>): string {
  if (plan.feasibility !== 'unrealistic') return '';
  return `This goal is about ${fmtShortfall(plan.shortfallSec)} out of reach. With every leg at the top-1% median of your field, the splits reach ${fmt(plan.planSec)}.`;
}

/** Subhead under the title. */
export function racePlanSubhead(plan: Pick<HyroxRacePlan, 'goalSource' | 'goalSec'>): string {
  return plan.goalSource === 'goal'
    ? `Splits for your ${fmt(plan.goalSec)} goal`
    : `Splits for your ${fmt(plan.goalSec)} forecast`;
}

function legRow(leg: HyroxRacePlanLeg, withForecast: boolean, first: boolean): string {
  const border = first ? 'none' : '1px solid rgba(0,0,0,0.05)';
  return `
    <div data-rp-leg="${leg.kind === 'run' ? `run-${leg.legNumber}` : leg.station}" style="${withForecast ? GRID : GRID_NO_FC};padding:9px 0;border-top:${border};font-size:13px">
      <span style="color:${leg.kind === 'run' ? TEXT_S : TEXT_M};min-width:0">${leg.label}</span>
      <span style="text-align:right;color:${TEXT_M};font-variant-numeric:tabular-nums">${fmt(leg.goalSec)}</span>
      <span style="text-align:right;color:${TEXT_M};font-weight:600;font-variant-numeric:tabular-nums">${fmt(leg.clockSec)}</span>
      ${withForecast ? `<span style="text-align:right;color:var(--c-faint);font-variant-numeric:tabular-nums">${fmt(leg.forecastSec)}</span>` : ''}
    </div>
  `;
}

/** The splits card: 16 legs, the Roxzone, one caption. */
export function renderRacePlanSplits(plan: HyroxRacePlan): string {
  const withForecast = plan.goalSource === 'goal';
  const grid = withForecast ? GRID : GRID_NO_FC;
  const head = `
    <div style="${grid};padding:0 0 6px;font-size:11px;color:var(--c-faint)">
      <span></span>
      <span style="text-align:right">${withForecast ? 'Goal' : 'Split'}</span>
      <span style="text-align:right">Clock</span>
      ${withForecast ? '<span style="text-align:right">Forecast</span>' : ''}
    </div>
  `;
  const rows = plan.legs.map((l, i) => legRow(l, withForecast, i === 0)).join('');
  const rox = `
    <div data-rp-leg="roxzone" style="${grid};padding:9px 0;border-top:1px solid rgba(0,0,0,0.05);font-size:13px">
      <span style="color:${TEXT_M}">Roxzone</span>
      <span style="text-align:right;color:${TEXT_M};font-variant-numeric:tabular-nums">${fmt(plan.roxzone.goalSec)}</span>
      <span></span>
      ${withForecast ? `<span style="text-align:right;color:var(--c-faint);font-variant-numeric:tabular-nums">${fmt(plan.roxzone.forecastSec)}</span>` : ''}
    </div>
  `;
  const doublesLine = plan.isDoubles ? ' Partners run every leg together; station splits are the pair\'s time.' : '';
  return `
    <div id="rp-splits" style="${CARD};margin-bottom:14px">
      ${head}
      ${rows}
      ${rox}
      <div style="font-size:11px;color:var(--c-faint);line-height:1.5;margin-top:10px">Clock includes the Roxzone, shared evenly around the stations. Run legs follow the forecast's per-leg fade.${doublesLine}</div>
    </div>
  `;
}

/** The checkpoints card: the race clock after each run, then the finish. */
export function renderRacePlanCheckpoints(plan: HyroxRacePlan): string {
  const rows = plan.checkpoints.map((c, i) => `
    <div data-rp-checkpoint="${c.label}" style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;border-top:${i === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'};font-size:13px">
      <span style="color:${c.label === 'Finish' ? TEXT_M : TEXT_S}">${c.label === 'Finish' ? 'Finish' : `After ${c.label}`}</span>
      <span style="color:${TEXT_M};font-weight:600;font-variant-numeric:tabular-nums">${fmt(c.clockSec)}</span>
    </div>
  `).join('');
  return `
    <div id="rp-checkpoints" style="${CARD};margin-bottom:14px;display:none">
      ${rows}
      <div style="font-size:11px;color:var(--c-faint);line-height:1.5;margin-top:10px">Race clock as each run ends.</div>
    </div>
  `;
}

const TOGGLE_ON = 'border:1px solid var(--c-black);background:var(--c-black);color:#FDFCF7';
const TOGGLE_OFF = 'border:1px solid rgba(0,0,0,0.12);background:transparent;color:var(--c-muted)';

/** Page body below the title: the feasibility line, the goal link, the
 *  toggle and both cards. */
export function renderRacePlanBody(plan: HyroxRacePlan): string {
  const line = racePlanFeasibilityLine(plan);
  const forecastLine = plan.goalSource === 'goal'
    ? `<div style="font-size:12px;color:${TEXT_S};text-align:center;margin:-6px 0 10px">Forecast ${fmt(plan.forecastSec)}</div>`
    : '';
  return `
    ${forecastLine}
    ${line ? `<div id="rp-feasibility" style="font-size:12px;color:${TEXT_M};line-height:1.5;text-align:center;margin:0 4px 10px">${line}</div>` : ''}
    <div style="text-align:center;margin-bottom:14px">
      <button id="rp-goal-link" type="button" style="font:inherit;font-size:12px;color:var(--c-muted);background:none;border:none;padding:0;cursor:pointer">${plan.goalSource === 'goal' ? 'Change goal ›' : 'Set a goal ›'}</button>
    </div>
    <div role="tablist" style="display:flex;gap:8px;margin-bottom:12px">
      <button type="button" data-rp-mode="splits" role="tab" aria-selected="true" style="flex:1;padding:8px 10px;border-radius:10px;${TOGGLE_ON};font-size:12px;font-weight:500;cursor:pointer">Splits</button>
      <button type="button" data-rp-mode="checkpoints" role="tab" aria-selected="false" style="flex:1;padding:8px 10px;border-radius:10px;${TOGGLE_OFF};font-size:12px;font-weight:500;cursor:pointer">Checkpoints</button>
    </div>
    ${renderRacePlanSplits(plan)}
    ${renderRacePlanCheckpoints(plan)}
  `;
}

/**
 * The Forecast tab's entry row: one line and a caption, no numbers (the goal
 * already shows in the hero). Opens the race plan.
 */
export function buildRacePlanEntryCard(state: Pick<SimulatorState, 'hyroxConfig'>): string {
  const hasGoal = (state.hyroxConfig?.targetFinishTimeSec ?? 0) > 0;
  const caption = hasGoal
    ? 'Goal split and race clock for every leg, beside the forecast.'
    : 'Split and race clock for every leg at your forecast. Add a goal to pace to it.';
  return `
    <div id="hx-race-plan-entry" role="button" tabindex="0" style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:16px 20px;margin-bottom:14px;display:flex;align-items:center;gap:12px;cursor:pointer;-webkit-tap-highlight-color:transparent">
      <span style="flex:1;min-width:0">
        <span style="display:block;font-size:13px;font-weight:600;color:var(--c-black)">Race plan</span>
        <span style="display:block;font-size:12px;color:var(--c-muted);margin-top:3px;line-height:1.4">${caption}</span>
      </span>
      <span style="color:var(--c-faint);font-size:16px;line-height:1;flex-shrink:0">›</span>
    </div>
  `;
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('@/ui/home-view').then(({ renderHomeView }) => renderHomeView());
  else if (tab === 'plan') import('@/ui/hyrox/plan-view').then(({ renderHyroxPlanView }) => renderHyroxPlanView());
  else if (tab === 'stats') import('@/ui/hyrox/stats-view').then(({ renderHyroxStatsView }) => renderHyroxStatsView());
  else if (tab === 'account') import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
  else if (tab === 'forecast') import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
}

/** Render the race plan page into #app-root. */
export function renderHyroxRacePlanView(): void {
  const root = document.getElementById('app-root');
  if (!root) return;
  const s = getState();
  const prediction: HyroxPrediction | null = predictHyroxRace(s);
  if (!prediction) {
    import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
    return;
  }
  const plan = buildHyroxRacePlan(s, prediction);
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  root.innerHTML = `
    <div id="rp-view" class="safe-top-bleed" style="position:relative;min-height:100vh;background:${atmosphereGradient('sky')};font-family:var(--f);overflow-x:hidden">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxrp', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}
      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">
        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <button id="rp-back-btn" style="background:transparent;border:none;font-size:14px;color:${TEXT_S};cursor:pointer;padding:0;font-family:var(--f)">← Back</button>
          <button id="rp-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>
        <div style="text-align:center;padding:20px 20px 16px">
          <div style="font-size:30px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.1">Race plan</div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">${racePlanSubhead(plan)}</div>
        </div>
        <div style="padding:0 16px">
          ${renderRacePlanBody(plan)}
        </div>
      </div>
      ${renderTabBar('forecast')}
    </div>
  `;

  document.getElementById('rp-back-btn')?.addEventListener('click', () => {
    import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
  });
  document.getElementById('rp-account-btn')?.addEventListener('click', () => {
    import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
  });
  document.getElementById('rp-goal-link')?.addEventListener('click', () => {
    const current = predictHyroxRace(getState());
    if (!current) return;
    import('./goal-modal').then(({ openHyroxGoalModal }) => {
      openHyroxGoalModal(current, { onChange: () => renderHyroxRacePlanView() });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-rp-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-rp-mode');
      const splits = document.getElementById('rp-splits');
      const checkpoints = document.getElementById('rp-checkpoints');
      if (!splits || !checkpoints) return;
      splits.style.display = mode === 'splits' ? '' : 'none';
      checkpoints.style.display = mode === 'checkpoints' ? '' : 'none';
      root.querySelectorAll<HTMLButtonElement>('[data-rp-mode]').forEach(b => {
        const on = b === btn;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.style.background = on ? 'var(--c-black)' : 'transparent';
        b.style.color = on ? '#FDFCF7' : 'var(--c-muted)';
        b.style.borderColor = on ? 'var(--c-black)' : 'rgba(0,0,0,0.12)';
      });
    });
  });
  wireTabBarHandlers(navigateTab);
}
