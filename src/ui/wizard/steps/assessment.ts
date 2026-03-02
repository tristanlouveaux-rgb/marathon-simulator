import type { OnboardingState } from '@/types/onboarding';
import { MILESTONE_THRESHOLDS, MILESTONE_LABELS } from '@/types/onboarding';
import type { RunnerType, RaceDistance } from '@/types/training';
import {
  cv, rd, rdKm, tv, calculateFatigueExponent,
  blendPredictions
} from '@/calculations';
import { calculateForecast } from '@/calculations/predictions';
import { initializeSimulator } from '@/state/initialization';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/** Volume scenario for comparison */
interface VolumeOption {
  runs: number;
  totalSessions: number;
  forecastTime: number;
  hitsTarget: boolean;
}

const CARD = 'background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:24px;margin-bottom:16px';

/**
 * Render the Assessment step (post-runner-type, pre-dashboard).
 * Shows plan selection and volume gap analysis.
 */
export function renderAssessment(container: HTMLElement, state: OnboardingState): void {
  const pbs = state.pbs;
  if (!Object.keys(pbs).length) {
    nextStep();
    return;
  }

  const b = calculateFatigueExponent(pbs);
  const runnerType = (state.confirmedRunnerType || state.calculatedRunnerType || 'Balanced') as RunnerType;

  const targetDistStr = (state.raceDistance || 'half') as RaceDistance;
  const targetDistMeters = rd(targetDistStr);
  const blendedTime = blendPredictions(
    targetDistMeters, pbs,
    state.ltPace || null, state.vo2max || null,
    b, runnerType, state.recentRace
  );

  if (!blendedTime || isNaN(blendedTime) || blendedTime <= 0) {
    nextStep();
    return;
  }

  const baselineVdot = cv(targetDistMeters, blendedTime);
  const crossSessions = calcCrossSessions(state);
  const totalSessions = state.runsPerWeek + crossSessions;
  const isSafetyCapped = totalSessions >= 8;

  const { options, target } = buildVolumeOptions(
    state.runsPerWeek, crossSessions, baselineVdot,
    state.planDurationWeeks, targetDistStr, runnerType, state
  );

  const current = options[0];
  const upgrade = options[1] || null;
  const showUpgrade = !isSafetyCapped && upgrade !== null;
  const showForecastOnly = !showUpgrade;
  const isNonEvent = state.trainingForEvent === false;
  const focusLabel = state.trainingFocus === 'speed' ? 'Speed' : state.trainingFocus === 'endurance' ? 'Endurance' : 'Balanced';

  // Non-event users
  if (isNonEvent) {
    container.innerHTML = `
      <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
        ${renderProgressIndicator(8, 8)}

        <div style="width:100%;max-width:520px">
          <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
            Your Training Plan
          </h2>
          <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:32px">
            Continuous training with periodic check-ins to track your progress.
          </p>

          <div style="${CARD}">
            <div style="display:flex;flex-direction:column;gap:12px">
              <div style="display:flex;align-items:center;gap:12px;padding:14px;border-radius:10px;background:rgba(0,0,0,0.04);border:1px solid var(--c-border)">
                <div style="width:40px;height:40px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">
                  <svg style="width:20px;height:20px;color:var(--c-muted)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                  </svg>
                </div>
                <div>
                  <div style="font-size:14px;font-weight:500;color:var(--c-black)">Continuous ${focusLabel} Training</div>
                  <div style="font-size:12px;color:var(--c-muted);margin-top:2px">4-week repeating blocks — 3 weeks training + 1 week recovery with optional check-in</div>
                </div>
              </div>

              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:center">
                <div style="padding:14px;border-radius:10px;background:var(--c-bg);border:1px solid var(--c-border)">
                  <div style="font-size:11px;color:var(--c-faint);margin-bottom:4px">Runs / Week</div>
                  <div style="font-size:20px;font-weight:500;color:var(--c-black)">${state.runsPerWeek}</div>
                </div>
                <div style="padding:14px;border-radius:10px;background:var(--c-bg);border:1px solid var(--c-border)">
                  <div style="font-size:11px;color:var(--c-faint);margin-bottom:4px">Starting VDOT</div>
                  <div style="font-size:20px;font-weight:500;color:var(--c-black)">${baselineVdot.toFixed(1)}</div>
                </div>
              </div>

              <p style="font-size:12px;color:var(--c-faint);line-height:1.5">
                Your plan has no fixed end date. Every 4 weeks you'll get an optional fitness check-in.
                Paces and workouts adjust automatically as you progress.
              </p>
            </div>

            <button id="btn-select-current"
              style="margin-top:20px;width:100%;padding:14px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer">
              Start Training
            </button>
          </div>

        </div>
        ${renderBackButton(true)}
      </div>
    `;

    wireHandlers(state, runnerType, upgrade, showUpgrade);
    return;
  }

  // Race/event users: plan selection
  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      ${renderProgressIndicator(8, 8)}

      <div style="width:100%;max-width:520px">
        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Choose Your Plan
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:32px">
          Your predicted race time based on your profile and training volume.
        </p>

        <div style="${CARD}">
          <h3 style="font-size:16px;font-weight:500;color:var(--c-black);margin-bottom:4px">Plan Outcome</h3>
          <p style="font-size:12px;color:var(--c-faint);margin-bottom:20px">
            Forecasts are adaptive and will evolve based on your actual training execution.
          </p>

          ${showForecastOnly ? `
            <!-- Scenario C: Forecast Only -->
            <div style="padding:16px;border-radius:10px;background:var(--c-bg);border:1px solid var(--c-border);margin-bottom:12px">
              <div style="font-size:14px;color:var(--c-black);font-weight:500;margin-bottom:6px">Current Forecast: ${formatTime(current.forecastTime)}</div>
              <p style="font-size:12px;color:var(--c-faint);line-height:1.5">
                This forecast is adaptive and will update as you train. Consistency is key.
              </p>
            </div>

            ${isSafetyCapped ? `
              <div style="padding:12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:10px;display:flex;align-items:flex-start;gap:10px;margin-bottom:12px">
                <svg style="width:18px;height:18px;color:var(--c-caution);flex-shrink:0;margin-top:1px" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </svg>
                <div style="font-size:12px;color:var(--c-caution-text)">
                  Volume capped at 8 sessions/week to reduce injury risk.
                </div>
              </div>
            ` : ''}

            <button id="btn-select-current"
              style="width:100%;padding:14px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer">
              Continue to Dashboard
            </button>
          ` : `
            <div style="display:flex;flex-direction:column;gap:10px">
              <!-- Card A: Current Plan -->
              <button id="btn-select-current" style="width:100%;text-align:left;display:flex;align-items:center;justify-content:space-between;padding:16px;border-radius:10px;background:var(--c-bg);border:${current.hitsTarget && !(upgrade?.hitsTarget) ? '2px solid var(--c-black)' : '1.5px solid var(--c-border-strong)'};cursor:pointer;transition:all 0.15s">
                <div>
                  <div style="font-size:14px;font-weight:500;color:var(--c-black);display:flex;align-items:center;gap:8px">
                    Current Plan
                    ${current.hitsTarget && !(upgrade?.hitsTarget) ? `<span style="font-size:11px;color:var(--c-ok);font-weight:500">Hits Target</span>` : ''}
                  </div>
                  <div style="font-size:12px;color:var(--c-faint);margin-top:2px">${state.runsPerWeek} runs / week</div>
                </div>
                <div style="text-align:right">
                  <div style="font-size:20px;font-family:monospace;color:var(--c-black)">${formatTime(current.forecastTime)}</div>
                  <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.05em;margin-top:2px">Predicted</div>
                </div>
              </button>

              ${showUpgrade && upgrade ? `
                <!-- Card B: Harder Plan -->
                <button id="btn-select-harder" style="width:100%;text-align:left;display:flex;align-items:center;justify-content:space-between;padding:16px;border-radius:10px;background:var(--c-bg);border:${upgrade.hitsTarget && !current.hitsTarget ? '2px solid var(--c-black)' : '1.5px solid var(--c-border-strong)'};cursor:pointer;transition:all 0.15s">
                  <div>
                    <div style="font-size:14px;font-weight:500;color:var(--c-black);display:flex;align-items:center;gap:8px">
                      Harder Plan
                      ${upgrade.hitsTarget && !current.hitsTarget ? `<span style="font-size:11px;color:var(--c-ok);font-weight:500">Hits Target</span>` : ''}
                    </div>
                    <div style="font-size:12px;color:var(--c-faint);margin-top:2px">${upgrade.runs} runs / week</div>
                  </div>
                  <div style="text-align:right">
                    <div style="font-size:20px;font-family:monospace;color:var(--c-black)">${formatTime(upgrade.forecastTime)}</div>
                    <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.05em;margin-top:2px">Predicted</div>
                  </div>
                </button>

                ${upgrade.totalSessions > 7 ? `
                  <div style="padding:12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:10px;display:flex;align-items:flex-start;gap:10px">
                    <svg style="width:18px;height:18px;color:var(--c-caution);flex-shrink:0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                    </svg>
                    <div style="font-size:12px;color:var(--c-caution-text)">
                      ${upgrade.totalSessions} total sessions/wk including cross-training. Monitor recovery closely.
                    </div>
                  </div>
                ` : ''}
              ` : ''}
            </div>
          `}
        </div>

      </div>
      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(state, runnerType, upgrade, showUpgrade);
}

