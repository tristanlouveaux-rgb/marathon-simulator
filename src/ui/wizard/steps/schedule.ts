import type { OnboardingState, RecurringActivity, RunnerExperience } from '@/types/onboarding';
import type { RaceDistance, AbilityBand } from '@/types/training';
import type { CommuteConfig } from '@/types/state';
import { nextStep, updateOnboarding, getOnboardingState } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { SPORT_LABELS } from '@/constants/sports';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { easyRunMinutes, longRunMinutes } from '@/workouts/plan_engine';

/**
 * Page 6. Schedule.
 *
 * Consolidates the legacy `frequency.ts` + `activities.ts` into one screen:
 *  - Runs per week (3 to 7)
 *  - Running-focused gym sessions per week (0 to 3)
 *  - "What else do you do regularly" multi-select with per-activity frequency
 *
 * Writes: `runsPerWeek`, `gymSessionsPerWeek`, `recurringActivities`,
 *         `activeLifestyle` (set true iff any recurring activity is added),
 *         `sportsPerWeek` (kept in sync for legacy consumers. Sum of freqs).
 *
 * Aesthetic clone of `goals.ts` / `review.ts`:
 * - Apple 3-layer shadow (`.shadow-ap`)
 * - Monochrome pills, selected = black fill
 * - Entry animation `scRise`
 * - No accent colour, no tinted backgrounds, no emoji
 */

/**
 * Runs-per-week range. Event-training users start at 2 (1 run/week isn't a
 * running plan, it's cross-training). Non-event users (continuous fitness /
 * just-track / no specific race) may select 1. They're maintaining, not
 * building toward a distance. A conditional caption below 3 explains that
 * cross-training fills the adaptation gap for users running less frequently.
 */
const RUNS_PER_WEEK_EVENT_OPTIONS = [2, 3, 4, 5, 6, 7];
const RUNS_PER_WEEK_NON_EVENT_OPTIONS = [1, 2, 3, 4, 5, 6, 7];
/** Gym sessions range. 0-to-3 is the onboarding-state comment range (`gymSessionsPerWeek`). */
const GYM_OPTIONS = [0, 1, 2, 3];
/** Activity frequency range (times per week). Matches `activities.ts` 1 to 7. */
const ACT_FREQ_OPTIONS = [1, 2, 3, 4, 5, 6, 7];
/** Default duration (min) when the user adds an activity. 60 lands on the
 * typical session length for gym, swim, cycle, team sport. User can slide
 * 15-120 per activity. Locked 2026-04-22. */
const DEFAULT_ACTIVITY_DURATION_MIN = 60;
/** Assumed minutes per gym session for the time-budget estimator. Onboarding
 * stores `gymSessionsPerWeek` as a count, not a duration, so we anchor the
 * cross-training tally against a typical 60-min lifting session (warm-up +
 * 3-4 main lifts + accessories). Used only by the "your runs cover ~Xh"
 * hint under the runs grid. Does not affect plan generation. */
const ASSUMED_GYM_SESSION_MIN = 60;
/** Per-activity duration slider bounds (min). */
const DUR_MIN = 15;
const DUR_MAX = 120;
const DUR_STEP = 15;

/** Sports catalogue — flattened from SPORT_LABELS, ordered as the constants file lists them. */
const SPORT_ENTRIES = Object.entries(SPORT_LABELS) as [string, string][];

/** Formats minutes for the week preview: 45→"45 min", 60→"1h", 105→"1h 45". */
function formatMin(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '0';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return m === 0 ? `${h}h` : `${h}h ${m}`;
}

/** Map `RunnerExperience` (8 onboarding buckets) onto `AbilityBand` (5 plan
 * engine buckets). Returning maps to novice (rusty), hybrid to intermediate
 * (mixed-sport background but not running-specific), competitive to elite. */
function experienceToAbility(exp: RunnerExperience | undefined): AbilityBand {
  switch (exp) {
    case 'total_beginner': return 'beginner';
    case 'beginner':       return 'beginner';
    case 'returning':      return 'novice';
    case 'novice':         return 'novice';
    case 'hybrid':         return 'intermediate';
    case 'intermediate':   return 'intermediate';
    case 'advanced':       return 'advanced';
    case 'competitive':    return 'elite';
    default:               return 'intermediate';
  }
}

/** Per-run minutes anchors used by `weekShapePreview`. Reads ability from the
 * user's onboarding `experienceLevel` so a beginner doesn't see intermediate
 * run lengths in the preview. Build phase is the neutral peak-week reference. */
function runMinuteAnchors(race: RaceDistance | null, exp: RunnerExperience | undefined): { longMin: number; easyMin: number } {
  const r: RaceDistance = race ?? 'half';
  const ability = experienceToAbility(exp);
  return {
    longMin: longRunMinutes(8, 12, ability, r, 'build'),
    easyMin: easyRunMinutes(ability, r, 'build'),
  };
}

/** "Your week" preview — concrete session-by-session shape that updates as
 * the user moves any input above. Shows the per-session lengths the race plan
 * will deliver plus a weekly total. Run lengths come from race + ability +
 * phase, not a time budget, so the card carries an Adjust reveal: any session
 * can be lengthened or shortened later from the plan itself. */
