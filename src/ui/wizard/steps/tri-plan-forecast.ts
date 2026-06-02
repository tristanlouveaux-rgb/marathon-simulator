/**
 * Triathlon onboarding forecast step.
 *
 * The triathlon equivalent of the running plan-ready forecast on
 * `plan-preview-v2.ts`. Shown AFTER `initializing` (so the plan and prediction
 * already exist), this is the final reveal before the main view.
 *
 * Three things, all live:
 *   1. Projected finish for the generated plan.
 *   2. Per-discipline session steppers (swim / bike / run). Triathlon is an
 *      hours-budget sport with no single "session" to add, so the lever is
 *      per-discipline: each +1 adds that discipline's representative session
 *      length and regenerates the plan in memory. The forecast and each row's
 *      impact update immediately. The per-discipline horizon model decides how
 *      much each discipline moves the number — no invented multiplier.
 *   3. An optional goal time (slider + live chance of beating it), reusing the
 *      same Monte Carlo the post-onboarding Forecast tab uses.
 *
 * On Continue the chosen volume is committed for real (writes onboarding
 * volume + re-runs initializeSimulator so the plan gains the sessions) and the
 * goal is persisted to `triConfig.targetFinishTimeSec` (carries to the
 * Forecast tab). Mirrors running's bumpSessionsAndRegen contract.
 *
 * Visual: page-flair (atmosphere + ring + sun glint), canonical onboarding
 * glass cards. Single accent = the chance-ladder tone. No emoji, no
 * em-dashes, accent reserved for the submit CTA.
 */

import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { initializeSimulator } from '@/state/initialization';
import { ft, fmtProbPct } from '@/utils/format';
import { liveTone, liveLabel, deriveBounds } from '@/ui/triathlon/goal-time-overlay';
import {
  ZERO_TRI_DELTA,
  type TriSessionDelta,
  triDeltaKey,
  baseTriSessions,
  maxAddTriSessions,
  applyTriSessionDelta,
  forecastTriWithDelta,
  goalChanceTriWithDelta,
  computeBumpedVolume,
} from '@/calculations/tri-session-lever';
import { runTriForecastSim } from '@/calculations/race-forecast-simulation.triathlon';
import { TRI_AVG_SESSION_HOURS } from '@/workouts/plan_engine.triathlon';

const DISCIPLINE_LABELS: Record<Discipline, string> = { swim: 'Swim', bike: 'Bike', run: 'Run' };
const DISTANCE_LABELS: Record<string, string> = {
  sprint: 'Sprint', olympic: 'Olympic', '70.3': '70.3', ironman: 'Ironman',
};

/** "~45 min" label for one session of the discipline. */
function sessionLengthLabel(d: Discipline): string {
  const min = Math.round(TRI_AVG_SESSION_HOURS[d] * 60);
  return `~${min} min`;
}

function fmtDelta(faster: number): string {
  // faster > 0 means the finish dropped (improved) by that many seconds.
  const abs = Math.abs(Math.round(faster));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  const body = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
  return faster > 0 ? `${body} faster` : 'no change';
}