function wireHandlers(
  state: OnboardingState,
  runnerType: RunnerType,
  upgrade: VolumeOption | null,
  showUpgrade: boolean
): void {
  document.getElementById('btn-select-current')?.addEventListener('click', () => {
    nextStep();
  });

  if (showUpgrade && upgrade) {
    document.getElementById('btn-select-harder')?.addEventListener('click', () => {
      updateOnboarding({ runsPerWeek: upgrade.runs });
      const currentState = getState();
      const isMidPlan = currentState.w > 1;
      if (isMidPlan) {
        const s = getMutableState();
        s.rw = upgrade.runs;
        saveState();
      } else {
        initializeSimulator({
          ...state,
          runsPerWeek: upgrade.runs,
          confirmedRunnerType: state.confirmedRunnerType || runnerType,
        });
      }
      nextStep();
    });
  }
}

function calcCrossSessions(state: OnboardingState): number {
  const INTENSITY_FACTOR: Record<string, number> = { easy: 0.5, moderate: 0.7, hard: 0.9 };
  let cross = 0;
  if (state.recurringActivities && state.recurringActivities.length > 0) {
    for (const act of state.recurringActivities) {
      const iFactor = INTENSITY_FACTOR[act.intensity] || 0.7;
      cross += (act.durationMin / 60) * iFactor * act.frequency;
    }
  } else {
    cross = 0.5 * (state.sportsPerWeek || 0);
  }
  if (state.activeLifestyle) cross += 0.5;
  return cross;
}