function weekShapePreview(state: OnboardingState): string {
  const runs = state.runsPerWeek ?? 0;
  const gym = state.gymSessionsPerWeek ?? 0;
  const acts = state.recurringActivities;

  const cardStyle = 'background:#fff;border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.06)';

  if (runs === 0 && gym === 0 && acts.length === 0) {
    return `
      <div style="${cardStyle}">
        <label class="sc-micro" style="margin-bottom:0">YOUR WEEK</label>
        <p style="font-size:12px;color:var(--c-faint);margin:8px 0 0;line-height:1.5">Pick how often you run and we'll show what each session looks like.</p>
      </div>
    `;
  }

  const { longMin, easyMin } = runMinuteAnchors(state.raceDistance, state.experienceLevel);
  const easyCount = Math.max(0, runs - 1);
  const rowStyle = 'display:flex;justify-content:space-between;font-size:14px;color:var(--c-black);padding:6px 0;line-height:1.3';
  const valStyle = 'color:var(--c-muted);font-variant-numeric:tabular-nums';
  const rows: string[] = [];

  if (runs >= 1) {
    rows.push(`<div style="${rowStyle}"><span>Long run</span><span style="${valStyle}">${formatMin(longMin)}</span></div>`);
  }
  if (easyCount > 0) {
    rows.push(`<div style="${rowStyle}"><span>${easyCount}× run${easyCount > 1 ? 's' : ''}</span><span style="${valStyle}">${formatMin(easyMin)} each</span></div>`);
  }
  if (gym > 0) {
    rows.push(`<div style="${rowStyle}"><span>${gym}× gym</span><span style="${valStyle}">${formatMin(ASSUMED_GYM_SESSION_MIN)} each</span></div>`);
  }
  for (const a of acts) {
    const label = SPORT_LABELS[a.sport as keyof typeof SPORT_LABELS] ?? a.sport;
    const labelText = a.frequency === 1 ? label : `${a.frequency}× ${label.toLowerCase()}`;
    rows.push(`<div style="${rowStyle}"><span>${labelText}</span><span style="${valStyle}">${formatMin(a.durationMin)} each</span></div>`);
  }

  const runMins = (runs >= 1 ? longMin : 0) + easyCount * easyMin;
  const gymMins = gym * ASSUMED_GYM_SESSION_MIN;
  const crossMins = acts.reduce((s, a) => s + a.frequency * a.durationMin, 0);
  const totalMin = runMins + gymMins + crossMins;

  // Single total row. No target, no gap-to-fill: the plan sets run lengths,
  // and the Adjust reveal below tells the user they can reshape any session
  // live once the plan exists.
  const totalRow = `
    <div style="display:flex;justify-content:space-between;font-size:14px;color:var(--c-black);font-weight:500;padding:6px 0;line-height:1.3">
      <span>Weekly total</span>
      <span style="font-variant-numeric:tabular-nums">${formatMin(totalMin)}</span>
    </div>
  `;

  const footer = runs >= 1
    ? `<p style="font-size:11.5px;color:var(--c-faint);margin:8px 0 0;line-height:1.4">Run lengths follow your race plan. You can lengthen or shorten any session later from your plan.</p>`
    : '';

  return `
    <div style="${cardStyle}">
      <label class="sc-micro" style="margin-bottom:8px">YOUR WEEK</label>
      <div>${rows.join('')}</div>
      <div style="border-top:1px solid rgba(0,0,0,0.06);padding-top:4px;margin-top:6px">
        ${totalRow}
      </div>
      ${footer}
    </div>
  `;
}

/** Caption under the runs grid. Only fires for 1- or 2-run weeks where the
 *  cross-training framing is genuinely useful context. The week preview below
 *  handles the underflow / target-gap nudge. */
function runsCaption(state: OnboardingState | undefined): string {
  if (!state) return '';
  const runs = state.runsPerWeek;
  if (runs == null) return '';
  const hintStyle = 'font-size:11.5px;color:var(--c-faint);margin:8px 0 0;line-height:1.4';
  if (runs === 1) {
    return `<p style="${hintStyle}">One run maintains a baseline. Cross-training carries the aerobic load.</p>`;
  }
  if (runs === 2) {
    return `<p style="${hintStyle}">Works if you cross-train regularly to fill the aerobic gap.</p>`;
  }
  return '';
}

/** DOM patch helper — re-evaluates `runsCaption` from live onboarding state
 * and updates the caption node. Called from every input handler that touches
 * a field feeding the gap math (runs, gym, hours, recurring activities) so
 * the underflow flag stays consistent with the rest of the form. */
function refreshRunsCaption(): void {
  const node = document.getElementById('sc-runs-caption');
  if (!node) return;
  node.innerHTML = runsCaption(getOnboardingState());
}

/** Strength nudge: shown only at 0 gym sessions. Strength training raises
 *  running economy and cuts injury risk, so we encourage at least one session.
 *  Evidence: Beattie & Blagrove 2018 meta-analysis. */
function gymCaption(state: OnboardingState | undefined): string {
  if (!state || (state.gymSessionsPerWeek ?? 0) !== 0) return '';
  const hintStyle = 'font-size:11.5px;color:var(--c-faint);margin:8px 0 0;line-height:1.4';
  return `<p style="${hintStyle}">Even one strength session a week makes runners measurably faster and more injury-resistant (Beattie &amp; Blagrove 2018). Try adding one.</p>`;
}

