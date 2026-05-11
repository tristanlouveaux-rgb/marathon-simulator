import type { OnboardingState } from '@/types/onboarding';
import { MILESTONE_THRESHOLDS, MILESTONE_LABELS } from '@/types/onboarding';
import { initializeSimulator } from '@/state/initialization';
import { cv } from '@/calculations/vdot';
import type { PBs } from '@/types/training';
import { nextStep, updateOnboarding } from '../controller';
import { getState } from '@/state/store';
import { renderProgressIndicator } from '../renderer';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';

// Re-export for backwards compatibility
export { initializeSimulator as initializeSimulatorFromOnboarding } from '@/state/initialization';
export type { CalculationResult } from '@/state/initialization';

/**
 * Render the initialization animation.
 * Glassy card with a central glass-circle filling indicator. Updates in-place
 * via setStepLabel + setProgress as the pipeline advances — no full re-render.
 */
const INIT_RADIUS = 44;
const INIT_CIRCUMFERENCE = 2 * Math.PI * INIT_RADIUS; // ~276.5

export function renderInitializing(container: HTMLElement, state: OnboardingState): void {
  // Initial state: 0% filled, "Mapping" label.
  container.innerHTML = `
    <style>
      @keyframes initRise { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
      .init-rise { opacity:0; animation: initRise 0.7s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      @keyframes initBreathe { 0%, 100% { opacity: 0.85; } 50% { opacity: 1; } }
      .init-fill { animation: initBreathe 2.6s ease-in-out infinite; }
      .init-label-fade { transition: opacity 0.45s ease; }
    </style>

    <div style="min-height:100vh;position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;background:#FAF9F6">

      <!-- Background: atmosphere → whisper rings → low glint -->
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('init', { variant: 'whisper' })}
        ${buildSunGlint('low')}
      </div>

      <div style="position:relative;z-index:1;width:100%;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(8, 8)}

        <!-- Glass card -->
        <div class="init-rise" style="width:100%;max-width:380px;
             background:rgba(255,255,255,0.58);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
             border:1px solid rgba(255,255,255,0.82);border-radius:28px;
             padding:36px 28px 30px;
             box-shadow:0 16px 56px rgba(0,0,0,0.08),0 2px 8px rgba(0,0,0,0.05);
             animation-delay:0.06s;
             display:flex;flex-direction:column;align-items:center;text-align:center">

          <!-- Chip -->
          <span style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;
                       color:rgba(0,0,0,0.35);background:rgba(255,255,255,0.7);
                       border:1px solid rgba(0,0,0,0.07);border-radius:100px;
                       padding:5px 13px;display:inline-block;margin-bottom:22px">
            Building your plan
          </span>

          <!-- Glass circle filling -->
          <div style="width:120px;height:120px;position:relative;margin-bottom:24px">
            <svg width="120" height="120" viewBox="0 0 100 100" style="display:block">
              <defs>
                <linearGradient id="init-fill-grad" x1="20%" y1="10%" x2="80%" y2="90%">
                  <stop offset="0%"   stop-color="#FFFFFF" stop-opacity="0.95"/>
                  <stop offset="50%"  stop-color="#5874A0" stop-opacity="0.85"/>
                  <stop offset="100%" stop-color="#2E4668" stop-opacity="0.65"/>
                </linearGradient>
              </defs>
              <circle cx="50" cy="50" r="${INIT_RADIUS}" fill="none"
                      stroke="rgba(0,0,0,0.07)" stroke-width="3"/>
              <circle id="init-fill" class="init-fill"
                      cx="50" cy="50" r="${INIT_RADIUS}" fill="none"
                      stroke="url(#init-fill-grad)" stroke-width="3"
                      stroke-linecap="round"
                      stroke-dasharray="${INIT_CIRCUMFERENCE.toFixed(1)}"
                      stroke-dashoffset="${INIT_CIRCUMFERENCE.toFixed(1)}"
                      transform="rotate(-90 50 50)"
                      style="transition: stroke-dashoffset 0.7s cubic-bezier(0.16, 1, 0.3, 1)"/>
            </svg>
          </div>

          <!-- Current step label -->
          <p id="init-title" class="init-label-fade"
             style="font-size:18px;font-weight:600;color:#1A1A1A;margin:0 0 8px;line-height:1.4">
            Mapping your physiology
          </p>

          <!-- Status -->
          <p id="init-status" class="init-label-fade"
             style="font-size:13px;font-weight:300;color:rgba(0,0,0,0.50);line-height:1.55;margin:0;max-width:280px">
            Building a plan tailored to your training history.
          </p>
        </div>
      </div>
    </div>
  `;

  runInitialization(state);
}