function buildVolumeOptions(
  runsPerWeek: number,
  crossSessions: number,
  baselineVdot: number,
  planWeeks: number,
  raceDistance: RaceDistance,
  runnerType: RunnerType,
  state: OnboardingState,
): { options: VolumeOption[]; target: { time: number; label: string } | null } {
  const options: VolumeOption[] = [];
  const maxTotal = 8;

  for (let extra = 0; extra <= 2; extra++) {
    const runs = runsPerWeek + extra;
    const total = runs + crossSessions;
    if (extra > 0 && total > maxTotal) break;

    const effectiveSessions = runs + crossSessions;
    const stateOverride = { ...state, runsPerWeek: runs };
    const forecast = calculateForecast(baselineVdot, effectiveSessions, stateOverride, runnerType);

    options.push({
      runs,
      totalSessions: Math.round(total),
      forecastTime: forecast.forecastTime,
      hitsTarget: false,
    });
  }

  const currentTime = options[0].forecastTime;
  const bestTime = options.length > 1 ? Math.min(...options.slice(1).map(o => o.forecastTime)) : currentTime;
  const target = findStraddledMilestone(currentTime, bestTime, raceDistance);
  const targetTime = target?.time ?? Infinity;

  for (const opt of options) {
    opt.hitsTarget = opt.forecastTime <= targetTime;
  }

  return { options, target };
}

function findStraddledMilestone(
  currentTime: number,
  bestTime: number,
  raceDistance: RaceDistance,
): { time: number; label: string } | null {
  const thresholds = MILESTONE_THRESHOLDS[raceDistance];
  const labels = MILESTONE_LABELS[raceDistance];
  if (!thresholds) return null;

  for (let i = 0; i < thresholds.length; i++) {
    if (currentTime > thresholds[i] && bestTime <= thresholds[i]) {
      return { time: thresholds[i], label: labels[i] };
    }
  }
  return null;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
