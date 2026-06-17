/**
 * Triathlon onboarding forecast step.
 *
 * The final reveal before the main view, shown AFTER `initializing` (so the plan
 * and prediction already exist). This step IS the real Forecast surface, brought
 * forward into onboarding: the same marquee hero (finish + per-leg cards) and the
 * same 12-factor fingerprint grid the post-onboarding Forecast tab shows, so the
 * user lands in the app already familiar with it. "Basically the same, not that
 * different" — it reuses the shipped `renderTriForecastMarquee` /
 * `renderTriForecastFingerprint` verbatim.
 *
 * Tweakable in two ways:
 *   1. Add-training sliders (swim / bike / run). Triathlon is an hours-budget
 *      sport, so the lever is per-discipline: each +1 adds that discipline's
 *      representative session and regenerates the plan in memory. The hero and
 *      each row's impact update live.
 *   2. Every factor chip and per-leg card is tappable, drilling into the same
 *      explainer / editor pages the live app uses (markers, bike & aero,
 *      transitions, venue). The drill-downs are opened wizard-aware (no tab bar,
 *      "← Back" returns here) via `TriDetailNavOpts`.
 *   3. An optional goal time (slider + live chance of beating it).
 *
 * Coherence: the lever writes the regenerated plan + prediction THROUGH to the
 * live store (`ms.wks`, `ms.triConfig.prediction`) on each committed change, so
 * the hero, the grid, and any drill-down all read one `getState()` and agree.
 * `triConfig.volumeSplit` is left untouched so the slider's base count stays
 * stable. The authoritative commit (onboarding volume + `initializeSimulator`)
 * still runs on Continue, mirroring running's bumpSessionsAndRegen contract.
 */

import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types/state';
import type { Discipline, TriRacePrediction } from '@/types/triathlon';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { initializeSimulator } from '@/state/initialization';
import { ft, fmtProbPct } from '@/utils/format';
import { liveTone, liveLabel, deriveBounds } from '@/ui/triathlon/goal-time-overlay';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { renderTriForecastMarquee } from '@/ui/triathlon/race-forecast-marquee';
import { renderTriForecastFingerprint, type TriChipKey } from '@/ui/triathlon/race-forecast-fingerprint';
import type { TriDetailNavOpts } from '@/ui/triathlon/forecast-chip-detail-view';
import {
  ZERO_TRI_DELTA,
  type TriSessionDelta,
  triDeltaKey,
  baseTriSessions,
  maxAddTriSessions,
  applyTriSessionDelta,
  computeBumpedVolume,
} from '@/calculations/tri-session-lever';
import { runTriForecastSim } from '@/calculations/race-forecast-simulation.triathlon';
import { TRI_AVG_SESSION_HOURS } from '@/workouts/plan_engine.triathlon';

const DISCIPLINE_LABELS: Record<Discipline, string> = { swim: 'Swim', bike: 'Bike', run: 'Run' };

