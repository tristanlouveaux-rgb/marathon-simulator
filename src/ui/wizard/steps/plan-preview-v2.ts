import type { OnboardingState, MilestoneTarget } from '@/types/onboarding';
import { findNearestMilestone } from '@/types/onboarding';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { updateOnboarding, goToStep } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { ft, fmtProbPct } from '@/utils/format';
import { getRunnerType, calculateLiveForecast } from '@/calculations';
import { getPlanPrescribedMeanWeeklyKm } from '@/calculations/training-horizon';
import { buildRingBackground, ringAnimationCSS, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { runMarathonForecastSim } from '@/calculations/race-forecast-simulation';
import { liveTone, liveLabel, deriveBounds } from '@/ui/goal-time-overlay';
import { initializeSimulator } from '@/state/initialization';

/**
 * Page 7. Plan Preview (v2).
 *
 * Visual-consistency rewrite of legacy `plan-preview.ts`. Structure is preserved:
 *  - Recalculate forecast via `calculateLiveForecast` (single source of truth)
 *  - Detect nearby milestone with `findNearestMilestone` (5% default, experience-scaled)
 *  - Show predicted finish, plan summary card, adaptive-prediction note
 *  - "See your sessions" CTA → hands off to the post-plan workout demonstration
 *    (workout-preview), which is the final step and completes onboarding
 *  - Optional milestone popup with accept/decline
 *
 * Aesthetic clone of `goals.ts` / `review.ts`:
 * - Apple 3-layer shadow on every surface
 * - Monochrome; no tinted cards, no decorative gradients, no accent colour
 * - Row pills (`pp-row-*`) with micro-label + value + sub caption
 * - No emoji in body copy
 */
export function renderPlanPreviewV2(container: HTMLElement, state: OnboardingState): void {
  const s = getState();
  const initialTime = s.initialBaseline || 0;
  const raceDistance = s.rd;
  const totalWeeks = s.tw;
  // No-event runners picked a focus, not a race. Swap title + hero to a focus
  // summary. Fitness plan rolls forever unless the user chose Set duration.
  const noEvent = !!s.continuousMode;
  const focusLabel = focusToLabel(state.trainingFocus);

  const commuteDays = s.commuteConfig?.enabled ? (s.commuteConfig.commuteDaysPerWeek ?? 0) : 0;
  const baseRunsPerWeek = s.rw || 3;
  const sessionsForHorizon = (s.epw || s.rw || 4) + commuteDays;
  const forecastTime = forecastForSessions(s, sessionsForHorizon);

  // Seed the headline forecast onto state so the goal Monte Carlo anchors its
  // cone to the same number the hero shows. Without this the sim has no
  // headline anchor during onboarding and falls back to a bare-VDOT trajectory
  // that can drift from the displayed forecast, making "X% chance · forecast Y"
  // read incoherently. This is the real first-launch forecast either way.
  if (forecastTime > 0 && s.forecastTimeAdjusted !== forecastTime) {
    updateState({ forecastTime, forecastTimeAdjusted: forecastTime });
  }

  // Strength → forecast benefit. The hero forecast already folds in the planned
  // strength contribution; isolate it (forecast at the same run count WITHOUT
  // strength minus the shown forecast) for the motivating onboarding callout.
  // Future-projection economy gain, Beattie & Blagrove 2018. See SCIENCE_LOG §BC.
  const gymSessions = s.gs ?? state.gymSessionsPerWeek ?? 0;
  const strengthBenefitSec = gymSessions >= 1 && forecastTime > 0
    ? Math.max(0, forecastForSessions(s, sessionsForHorizon, 0) - forecastTime)
    : 0;

  // User-entered goal (running). Persisted in `s.raceGoalTimeSec`, carries
  // through to the post-onboarding Race Forecast page. When set, the hero
  // reframes around the goal and shows the live Monte Carlo chance of hitting
  // it on the *current* plan.
  const goalSec = s.raceGoalTimeSec && s.raceGoalTimeSec > 0 ? s.raceGoalTimeSec : null;
  const goalChancePct = goalSec ? goalChanceForState(s, goalSec) : null;
  // Room to add sessions (same cap the bump helper enforces: 7 runs/week).
  const canAddSessions = baseRunsPerWeek < 7;


  const candidateMilestone = s.continuousMode
    ? null
    : findNearestMilestone(forecastTime, raceDistance, 0.05, state.experienceLevel || 'intermediate');

  // Feasibility gate: only surface a milestone popup if adding one session/week
  // would actually bring the forecast to or below the milestone time, AND there
  // is real room to bump (rw < 7 and epw < 10. Same caps the accept handler uses).
  // Otherwise we'd promise a goal the plan engine can't deliver.
  const canBumpSessions = (s.rw ?? 0) < 7 && (s.epw ?? 0) < 10;
  let milestone: MilestoneTarget | null = null;
  if (candidateMilestone && canBumpSessions) {
    const bumpedForecast = forecastForSessions(s, sessionsForHorizon + 1);
    if (bumpedForecast <= candidateMilestone.time) {
      milestone = candidateMilestone;
    }
  }
  const showMilestonePopup = !!milestone && !state.acceptedMilestoneChallenge && state.targetMilestone === null;

  const shownTime = state.targetMilestone ? state.targetMilestone.time : forecastTime;

  container.innerHTML = `
    <style>
      @keyframes ppRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .pp-rise { opacity:0; animation: ppRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${ringAnimationCSS('pp')}

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      /* Hero finish-time card. */
      .pp-hero { width:100%; background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:20px; padding:26px 22px; text-align:center; }
      .pp-hero-label { font-size:11px; color:var(--c-faint); letter-spacing:0.08em; margin:0 0 10px; }
      .pp-hero-time { font-size:clamp(2.6rem,9vw,3.6rem); font-weight:300; color:var(--c-black); letter-spacing:-0.02em; line-height:1; margin:0; font-variant-numeric: tabular-nums; }
      .pp-hero-dist { font-size:13px; color:var(--c-faint); margin:8px 0 0; }

      .pp-hero-foot { display:flex; justify-content:space-between; align-items:center; margin-top:18px; padding-top:16px; border-top:1px solid rgba(0,0,0,0.06); font-size:13px; }
      .pp-hero-foot .k { color:var(--c-faint); }
      .pp-hero-foot .v { color:var(--c-black); margin-left:6px; font-variant-numeric: tabular-nums; }
      .pp-hero-foot .delta { color:var(--c-black); font-weight:500; font-variant-numeric: tabular-nums; }

      /* Milestone pill — no accent, just a bordered tag. */
      .pp-milestone-tag { display:inline-flex; align-items:center; gap:6px; margin-top:12px; padding:6px 12px; border-radius:100px; background:#FFFFFF; border:1px solid rgba(0,0,0,0.12); font-size:12px; color:var(--c-black); }

      /* Goal chance row under the target time. */
      .pp-goal-chance { display:flex; align-items:baseline; justify-content:center; gap:8px; margin-top:12px; }
      .pp-goal-pct { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; letter-spacing:-0.01em; line-height:1; }
      .pp-goal-chance-cap { font-size:12px; color:var(--c-faint); }

      /* Secondary goal-entry button — bordered pill, no accent (nav-link colour rule). */
      .pp-goal-btn { width:100%; height:46px; margin-top:10px; border-radius:23px; background:#FFFFFF; border:1px solid rgba(0,0,0,0.12); color:var(--c-black); font-size:14px; font-weight:500; cursor:pointer; transition:transform 0.12s ease; box-shadow:0 1px 2px rgba(0,0,0,0.04); }
      .pp-goal-btn:active { transform:translateY(1px); }

      /* Plan summary rows. */
      .pp-rows { display:flex; flex-direction:column; gap:10px; }
      .pp-row { display:flex; align-items:center; justify-content:space-between; width:100%; background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:14px; padding:12px 16px; }
      .pp-row-k { font-size:12.5px; color:var(--c-faint); }
      .pp-row-v { font-size:14px; font-weight:500; color:var(--c-black); font-variant-numeric: tabular-nums; display:inline-flex; align-items:center; gap:6px; }
      .pp-row-v .info { background:none; border:none; color:var(--c-muted); cursor:pointer; padding:0; display:inline-flex; }
      .pp-row-v .info svg { width:14px; height:14px; }

      /* Prediction caveat — muted, no colour. */
      .pp-note { font-size:12px; color:var(--c-faint); line-height:1.5; margin:0; }
      .pp-note-card { background:rgba(255,255,255,0.75); border:1px solid rgba(0,0,0,0.06); border-radius:14px; padding:12px 14px; }

      /* CTA — monochrome pill. */
      .pp-cta { width:100%; height:50px; border-radius:25px; background:#0A0A0A; color:#FDFCF7; border:none; font-size:15px; font-weight:500; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.1), 0 10px 26px -8px rgba(0,0,0,0.4); transition: transform 0.12s ease; }
      .pp-cta:active { transform: translateY(1px); }

      /* Milestone overlay — centered, per UX_PATTERNS. */
      .pp-overlay-backdrop { position:fixed; inset:0; z-index:50; background:rgba(0,0,0,0.55); display:flex; align-items:center; justify-content:center; padding:24px; }
      .pp-overlay-card { width:100%; max-width:380px; background:var(--c-bg); border:1px solid rgba(0,0,0,0.08); border-radius:20px; padding:24px; }
      .pp-overlay-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:18px; }
      .pp-overlay-btn-secondary { background:#FFFFFF; color:var(--c-black); border:1px solid var(--c-border); border-radius:14px; padding:12px 14px; font-size:14px; font-weight:500; cursor:pointer; }
      .pp-overlay-btn-primary { background:#0A0A0A; color:#FDFCF7; border:none; border-radius:14px; padding:12px 14px; font-size:14px; font-weight:500; cursor:pointer; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <!-- Hero arrival: atmosphere → centered+pulse rings → mid glint. Same loud treatment as intro slides. -->
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('pp', { variant: 'centered', pulse: true })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(8, 8)}

        <div class="pp-rise" style="width:100%;max-width:480px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.15">
            Your plan is ready
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">
            ${noEvent
              ? (state.continuousMode === false
                  ? `${totalWeeks}-week block · ${focusLabel} focus.`
                  : `Ongoing · ${focusLabel} focus.`)
              : `${totalWeeks} weeks to ${distanceLabel(raceDistance)}.`}
          </p>
        </div>

        ${noEvent ? `
          <div class="pp-rise shadow-ap pp-hero" style="max-width:480px;margin-top:22px;animation-delay:0.12s">
            <p class="pp-hero-label">${focusLabel.toUpperCase()} FOCUS</p>
            <p style="font-size:14px;color:var(--c-muted);margin:12px 0 0;line-height:1.55">
              ${focusBlurb(state.trainingFocus)}
            </p>
            <p style="font-size:12px;color:var(--c-faint);margin:14px 0 0;line-height:1.5">
              No race target. ${state.continuousMode === false ? `Fixed ${totalWeeks}-week block with a benchmark test at the end.` : 'Rolling plan that rebuilds week-by-week as you train.'}
            </p>
          </div>
        ` : goalSec ? `
          <div class="pp-rise shadow-ap pp-hero" style="max-width:480px;margin-top:22px;animation-delay:0.12s">
            <p class="pp-hero-label">TARGET TIME</p>
            <p class="pp-hero-time">${ft(goalSec)}</p>
            <p class="pp-hero-dist">${distanceLabel(raceDistance)}</p>

            ${goalChancePct != null ? `
              <div class="pp-goal-chance">
                <span class="pp-goal-pct" style="color:${liveTone(goalChancePct)}">${fmtProbPct(goalChancePct)}</span>
                <span class="pp-goal-chance-cap">chance · ${liveLabel(goalChancePct)}</span>
              </div>
            ` : ''}

            ${initialTime > 0 ? `
              <div class="pp-hero-foot">
                <div><span class="k">On current plan</span><span class="v">${ft(forecastTime)}</span></div>
                <div class="delta">${formatImprovement(initialTime, forecastTime)}</div>
              </div>
            ` : ''}
          </div>
        ` : `
          <div class="pp-rise shadow-ap pp-hero" style="max-width:480px;margin-top:22px;animation-delay:0.12s">
            <p class="pp-hero-label">PREDICTED FINISH</p>
            <p class="pp-hero-time">${ft(shownTime)}</p>
            <p class="pp-hero-dist">${distanceLabel(raceDistance)}</p>

            ${state.targetMilestone ? `
              <div class="pp-milestone-tag">Targeting ${state.targetMilestone.label}</div>
            ` : ''}

            ${initialTime > 0 ? `
              <div class="pp-hero-foot">
                <div><span class="k">Current fitness</span><span class="v">${ft(initialTime)}</span></div>
                <div class="delta">${formatImprovement(initialTime, shownTime)}</div>
              </div>
            ` : ''}
          </div>
        `}

        ${(s.ctlBaseline ?? 0) >= 20 ? `
        <div class="pp-rise" style="width:100%;max-width:480px;margin-top:16px;animation-delay:0.16s">
          <div class="pp-note-card">
            <p class="pp-note">Starting with <strong style="color:var(--c-black);font-weight:500">${Math.round((s.ctlBaseline ?? 0) / 7)} TSS/day</strong> of baseline fitness from your recent training. Your plan is pitched to continue from there, not restart you.</p>
          </div>
        </div>
        ` : ''}

        ${strengthBenefitSec >= 5 ? `
        <div class="pp-rise" style="width:100%;max-width:480px;margin-top:16px;animation-delay:0.17s">
          <div class="pp-note-card">
            <p class="pp-note">Your ${gymSessions} strength ${gymSessions === 1 ? 'session' : 'sessions'} a week ${gymSessions === 1 ? 'is' : 'are'} worth about <strong style="color:var(--c-black);font-weight:500">${fmtBenefitSec(strengthBenefitSec)}</strong> of the projected finish above. Resistance work raises running economy, so you hold goal pace at a lower cost (Beattie &amp; Blagrove 2018).</p>
          </div>
        </div>
        ` : ''}

        <div class="pp-rise" style="width:100%;max-width:480px;margin-top:16px;animation-delay:0.18s">
          <div class="pp-note-card">
            <p class="pp-note">${noEvent
              ? 'Your plan adapts weekly from your paces, heart rate, and workout feedback.'
              : 'This prediction updates weekly from your paces, heart rate, and workout feedback.'}</p>
          </div>
        </div>

        <div class="pp-rise" style="width:100%;max-width:480px;margin-top:16px;animation-delay:0.22s">
          <div class="pp-rows">
            <div class="pp-row"><span class="pp-row-k">Runs per week</span><span class="pp-row-v">${s.rw}</span></div>
            <div class="pp-row"><span class="pp-row-k">Weekly volume</span><span class="pp-row-v">~${s.wkm} km</span></div>
            <div class="pp-row"><span class="pp-row-k">Race preference</span><span class="pp-row-v">${s.typ}</span></div>
            <div class="pp-row">
              <span class="pp-row-k">Starting VO2max</span>
              <span class="pp-row-v">
                ${(s.v ?? 0).toFixed(1)}
                <button id="pp-vdot-info" class="info" aria-label="What is VO2max?">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01"/><path d="M11 12h1v5h1"/></svg>
                </button>
              </span>
            </div>
            ${renderVdotMethodSubline(s)}
            ${s.initialLT ? `
              <div class="pp-row"><span class="pp-row-k">LT threshold</span><span class="pp-row-v">${formatLTPace(s.initialLT)}${(s.unitPref ?? 'km') === 'mi' ? '/mi' : '/km'}</span></div>
            ` : ''}
            ${s.initialVO2 ? `
              <div class="pp-row"><span class="pp-row-k">VO2 max</span><span class="pp-row-v">${s.initialVO2.toFixed(1)} ml/kg/min</span></div>
            ` : ''}
          </div>
        </div>
      </div>

      <div class="pp-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.30s">
        <div style="max-width:480px;margin:0 auto">
          <button id="pp-start" class="pp-cta">See your sessions</button>
          ${!noEvent ? `<button id="pp-goal" class="pp-goal-btn">${goalSec ? 'Edit goal time' : 'Do you have a goal time?'}</button>` : ''}
        </div>
      </div>

      ${renderBackButton(true)}
    </div>

    ${showMilestonePopup && milestone ? renderMilestoneOverlay(milestone, forecastTime) : ''}
  `;

  wireHandlers(state, milestone, showMilestonePopup);
}

/* ---------- Milestone overlay (centered, per UX_PATTERNS) ---------- */

function renderMilestoneOverlay(milestone: MilestoneTarget, forecastTime: number): string {
  const timeDiff = forecastTime - milestone.time;
  const percentAway = ((timeDiff / milestone.time) * 100).toFixed(1);
  return `
    <div id="pp-milestone-overlay" class="pp-overlay-backdrop">
      <div class="pp-overlay-card shadow-ap">
        <p style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;margin:0">MILESTONE NEARBY</p>
        <h3 style="font-size:18px;font-weight:500;color:var(--c-black);margin:8px 0 6px;line-height:1.25">You're close to ${milestone.label}.</h3>
        <p style="font-size:13px;color:var(--c-muted);margin:0;line-height:1.5">
          Current prediction sits ${percentAway}% above the milestone target. Adding one quality session per week could close the gap.
        </p>
        <div style="margin-top:16px;padding:12px 14px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;background:#FFFFFF">
          <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--c-faint);margin-bottom:6px"><span>Current prediction</span><span style="color:var(--c-black);font-variant-numeric:tabular-nums">${ft(forecastTime)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--c-faint)"><span>Milestone target</span><span style="color:var(--c-black);font-weight:500;font-variant-numeric:tabular-nums">${ft(milestone.time)}</span></div>
        </div>
        ${milestone.extraWorkout ? `<p style="font-size:12px;color:var(--c-faint);margin:12px 0 0;line-height:1.5">${milestone.extraWorkout}</p>` : ''}
        <div class="pp-overlay-grid">
          <button id="pp-decline" class="pp-overlay-btn-secondary">No thanks</button>
          <button id="pp-accept" class="pp-overlay-btn-primary">Target it</button>
        </div>
      </div>
    </div>
  `;
}

/* ---------- Helpers ---------- */

function distanceLabel(distance: string): string {
  switch (distance) {
    case '5k': return '5K';
    case '10k': return '10K';
    case 'half': return 'Half Marathon';
    case 'marathon': return 'Marathon';
    default: return distance;
  }
}

/**
 * One-line method explanation under the Starting VDOT row. Mirrors the copy
 * tiers on the review screen so the user sees the *same* answer to "where did
 * this number come from?" on both pages.
 */
function renderVdotMethodSubline(s: ReturnType<typeof getState>): string {
  const hr = s.hrCalibratedVdot;
  let text = '';
  if (hr && hr.vdot != null && hr.confidence !== 'none') {
    const runWord = hr.n === 1 ? 'run' : 'runs';
    if (hr.confidence === 'low') {
      text = `Rough estimate from ${hr.n} steady ${runWord} in the last 8 weeks.`;
    } else {
      const tier = hr.confidence === 'high' ? 'high confidence' : 'medium confidence';
      text = `Measured from your heart rate response to pace across ${hr.n} steady ${runWord} in the last 8 weeks (${tier}).`;
    }
  } else if (hr && hr.reason === 'no-rhr') {
    text = 'Connect Garmin or add a resting HR to calibrate this from your heart rate.';
  } else if (hr && hr.reason === 'too-few-points') {
    text = `Only ${hr.n} steady ${hr.n === 1 ? 'run' : 'runs'} in the last 8 weeks. Need 3 to read fitness from heart rate.`;
  } else if (hr && (hr.reason === 'no-points' || hr.reason === 'no-maxhr')) {
    text = 'Calibration from heart rate kicks in once a few more steady runs sync.';
  } else if (hr && hr.reason === 'bad-fit') {
    text = 'Heart rate signal is noisy across your recent runs.';
  } else {
    text = 'Estimated from your personal bests and recent training.';
  }
  return `<p class="pp-row-sub" style="font-size:11.5px;color:var(--c-faint);margin:-2px 0 0;padding:0 2px;line-height:1.45">${text}</p>`;
}

function focusToLabel(focus: string | null | undefined): string {
  switch (focus) {
    case 'speed': return 'Speed';
    case 'endurance': return 'Endurance';
    case 'both': return 'Balanced';
    default: return 'Fitness';
  }
}

function focusBlurb(focus: string | null | undefined): string {
  switch (focus) {
    case 'speed':
      return 'Shorter, faster work. Intervals and tempos build top-end speed and running economy at 5K–10K pace.';
    case 'endurance':
      return 'Aerobic base with progressive long runs. Time on feet grows your engine for half-marathon and beyond.';
    case 'both':
      return 'Both ends in equal measure. Quality sessions for speed, long runs for endurance.';
    default:
      return 'A consistent weekly structure of easy, long, and quality runs that scales with your capacity.';
  }
}

function formatImprovement(initial: number, forecast: number): string {
  const diff = initial - forecast;
  if (diff <= 0) return 'Maintain fitness';
  const minutes = Math.floor(diff / 60);
  const seconds = Math.floor(diff % 60);
  if (minutes > 0) return `↓ ${minutes}m ${seconds}s`;
  return `↓ ${seconds}s`;
}

function formatLTPace(secPerKm: number): string {
  const min = Math.floor(secPerKm / 60);
  const sec = Math.floor(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

/** Human delta for the strength callout: "2 min 14 s", "3 min", or "40 s". */
function fmtBenefitSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m > 0) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

/* ---------- Forecast / goal helpers ---------- */

/**
 * Single source for the onboarding forecast at a given session count. The hero,
 * the milestone feasibility check, and the goal overlay all read from this one
 * call so the numbers can never diverge between surfaces.
 */
function forecastForSessions(
  s: ReturnType<typeof getState>,
  sessions: number,
  strengthSessions?: number,
): number {
  const planMeanKm = getPlanPrescribedMeanWeeklyKm(sessions, s.rd);
  return calculateLiveForecast({
    currentVdot: s.v || 50,
    targetDistance: s.rd,
    weeksRemaining: s.tw || 16,
    sessionsPerWeek: sessions,
    runnerType: getRunnerType(s.b || 1.06),
    experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
    weeklyVolumeKm: planMeanKm ?? s.wkm,
    hmPbSeconds: s.pbs?.h || undefined,
    ltPaceSecPerKm: s.lt || undefined,
    // Default to the plan's planned strength count; callers can override (e.g.
    // pass 0 to compute the no-strength baseline for the benefit callout).
    strengthSessionsPerWeek: strengthSessions ?? s.gs ?? s.onboarding?.gymSessionsPerWeek ?? 0,
    blendedAnchorSec: s.blendedRaceTimeSec ?? s.initialBaseline ?? undefined,
  }).forecastTime;
}

/**
 * Live Monte Carlo chance (%) of beating `goalSec`. `addedSessions` simulates
 * extra runs/week WITHOUT mutating state (spread-clone), so the overlay can
 * show the goal probability sliding up as the user adds sessions.
 */
function goalChanceForState(
  s: ReturnType<typeof getState>,
  goalSec: number,
  addedSessions = 0,
  gymSessions?: number,
): number | null {
  const commuteDays = s.commuteConfig?.enabled ? (s.commuteConfig.commuteDaysPerWeek ?? 0) : 0;
  const sessions = (s.epw || s.rw || 4) + commuteDays + addedSessions;
  // The forecast for this scenario (added runs + strength, §BC) becomes the cone
  // CENTRE via the override. We deliberately do NOT mutate the session counts on
  // the sim state. The sim re-derives its own mean improvement from the session
  // count and the cone's *spread* scales with that mean — and because the
  // VDOT→time map is nonlinear, a higher mean compresses the spread in seconds,
  // which for an aggressive goal could make the chance JUMP and even move the
  // wrong way (more sessions → narrower cone → lower chance). Pinning the spread
  // to the base plan and letting only the override move the centre makes the
  // chance a smooth, monotonic function of the forecast the user sees.
  const forecastOverride = forecastForSessions(s, sessions, gymSessions);
  const sim = runMarathonForecastSim(s, 2000, goalSec, forecastOverride);
  if (!sim || sim.goalProbability == null) return null;
  return sim.goalProbability * 100;
}

/**
 * Add `added` runs/week to the plan FOR REAL: bump the onboarding record's
 * runsPerWeek (capped at 7) and re-run initializeSimulator so the generated
 * weeks actually gain the session. The plan is built before this screen and
 * only regenerates through this path, so bumping `s.rw`/`s.epw` alone would be
 * cosmetic — the prescribed weeks would never reflect the extra session.
 */
function bumpSessionsAndRegen(added: number): void {
  if (added <= 0) return;
  const ob = getState().onboarding;
  if (!ob) return;
  const current = ob.runsPerWeek ?? getState().rw ?? 3;
  const next = Math.min(7, current + added);
  if (next <= current) return;
  updateOnboarding({ runsPerWeek: next });
  try {
    const ob2 = getState().onboarding;
    if (ob2) initializeSimulator(ob2);
  } catch (e) {
    console.warn('[PlanPreview] session-bump regen failed:', e);
  }
}

/**
 * Commit BOTH the added runs and the added strength sessions in one regen, so
 * the goal overlay's "+N runs / +M strength" levers become real without running
 * initializeSimulator twice. Runs cap at 7, strength at 3 (the onboarding
 * `gymSessionsPerWeek` range, schedule.ts GYM_OPTIONS). Strength feeds the
 * forecast's economy projection (§BC); both only take effect after this regen.
 */
function bumpSessionsAndGymAndRegen(addedRuns: number, addedGym: number): void {
  if (addedRuns <= 0 && addedGym <= 0) return;
  const ob = getState().onboarding;
  if (!ob) return;
  const nextRuns = Math.min(7, (ob.runsPerWeek ?? getState().rw ?? 3) + Math.max(0, addedRuns));
  const nextGym = Math.min(3, (ob.gymSessionsPerWeek ?? getState().gs ?? 0) + Math.max(0, addedGym));
  updateOnboarding({ runsPerWeek: nextRuns, gymSessionsPerWeek: nextGym });
  try {
    const ob2 = getState().onboarding;
    if (ob2) initializeSimulator(ob2);
  } catch (e) {
    console.warn('[PlanPreview] session/gym-bump regen failed:', e);
  }
}

/* ---------- Goal-time overlay (onboarding-local) ---------- */

/**
 * Goal-time entry on the plan-ready screen. Two interacting controls — a goal
 * slider and a sessions stepper — both re-run the Monte Carlo so the predicted
 * finish and the chance of hitting the goal slide live. Saving persists
 * `s.raceGoalTimeSec` (carries to the post-onboarding Race Forecast page) and,
 * if sessions were added, regenerates the plan so the extra session is real.
 */
function openOnboardingGoalOverlay(onboarding: OnboardingState): void {
  document.getElementById('pp-goal-overlay')?.remove();

  const s = getState();
  const commuteDays = s.commuteConfig?.enabled ? (s.commuteConfig.commuteDaysPerWeek ?? 0) : 0;
  const baseSessions = (s.epw || s.rw || 4) + commuteDays;
  const baseRunsPerWeek = s.rw || 3;
  const maxAdd = Math.max(0, 7 - baseRunsPerWeek);

  // Strength lever. Strength sessions raise running economy, so adding them
  // pulls the forecast faster (§BC). Range is 0-3 (onboarding gymSessionsPerWeek).
  const baseGym = s.gs ?? onboarding.gymSessionsPerWeek ?? 0;
  const maxGymAdd = Math.max(0, 3 - baseGym);

  const predictedSec = forecastForSessions(s, baseSessions);
  if (!predictedSec || predictedSec <= 0) return;

  // Extend the slider's fast end to cover the fastest plan the user could build
  // here (every addable run AND every addable strength session), so adding either
  // lever never runs the goal off the end of the range. The range is fixed at
  // open time, not re-derived per tap, so the bounds don't shift under the user.
  const fastestSec = (maxAdd > 0 || maxGymAdd > 0)
    ? forecastForSessions(s, baseSessions + maxAdd, baseGym + maxGymAdd)
    : undefined;
  const { minSec, maxSec, stepSec: STEP } = deriveBounds(predictedSec, s.rd, fastestSec);
  const snap = (v: number, st: number) => Math.round(v / st) * st;
  const savedGoal = s.raceGoalTimeSec && s.raceGoalTimeSec > 0 ? s.raceGoalTimeSec : null;
  // Default to the forecast itself — a goal equal to the forecast sits on the
  // simulation's median, so it opens at ~50% chance (a coin-flip target the user
  // then drags harder or easier). A saved goal always takes precedence.
  const initialSec = Math.min(maxSec, Math.max(minSec, snap(savedGoal ?? predictedSec, STEP)));

  let goalSec = initialSec;
  let added = 0;
  let addedGym = 0;

  const overlay = document.createElement('div');
  overlay.id = 'pp-goal-overlay';
  overlay.className = 'pp-overlay-backdrop';
  overlay.innerHTML = `
    <div class="pp-overlay-card shadow-ap" style="max-width:400px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <p class="pp-hero-label" style="margin:0">GOAL TIME</p>
          <h3 style="font-size:18px;font-weight:500;color:var(--c-black);margin:6px 0 0">What are you chasing?</h3>
        </div>
        <button id="ppg-close" aria-label="Close" style="background:none;border:none;cursor:pointer;color:var(--c-muted);font-size:22px;line-height:1;padding:0">×</button>
      </div>
      <p style="font-size:12.5px;color:var(--c-muted);margin:8px 0 18px;line-height:1.5">Set a race-day target. We simulate the rest of your block to show your chance of hitting it.</p>

      <div style="text-align:center;margin-bottom:4px">
        <div id="ppg-time" style="font-size:40px;font-weight:300;color:var(--c-black);letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${ft(goalSec)}</div>
      </div>
      <input id="ppg-slider" type="range" min="${minSec}" max="${maxSec}" step="${STEP}" value="${goalSec}" style="width:100%;margin:16px 0 4px;-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer" />
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums;margin-bottom:16px">
        <span>${ft(minSec)}</span><span>${ft(maxSec)}</span>
      </div>

      <div id="ppg-chance" style="border:1px solid rgba(0,0,0,0.06);border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px"></div>

      ${maxAdd > 0 ? `
        <div style="border:1px solid rgba(0,0,0,0.06);border-radius:12px;padding:12px 14px;margin-bottom:18px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div>
              <div style="font-size:13px;color:var(--c-black)">Add quality sessions</div>
              <div id="ppg-sess-cap" style="font-size:11.5px;color:var(--c-faint);margin-top:2px">${baseRunsPerWeek} runs/week</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <button id="ppg-minus" class="ppg-step" aria-label="Remove a session">−</button>
              <span id="ppg-added" style="font-size:14px;font-weight:500;color:var(--c-black);min-width:28px;text-align:center;font-variant-numeric:tabular-nums">+0</span>
              <button id="ppg-plus" class="ppg-step" aria-label="Add a session">+</button>
            </div>
          </div>
        </div>
      ` : ''}

      ${maxGymAdd > 0 ? `
        <div style="border:1px solid rgba(0,0,0,0.06);border-radius:12px;padding:12px 14px;margin-bottom:18px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div>
              <div style="font-size:13px;color:var(--c-black)">Add strength sessions</div>
              <div id="ppg-gym-cap" style="font-size:11.5px;color:var(--c-faint);margin-top:2px">${baseGym} strength/week</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px">
              <button id="ppg-gym-minus" class="ppg-step" aria-label="Remove a strength session">−</button>
              <span id="ppg-gym-added" style="font-size:14px;font-weight:500;color:var(--c-black);min-width:28px;text-align:center;font-variant-numeric:tabular-nums">+0</span>
              <button id="ppg-gym-plus" class="ppg-step" aria-label="Add a strength session">+</button>
            </div>
          </div>
        </div>
      ` : ''}

      <button id="ppg-save" class="pp-overlay-btn-primary" style="width:100%">Set this goal</button>
      ${savedGoal ? `<button id="ppg-clear" style="width:100%;padding:10px 0 0;background:none;border:none;color:var(--c-muted);font-size:13px;cursor:pointer">Clear goal</button>` : ''}
    </div>

    <style>
      #ppg-slider::-webkit-slider-runnable-track { height:4px;background:rgba(0,0,0,0.10);border-radius:2px; }
      #ppg-slider::-webkit-slider-thumb { -webkit-appearance:none;appearance:none;width:24px;height:24px;border-radius:50%;background:#fff;border:1px solid rgba(0,0,0,0.18);box-shadow:0 2px 6px rgba(0,0,0,0.18);margin-top:-10px;cursor:pointer; }
      #ppg-slider::-moz-range-track { height:4px;background:rgba(0,0,0,0.10);border-radius:2px; }
      #ppg-slider::-moz-range-thumb { width:24px;height:24px;border-radius:50%;background:#fff;border:1px solid rgba(0,0,0,0.18);box-shadow:0 2px 6px rgba(0,0,0,0.18);cursor:pointer; }
      .ppg-step { width:32px;height:32px;border-radius:50%;background:#FFFFFF;border:1px solid var(--c-border);color:var(--c-black);font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center; }
      .ppg-step:disabled { opacity:0.35;cursor:default; }
    </style>
  `;
  document.body.appendChild(overlay);

  const timeEl = overlay.querySelector('#ppg-time') as HTMLElement | null;
  const chanceEl = overlay.querySelector('#ppg-chance') as HTMLElement | null;
  const addedEl = overlay.querySelector('#ppg-added') as HTMLElement | null;
  const sessCapEl = overlay.querySelector('#ppg-sess-cap') as HTMLElement | null;
  const minusBtn = overlay.querySelector('#ppg-minus') as HTMLButtonElement | null;
  const plusBtn = overlay.querySelector('#ppg-plus') as HTMLButtonElement | null;
  const gymAddedEl = overlay.querySelector('#ppg-gym-added') as HTMLElement | null;
  const gymCapEl = overlay.querySelector('#ppg-gym-cap') as HTMLElement | null;
  const gymMinusBtn = overlay.querySelector('#ppg-gym-minus') as HTMLButtonElement | null;
  const gymPlusBtn = overlay.querySelector('#ppg-gym-plus') as HTMLButtonElement | null;

  const recomputeChance = (): void => {
    const gymCount = baseGym + addedGym;
    const predicted = forecastForSessions(getState(), baseSessions + added, gymCount);
    // Forecast lives with the sessions rows (cause → effect), not in the chance
    // box, so it doesn't read as a competing number against the goal + hero. Both
    // levers feed one combined forecast, so each row shows the same number.
    if (sessCapEl) sessCapEl.textContent = `${baseRunsPerWeek + added} runs/week · forecast ${ft(predicted)}`;
    if (gymCapEl) gymCapEl.textContent = `${gymCount} strength/week · forecast ${ft(predicted)}`;
    if (!chanceEl) return;
    const pct = goalChanceForState(getState(), goalSec, added, gymCount);
    if (pct == null) {
      chanceEl.innerHTML = `<div style="font-size:12px;color:var(--c-faint)">Forecast unavailable.</div>`;
      return;
    }
    chanceEl.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px">
        <span style="font-size:24px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums;line-height:1">${fmtProbPct(pct)}</span>
        <span style="font-size:12px;color:var(--c-muted)">chance of ${ft(goalSec)}</span>
      </div>
      <span style="font-size:12px;font-weight:600;color:${liveTone(pct)}">${liveLabel(pct)}</span>
    `;
  };
  recomputeChance();

  // Goal slider — debounced sim per frame.
  let pending = false;
  const slider = overlay.querySelector('#ppg-slider') as HTMLInputElement | null;
  slider?.addEventListener('input', () => {
    goalSec = Number(slider.value);
    if (timeEl) timeEl.textContent = ft(goalSec);
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => { pending = false; recomputeChance(); });
    }
  });

  const syncSteppers = (): void => {
    if (addedEl) addedEl.textContent = `+${added}`;
    // Caption text (runs/week + forecast) is set by recomputeChance, called
    // right after this in the +/- handlers.
    if (minusBtn) minusBtn.disabled = added <= 0;
    if (plusBtn) plusBtn.disabled = added >= maxAdd;
    if (gymAddedEl) gymAddedEl.textContent = `+${addedGym}`;
    if (gymMinusBtn) gymMinusBtn.disabled = addedGym <= 0;
    if (gymPlusBtn) gymPlusBtn.disabled = addedGym >= maxGymAdd;
  };
  minusBtn?.addEventListener('click', () => { if (added > 0) { added--; syncSteppers(); recomputeChance(); } });
  plusBtn?.addEventListener('click', () => { if (added < maxAdd) { added++; syncSteppers(); recomputeChance(); } });
  gymMinusBtn?.addEventListener('click', () => { if (addedGym > 0) { addedGym--; syncSteppers(); recomputeChance(); } });
  gymPlusBtn?.addEventListener('click', () => { if (addedGym < maxGymAdd) { addedGym++; syncSteppers(); recomputeChance(); } });

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#ppg-close')?.addEventListener('click', close);

  overlay.querySelector('#ppg-save')?.addEventListener('click', () => {
    // Regenerate first (initializeSimulator rewrites broad state), then pin the
    // goal so the regen can't clobber it. One regen for both levers.
    if (added > 0 || addedGym > 0) bumpSessionsAndGymAndRegen(added, addedGym);
    updateState({ raceGoalTimeSec: goalSec });
    saveState();
    close();
    rerender(onboarding);
  });

  overlay.querySelector('#ppg-clear')?.addEventListener('click', () => {
    updateState({ raceGoalTimeSec: undefined });
    saveState();
    close();
    rerender(onboarding);
  });
}

/* ---------- Handlers ---------- */

function wireHandlers(state: OnboardingState, milestone: MilestoneTarget | null, _showMilestone: boolean): void {
  document.getElementById('pp-start')?.addEventListener('click', () => {
    // The plan reveal now hands off to the post-plan workout demonstration, which is
    // the final step and completes onboarding. (plan-preview-v2 is running-only.)
    goToStep('workout-preview');
  });

  document.getElementById('pp-vdot-info')?.addEventListener('click', showVDOTExplanation);

  document.getElementById('pp-goal')?.addEventListener('click', () => openOnboardingGoalOverlay(state));

  document.getElementById('pp-accept')?.addEventListener('click', () => {
    if (milestone) {
      updateOnboarding({ targetMilestone: milestone, acceptedMilestoneChallenge: true });
      // Add the session FOR REAL: bump runsPerWeek and regenerate the plan so
      // the prescribed weeks gain it. (Bumping s.rw/s.epw alone was cosmetic —
      // the plan is built before this screen.)
      bumpSessionsAndRegen(1);
      saveState();
    }
    closeMilestoneOverlay();
    rerender(state);
  });

  document.getElementById('pp-decline')?.addEventListener('click', () => {
    updateOnboarding({ acceptedMilestoneChallenge: true });
    closeMilestoneOverlay();
  });
}

function closeMilestoneOverlay(): void {
  document.getElementById('pp-milestone-overlay')?.remove();
}

function showVDOTExplanation(): void {
  const s = getState();
  const hr = s.hrCalibratedVdot;
  const v = s.v;

  let methodBlock = '';
  if (hr && hr.vdot != null && hr.confidence !== 'none') {
    const runWord = hr.n === 1 ? 'run' : 'runs';
    const tier = hr.confidence === 'high'
      ? 'High confidence'
      : hr.confidence === 'medium' ? 'Medium confidence' : 'Rough estimate';
    const r2 = hr.r2 != null ? ` (R²=${hr.r2.toFixed(2)})` : '';
    methodBlock = `
      <div style="margin:14px 0 10px;padding:12px;background:var(--c-soft);border-radius:10px">
        <p style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;margin:0 0 6px">HOW WE MEASURED YOURS</p>
        <p style="font-size:13px;color:var(--c-black);margin:0 0 6px;line-height:1.55">
          Your VO2max of <strong>${v?.toFixed(1) ?? '—'}</strong> was measured from your heart rate response to pace across ${hr.n} steady ${runWord} in the last 8 weeks${r2}.
        </p>
        <p style="font-size:12px;color:var(--c-muted);margin:0;line-height:1.55">
          ${tier}. We regress %HRR (heart rate reserve) against pace to find the pace your heart says corresponds to VO2 max, then invert Daniels' formula.
        </p>
      </div>`;
  } else if (hr && hr.reason === 'no-rhr') {
    methodBlock = `
      <div style="margin:14px 0 10px;padding:12px;background:var(--c-soft);border-radius:10px">
        <p style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;margin:0 0 6px">HOW WE MEASURED YOURS</p>
        <p style="font-size:13px;color:var(--c-black);margin:0;line-height:1.55">
          Your VO2max of <strong>${v?.toFixed(1) ?? '—'}</strong> is estimated from your personal bests and recent training. Connect Garmin or add a resting HR to calibrate it from your heart rate.
        </p>
      </div>`;
  } else if (hr && (hr.reason === 'too-few-points' || hr.reason === 'no-points' || hr.reason === 'no-maxhr')) {
    methodBlock = `
      <div style="margin:14px 0 10px;padding:12px;background:var(--c-soft);border-radius:10px">
        <p style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;margin:0 0 6px">HOW WE MEASURED YOURS</p>
        <p style="font-size:13px;color:var(--c-black);margin:0;line-height:1.55">
          Your VO2max of <strong>${v?.toFixed(1) ?? '—'}</strong> is estimated from your personal bests and recent training. Heart-rate calibration kicks in once a few more steady runs sync.
        </p>
      </div>`;
  } else {
    methodBlock = `
      <div style="margin:14px 0 10px;padding:12px;background:var(--c-soft);border-radius:10px">
        <p style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;margin:0 0 6px">HOW WE MEASURED YOURS</p>
        <p style="font-size:13px;color:var(--c-black);margin:0;line-height:1.55">
          Your VO2max of <strong>${v?.toFixed(1) ?? '—'}</strong> is estimated from your personal bests and recent training.
        </p>
      </div>`;
  }

  const popup = document.createElement('div');
  popup.id = 'pp-vdot-popup';
  popup.className = 'pp-overlay-backdrop';
  popup.innerHTML = `
    <div class="pp-overlay-card shadow-ap" style="max-width:440px">
      <p style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;margin:0">ABOUT VO2MAX</p>
      <h3 style="font-size:18px;font-weight:500;color:var(--c-black);margin:8px 0 10px">Aerobic capacity, as a single number.</h3>
      <p style="font-size:13px;color:var(--c-muted);margin:0 0 10px;line-height:1.55">
        VO2max is how much oxygen your body can use at peak effort. We compute it from how your heart rate responds to pace (Jack Daniels' VDOT method), so the number reflects both aerobic capacity and running economy together.
      </p>
      ${methodBlock}
      <p style="font-size:13px;color:var(--c-muted);margin:0 0 10px;line-height:1.55">
        Your VO2max drives training paces across every zone. As fitness changes, paces update automatically.
      </p>
      <p style="font-size:11.5px;color:var(--c-faint);margin:0;line-height:1.5">References: Daniels' Running Formula (Jack Daniels, PhD); Swain & Leutholtz 1997 (%HRR ≈ %VO2R).</p>
      <div style="margin-top:16px">
        <button id="pp-vdot-close" class="pp-overlay-btn-primary" style="width:100%">Got it</button>
      </div>
    </div>
  `;
  document.body.appendChild(popup);
  const close = () => popup.remove();
  document.getElementById('pp-vdot-close')?.addEventListener('click', close);
  popup.addEventListener('click', (e) => { if (e.target === popup) close(); });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const cur = getOnboardingState() ?? state;
    const container = document.getElementById('app-root');
    if (container) renderPlanPreviewV2(container, cur);
  });
}