function refreshGymCaption(): void {
  const node = document.getElementById('sc-gym-caption');
  if (!node) return;
  node.innerHTML = gymCaption(getOnboardingState());
}

/** Re-render the week-shape preview from live onboarding state. Called from
 * every input handler that touches a field feeding the preview math. */
function refreshWeekPreview(): void {
  const node = document.getElementById('sc-week-preview');
  if (!node) return;
  const cur = getOnboardingState();
  if (!cur) return;
  node.innerHTML = weekShapePreview(cur);
}

/** Heuristic intensity mapper, mirrored from legacy `activities.ts`. */
function inferIntensity(sportKey: string): 'easy' | 'moderate' | 'hard' {
  const hard = ['soccer', 'rugby', 'basketball', 'boxing', 'crossfit', 'martial_arts', 'jump_rope'];
  const easy = ['swimming', 'yoga', 'pilates', 'walking', 'hiking'];
  if (hard.includes(sportKey)) return 'hard';
  if (easy.includes(sportKey)) return 'easy';
  return 'moderate';
}

export function renderSchedule(container: HTMLElement, state: OnboardingState): void {
  const isNonEvent = state.trainingForEvent === false || state.continuousMode === true || state.trainingMode === 'fitness';
  const runsOptions = isNonEvent ? RUNS_PER_WEEK_NON_EVENT_OPTIONS : RUNS_PER_WEEK_EVENT_OPTIONS;

  container.innerHTML = `
    <style>
      @keyframes scRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .sc-rise { opacity:0; animation: scRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .sc-hint { font-size:12px; color:var(--c-faint); margin:5px 0 0; line-height:1.5; }

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      .sc-micro { display:block; font-size:11px; color:var(--c-faint); letter-spacing:0.08em; margin:0 0 10px; }

      /* Question-style label (sports toggle) — sentence case, not a section caps label. */
      .sc-q { display:block; font-size:15px; font-weight:500; color:var(--c-black); margin:0 0 4px; line-height:1.3; }
      .sc-q-sub { font-size:12px; color:var(--c-faint); margin:0 0 12px; line-height:1.45; }
      .sc-yesno { display:grid; grid-template-columns:1fr 1fr; gap:8px; }

      /* Age input + gate hint. */
      .sc-age-input { width:72px; height:42px; border-radius:8px; border:1px solid var(--c-border); text-align:center; font-size:16px; background:#fff; color:var(--c-black); }
      .sc-age-input:focus { outline:none; border-color:var(--c-black); }
      .sc-gate-hint { font-size:12px; color:var(--c-faint); text-align:center; margin:10px 0 0; min-height:16px; }

      /* Commute (run-to-work) inline fields. */
      .sc-cm-field { display:flex; align-items:center; gap:12px; }
      .sc-cm-label { font-size:14px; color:var(--c-black); font-weight:500; margin:0; line-height:1.2; }

      /* Numeric pill grid (runs / gym). */
      .sc-num-grid { display:grid; gap:8px; }
      .sc-num {
        background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:14px;
        padding:12px 6px; color:var(--c-black); cursor:pointer;
        display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:500;
        transition: transform 0.12s ease, box-shadow 0.2s ease;
      }
      .sc-num:active { transform: translateY(0.5px) scale(0.99); }
      .sc-num.selected { background:#0A0A0A; color:#FDFCF7; border-color: rgba(0,0,0,0.9); box-shadow: 0 0 0 1px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.10); }

      /* Section card wrapper — used for the "other activities" group. */
      .sc-section { display:flex; flex-direction:column; gap:14px; }

      /* Sport picker — single row on mobile, grid of chips. */
      .sc-chip-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; }
      .sc-chip {
        background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:12px;
        padding:10px 6px; color:var(--c-black); cursor:pointer;
        font-size:13px; font-weight:500; text-align:center;
        transition: transform 0.12s ease, box-shadow 0.2s ease;
      }
      .sc-chip:active { transform: translateY(0.5px) scale(0.99); }
      .sc-chip.selected { background:#0A0A0A; color:#FDFCF7; border-color: rgba(0,0,0,0.9); }

      /* Active-row card — edits an existing recurring activity. */
      .sc-active {
        display:flex; align-items:center; gap:12px; width:100%;
        background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:16px;
        padding:12px 14px;
      }
      .sc-active-body { flex:1; min-width:0; }
      .sc-active-title { font-size:14px; font-weight:500; color:var(--c-black); margin:0; line-height:1.2; }
      .sc-active-sub { font-size:11.5px; color:var(--c-faint); margin:3px 0 0; }

      .sc-freq-row { display:flex; align-items:center; gap:6px; flex-shrink:0; }
      .sc-freq-btn {
        width:26px; height:26px; border-radius:8px; border:1px solid rgba(0,0,0,0.1);
        background:#FFFFFF; color:var(--c-black); cursor:pointer; font-size:14px; line-height:1;
      }
      .sc-freq-btn[disabled] { opacity:0.3; cursor:not-allowed; }
      .sc-freq-val { min-width:24px; text-align:center; font-size:14px; font-weight:500; color:var(--c-black); font-variant-numeric: tabular-nums; }

      /* Small X icon button — replaces the old underlined "Remove" link for less visual weight. */
      .sc-remove-x {
        flex:0 0 auto; width:28px; height:28px; border-radius:50%;
        background:rgba(0,0,0,0.04); border:1px solid rgba(0,0,0,0.06); color:var(--c-muted);
        display:flex; align-items:center; justify-content:center; cursor:pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .sc-remove-x:hover { background:rgba(0,0,0,0.07); color:var(--c-black); }
      .sc-remove-x:active { transform: scale(0.95); }

      /* Per-activity duration slider — monochrome, matches readiness-view sliders. */
      .sc-dur-slider { -webkit-appearance:none; appearance:none; width:100%; height:4px; border-radius:2px; background:rgba(0,0,0,0.1); outline:none; cursor:pointer; }
      .sc-dur-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:20px; height:20px; border-radius:50%; background:#0A0A0A; border:2px solid #FDFCF7; box-shadow: 0 1px 3px rgba(0,0,0,0.2); cursor:pointer; }
      .sc-dur-slider::-moz-range-thumb { width:20px; height:20px; border-radius:50%; background:#0A0A0A; border:2px solid #FDFCF7; box-shadow: 0 1px 3px rgba(0,0,0,0.2); cursor:pointer; border:none; }

      /* Toggle-open "add another" link. */
      .sc-add-toggle {
        background:none; border:none; color:var(--c-muted); font-size:13px; cursor:pointer;
        padding:10px 6px; text-decoration:underline;
      }
      .sc-add-toggle:active { color:var(--c-black); }

      /* CTA. */
      .sc-cta { width:100%; height:50px; border-radius:25px; background:#0A0A0A; color:#FDFCF7; border:none; font-size:15px; font-weight:500; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.1), 0 8px 22px -8px rgba(0,0,0,0.35); transition: transform 0.12s ease; }
      .sc-cta:active { transform: translateY(1px); }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <!-- Background layers: cool-blue atmosphere → asymmetric (left) rings → sun glint -->
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('sch', { variant: 'asymmetric', side: 'left' })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(6, 8)}

        <div class="sc-rise" style="width:100%;max-width:480px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.15">
            Your weekly schedule
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">
            How often you train. Cross-training counts.
          </p>
        </div>

        <div class="sc-rise" style="width:100%;max-width:480px;margin-top:24px;animation-delay:0.12s;display:flex;flex-direction:column;gap:22px">

          <!-- About you (age — and sex if Strava didn't give it). Sets max HR + zones. -->
          <div style="background:#fff;border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.06)">
            <label class="sc-micro" style="margin-bottom:14px">ABOUT YOU</label>
            <div style="display:flex;align-items:center;gap:12px">
              <span style="flex:1;font-size:14px;color:var(--c-black)">Your age</span>
              <input id="sc-age" class="sc-age-input" type="number" inputmode="numeric" min="14" max="90"
                value="${state.age ?? ''}" placeholder="—">
            </div>
            ${state.biologicalSex ? '' : `
            <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(0,0,0,0.06)">
              <span style="font-size:14px;color:var(--c-black)">Sex</span>
              <div class="sc-num-grid" style="grid-template-columns:repeat(3,1fr);margin-top:8px">
                <button data-sex="male" class="sc-num ${state.biologicalSex === 'male' ? 'selected' : ''}">Male</button>
                <button data-sex="female" class="sc-num ${state.biologicalSex === 'female' ? 'selected' : ''}">Female</button>
                <button data-sex="prefer_not_to_say" class="sc-num ${state.biologicalSex === 'prefer_not_to_say' ? 'selected' : ''}" style="font-size:12.5px">Prefer not</button>
              </div>
              <p class="sc-hint">Refines your recovery and effort estimates.</p>
            </div>
            `}
          </div>

          <div>
            <label class="sc-micro">RUNS PER WEEK</label>
            <div class="sc-num-grid" style="grid-template-columns:repeat(${runsOptions.length},1fr)">
              ${runsOptions.map(n => `
                <button data-runs="${n}" class="sc-num ${state.runsPerWeek === n ? 'selected' : ''}">${n}</button>
              `).join('')}
            </div>
            <div id="sc-runs-caption">${runsCaption(state)}</div>
          </div>

          <div>
            <label class="sc-micro">GYM SESSIONS PER WEEK</label>
            <div class="sc-num-grid" style="grid-template-columns:repeat(${GYM_OPTIONS.length},1fr)">
              ${GYM_OPTIONS.map(n => `
                <button data-gym="${n}" class="sc-num ${state.gymSessionsPerWeek === n ? 'selected' : ''}">${n}</button>
              `).join('')}
            </div>
            <div id="sc-gym-caption">${gymCaption(state)}</div>
          </div>

          <div id="sc-week-preview">${weekShapePreview(state)}</div>

          <div id="sc-other-activities">${renderOtherActivities(state)}</div>

          <div id="sc-commute">${renderCommuteSection(state)}</div>

        </div>
      </div>

      <div class="sc-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.28s">
        <div style="max-width:480px;margin:0 auto">
          <button id="sc-continue" class="sc-cta">Continue</button>
          <p id="sc-gate-hint" class="sc-gate-hint"></p>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(state);
}

function renderOtherActivities(state: OnboardingState): string {
  const active = state.recurringActivities;
  const activeKeys = new Set(active.map(a => a.sport));
  const allSelected = activeKeys.size >= SPORT_ENTRIES.length;
  // Default the toggle to "No" (collapsed). Open it only if the user already has
  // sports added (e.g. returning to the step, or Strava/express-path seeded them).
  const playsSports = active.length > 0;

  return `
    <div class="sc-section">
      <div>
        <label class="sc-q">Do you play other sports regularly?</label>
        <p class="sc-q-sub">Don't worry if it's not regular — we'll auto-adjust your plan. Each session reduces your run load.</p>
        <div class="sc-yesno">
          <button data-sports-toggle="no" class="sc-num ${playsSports ? '' : 'selected'}">No</button>
          <button data-sports-toggle="yes" class="sc-num ${playsSports ? 'selected' : ''}">Yes</button>
        </div>
      </div>

      <div id="sc-sports-body" style="display:${playsSports ? 'flex' : 'none'};flex-direction:column;gap:14px">
        ${allSelected ? '' : renderSportPicker(activeKeys)}

        ${active.length > 0 ? `
          <div style="display:flex;flex-direction:column;gap:8px">
            ${active.map((a, i) => renderActiveRow(a, i)).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderActiveRow(a: RecurringActivity, idx: number): string {
  const label = SPORT_LABELS[a.sport as keyof typeof SPORT_LABELS] ?? a.sport;
  return `
    <div class="sc-active shadow-ap" data-idx="${idx}" style="flex-direction:column;align-items:stretch;gap:12px;padding:14px 14px 16px;position:relative">
      <!-- Title row. X icon top-right for Remove. -->
      <div style="display:flex;align-items:center;gap:12px">
        <p class="sc-active-title" style="flex:1">${label}</p>
        <button class="sc-remove-x" data-remove="${idx}" aria-label="Remove ${label}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <!-- Frequency stepper row. -->
      <div style="display:flex;align-items:center;gap:10px">
        <span class="sc-active-sub" style="flex:1;margin:0">Sessions per week</span>
        <div class="sc-freq-row">
          <button class="sc-freq-btn" data-freq-dec="${idx}" ${a.frequency <= 1 ? 'disabled' : ''}>−</button>
          <span class="sc-freq-val">${a.frequency}</span>
          <button class="sc-freq-btn" data-freq-inc="${idx}" ${a.frequency >= ACT_FREQ_OPTIONS[ACT_FREQ_OPTIONS.length - 1] ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <!-- Duration slider with inline readout. -->
      <div style="display:flex;align-items:center;gap:12px">
        <span class="sc-active-sub" style="flex:0 0 auto;margin:0;min-width:68px"><span data-dur-readout="${idx}">${a.durationMin}</span> min</span>
        <input type="range"
          class="sc-dur-slider"
          data-dur="${idx}"
          min="${DUR_MIN}" max="${DUR_MAX}" step="${DUR_STEP}" value="${a.durationMin}"
          aria-label="${label} duration in minutes"
          style="flex:1"
        />
      </div>
    </div>
  `;
}

/**
 * Run-to-work (commute) capture, folded onto the schedule step under a Yes/No
 * toggle next to the sports question (Tristan: "could this not just sit under
 * 'do you play sports?'"). Same fields and `commuteConfig` shape as the old
 * standalone commute step; the plan engine reads the config wherever it's set.
 */
function renderCommuteSection(state: OnboardingState): string {
  const cfg = state.commuteConfig;
  const yes = state.runsToWork === true || cfg?.enabled === true;
  const distance = cfg?.distanceKm ? String(cfg.distanceKm) : '';
  const bidir = cfg?.isBidirectional ?? true;
  const days = cfg?.commuteDaysPerWeek && cfg.commuteDaysPerWeek > 0 ? cfg.commuteDaysPerWeek : 3;
  const backpack = cfg?.backpackKg ? String(cfg.backpackKg) : '';

  return `
    <div class="sc-section">
      <div>
        <label class="sc-q">Do you run to or from work?</label>
        <p class="sc-q-sub">Commute runs are added on top of your plan. We track the extra easy mileage as its own sessions.</p>
        <div class="sc-yesno">
          <button data-commute-toggle="no" class="sc-num ${yes ? '' : 'selected'}">No</button>
          <button data-commute-toggle="yes" class="sc-num ${yes ? 'selected' : ''}">Yes</button>
        </div>
      </div>

      <div id="sc-commute-body" style="display:${yes ? 'flex' : 'none'};flex-direction:column;gap:16px">
        <div class="sc-cm-field">
          <div style="flex:1">
            <p class="sc-cm-label">One-way distance</p>
            <p class="sc-hint" style="margin-top:2px">Home to work, in km.</p>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <input id="sc-cm-distance" class="sc-age-input" type="number" inputmode="decimal" min="1" max="30" step="0.5" placeholder="—" value="${distance}">
            <span style="font-size:13px;color:var(--c-faint)">km</span>
          </div>
        </div>

        <div class="sc-cm-field">
          <div style="flex:1">
            <p class="sc-cm-label">Run both ways?</p>
            <p class="sc-hint" style="margin-top:2px">To and from work, or one direction.</p>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button data-bidir="one" class="sc-num ${bidir ? '' : 'selected'}" style="padding:8px 14px">One way</button>
            <button data-bidir="both" class="sc-num ${bidir ? 'selected' : ''}" style="padding:8px 14px">Both</button>
          </div>
        </div>

        <div>
          <p class="sc-cm-label" style="margin-bottom:8px">Days per week</p>
          <div class="sc-num-grid" style="grid-template-columns:repeat(5,1fr)">
            ${[1, 2, 3, 4, 5].map(d => `<button data-cm-days="${d}" class="sc-num ${days === d ? 'selected' : ''}">${d}</button>`).join('')}
          </div>
        </div>

        <div class="sc-cm-field">
          <div style="flex:1">
            <p class="sc-cm-label">Backpack weight <span style="color:var(--c-faint);font-weight:400">(optional)</span></p>
            <p class="sc-hint" style="margin-top:2px">Leave blank if you don't carry one.</p>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <input id="sc-cm-backpack" class="sc-age-input" type="number" inputmode="decimal" min="0" max="25" step="0.5" placeholder="0" value="${backpack}">
            <span style="font-size:13px;color:var(--c-faint)">kg</span>
          </div>
        </div>

        <p id="sc-cm-summary" class="sc-hint" style="margin:0"></p>
      </div>
    </div>
  `;
}

function renderSportPicker(activeKeys: Set<string>): string {
  return `
    <div class="sc-chip-grid">
      ${SPORT_ENTRIES.map(([key, label]) => {
        const selected = activeKeys.has(key);
        return `
          <button data-sport-add="${key}" class="sc-chip ${selected ? 'selected' : ''}">${label}</button>
        `;
      }).join('')}
    </div>
  `;
}

/* ---------- Handlers ---------- */

function wireHandlers(state: OnboardingState): void {
  // Runs per week. Update selection + caption in-place to avoid full rerender.
  document.querySelectorAll<HTMLElement>('[data-runs]').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.getAttribute('data-runs') || '0', 10);
      if (Number.isNaN(n)) return;
      updateOnboarding({ runsPerWeek: n });
      document.querySelectorAll<HTMLElement>('[data-runs]').forEach(b => {
        const v = parseInt(b.getAttribute('data-runs') || '0', 10);
        b.classList.toggle('selected', v === n);
      });
      refreshRunsCaption();
      refreshWeekPreview();
    });
  });

  // Gym sessions. Update selection in-place; refresh preview since gym
  // sessions feed total time math.
  document.querySelectorAll<HTMLElement>('[data-gym]').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.getAttribute('data-gym') || '0', 10);
      if (Number.isNaN(n)) return;
      updateOnboarding({ gymSessionsPerWeek: n });
      document.querySelectorAll<HTMLElement>('[data-gym]').forEach(b => {
        const v = parseInt(b.getAttribute('data-gym') || '0', 10);
        b.classList.toggle('selected', v === n);
      });
      refreshRunsCaption();
      refreshGymCaption();
      refreshWeekPreview();
    });
  });

  // Age (required — Strava/Apple can't give us a birthdate, so this is the one
  // physiology field we always ask. Captured here now that the About-you step is gone).
  document.getElementById('sc-age')?.addEventListener('input', () => {
    const el = document.getElementById('sc-age') as HTMLInputElement | null;
    const n = el ? parseInt(el.value, 10) : NaN;
    updateOnboarding({ age: Number.isFinite(n) ? n : undefined });
    clearGateHint();
  });

  // Sex pills (only rendered when Strava didn't pre-fill biologicalSex).
  document.querySelectorAll<HTMLElement>('[data-sex]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sex = btn.getAttribute('data-sex') as 'male' | 'female' | 'prefer_not_to_say' | null;
      if (!sex) return;
      updateOnboarding({ biologicalSex: sex });
      document.querySelectorAll<HTMLElement>('[data-sex]').forEach(b =>
        b.classList.toggle('selected', b.getAttribute('data-sex') === sex));
      clearGateHint();
    });
  });

  wireActivitiesHandlers(state);
  wireCommuteHandlers();
  refreshCommuteSummary();

  // Continue — gated on age + sex (max-HR estimation needs both), and on a commute
  // distance when run-to-work is set to Yes.
  document.getElementById('sc-continue')?.addEventListener('click', () => {
    const cur = getOnboardingState();
    const age = cur?.age;
    const ageOk = typeof age === 'number' && age >= 14 && age <= 90;
    if (!ageOk) {
      showGateHint('Add your age to continue.');
      document.getElementById('sc-age')?.focus();
      return;
    }
    if (!cur?.biologicalSex) {
      showGateHint('Pick your sex to continue.');
      return;
    }
    if (cur?.runsToWork === true && !(cur.commuteConfig?.distanceKm && cur.commuteConfig.distanceKm > 0)) {
      showGateHint('Add your commute distance, or switch run-to-work to No.');
      document.getElementById('sc-cm-distance')?.focus();
      return;
    }
    nextStep();
  });
}

function showGateHint(msg: string): void {
  const el = document.getElementById('sc-gate-hint');
  if (el) el.textContent = msg;
}
function clearGateHint(): void {
  const el = document.getElementById('sc-gate-hint');
  if (el) el.textContent = '';
}

/* ---------- Commute (run-to-work) handlers ---------- */

function wireCommuteHandlers(): void {
  document.querySelectorAll<HTMLElement>('[data-commute-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const yes = btn.getAttribute('data-commute-toggle') === 'yes';
      updateOnboarding({ runsToWork: yes });
      document.querySelectorAll<HTMLElement>('[data-commute-toggle]').forEach(b =>
        b.classList.toggle('selected', (b.getAttribute('data-commute-toggle') === 'yes') === yes));
      const body = document.getElementById('sc-commute-body');
      if (body) body.style.display = yes ? 'flex' : 'none';
      if (yes) {
        const cur = getOnboardingState();
        if (!cur?.commuteConfig || !cur.commuteConfig.commuteDaysPerWeek) {
          updateOnboarding({ commuteConfig: { enabled: false, distanceKm: 0, isBidirectional: true, commuteDaysPerWeek: 3 } });
        }
        persistCommute();
      } else {
        updateOnboarding({ commuteConfig: { enabled: false, distanceKm: 0, isBidirectional: false, commuteDaysPerWeek: 0 } });
      }
      refreshCommuteSummary();
      clearGateHint();
    });
  });

  document.getElementById('sc-cm-distance')?.addEventListener('input', () => {
    persistCommute();
    refreshCommuteSummary();
    clearGateHint();
  });

  // Both ways / one way.
  document.querySelectorAll<HTMLElement>('[data-bidir]').forEach(btn => {
    btn.addEventListener('click', () => {
      const both = btn.getAttribute('data-bidir') === 'both';
      const cur = getOnboardingState();
      const existing = cur?.commuteConfig ?? { enabled: false, distanceKm: 0, isBidirectional: true, commuteDaysPerWeek: 3 };
      updateOnboarding({ commuteConfig: { ...existing, isBidirectional: both } });
      document.querySelectorAll<HTMLElement>('[data-bidir]').forEach(b =>
        b.classList.toggle('selected', (b.getAttribute('data-bidir') === 'both') === both));
      refreshCommuteSummary();
    });
  });

  // Days per week.
  document.querySelectorAll<HTMLElement>('[data-cm-days]').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = parseInt(btn.getAttribute('data-cm-days') || '0', 10);
      if (!d) return;
      const cur = getOnboardingState();
      const existing = cur?.commuteConfig ?? { enabled: false, distanceKm: 0, isBidirectional: true, commuteDaysPerWeek: d };
      updateOnboarding({ commuteConfig: { ...existing, commuteDaysPerWeek: d } });
      document.querySelectorAll<HTMLElement>('[data-cm-days]').forEach(b =>
        b.classList.toggle('selected', parseInt(b.getAttribute('data-cm-days') || '0', 10) === d));
      refreshCommuteSummary();
    });
  });

  document.getElementById('sc-cm-backpack')?.addEventListener('input', () => {
    persistCommute();
    refreshCommuteSummary();
  });
}

/** Rebuild commuteConfig from the live inputs (distance/backpack) + persisted
 * days/bidirectional. Mirrors the old commute step's persistConfig. */
function persistCommute(): void {
  const s = getOnboardingState();
  if (!s) return;
  if (s.runsToWork !== true) {
    updateOnboarding({ commuteConfig: { enabled: false, distanceKm: 0, isBidirectional: false, commuteDaysPerWeek: 0 } });
    return;
  }
  const distEl = document.getElementById('sc-cm-distance') as HTMLInputElement | null;
  const backpackEl = document.getElementById('sc-cm-backpack') as HTMLInputElement | null;
  const dist = distEl ? Number(distEl.value) : NaN;
  const distance = Number.isFinite(dist) && dist > 0 ? dist : 0;
  const isBidirectional = s.commuteConfig?.isBidirectional ?? true;
  const daysRaw = s.commuteConfig?.commuteDaysPerWeek;
  const days = daysRaw && daysRaw > 0 ? daysRaw : 3;
  const backpackRaw = backpackEl ? Number(backpackEl.value) : NaN;
  const backpackKg = Number.isFinite(backpackRaw) && backpackRaw > 0 ? backpackRaw : undefined;

  const cfg: CommuteConfig = {
    enabled: distance > 0,
    distanceKm: distance,
    isBidirectional,
    commuteDaysPerWeek: Math.min(Math.max(days, 1), 5),
    ...(backpackKg ? { backpackKg } : {}),
  };
  updateOnboarding({ commuteConfig: cfg });
}

function refreshCommuteSummary(): void {
  const el = document.getElementById('sc-cm-summary');
  if (!el) return;
  const cfg = getOnboardingState()?.commuteConfig;
  if (!cfg || !cfg.enabled || !cfg.distanceKm || cfg.distanceKm <= 0) { el.textContent = ''; return; }
  const perDay = cfg.isBidirectional ? cfg.distanceKm * 2 : cfg.distanceKm;
  const weekly = perDay * cfg.commuteDaysPerWeek;
  const pack = cfg.backpackKg && cfg.backpackKg > 0 ? ` with a ${cfg.backpackKg}kg pack` : '';
  el.textContent = `That's about ${weekly.toFixed(0)} km/week of easy mileage${pack}.`;
}

/**
 * Wire handlers scoped to the activities subtree. Re-invoked after a section-only
 * rerender (rerenderActivities), so a sport toggle / freq step / remove doesn't
 * tear down the whole step and replay entrance animations.
 */
function wireActivitiesHandlers(state: OnboardingState): void {
  // "Do you play other sports regularly?" Yes/No toggle. Yes reveals the picker;
  // No collapses it and clears any added sports (so the answer and the data agree).
  document.querySelectorAll<HTMLElement>('[data-sports-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-sports-toggle');
      if (val === 'no') {
        updateOnboarding({ recurringActivities: [], sportsPerWeek: 0, activeLifestyle: false });
        rerenderActivities();
        refreshRunsCaption();
        refreshWeekPreview();
      } else {
        const body = document.getElementById('sc-sports-body');
        if (body) body.style.display = 'flex';
        document.querySelectorAll<HTMLElement>('[data-sports-toggle]').forEach(b =>
          b.classList.toggle('selected', b.getAttribute('data-sports-toggle') === 'yes'));
      }
    });
  });

  // Add / toggle a sport.
  document.querySelectorAll<HTMLElement>('[data-sport-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sport = btn.getAttribute('data-sport-add');
      if (!sport) return;
      const current = state.recurringActivities;
      const existing = current.findIndex(a => a.sport === sport);
      let next: RecurringActivity[];
      if (existing >= 0) {
        next = current.filter((_, i) => i !== existing);
      } else {
        next = [
          ...current,
          {
            sport,
            durationMin: DEFAULT_ACTIVITY_DURATION_MIN,
            frequency: 1,
            intensity: inferIntensity(sport),
          },
        ];
      }
      const totalFreq = next.reduce((sum, a) => sum + a.frequency, 0);
      updateOnboarding({
        recurringActivities: next,
        sportsPerWeek: totalFreq,
        activeLifestyle: next.length > 0 ? true : state.activeLifestyle,
      });
      rerenderActivities();
    });
  });

  // Frequency +/- on an existing activity.
  document.querySelectorAll<HTMLElement>('[data-freq-inc]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-freq-inc') || '-1', 10);
      adjustFrequency(state, i, +1);
    });
  });
  document.querySelectorAll<HTMLElement>('[data-freq-dec]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-freq-dec') || '-1', 10);
      adjustFrequency(state, i, -1);
    });
  });

  // Duration slider per active row. `input` event for live readout, `change` for persist.
  document.querySelectorAll<HTMLInputElement>('input[data-dur]').forEach(slider => {
    const idx = parseInt(slider.getAttribute('data-dur') || '-1', 10);
    if (idx < 0) return;
    const readout = document.querySelector<HTMLElement>(`[data-dur-readout="${idx}"]`);
    slider.addEventListener('input', () => {
      if (readout) readout.textContent = slider.value;
    });
    slider.addEventListener('change', () => {
      const mins = parseInt(slider.value, 10);
      if (!Number.isFinite(mins)) return;
      const next = state.recurringActivities.map((a, i) => i === idx ? { ...a, durationMin: mins } : a);
      updateOnboarding({ recurringActivities: next });
      // No rerender. Live readout handles display; skipping rerender keeps slider focus.
      refreshRunsCaption();
      refreshWeekPreview();
    });
  });

  // Remove row.
  document.querySelectorAll<HTMLElement>('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-remove') || '-1', 10);
      if (i < 0) return;
      const next = state.recurringActivities.filter((_, idx) => idx !== i);
      const totalFreq = next.reduce((sum, a) => sum + a.frequency, 0);
      updateOnboarding({
        recurringActivities: next,
        sportsPerWeek: totalFreq,
        activeLifestyle: next.length > 0,
      });
      rerenderActivities();
    });
  });
}

