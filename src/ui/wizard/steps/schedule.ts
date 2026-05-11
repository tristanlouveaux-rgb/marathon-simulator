import type { OnboardingState, RecurringActivity, RunnerExperience } from '@/types/onboarding';
import type { RaceDistance, AbilityBand } from '@/types/training';
import { nextStep, updateOnboarding, getOnboardingState } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { SPORT_LABELS } from '@/constants/sports';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { easyRunMinutes, longRunMinutes } from '@/workouts/plan_engine';

/**
 * Page 6 — Schedule.
 *
 * Consolidates the legacy `frequency.ts` + `activities.ts` into one screen:
 *  - Runs per week (3 to 7)
 *  - Running-focused gym sessions per week (0 to 3)
 *  - "What else do you do regularly" multi-select with per-activity frequency
 *
 * Writes: `runsPerWeek`, `gymSessionsPerWeek`, `recurringActivities`,
 *         `activeLifestyle` (set true iff any recurring activity is added),
 *         `sportsPerWeek` (kept in sync for legacy consumers — sum of freqs).
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
 * just-track / no specific race) may select 1 — they're maintaining, not
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
 * hint under the runs grid — does not affect plan generation. */
const ASSUMED_GYM_SESSION_MIN = 60;
/** Per-activity duration slider bounds (min). */
const DUR_MIN = 15;
const DUR_MAX = 120;
const DUR_STEP = 15;

/** Sports catalogue — flattened from SPORT_LABELS, ordered as the constants file lists them. */
const SPORT_ENTRIES = Object.entries(SPORT_LABELS) as [string, string][];

/** Hours slider range and default by race distance.
 * Defaults calibrated to "first event, time-constrained" not "competitive
 * intermediate" — most onboarding users are building toward their first race,
 * not their fifth. Each default lands at roughly running portion + ~2h cross
 * buffer for a 4-runs/week starting point. Range stays wide so users can slide
 * up to Pfitzinger / Daniels competitive volumes (5K: 4–8h, marathon: 8–14h). */
const HOURS_BY_RACE: Record<string, { min: number; max: number; default: number }> = {
  '5k':      { min: 2, max: 8,  default: 3 },
  '10k':     { min: 3, max: 10, default: 4 },
  half:      { min: 4, max: 12, default: 5 },
  marathon:  { min: 5, max: 15, default: 6 },
};
const HOURS_DEFAULT_NO_RACE = { min: 2, max: 12, default: 4 };

function hoursRange(state: OnboardingState): { min: number; max: number; default: number } {
  return HOURS_BY_RACE[state.raceDistance ?? ''] ?? HOURS_DEFAULT_NO_RACE;
}

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
 * the user moves any input above. Replaces three forms of prose hint
 * (hours commentary, runs underflow, cross-training nudge) with one
 * informative summary. */