export function renderTriPlanForecast(container: HTMLElement, _state: OnboardingState): void {
  const s = getState();
  const tri = s.triConfig;
  if (!tri) { nextStep(); return; }

  const distanceLabel = DISTANCE_LABELS[tri.distance] ?? tri.distance;
  const base = baseTriSessions(tri);
  const maxAdd = maxAddTriSessions(tri);

  // ── Live state held in the closure ────────────────────────────────────────
  let delta: TriSessionDelta = { ...ZERO_TRI_DELTA };
  let goalEnabled = !!(tri.targetFinishTimeSec && tri.targetFinishTimeSec > 0);
  let goalSec = 0;

  // Memo caches so dragging / stepping never recomputes the same plan twice.
  const cloneCache = new Map<string, SimulatorState>();
  const forecastCache = new Map<string, number | null>();
  const getClone = (d: TriSessionDelta): SimulatorState => {
    const key = triDeltaKey(d);
    let c = cloneCache.get(key);
    if (!c) { c = applyTriSessionDelta(s, d); cloneCache.set(key, c); }
    return c;
  };
  const getForecast = (d: TriSessionDelta): number | null => {
    const key = triDeltaKey(d);
    if (forecastCache.has(key)) return forecastCache.get(key)!;
    const f = forecastTriWithDelta(s, d);
    forecastCache.set(key, f);
    return f;
  };
  // No-goal sim per delta, cached, for the hero's likely-range. The goal chance
  // re-runs the sim live with goalSec (raceDay percentiles are goal-independent).
  const simCache = new Map<string, ReturnType<typeof runTriForecastSim>>();
  const getRangeSim = (d: TriSessionDelta): ReturnType<typeof runTriForecastSim> => {
    const key = triDeltaKey(d);
    if (simCache.has(key)) return simCache.get(key)!;
    const sim = runTriForecastSim(getClone(d), 2000);
    simCache.set(key, sim);
    return sim;
  };

  const baseForecast = getForecast(ZERO_TRI_DELTA);
  if (!baseForecast || baseForecast <= 0) { nextStep(); return; }

  const bounds = deriveBounds(baseForecast);
  const snap = (v: number, st: number) => Math.round(v / st) * st;
  goalSec = goalEnabled && tri.targetFinishTimeSec
    ? Math.min(bounds.maxSec, Math.max(bounds.minSec, snap(tri.targetFinishTimeSec, bounds.stepSec)))
    : Math.min(bounds.maxSec, Math.max(bounds.minSec, snap(baseForecast, bounds.stepSec)));

  // ── Markup ────────────────────────────────────────────────────────────────
  const stepperRow = (d: Discipline): string => `
    <div class="tpf-row" data-disc="${d}">
      <div>
        <div class="tpf-row-label">${DISCIPLINE_LABELS[d]}</div>
        <div class="tpf-row-sub" id="tpf-sub-${d}">${base[d]} sessions/week</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="tpf-step" data-act="minus" data-disc="${d}" aria-label="Remove a ${d} session">&minus;</button>
        <span class="tpf-added" id="tpf-added-${d}">+0</span>
        <button class="tpf-step" data-act="plus" data-disc="${d}" aria-label="Add a ${d} session"${maxAdd[d] <= 0 ? ' disabled' : ''}>+</button>
      </div>
    </div>
  `;

  container.innerHTML = `
    <style>
      @keyframes tpfRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .tpf-rise { opacity:0; animation: tpfRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .tpf-card { position:relative; background:rgba(255,255,255,0.58); backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px); border:1px solid rgba(255,255,255,0.7); border-radius:16px; padding:18px 18px; box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05),inset 0 1px 0 rgba(255,255,255,0.4); }
      .tpf-section-title { font-size:14px; font-weight:500; color:var(--c-black); margin:0 0 2px; }
      .tpf-section-sub { font-size:12.5px; color:var(--c-faint); margin:0 0 14px; line-height:1.5; }

      .tpf-row { display:flex; align-items:center; justify-content:space-between; padding:11px 0; border-bottom:1px solid rgba(0,0,0,0.06); }
      .tpf-row:last-child { border-bottom:none; }
      .tpf-row-label { font-size:14px; color:var(--c-black); }
      .tpf-row-sub { font-size:12px; color:var(--c-muted); margin-top:2px; font-variant-numeric:tabular-nums; }
      .tpf-added { font-size:14px; font-weight:500; color:var(--c-black); min-width:28px; text-align:center; font-variant-numeric:tabular-nums; }
      .tpf-step { width:32px; height:32px; border-radius:50%; background:#FFFFFF; border:1px solid var(--c-border); color:var(--c-black); font-size:18px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; }
      .tpf-step:disabled { opacity:0.35; cursor:default; }

      .tpf-goal-toggle { width:100%; background:none; border:none; color:var(--c-muted); font-size:13px; cursor:pointer; padding:8px 0; text-align:center; }

      .tpf-slider { width:100%; margin:14px 0 4px; -webkit-appearance:none; appearance:none; background:transparent; cursor:pointer; }
      .tpf-slider::-webkit-slider-runnable-track { height:4px; background:rgba(0,0,0,0.10); border-radius:2px; }
      .tpf-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:24px; height:24px; border-radius:50%; background:#fff; border:1px solid rgba(0,0,0,0.18); box-shadow:0 2px 6px rgba(0,0,0,0.18); margin-top:-10px; cursor:pointer; }
      .tpf-slider::-moz-range-track { height:4px; background:rgba(0,0,0,0.10); border-radius:2px; }
      .tpf-slider::-moz-range-thumb { width:24px; height:24px; border-radius:50%; background:#fff; border:1px solid rgba(0,0,0,0.18); box-shadow:0 2px 6px rgba(0,0,0,0.18); cursor:pointer; }

      .tpf-chance { border:1px solid rgba(0,0,0,0.06); border-radius:12px; padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .tpf-cta { width:100%; padding:14px 20px; height:50px; background:var(--c-black); color:#FDFCF7; border:none; border-radius:25px; font-size:15px; font-weight:500; cursor:pointer; margin-top:18px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;display:flex;flex-direction:column">
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('tpf', { variant: 'whisper' })}
        ${buildSunGlint('low')}
      </div>

      <div style="position:relative;z-index:1;padding:36px 20px 140px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(8, 8)}

        <div class="tpf-rise" style="width:100%;max-width:440px;text-align:center;margin-bottom:18px;animation-delay:0.05s">
          <p style="font-size:12.5px;color:var(--c-muted);font-weight:500;margin:0">Projected ${distanceLabel} finish</p>
          <div id="tpf-forecast" style="font-size:clamp(2.4rem,9vw,3.2rem);font-weight:300;color:var(--c-black);letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1.05;margin:8px 0 2px">${ft(baseForecast)}</div>
          <p id="tpf-range" style="font-size:12.5px;color:var(--c-muted);margin:0 0 6px;font-variant-numeric:tabular-nums;min-height:16px"></p>
          <p style="font-size:13px;color:var(--c-faint);margin:0;line-height:1.5">If you follow the plan to race day. Add sessions below to see how training more would change it.</p>
        </div>

        <div class="tpf-card tpf-rise" style="width:100%;max-width:440px;animation-delay:0.12s">
          <p class="tpf-section-title">Add training</p>
          <p class="tpf-section-sub">More volume in a discipline raises the projection. Where it helps most depends on your current fitness in each.</p>
          ${(['swim', 'bike', 'run'] as Discipline[]).map(stepperRow).join('')}
        </div>

        <div class="tpf-rise" style="width:100%;max-width:440px;animation-delay:0.18s">
          <button id="tpf-goal-toggle" class="tpf-goal-toggle" style="${goalEnabled ? 'display:none' : ''}">Do you have a goal time?</button>
          <div id="tpf-goal-card" class="tpf-card" style="margin-top:12px;${goalEnabled ? '' : 'display:none'}">
            <p class="tpf-section-title">Goal time</p>
            <p class="tpf-section-sub">Set a race-day target. We simulate the rest of your block to show your chance of hitting it.</p>
            <div style="text-align:center">
              <div id="tpf-goal-time" style="font-size:34px;font-weight:300;color:var(--c-black);letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${ft(goalSec)}</div>
            </div>
            <input id="tpf-goal-slider" class="tpf-slider" type="range" min="${bounds.minSec}" max="${bounds.maxSec}" step="${bounds.stepSec}" value="${goalSec}" />
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums;margin-bottom:14px">
              <span>${ft(bounds.minSec)}</span><span>${ft(bounds.maxSec)}</span>
            </div>
            <div id="tpf-chance" class="tpf-chance"></div>
          </div>
        </div>

        <div style="width:100%;max-width:440px">
          <button id="tpf-continue" class="tpf-cta tpf-rise" style="animation-delay:0.26s">Looks good, let's go</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  // ── Live wiring ─────────────────────────────────────────────────────────
  const forecastEl = container.querySelector('#tpf-forecast') as HTMLElement | null;
  const chanceEl = container.querySelector('#tpf-chance') as HTMLElement | null;
  const goalTimeEl = container.querySelector('#tpf-goal-time') as HTMLElement | null;
  const goalSlider = container.querySelector('#tpf-goal-slider') as HTMLInputElement | null;
  const goalCard = container.querySelector('#tpf-goal-card') as HTMLElement | null;
  const goalToggle = container.querySelector('#tpf-goal-toggle') as HTMLElement | null;

  const renderChance = (): void => {
    if (!goalEnabled || !chanceEl) return;
    // Run the sim on the already-regenerated clone for the current delta so the
    // chance and the displayed forecast agree. Same cost as the Forecast tab.
    const sim = runTriForecastSim(getClone(delta), 2000, goalSec);
    if (!sim || sim.goalProbability == null) {
      chanceEl.innerHTML = `<div style="font-size:12px;color:var(--c-faint)">Forecast unavailable.</div>`;
      return;
    }
    const pct = sim.goalProbability * 100;
    chanceEl.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px">
        <span style="font-size:24px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums;line-height:1">${fmtProbPct(pct)}</span>
        <span style="font-size:12px;color:var(--c-muted)">chance of ${ft(goalSec)}</span>
      </div>
      <span style="font-size:12px;font-weight:600;color:${liveTone(pct)}">${liveLabel(pct)}</span>
    `;
  };

  const rangeEl = container.querySelector('#tpf-range') as HTMLElement | null;
  const renderRange = (): void => {
    if (!rangeEl) return;
    const sim = getRangeSim(delta);
    // p25/p75 = interquartile band: half of simulated race-day outcomes land here.
    // Lower seconds = faster, so p25 is the fast end.
    if (sim && sim.raceDay && (sim.raceDay.p75 - sim.raceDay.p25) > 60) {
      rangeEl.textContent = `Likely ${ft(sim.raceDay.p25)} to ${ft(sim.raceDay.p75)} on race day`;
    } else {
      rangeEl.textContent = '';
    }
  };

  const refresh = (): void => {
    const current = getForecast(delta) ?? baseForecast;
    if (forecastEl) forecastEl.textContent = ft(current);
    renderRange();
    for (const d of ['swim', 'bike', 'run'] as Discipline[]) {
      const subEl = container.querySelector(`#tpf-sub-${d}`) as HTMLElement | null;
      const addedEl = container.querySelector(`#tpf-added-${d}`) as HTMLElement | null;
      const minusBtn = container.querySelector(`.tpf-step[data-act="minus"][data-disc="${d}"]`) as HTMLButtonElement | null;
      const plusBtn = container.querySelector(`.tpf-step[data-act="plus"][data-disc="${d}"]`) as HTMLButtonElement | null;
      if (addedEl) addedEl.textContent = `+${delta[d]}`;
      if (minusBtn) minusBtn.disabled = delta[d] <= 0;
      if (plusBtn) plusBtn.disabled = delta[d] >= maxAdd[d];
      if (subEl) {
        const count = base[d] + delta[d];
        const canAddMore = delta[d] < maxAdd[d];
        if (canAddMore) {
          // Show the projected impact of the NEXT session in this discipline.
          const next: TriSessionDelta = { ...delta, [d]: delta[d] + 1 } as TriSessionDelta;
          const nextF = getForecast(next) ?? current;
          const impact = current - nextF; // positive = faster
          subEl.textContent = `${count} sessions/week · +1 ${sessionLengthLabel(d)}, ${fmtDelta(impact)}`;
        } else if (maxAdd[d] <= 0) {
          // Discipline starts at the cap. Explain why there's no + so the
          // disabled control reads as deliberate: the plan adds load through
          // longer sessions across the block, not extra weekly sessions.
          subEl.textContent = `${count} sessions/week · the plan builds volume over the block`;
        } else {
          subEl.textContent = `${count} sessions/week · at the recommended cap`;
        }
      }
    }
    renderChance();
  };
  refresh();

  // Steppers
  container.querySelectorAll('.tpf-step').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLButtonElement;
      const d = el.dataset.disc as Discipline;
      const act = el.dataset.act;
      if (act === 'plus' && delta[d] < maxAdd[d]) delta = { ...delta, [d]: delta[d] + 1 };
      else if (act === 'minus' && delta[d] > 0) delta = { ...delta, [d]: delta[d] - 1 };
      else return;
      refresh();
    });
  });

  // Goal reveal
  goalToggle?.addEventListener('click', () => {
    goalEnabled = true;
    if (goalToggle) goalToggle.style.display = 'none';
    if (goalCard) goalCard.style.display = '';
    renderChance();
  });

  // Goal slider — debounced sim per frame.
  let pending = false;
  goalSlider?.addEventListener('input', () => {
    goalSec = Number(goalSlider.value);
    if (goalTimeEl) goalTimeEl.textContent = ft(goalSec);
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => { pending = false; renderChance(); });
    }
  });

  // Continue — commit the chosen volume + goal, then advance.
  container.querySelector('#tpf-continue')?.addEventListener('click', () => {
    commitTriPlanForecast(delta, goalEnabled ? goalSec : null);
    nextStep();
  });
}