/** Smooth in-place fill update — no DOM re-render. pct = 0..1. */
function setInitProgress(pct: number): void {
  const fill = document.getElementById('init-fill') as SVGCircleElement | null;
  if (!fill) return;
  const clamped = Math.max(0, Math.min(1, pct));
  fill.style.strokeDashoffset = (INIT_CIRCUMFERENCE * (1 - clamped)).toFixed(1);
}

/** Fade-swap the headline label so changes feel calm, not jumpy. */
function setInitLabel(title: string, status?: string): void {
  const titleEl = document.getElementById('init-title');
  const statusEl = document.getElementById('init-status');
  if (titleEl && titleEl.textContent !== title) {
    titleEl.style.opacity = '0';
    setTimeout(() => { titleEl.textContent = title; titleEl.style.opacity = '1'; }, 220);
  }
  if (statusEl && status !== undefined && statusEl.textContent !== status) {
    statusEl.style.opacity = '0';
    setTimeout(() => { statusEl.textContent = status; statusEl.style.opacity = '1'; }, 220);
  }
}

async function runInitialization(state: OnboardingState): Promise<void> {
  // Mid-plan: user arrived via "Edit Settings". Keep existing plan — just advance.
  // Exception: if the user just flipped modes (plan ↔ trackOnly), the runtime
  // `s.trackOnly` still reflects the old mode but `onboarding.trackOnly` is the
  // new intent. Run the full init so state is rewritten cleanly.
  const rt = getState();
  const modeChanged = !!state.trackOnly !== !!rt.trackOnly;
  // Cross-mode switch: if the user previously initialised in one mode and is
  // now coming through the wizard as another, the old `wks` / `eventType` /
  // `triConfig` / `hyroxConfig` are stale and must be rebuilt. The earlier
  // narrow check (`(triMode==='triathlon') !== (eventType==='triathlon')`)
  // missed three switches:
  //   • running ↔ hyrox (both eventTypes mismatch but neither was 'triathlon')
  //   • triathlon ↔ cycling (both set eventType='triathlon'; only `disciplines` distinguishes them)
  //   • hyrox ↔ cycling
  // Now we project `state.trainingMode` to the expected runtime shape (eventType
  // + cycling-discipline flag) and compare against the actual runtime shape.
  const expectedEventType: 'triathlon' | 'hyrox' | 'running' =
    state.trainingMode === 'triathlon' || state.trainingMode === 'cycling' ? 'triathlon' :
    state.trainingMode === 'hyrox' ? 'hyrox' :
    'running';
  const expectedIsCycling = state.trainingMode === 'cycling';
  const actualIsCycling =
    rt.eventType === 'triathlon'
    && rt.triConfig?.disciplines?.length === 1
    && rt.triConfig.disciplines[0] === 'bike';
  const actualEventType = rt.eventType ?? 'running';
  const trainingModeChanged =
    expectedEventType !== actualEventType
    || expectedIsCycling !== actualIsCycling;
  // Triathlon settings changes (hours, weekday split, distance, skill, FTP, CSS,
  // gym) must trigger a full reinit so the plan actually reflects what the
  // user just set. Otherwise the wizard's "Edit settings" flow silently keeps
  // the old plan.
  const triSettingsChanged = state.trainingMode === 'triathlon' && (
    (state.triTimeAvailableHoursPerWeek ?? null) !== (rt.triConfig?.timeAvailableHoursPerWeek ?? null) ||
    (state.triWeekdayHoursPerWeek ?? null) !== (rt.triConfig?.weekdayHoursPerWeek ?? null) ||
    state.triDistance !== rt.triConfig?.distance ||
    JSON.stringify(state.triSkillRating ?? null) !== JSON.stringify(rt.triConfig?.skillRating ?? null) ||
    JSON.stringify(state.triVolumeSplit ?? null) !== JSON.stringify(rt.triConfig?.volumeSplit ?? null) ||
    (state.gymSessionsPerWeek ?? 0) !== (rt.gs ?? 0) ||
    (state.customRaceDate ?? null) !== (rt.triConfig?.raceDate ?? null) ||
    (state.planDurationWeeks ?? null) !== (rt.triConfig?.weeksToRace ?? null)
  );
  // Running settings changes: flipping Yes/No event, swapping race distance, or
  // changing focus (for no-event plans) must force a full reinit. Without this,
  // a user going Endurance → Speed in Edit Settings keeps s.rd='half' despite
  // having asked for 5K-focused training.
  const expectedRd = state.trainingMode === 'running' && state.trainingForEvent === false
    ? (state.trainingFocus === 'speed' ? '5k'
      : state.trainingFocus === 'both' ? '10k'
      : 'half')
    : state.raceDistance;
  const runningSettingsChanged = state.trainingMode === 'running' && (
    // Event Y/N flipped — s.continuousMode is the runtime echo of trainingForEvent===false.
    (state.trainingForEvent === false) !== !!rt.continuousMode ||
    // Target distance drifted (running event → different distance, or focus flip in no-event).
    (expectedRd ?? null) !== (rt.rd ?? null)
  );
  // HYROX settings changes (hours, format, equipment, previous time → band,
  // race date, plan length) must trigger a full reinit so the plan reflects
  // the new inputs. Without this, the wizard's "Edit settings" flow silently
  // keeps the old plan. Mirrors triSettingsChanged.
  const hyroxSettingsChanged = state.trainingMode === 'hyrox' && (
    (state.triTimeAvailableHoursPerWeek ?? null) !== (rt.hyroxConfig?.weeklyHoursAvailable ?? null) ||
    (state.hyroxFormat ?? null) !== (rt.hyroxConfig?.format ?? null) ||
    (state.previousHyroxTimeSec ?? null) !== (rt.hyroxConfig?.previousHyroxTimeSec ?? null) ||
    (state.hyroxSledAccess ?? null) !== (rt.hyroxConfig?.stationAccess?.sled ?? null) ||
    (state.hyroxHasSkiErg ?? null) !== (rt.hyroxConfig?.stationAccess?.skiErg ?? null) ||
    (state.hyroxHasRowErg ?? null) !== (rt.hyroxConfig?.stationAccess?.rowErg ?? null) ||
    (state.customRaceDate ?? null) !== (rt.hyroxConfig?.raceDate ?? null) ||
    (state.planDurationWeeks ?? null) !== (rt.tw ?? null)
  );
  // Cycling settings changes. Cycling reuses `eventType: 'triathlon'` and the
  // triConfig shape, so the same fields apply minus the tri-specific ones.
  // `cyclingDistance` has no runtime echo (it lives only on onboarding), so
  // hours and race-date edits are the reliable reinit signals here.
  const cyclingSettingsChanged = state.trainingMode === 'cycling' && (
    (state.triTimeAvailableHoursPerWeek ?? null) !== (rt.triConfig?.timeAvailableHoursPerWeek ?? null) ||
    (state.triWeekdayHoursPerWeek ?? null) !== (rt.triConfig?.weekdayHoursPerWeek ?? null) ||
    (state.gymSessionsPerWeek ?? 0) !== (rt.gs ?? 0) ||
    (state.customRaceDate ?? null) !== (rt.triConfig?.raceDate ?? null) ||
    (state.planDurationWeeks ?? null) !== (rt.triConfig?.weeksToRace ?? null)
  );
  if (
    rt.wks.length > 0 &&
    !modeChanged &&
    !triSettingsChanged &&
    !trainingModeChanged &&
    !runningSettingsChanged &&
    !hyroxSettingsChanged &&
    !cyclingSettingsChanged
  ) {
    nextStep();
    return;
  }

  await delay(600);

  // Step 1/3: PBs analysed → 33% fill
  setInitProgress(0.33);
  setInitLabel('Mapping your physiology', 'Reading your training history into the model.');

  await checkVolumeRecommendation(state);

  await delay(500);

  const result = initializeSimulator(state);
  if (!result.success) {
    showError(result.error || 'Failed to initialize plan');
    return;
  }

  // Step 2/3: profile calculated → 66% fill
  setInitProgress(0.66);
  setInitLabel('Calculating your runner profile', 'Working out your runner type and pace zones.');
  await delay(700);

  // Step 3/3: plan built → 100% fill
  setInitProgress(1.0);
  setInitLabel('Building your training plan', 'Final touches.');
  await delay(700);

  setInitLabel('Your plan is ready.', 'Loading.');

  updateOnboarding({ calculatedRunnerType: result.runnerType });

  await delay(700);
  nextStep();
}