function weekShapePreview(state: OnboardingState): string {
  const runs = state.runsPerWeek ?? 0;
  const gym = state.gymSessionsPerWeek ?? 0;
  const acts = state.recurringActivities;
  const target = state.weeklyTrainingHours ?? 0;

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
  const targetMin = target * 60;
  const gapMin = targetMin - totalMin;

  // Two-row totals make the model explicit: running structure is fixed by the
  // race plan; the hours slider is a total-time budget that cross-training is
  // meant to fill. Showing "Total X of Yh" reads as a deficit; "Scheduled / Target"
  // as separate rows reads as an intentional gap to fill below.
  const totalRow = (label: string, value: string, muted: boolean) => `
    <div style="display:flex;justify-content:space-between;font-size:14px;color:${muted ? 'var(--c-muted)' : 'var(--c-black)'};font-weight:${muted ? '400' : '500'};padding:6px 0;line-height:1.3">
      <span>${label}</span>
      <span style="font-variant-numeric:tabular-nums">${value}</span>
    </div>
  `;
  const totalsHTML = totalRow('Scheduled', formatMin(totalMin), false)
    + (target > 0 ? totalRow('Target', `${target}h`, true) : '');

  let footer = '';
  if (target > 0) {
    if (gapMin >= 30) {
      footer = `<p style="font-size:11.5px;color:var(--c-faint);margin:8px 0 0;line-height:1.4">Add up to ${formatMin(gapMin)} of cross-training below to fill your target. Run lengths follow your race plan, not the hours slider.</p>`;
    } else if (gapMin <= -30) {
      footer = `<p style="font-size:11.5px;color:var(--c-faint);margin:8px 0 0;line-height:1.4">${formatMin(-gapMin)} over target. Raise the target or trim a cross-training session.</p>`;
    }
  }

  return `
    <div style="${cardStyle}">
      <label class="sc-micro" style="margin-bottom:8px">YOUR WEEK</label>
      <div>${rows.join('')}</div>
      <div style="border-top:1px solid rgba(0,0,0,0.06);padding-top:4px;margin-top:6px">
        ${totalsHTML}
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
  const hr = hoursRange(state);
  const hoursPerWeek = state.weeklyTrainingHours ?? hr.default;
  const defaultWeekdayHours = Math.round(hoursPerWeek * 0.4 * 2) / 2;
  const weekdayHours = state.weekdayTrainingHours ?? defaultWeekdayHours;
  const weekendHours = Math.max(0, hoursPerWeek - weekdayHours);

  container.innerHTML = `
    <style>
      @keyframes scRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .sc-rise { opacity:0; animation: scRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .sc-slider { -webkit-appearance:none; appearance:none; width:100%; height:4px; background:rgba(0,0,0,0.12); border-radius:4px; outline:none; margin:10px 0 2px; }
      .sc-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:20px; height:20px; background:var(--c-black); border-radius:50%; cursor:pointer; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
      .sc-slider::-moz-range-thumb { width:20px; height:20px; background:var(--c-black); border-radius:50%; cursor:pointer; border:none; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
      .sc-slider-row { display:flex; justify-content:space-between; align-items:baseline; font-size:13px; color:var(--c-black); }
      .sc-slider-val { font-size:16px; font-weight:500; font-variant-numeric:tabular-nums; }
      .sc-hint { font-size:12px; color:var(--c-faint); margin:5px 0 0; line-height:1.5; }

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      .sc-micro { display:block; font-size:11px; color:var(--c-faint); letter-spacing:0.08em; margin:0 0 10px; }

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

          <!-- Time available -->
          <div style="background:#fff;border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.06)">
            <label class="sc-micro" style="margin-bottom:14px">TOTAL TRAINING TIME PER WEEK</label>
            <div class="sc-slider-row">
              <span>Peak weekly hours</span>
              <span class="sc-slider-val" id="sc-hours-value">${hoursPerWeek}h</span>
            </div>
            <input type="range" class="sc-slider" id="sc-hours"
              min="${hr.min}" max="${hr.max}" step="1" value="${hoursPerWeek}">

            <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(0,0,0,0.06)">
              <div class="sc-slider-row" style="margin-bottom:4px">
                <span style="font-size:13px">Mon–Fri split</span>
                <span class="sc-slider-val" id="sc-weekday-value" style="font-size:14px">${weekdayHours}h weekday / ${weekendHours.toFixed(1)}h weekend</span>
              </div>
              <input type="range" class="sc-slider" id="sc-weekday"
                min="0" max="${hoursPerWeek}" step="0.5" value="${weekdayHours}">
              <p class="sc-hint">Long runs land Sat/Sun by default.</p>
            </div>
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
            <p style="font-size:11.5px;color:var(--c-faint);margin:8px 0 0;line-height:1.4">
              Leave at 0 if you don't lift.
            </p>
          </div>

          <div id="sc-week-preview">${weekShapePreview(state)}</div>

          <div id="sc-other-activities">${renderOtherActivities(state)}</div>

        </div>
      </div>

      <div class="sc-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.28s">
        <div style="max-width:480px;margin:0 auto">
          <button id="sc-continue" class="sc-cta">Continue</button>
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

  return `
    <div class="sc-section">
      <div>
        <label class="sc-micro">OTHER SPORTS YOU DO REGULARLY</label>
        <p style="font-size:11.5px;color:var(--c-faint);margin:0 0 12px;line-height:1.4">
          Each session reduces your run load.
        </p>
      </div>

      ${allSelected ? '' : renderSportPicker(activeKeys)}

      ${active.length > 0 ? `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${active.map((a, i) => renderActiveRow(a, i)).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderActiveRow(a: RecurringActivity, idx: number): string {
  const label = SPORT_LABELS[a.sport as keyof typeof SPORT_LABELS] ?? a.sport;
  return `
    <div class="sc-active shadow-ap" data-idx="${idx}" style="flex-direction:column;align-items:stretch;gap:12px;padding:14px 14px 16px;position:relative">
      <!-- Title row — X icon top-right for Remove. -->
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
  // Hours slider
  const hoursInput = document.getElementById('sc-hours') as HTMLInputElement | null;
  const hoursValue = document.getElementById('sc-hours-value');
  const weekdayInput = document.getElementById('sc-weekday') as HTMLInputElement | null;

  hoursInput?.addEventListener('input', () => {
    const h = Number(hoursInput.value);
    if (hoursValue) hoursValue.textContent = `${h}h`;
    updateOnboarding({ weeklyTrainingHours: h });
    // Rescale weekday slider max and proportionally adjust value
    if (weekdayInput) {
      const prev = Number(weekdayInput.max) || h;
      weekdayInput.max = String(h);
      const scaled = prev > 0 ? Math.min(h, Math.round((Number(weekdayInput.value) / prev) * h * 2) / 2) : h * 0.4;
      weekdayInput.value = String(scaled);
      updateWeekdayLabel(scaled, h);
      updateOnboarding({ weekdayTrainingHours: scaled });
    }
    refreshRunsCaption();
    refreshWeekPreview();
  });

  weekdayInput?.addEventListener('input', () => {
    const wd = Number(weekdayInput.value);
    const total = Number(hoursInput?.value ?? state.weeklyTrainingHours ?? 5);
    updateWeekdayLabel(wd, total);
    updateOnboarding({ weekdayTrainingHours: wd });
  });

  // Runs per week — update selection + caption in-place to avoid full rerender.
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

  // Gym sessions — update selection in-place; refresh preview since gym
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
      refreshWeekPreview();
    });
  });

  wireActivitiesHandlers(state);

  // Continue.
  document.getElementById('sc-continue')?.addEventListener('click', () => {
    nextStep();
  });
}

/**
 * Wire handlers scoped to the activities subtree. Re-invoked after a section-only
 * rerender (rerenderActivities), so a sport toggle / freq step / remove doesn't
 * tear down the whole step and replay entrance animations.
 */
function wireActivitiesHandlers(state: OnboardingState): void {
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
      // No rerender — live readout handles display; skipping rerender keeps slider focus.
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

function updateWeekdayLabel(wd: number, total: number): void {
  const label = document.getElementById('sc-weekday-value');
  if (!label) return;
  label.textContent = `${wd}h weekday / ${Math.max(0, total - wd).toFixed(1)}h weekend`;
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