// ── Lever state, hoisted to module scope so it survives the app-root re-render
// when the user returns from a chip / leg drill-down. Reset on commit. ─────────
let savedDelta: TriSessionDelta = { ...ZERO_TRI_DELTA };
let savedGoalEnabled = false;
let savedGoalSec = 0;
let savedGoalInit = false;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveStateDebounced(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveState(); saveTimer = null; }, 400);
}

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

  const base = baseTriSessions(tri);
  const maxAdd = maxAddTriSessions(tri);

  // Restore lever state from module scope (survives drill-down round-trips).
  let delta: TriSessionDelta = { ...savedDelta };
  let goalEnabled = savedGoalEnabled;
  let goalSec = savedGoalSec;

  // ── Per-delta caches (render-scoped: recomputed once per fresh render, reused
  // while dragging). predFor also populates planCache. ─────────────────────────
  const planCache = new Map<string, SimulatorState['wks']>();
  const predCache = new Map<string, TriRacePrediction | null>();
  const predFor = (d: TriSessionDelta): TriRacePrediction | null => {
    const key = triDeltaKey(d);
    if (predCache.has(key)) return predCache.get(key)!;
    const clone = applyTriSessionDelta(getState(), d);
    const pred = predictTriathlonRace(clone);
    predCache.set(key, pred);
    planCache.set(key, clone.wks);
    return pred;
  };
  /** A state object reflecting `d` (delta plan + prediction) for the pure
   *  marquee / fingerprint renderers. Does not write the store. */
  const stateForDelta = (d: TriSessionDelta): { st: SimulatorState; pred: TriRacePrediction | null } => {
    const cur = getState();
    const pred = predFor(d);
    const wks = planCache.get(triDeltaKey(d)) ?? cur.wks;
    const st: SimulatorState = {
      ...cur,
      wks,
      triConfig: cur.triConfig ? { ...cur.triConfig, prediction: pred ?? undefined } : cur.triConfig,
    };
    return { st, pred };
  };
  /** Write the delta's plan + prediction through to the live store so the grid
   *  and every drill-down read coherent numbers. Leaves volumeSplit untouched. */
  const commitDelta = (d: TriSessionDelta): void => {
    const pred = predFor(d);
    const wks = planCache.get(triDeltaKey(d));
    const ms = getMutableState();
    if (ms.triConfig) ms.triConfig.prediction = pred ?? undefined;
    if (wks) ms.wks = wks;
    saveStateDebounced();
  };

  const baseForecast = predFor(ZERO_TRI_DELTA)?.totalSec ?? 0;
  if (!baseForecast || baseForecast <= 0) { nextStep(); return; }

  const bounds = deriveBounds(baseForecast);
  const snap = (v: number, st: number) => Math.round(v / st) * st;
  goalSec = savedGoalInit
    ? Math.min(bounds.maxSec, Math.max(bounds.minSec, snap(goalSec, bounds.stepSec)))
    : Math.min(bounds.maxSec, Math.max(bounds.minSec, snap(baseForecast, bounds.stepSec)));

  // ── Markup ────────────────────────────────────────────────────────────────
  const leverRow = (d: Discipline): string => {
    const canTweak = maxAdd[d] > 0;
    return `
      <div class="tpf-lever" data-disc="${d}">
        <div class="tpf-lever-head">
          <div class="tpf-row-label">${DISCIPLINE_LABELS[d]}</div>
          <div class="tpf-added" id="tpf-added-${d}">+${delta[d]}</div>
        </div>
        ${canTweak
          ? `<input class="m-slider-glass" type="range" id="tpf-slider-${d}" min="0" max="${maxAdd[d]}" step="1" value="${delta[d]}" aria-label="Add ${d} sessions per week" />`
          : ''}
        <div class="tpf-row-sub" id="tpf-sub-${d}"></div>
      </div>
    `;
  };

  container.innerHTML = `
    <style>
      @keyframes tpfRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .tpf-rise { opacity:0; animation: tpfRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .tpf-card { position:relative; background:rgba(255,255,255,0.58); backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px); border:1px solid rgba(255,255,255,0.7); border-radius:16px; padding:18px; box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05),inset 0 1px 0 rgba(255,255,255,0.4); }
      .tpf-section-title { font-size:14px; font-weight:500; color:var(--c-black); margin:0 0 2px; }
      .tpf-section-sub { font-size:12.5px; color:var(--c-faint); margin:0 0 14px; line-height:1.5; }

      .tpf-lever { padding:12px 0; border-bottom:1px solid rgba(0,0,0,0.06); }
      .tpf-lever:last-child { border-bottom:none; padding-bottom:2px; }
      .tpf-lever-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
      .tpf-row-label { font-size:14px; color:var(--c-black); }
      .tpf-row-sub { font-size:12px; color:var(--c-muted); margin-top:8px; font-variant-numeric:tabular-nums; line-height:1.4; }
      .tpf-added { font-size:14px; font-weight:500; color:var(--c-black); min-width:28px; text-align:right; font-variant-numeric:tabular-nums; }

      .tpf-goal-toggle { width:100%; background:none; border:none; color:var(--c-muted); font-size:13px; cursor:pointer; padding:8px 0; text-align:center; }
      .tpf-chance { border:1px solid rgba(0,0,0,0.06); border-radius:12px; padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .tpf-grid-caption { font-size:12px; color:var(--c-faint); line-height:1.5; text-align:center; padding:10px 16px 0; }
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

        <div id="tpf-marquee" class="tpf-rise" style="width:100%;max-width:440px;animation-delay:0.05s"></div>

        <div class="tpf-card tpf-rise" style="width:100%;max-width:440px;animation-delay:0.12s">
          <p class="tpf-section-title">Add training</p>
          <p class="tpf-section-sub">More volume in a discipline raises the projection. Where it helps most depends on your current fitness in each.</p>
          ${(['swim', 'bike', 'run'] as Discipline[]).map(leverRow).join('')}
        </div>

        <div class="tpf-rise" style="width:100%;max-width:440px;animation-delay:0.18s">
          <button id="tpf-goal-toggle" class="tpf-goal-toggle" style="${goalEnabled ? 'display:none' : ''}">Do you have a goal time?</button>
          <div id="tpf-goal-card" class="tpf-card" style="margin-top:12px;${goalEnabled ? '' : 'display:none'}">
            <p class="tpf-section-title">Goal time</p>
            <p class="tpf-section-sub">Set a race-day target. We simulate the rest of your block to show your chance of hitting it.</p>
            <div style="text-align:center">
              <div id="tpf-goal-time" style="font-size:34px;font-weight:300;color:var(--c-black);letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${ft(goalSec)}</div>
            </div>
            <input id="tpf-goal-slider" class="m-slider-glass" type="range" min="${bounds.minSec}" max="${bounds.maxSec}" step="${bounds.stepSec}" value="${goalSec}" />
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums;margin-bottom:14px">
              <span>${ft(bounds.minSec)}</span><span>${ft(bounds.maxSec)}</span>
            </div>
            <div id="tpf-chance" class="tpf-chance"></div>
          </div>
        </div>

        <div id="tpf-grid" class="tpf-rise" style="width:100%;max-width:440px;animation-delay:0.22s"></div>
        <p class="tpf-grid-caption" style="max-width:440px">Tap any factor to see how it is calculated, or fill in what is missing.</p>

        <div style="width:100%;max-width:440px">
          <button id="tpf-continue" class="tpf-cta tpf-rise" style="animation-delay:0.28s">Looks good, let's go</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  // ── Drill-down nav context: wizard-aware (no tab bar, Back returns here) ─────
  const detailOpts: TriDetailNavOpts = {
    showTabBar: false,
    onBack: () => renderTriPlanForecast(container, _state),
  };

  const marqueeEl = container.querySelector('#tpf-marquee') as HTMLElement | null;
  const gridEl = container.querySelector('#tpf-grid') as HTMLElement | null;
  const chanceEl = container.querySelector('#tpf-chance') as HTMLElement | null;
  const goalTimeEl = container.querySelector('#tpf-goal-time') as HTMLElement | null;
  const goalSlider = container.querySelector('#tpf-goal-slider') as HTMLInputElement | null;
  const goalCard = container.querySelector('#tpf-goal-card') as HTMLElement | null;
  const goalToggle = container.querySelector('#tpf-goal-toggle') as HTMLElement | null;

  // ── Paint helpers ───────────────────────────────────────────────────────────
  const paintHero = (st: SimulatorState): void => {
    if (marqueeEl) marqueeEl.innerHTML = renderTriForecastMarquee(st);
    wireLegTaps();
  };
  const paintGrid = (st: SimulatorState, pred: TriRacePrediction | null): void => {
    if (gridEl) gridEl.innerHTML = renderTriForecastFingerprint(st, pred);
    wireChipTaps();
  };

  const wireChipTaps = (): void => {
    container.querySelectorAll<HTMLElement>('.tri-rfc-chip').forEach(el => {
      const open = () => {
        const key = el.dataset.cluster as TriChipKey | undefined;
        if (!key) return;
        if (key === 'bike-setup') {
          import('@/ui/triathlon/bike-setup-view').then(m =>
            m.openBikeSetupOverlay(() => renderTriPlanForecast(container, _state)));
          return;
        }
        import('@/ui/triathlon/forecast-chip-detail-view').then(m =>
          m.renderTriForecastChipDetail(key, detailOpts));
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  };
  const wireLegTaps = (): void => {
    container.querySelectorAll<HTMLElement>('[data-leg-tap]').forEach(el => {
      const open = () => {
        const leg = el.dataset.legTap as 'swim' | 'bike' | 'run' | undefined;
        if (!leg) return;
        import('@/ui/triathlon/race-forecast-leg-detail').then(m =>
          m.renderTriLegBreakdown(leg, detailOpts));
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  };

  // ── Add-training row sub-lines + readouts ───────────────────────────────────
  const updateLeverLabels = (): void => {
    const current = predFor(delta)?.totalSec ?? baseForecast;
    for (const d of ['swim', 'bike', 'run'] as Discipline[]) {
      const subEl = container.querySelector(`#tpf-sub-${d}`) as HTMLElement | null;
      const addedEl = container.querySelector(`#tpf-added-${d}`) as HTMLElement | null;
      if (addedEl) addedEl.textContent = `+${delta[d]}`;
      if (!subEl) continue;
      const count = base[d] + delta[d];
      const canAddMore = delta[d] < maxAdd[d];
      if (canAddMore) {
        const next: TriSessionDelta = { ...delta, [d]: delta[d] + 1 } as TriSessionDelta;
        const nextF = predFor(next)?.totalSec ?? current;
        const impact = current - nextF; // positive = faster
        subEl.textContent = `${count} sessions/week · +1 ${sessionLengthLabel(d)}, ${fmtDelta(impact)}`;
      } else if (maxAdd[d] <= 0) {
        subEl.textContent = `${count} sessions/week · the plan builds volume over the block`;
      } else {
        subEl.textContent = `${count} sessions/week · at the recommended cap`;
      }
    }
  };

  // ── Goal chance ─────────────────────────────────────────────────────────────
  const renderChance = (): void => {
    if (!goalEnabled || !chanceEl) return;
    const { st } = stateForDelta(delta);
    const sim = runTriForecastSim(st, 2000, goalSec);
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

  // ── Initial paint (also writes the current delta through to the store) ───────
  const initial = stateForDelta(delta);
  commitDelta(delta);
  paintHero(initial.st);
  paintGrid(initial.st, initial.pred);
  updateLeverLabels();
  renderChance();

  // ── Discipline sliders. input → live hero + labels (no commit, no grid flicker);
  // change → commit through + repaint grid + chance. ──────────────────────────
  for (const d of ['swim', 'bike', 'run'] as Discipline[]) {
    const slider = container.querySelector(`#tpf-slider-${d}`) as HTMLInputElement | null;
    if (!slider) continue;
    let pending = false;
    slider.addEventListener('input', () => {
      delta = { ...delta, [d]: Number(slider.value) } as TriSessionDelta;
      savedDelta = { ...delta };
      if (!pending) {
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          paintHero(stateForDelta(delta).st);
          updateLeverLabels();
        });
      }
    });
    slider.addEventListener('change', () => {
      delta = { ...delta, [d]: Number(slider.value) } as TriSessionDelta;
      savedDelta = { ...delta };
      commitDelta(delta);
      const { st, pred } = stateForDelta(delta);
      paintHero(st);
      paintGrid(st, pred);
      updateLeverLabels();
      renderChance();
    });
  }

  // ── Goal reveal ─────────────────────────────────────────────────────────────
  goalToggle?.addEventListener('click', () => {
    goalEnabled = true;
    savedGoalEnabled = true;
    savedGoalInit = true;
    savedGoalSec = goalSec;
    if (goalToggle) goalToggle.style.display = 'none';
    if (goalCard) goalCard.style.display = '';
    renderChance();
  });

  // ── Goal slider — debounced sim per frame ───────────────────────────────────
  let goalPending = false;
  goalSlider?.addEventListener('input', () => {
    goalSec = Number(goalSlider.value);
    savedGoalSec = goalSec;
    savedGoalInit = true;
    if (goalTimeEl) goalTimeEl.textContent = ft(goalSec);
    if (!goalPending) {
      goalPending = true;
      requestAnimationFrame(() => { goalPending = false; renderChance(); });
    }
  });

  // ── Continue — commit volume + goal authoritatively, then advance ───────────
  container.querySelector('#tpf-continue')?.addEventListener('click', () => {
    commitTriPlanForecast(delta, goalEnabled ? goalSec : null);
    // Reset lever state so a future onboarding run starts clean.
    savedDelta = { ...ZERO_TRI_DELTA };
    savedGoalEnabled = false;
    savedGoalSec = 0;
    savedGoalInit = false;
    nextStep();
  });
}

/**
 * Persist the chosen per-discipline volume and goal. Mirrors running's
 * bumpSessionsAndRegen: write the bumped volume into the onboarding record and
 * re-run initializeSimulator so the generated weeks actually gain the sessions.
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