function showError(message: string): void {
  const t = document.getElementById('init-title');
  const s = document.getElementById('init-status');
  if (t) { t.textContent = 'Initialization failed'; t.style.color = 'var(--c-warn)'; }
  if (s) { s.textContent = message; s.style.color = 'var(--c-warn)'; }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** PB keys to meters */
const PB_METERS: Record<string, number> = { k5: 5000, k10: 10000, h: 21097, m: 42195 };

/** Best VDOT from PBs */
function bestVdot(pbs: PBs): number {
  let best = 0;
  for (const [key, meters] of Object.entries(PB_METERS)) {
    const t = (pbs as any)[key] as number | undefined;
    if (t && t > 0) best = Math.max(best, cv(meters, t));
  }
  return best;
}

/** Race distance key to meters */
function distMeters(dist: string): number {
  return dist === 'marathon' ? 42195 : dist === 'half' ? 21097 : dist === '10k' ? 10000 : 5000;
}

/**
 * Check if runner should be recommended a volume upgrade.
 * Returns a promise that resolves after the user dismisses the modal (or immediately if no recommendation).
 */
function checkVolumeRecommendation(_state: OnboardingState): Promise<void> {
  // Milestone nudging is handled on the assessment page via plan comparison cards.
  // No popup needed here — the user sees both plans with times and can choose.
  return Promise.resolve();
}
