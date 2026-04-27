import type { OnboardingState, MilestoneTarget } from '@/types/onboarding';
import { findNearestMilestone } from '@/types/onboarding';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { completeOnboarding, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { ft } from '@/utils/format';
import { getRunnerType, calculateLiveForecast } from '@/calculations';

/**
 * Page 7 — Plan Preview (v2).
 *
 * Visual-consistency rewrite of legacy `plan-preview.ts`. Structure is preserved:
 *  - Recalculate forecast via `calculateLiveForecast` (single source of truth)
 *  - Detect nearby milestone with `findNearestMilestone` (5% default, experience-scaled)
 *  - Show predicted finish, plan summary card, adaptive-prediction note
 *  - Start-training CTA → `completeOnboarding()` + reload
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

  const { forecastTime } = calculateLiveForecast({
    currentVdot: s.v || 50,
    targetDistance: s.rd,
    weeksRemaining: s.tw || 16,
    sessionsPerWeek: (s.epw || s.rw || 4) + (s.commuteConfig?.enabled ? s.commuteConfig.commuteDaysPerWeek : 0),
    runnerType: getRunnerType(s.b || 1.06),
    experienceLevel: s.onboarding?.experienceLevel || 'intermediate',
    weeklyVolumeKm: s.wkm,
    hmPbSeconds: s.pbs?.h || undefined,
    ltPaceSecPerKm: s.lt || undefined,
  });

  const milestone = s.continuousMode
    ? null
    : findNearestMilestone(forecastTime, raceDistance, 0.05, state.experienceLevel || 'intermediate');
  const showMilestonePopup = !!milestone && !state.acceptedMilestoneChallenge && state.targetMilestone === null;

  const shownTime = state.targetMilestone ? state.targetMilestone.time : forecastTime;

  container.innerHTML = `
    <style>
      @keyframes ppRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .pp-rise { opacity:0; animation: ppRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

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

      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 32%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(7, 7)}

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
            <div class="pp-row"><span class="pp-row-k">Runner type</span><span class="pp-row-v">${s.typ}</span></div>
            <div class="pp-row">
              <span class="pp-row-k">Starting VDOT</span>
              <span class="pp-row-v">
                ${(s.v ?? 0).toFixed(1)}
                <button id="pp-vdot-info" class="info" aria-label="What is VDOT?">
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
          <button id="pp-start" class="pp-cta">Start training</button>
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

/* ---------- Handlers ---------- */

function wireHandlers(state: OnboardingState, milestone: MilestoneTarget | null, _showMilestone: boolean): void {
  document.getElementById('pp-start')?.addEventListener('click', () => {
    completeOnboarding();
    window.location.reload();
  });

  document.getElementById('pp-vdot-info')?.addEventListener('click', showVDOTExplanation);

  document.getElementById('pp-accept')?.addEventListener('click', () => {
    if (milestone) {
      updateOnboarding({ targetMilestone: milestone, acceptedMilestoneChallenge: true });
      const s = getState();
      // Mirror legacy behaviour: nudge runs + sessions up by one, capped at 7/10.
      updateState({
        rw: Math.min(s.rw + 1, 7),
        epw: Math.min(s.epw + 1, 10),
      });
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
          Your VDOT of <strong>${v?.toFixed(1) ?? '—'}</strong> was measured from your heart rate response to pace across ${hr.n} steady ${runWord} in the last 8 weeks${r2}.
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
          Your VDOT of <strong>${v?.toFixed(1) ?? '—'}</strong> is estimated from your personal bests and recent training. Connect Garmin or add a resting HR to calibrate it from your heart rate.
        </p>
      </div>`;
  } else if (hr && (hr.reason === 'too-few-points' || hr.reason === 'no-points' || hr.reason === 'no-maxhr')) {
    methodBlock = `
      <div style="margin:14px 0 10px;padding:12px;background:var(--c-soft);border-radius:10px">
        <p style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;margin:0 0 6px">HOW WE MEASURED YOURS</p>
        <p style="font-size:13px;color:var(--c-black);margin:0;line-height:1.55">
          Your VDOT of <strong>${v?.toFixed(1) ?? '—'}</strong> is estimated from your personal bests and recent training. Heart-rate calibration kicks in once a few more steady runs sync.
        </p>
      </div>`;
  } else {
    methodBlock = `
      <div style="margin:14px 0 10px;padding:12px;background:var(--c-soft);border-radius:10px">
        <p style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;margin:0 0 6px">HOW WE MEASURED YOURS</p>
        <p style="font-size:13px;color:var(--c-black);margin:0;line-height:1.55">
          Your VDOT of <strong>${v?.toFixed(1) ?? '—'}</strong> is estimated from your personal bests and recent training.
        </p>
      </div>`;
  }

  const popup = document.createElement('div');
  popup.id = 'pp-vdot-popup';
  popup.className = 'pp-overlay-backdrop';
  popup.innerHTML = `
    <div class="pp-overlay-card shadow-ap" style="max-width:440px">
      <p style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;margin:0">ABOUT VDOT</p>
      <h3 style="font-size:18px;font-weight:500;color:var(--c-black);margin:8px 0 10px">Running performance, as a single number.</h3>
      <p style="font-size:13px;color:var(--c-muted);margin:0 0 10px;line-height:1.55">
        VDOT (Jack Daniels) models current running fitness as a single value. It correlates with VO2 max but also accounts for running economy, so it reflects race performance directly.
      </p>
      ${methodBlock}
      <p style="font-size:13px;color:var(--c-muted);margin:0 0 10px;line-height:1.55">
        Your VDOT drives training paces across every zone. As fitness changes, paces update automatically.
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