/**
 * Persist the chosen per-discipline volume and goal. Mirrors running's
 * bumpSessionsAndRegen: write the bumped volume into the onboarding record and
 * re-run initializeSimulator so the generated weeks actually gain the sessions
 * (the plan is built at `initializing` and only regenerates through this path).
 * The goal is pinned AFTER regen because initializeSimulator rebuilds triConfig.
 */
function commitTriPlanForecast(delta: TriSessionDelta, goalSec: number | null): void {
  const hasDelta = delta.swim > 0 || delta.bike > 0 || delta.run > 0;
  const tri = getState().triConfig;
  if (hasDelta && tri) {
    const { volumeSplit, timeAvailableHoursPerWeek } = computeBumpedVolume(tri, delta);
    updateOnboarding({ triVolumeSplit: volumeSplit, triTimeAvailableHoursPerWeek: timeAvailableHoursPerWeek });
    try {
      const ob = getState().onboarding;
      if (ob) initializeSimulator(ob);
    } catch (e) {
      console.warn('[TriPlanForecast] volume-bump regen failed:', e);
    }
  }
  if (goalSec && goalSec > 0) {
    const ms = getMutableState();
    if (ms.triConfig) ms.triConfig.targetFinishTimeSec = goalSec;
  }
  saveState();
}