function adjustFrequency(state: OnboardingState, idx: number, delta: 1 | -1): void {
  if (idx < 0 || idx >= state.recurringActivities.length) return;
  const cur = state.recurringActivities[idx];
  const nextFreq = cur.frequency + delta;
  if (nextFreq < 1 || nextFreq > ACT_FREQ_OPTIONS[ACT_FREQ_OPTIONS.length - 1]) return;
  const next = state.recurringActivities.map((a, i) => i === idx ? { ...a, frequency: nextFreq } : a);
  const totalFreq = next.reduce((sum, a) => sum + a.frequency, 0);
  updateOnboarding({ recurringActivities: next, sportsPerWeek: totalFreq });
  rerenderActivities();
}

/** Rerender only the "Other sports" subtree. Avoids rebuilding the whole step
 * (which would reset scroll position and replay entrance animations). Also
 * refreshes the runs caption since adding/removing activities or changing
 * frequency affects the underflow-flag math. */
function rerenderActivities(): void {
  import('../controller').then(({ getOnboardingState }) => {
    const cur = getOnboardingState();
    if (!cur) return;
    const container = document.getElementById('sc-other-activities');
    if (!container) return;
    container.innerHTML = renderOtherActivities(cur);
    wireActivitiesHandlers(cur);
    refreshRunsCaption();
    refreshWeekPreview();
  });
}
