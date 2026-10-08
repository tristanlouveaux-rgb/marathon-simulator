import type { OnboardingState, Marathon, TrainingFocus } from '@/types/onboarding';
import type { RaceDistance } from '@/types/training';
import { getMarathonsByDistance, formatRaceDate, calculateDaysUntil, formatTimeUntil } from '@/data/marathons';
import { FULL_BUILD_WEEKS } from '@/workouts/phases';
import { getState } from '@/state';
import { racePlanNote, lowBaseMarathon, trainingWeeksForRace, type LowBaseState } from './race-target-plan-note';
import { ESTIMATED_DATE_NOTE } from '@/data/race-calendar';
import { nextStep, updateOnboarding, getOnboardingState } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';

/**
 * Page 5. Race / Target (mode-branched).
 *
 * Running path: race picker (5K/10K/half/marathon) + scrollable event list (half/marathon)
 * or plan-duration stepper (5K/10K) + optional custom date.
 *
 * Fitness path: focus picker (speed / balanced / endurance) + optional target date.
 *
 * Hyrox/Triathlon: auto-skip. No screen yet. Those modes go to the next step silently.
 *
 * Aesthetic clone of `goals.ts` / `review.ts`:
 * - Apple 3-layer shadow (`.shadow-ap`)
 * - Row pills with `.rt-row-*` (scoped prefix; mirrors `.cs-row-*` / `.r-row-*`)
 * - Monochrome, no tinted cards, no accent colour on navigation
 * - `rtRise` entry animation
 */

type TrainingMode = 'running' | 'hyrox' | 'triathlon' | 'cycling' | 'fitness';

/** Maximum plan weeks the stepper allows. */
const MAX_PLAN_WEEKS = 52;

/** Plan-length slider floor (5K/10K and the fitness Set-duration path): the full
 *  build (FULL_BUILD_WEEKS, phases.ts; locked 2026-04-22). A half or marathon
 *  closer than its full build is not refused: it gets a sharpening block
 *  (Tristan, 2026-10-05), so the race list and the custom date accept any
 *  date from tomorrow. */
function minWeeksFor(distance: RaceDistance | null): number {
  return distance ? FULL_BUILD_WEEKS[distance] : 4;
}

/** Local YYYY-MM-DD `days` from today. Built from local date parts so a DST
 *  change between now and the target date can't shift it by a day. */
function isoInDays(days: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Earliest and latest custom race dates the date handler accepts, for the
 * picker's min / max: tomorrow, and the last date whose plan stays within
 * MAX_PLAN_WEEKS training weeks (trainingWeeksForRace, the calendar the plan
 * is built on), so the picker never offers a date the handler then refuses.
 */
function customDateBounds(): { min: string; max: string } {
  let maxDays = (MAX_PLAN_WEEKS + 1) * 7;
  while (maxDays > 1 && (trainingWeeksForRace(isoInDays(maxDays)) ?? 0) > MAX_PLAN_WEEKS) maxDays--;
  return { min: isoInDays(1), max: isoInDays(maxDays) };
}

type CustomDateCheck =
  | { ok: true; weeks: number }
  /** `reason` sits under the date field; `hint` sits under Continue. */
  | { ok: false; reason: string; hint: string };

/**
 * Validate a custom race date against the distance floor and the 52-week
 * horizon. Same rule the handler always applied; this version returns copy
 * for the page instead of a native validation bubble, which fades on desktop
 * and may never show in WKWebView.
 */
function checkCustomDate(value: string): CustomDateCheck {
  if (!value) return { ok: false, reason: '', hint: 'Set your race date to continue.' };
  const days = calculateDaysUntil(value);
  const weeks = trainingWeeksForRace(value) ?? NaN;
  if (!Number.isFinite(days) || (days >= 1 && !Number.isFinite(weeks))) {
    return { ok: false, reason: 'Enter a full date: day, month and year.', hint: 'Set your race date to continue.' };
  }
  const futureHint = 'Pick a date from tomorrow to continue.';
  if (days < 0) return { ok: false, reason: 'That date has passed.', hint: futureHint };
  if (days === 0) return { ok: false, reason: 'This date is today.', hint: futureHint };
  if (weeks > MAX_PLAN_WEEKS) {
    return {
      ok: false,
      reason: `Plans run up to ${MAX_PLAN_WEEKS} weeks. This date is ${weeks} weeks away.`,
      hint: `Pick a date within ${MAX_PLAN_WEEKS} weeks to continue.`,
    };
  }
  return { ok: true, weeks };
}

/**
 * Fitness-path focus options.
 *
 * `track` selects Just-Track mode: no plan generated, activity tracking only.
 * The handler sets `trackOnly: true` on the onboarding state so the controller
 * can skip plan-preview and initialization can short-circuit plan generation.
 *
 * Lock order (Decision 5, 2026-04-22): endurance / speed / both / track.
 */
const FOCUS_OPTIONS: { id: TrainingFocus; label: string; sub: string }[] = [
  { id: 'endurance', label: 'Endurance',  sub: 'Aerobic base, longer efforts.' },
  { id: 'speed',     label: 'Speed',      sub: 'Build raw speed at shorter distances.' },
  { id: 'both',      label: 'Balanced',   sub: 'Speed and endurance in equal measure.' },
  { id: 'track',     label: 'On demand',  sub: 'No fixed plan. Generate sessions when you want them.' },
];

export function renderRaceTarget(container: HTMLElement, state: OnboardingState): void {
  const mode = resolveMode(state);

  // Just-Track mode: nothing to configure. Skip silently.
  if (state.trackOnly === true) {
    console.log('[race-target] trackOnly; skipping screen.');
    nextStep();
    return;
  }

  // Auto-skip for modes we don't handle yet.
  if (mode !== 'running' && mode !== 'fitness') {
    console.log(`[race-target] Mode=${mode ?? 'null'}; skipping screen.`);
    nextStep();
    return;
  }

  container.innerHTML = `
    <style>
      @keyframes rtRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .rt-rise { opacity:0; animation: rtRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      /* Row / pill surfaces (scoped). */
      .rt-row { display:flex; align-items:center; gap:14px; width:100%; background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:14px 16px; text-align:left; color:var(--c-black); cursor:pointer; transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .rt-row:active { transform: translateY(0.5px) scale(0.997); }
      .rt-row.selected { background:#0A0A0A; color:#FDFCF7; border-color: rgba(0,0,0,0.9); box-shadow: 0 0 0 1px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.10); }

      .rt-row-body { flex:1; min-width:0; }
      .rt-row-label { font-size:15px; font-weight:500; line-height:1.2; margin:0; letter-spacing:-0.005em; }
      .rt-row-sub { font-size:12px; color:var(--c-faint); margin:3px 0 0; line-height:1.35; }
      .rt-row.selected .rt-row-sub { color: rgba(253,252,247,0.7); }

      /* Distance grid — 4 small pills. 5 columns only if ultra is enabled; we match goals.ts 5-col. */
      .rt-dist-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; }
      .rt-dist { display:flex; flex-direction:column; align-items:center; justify-content:center; background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:14px; padding:12px 6px; color:var(--c-black); cursor:pointer; transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .rt-dist:active { transform: translateY(0.5px) scale(0.99); }
      .rt-dist.selected { background:#0A0A0A; color:#FDFCF7; border-color: rgba(0,0,0,0.9); box-shadow: 0 0 0 1px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.10); }
      .rt-dist-label { font-size:14px; font-weight:500; }
      .rt-dist-sub { font-size:10px; opacity:0.65; margin-top:2px; }
      .rt-dist.selected .rt-dist-sub { opacity: 0.7; }

      /* Micro section label (mirrors goals.ts). */
      .rt-micro { display:block; font-size:11px; color:var(--c-faint); letter-spacing:0.08em; margin:0 0 10px; }

      /* Plan-duration slider — replaces the +/- stepper (2026-06-15). Uses the
         canonical glass slider (.m-slider-glass, styles.css) — same control as
         the Run Complete RPE slider. Card + readout + min/max ends are local. */
      .rt-weeks-card { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:16px 16px 12px; }
      .rt-weeks-readout { text-align:center; margin-bottom:12px; }
      .rt-weeks-readout .v { font-size:28px; font-weight:300; color:var(--c-black); font-variant-numeric:tabular-nums; }
      .rt-weeks-readout .u { font-size:13px; color:var(--c-muted); margin-left:4px; }
      .rt-slider-ends { display:flex; justify-content:space-between; font-size:11px; color:var(--c-faint); font-variant-numeric:tabular-nums; margin-top:8px; }

      /* Race picker — native <select> (iOS renders the frosted glass popup). Mirrors hyrox-setup.ts. */
      .rt-select { width:100%; box-sizing:border-box; padding:13px 14px; border-radius:14px; border:1px solid rgba(0,0,0,0.06); background:rgba(255,255,255,0.95); color:var(--c-black); font-size:15px; font-family:var(--f); outline:none; cursor:pointer; }

      /* Custom date surface. */
      .rt-date-card { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:14px 16px; }
      .rt-date-input { width:100%; box-sizing:border-box; background:var(--c-bg); border:1.5px solid var(--c-border-strong); color:var(--c-black); border-radius:10px; padding:10px 12px; font-size:15px; outline:none; }
      .rt-date-note { font-size:12px; color:var(--c-faint); margin:8px 0 0; }

      /* Segmented control — used for Ongoing / Set duration on the fitness path. */
      .rt-seg { border:none; background:transparent; color:var(--c-black); border-radius:10px; padding:10px 8px; font-size:14px; font-weight:500; cursor:pointer; transition: background 0.15s ease, color 0.15s ease; }
      .rt-seg.selected { background:#0A0A0A; color:#FDFCF7; }

      /* Toggle link — muted, no colour, no border (per UI rules). */
      .rt-toggle { background:none; border:none; color:var(--c-muted); font-size:13px; cursor:pointer; padding:8px 6px; text-decoration:underline; }
      .rt-toggle:active { color:var(--c-black); }

      /* CTA — monochrome pill (matches review.ts). */
      .rt-cta { width:100%; height:50px; border-radius:25px; background:#0A0A0A; color:#FDFCF7; border:none; font-size:15px; font-weight:500; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.1), 0 8px 22px -8px rgba(0,0,0,0.35); transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .rt-cta:active { transform: translateY(1px); }
      .rt-cta[disabled] { opacity:0.35; cursor:not-allowed; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <!-- Glint only. Race photos own the visual space. Atmosphere base ties it to the family. -->
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildSunGlint('low')}
      </div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(5, 8)}

        <div class="rt-rise" style="width:100%;max-width:460px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.15">
            ${renderHeading(mode, state)}
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">
            ${renderSubheading(mode, state)}
          </p>
        </div>

        <div class="rt-rise" style="width:100%;max-width:460px;margin-top:22px;animation-delay:0.12s;display:flex;flex-direction:column;gap:16px">
          ${mode === 'running' ? renderRunningBlock(state) : renderFitnessBlock(state)}
        </div>
      </div>

      <div class="rt-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.28s">
        <div style="max-width:460px;margin:0 auto">
          <button id="rt-continue" class="rt-cta" ${canContinue(mode, state) ? '' : 'disabled'}>Continue</button>
          <p id="rt-continue-hint" aria-live="polite" style="font-size:12px;color:var(--c-faint);text-align:center;margin:10px 0 0;display:${canContinue(mode, state) || !continueHint(mode, state) ? 'none' : 'block'}">${canContinue(mode, state) ? '' : continueHint(mode, state)}</p>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(state, mode);
}

/* ---------- Running block ---------- */

function renderHeading(mode: TrainingMode | null, state: OnboardingState): string {
  if (mode === 'running') {
    if (state.trainingForEvent === null) return 'Training for an event?';
    if (state.trainingForEvent === false) return "What's your focus?";
    return 'Pick your target';
  }
  return "What's your focus?";
}

function renderSubheading(mode: TrainingMode | null, state: OnboardingState): string {
  if (mode === 'running') {
    if (state.trainingForEvent === null) return "We'll tailor the plan either way.";
    if (state.trainingForEvent === false) return 'Tell us what you want to build.';
    return 'Distance first, then the event or a date.';
  }
  return 'Tell us what you want to build.';
}

function renderRunningBlock(state: OnboardingState): string {
  // Gate: no Y/N answer yet → show only the Yes/No pair.
  if (state.trainingForEvent === null) {
    return renderEventYesNo(state);
  }

  // No event → focus picker (endurance/speed/both) + plan length.
  if (state.trainingForEvent === false) {
    return `${renderEventYesNo(state)}${renderRunningFocusPicker(state)}${renderFitnessDurationBlock(state)}`;
  }

  // Yes → distance + race/date picker.
  const distanceBlock = renderDistanceGrid(state);
  const eventBlock =
    (state.raceDistance === 'half' || state.raceDistance === 'marathon')
      ? renderEventPicker(state)
      : (state.raceDistance === '5k' || state.raceDistance === '10k')
        ? renderWeeksStepper(state)
        : '';
  return `${renderEventYesNo(state)}${distanceBlock}${eventBlock}`;
}

/** Yes / No segmented pair at the top of the running flow. */
function renderEventYesNo(state: OnboardingState): string {
  const yes = state.trainingForEvent === true;
  const no = state.trainingForEvent === false;
  return `
    <div>
      <label class="rt-micro">TRAINING FOR AN EVENT?</label>
      <div class="shadow-ap" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:6px;background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.06);border-radius:14px">
        <button data-event-answer="yes" class="rt-seg ${yes ? 'selected' : ''}">Yes</button>
        <button data-event-answer="no"  class="rt-seg ${no ? 'selected' : ''}">No</button>
      </div>
    </div>
  `;
}

/** Running-mode focus picker (no Just Track — that's a separate mode tile). */
function renderRunningFocusPicker(state: OnboardingState): string {
  const options: { id: TrainingFocus; label: string; sub: string }[] = [
    { id: 'endurance', label: 'Endurance', sub: 'Aerobic base, longer efforts.' },
    { id: 'speed',     label: 'Speed',     sub: 'Build raw speed at shorter distances.' },
    { id: 'both',      label: 'Balanced',  sub: 'Speed and endurance in equal measure.' },
  ];
  return `
    <div>
      <label class="rt-micro">FOCUS</label>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${options.map(o => {
          const selected = state.trainingFocus === o.id;
          return `
            <button data-focus="${o.id}" class="rt-row shadow-ap ${selected ? 'selected' : ''}">
              <div class="rt-row-body">
                <p class="rt-row-label">${o.label}</p>
                <p class="rt-row-sub">${o.sub}</p>
              </div>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderDistanceGrid(state: OnboardingState): string {
  const distances: { id: RaceDistance; label: string; sub: string }[] = [
    { id: '5k',       label: '5K',       sub: '3.1 mi' },
    { id: '10k',      label: '10K',      sub: '6.2 mi' },
    { id: 'half',     label: 'Half',     sub: '13.1 mi' },
    { id: 'marathon', label: 'Marathon', sub: '26.2 mi' },
  ];
  return `
    <div>
      <label class="rt-micro">DISTANCE</label>
      <div class="rt-dist-grid">
        ${distances.map(d => `
          <button data-dist="${d.id}" class="rt-dist ${state.raceDistance === d.id ? 'selected' : ''}">
            <span class="rt-dist-label">${d.label}</span>
            <span class="rt-dist-sub">${d.sub}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderWeeksStepper(state: OnboardingState): string {
  return `
    <div>
      <label class="rt-micro">PLAN DURATION</label>
      ${renderWeeksSlider(state, minWeeksFor(state.raceDistance))}
    </div>
  `;
}

/**
 * Plan-duration slider. Replaces the old +/- stepper (2026-06-15): a range
 * input reads more naturally for "how many weeks" and matches the app's
 * preference for sliders over steppers. Live readout + min/max ends mirror
 * the goal-time overlay's range pattern. `min` is the distance-dependent floor
 * (`minWeeksFor`); both the 5K/10K and fitness Set-duration paths share this.
 */
function renderWeeksSlider(state: OnboardingState, minWeeks: number): string {
  const weeks = Math.max(minWeeks, Math.min(MAX_PLAN_WEEKS, state.planDurationWeeks));
  return `
    <div class="shadow-ap rt-weeks-card">
      <div class="rt-weeks-readout">
        <span class="v" id="rt-weeks-value">${weeks}</span><span class="u">weeks</span>
      </div>
      <input id="rt-weeks-slider" type="range" min="${minWeeks}" max="${MAX_PLAN_WEEKS}" step="1" value="${weeks}" class="m-slider-glass" aria-label="Plan duration in weeks">
      <div class="rt-slider-ends">
        <span>${minWeeks}</span>
        <span>${MAX_PLAN_WEEKS}</span>
      </div>
    </div>
  `;
}

/** Every listed race of the distance from tomorrow to MAX_PLAN_WEEKS out:
 *  near races continue into a sharpening block instead of being hidden. */
function listedRaces(distance: 'half' | 'marathon') {
  return getMarathonsByDistance(distance, 0, MAX_PLAN_WEEKS);
}

/** The plan note and, for a marathon block that cannot build marathon
 *  endurance, the plain statement plus a one-tap switch to a half on the same
 *  date or to the first listed marathon far enough away for a full build. */
function renderBlockNote(state: OnboardingState, raceISO: string | null): string {
  if (!raceISO || (state.raceDistance !== 'marathon' && state.raceDistance !== 'half')) return '';
  const note = racePlanNote(state.raceDistance, raceISO);
  if (!note) return '';
  const low = lowBaseMarathon(state.raceDistance, raceISO, getState() as unknown as LowBaseState, state.experienceLevel);
  let lowHtml = '';
  if (low) {
    const later = listedRaces('marathon').find(r => (trainingWeeksForRace(r.date) ?? 0) >= FULL_BUILD_WEEKS.marathon);
    lowHtml = `
      <p class="rt-date-note" style="margin-top:6px">${low.text}</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
        <button class="m-btn-glass" data-switch="half" data-date="${raceISO}" style="width:100%;font-size:14px">Half marathon on the same date</button>
        ${later ? `<button class="m-btn-glass" data-switch="later" data-race="${later.id}" style="width:100%;font-size:14px">${later.name} · ${formatRaceDate(later.date)}</button>` : ''}
      </div>`;
  }
  return `<p class="rt-date-note" id="rt-weeks-note">${note}</p>${lowHtml}`;
}

function renderEventPicker(state: OnboardingState): string {
  const distance = state.raceDistance === 'marathon' ? 'marathon' : 'half';
  const races = listedRaces(distance);
  const usingCustomDate = state.customRaceDate !== null;

  if (usingCustomDate) {
    return `
      <div>
        <label class="rt-micro">RACE DATE</label>
        <div class="shadow-ap rt-date-card">
          <input type="date" id="rt-custom-date" class="rt-date-input" value="${state.customRaceDate || ''}">
          <p class="rt-date-note" id="rt-date-error" aria-live="polite" style="display:none"></p>
          <div id="rt-block-note">${renderBlockNote(state, state.customRaceDate || null)}</div>
        </div>
        <div style="text-align:center;margin-top:8px">
          <button id="rt-toggle-date" class="rt-toggle">Browse races instead</button>
        </div>
      </div>
    `;
  }

  const sel = state.selectedRace ?? null;
  return `
    <div>
      <label class="rt-micro">SELECT YOUR EVENT</label>
      <select id="rt-race-select" class="rt-select shadow-ap" aria-label="Select your race">
        <option value="" ${sel ? '' : 'selected'}>Select a race…</option>
        ${races.map(race => {
          const selected = sel?.id === race.id;
          return `<option value="${race.id}" ${selected ? 'selected' : ''}>${race.name} · ${formatRaceDate(race.date)}${race.estimated ? ' (est.)' : ''}</option>`;
        }).join('')}
        <option value="__custom">Other / enter date manually</option>
      </select>
      ${sel ? `<p class="rt-date-note" style="margin-top:8px">${[formatTimeUntil(sel.date), sel.city].filter(Boolean).join(' · ')}</p>` : ''}
      ${sel?.estimated ? `<p class="rt-date-note" style="margin-top:4px">${ESTIMATED_DATE_NOTE}</p>` : ''}
      ${sel ? `<div id="rt-block-note" style="margin-top:4px">${renderBlockNote(state, sel.date)}</div>` : ''}
    </div>
  `;
}

/* ---------- Fitness block ---------- */

function renderFitnessBlock(state: OnboardingState): string {
  const trackOnly = state.trackOnly === true;
  return `
    <div>
      <label class="rt-micro">FOCUS</label>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${FOCUS_OPTIONS.map(o => {
          const selected = o.id === 'track'
            ? trackOnly
            : (!trackOnly && state.trainingFocus === o.id);
          return `
            <button data-focus="${o.id}" class="rt-row shadow-ap ${selected ? 'selected' : ''}">
              <div class="rt-row-body">
                <p class="rt-row-label">${o.label}</p>
                <p class="rt-row-sub">${o.sub}</p>
              </div>
            </button>
          `;
        }).join('')}
      </div>
    </div>
    ${trackOnly ? '' : renderFitnessDurationBlock(state)}
  `;
}

/**
 * Fitness path duration picker. Segmented Ongoing / Set duration.
 * - Ongoing: `continuousMode: true`. No target date, plan regenerates rolling.
 * - Set duration: weeks stepper reusing the 5K/10K stepper handlers.
 *
 * Locked 2026-04-22: replaces the previous optional target-date block because
 * "fitness with a target date" was confusing. If the user has a date, they're
 * in running mode. Fitness mode is goal-less by definition.
 */
function renderFitnessDurationBlock(state: OnboardingState): string {
  const continuous = state.continuousMode !== false; // default true
  return `
    <div>
      <label class="rt-micro">PLAN LENGTH</label>
      <div class="shadow-ap" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:6px;background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.06);border-radius:14px">
        <button data-fit-mode="ongoing" class="rt-seg ${continuous ? 'selected' : ''}">Ongoing</button>
        <button data-fit-mode="fixed"   class="rt-seg ${continuous ? '' : 'selected'}">Set duration</button>
      </div>
      ${continuous ? `
        <p class="rt-date-note" style="margin-top:10px">A rolling plan that keeps rebuilding week-by-week. No end date.</p>
      ` : `
        <div style="margin-top:10px">${renderWeeksSlider(state, minWeeksFor(state.raceDistance))}</div>
      `}
    </div>
  `;
}

/* ---------- Validation ---------- */

function canContinue(mode: TrainingMode | null, state: OnboardingState): boolean {
  if (mode === 'running') {
    // "No event" sub-path: user wants a focus-based plan, not a race target.
    if (state.trainingForEvent === false) return !!state.trainingFocus;
    if (!state.raceDistance) return false;
    if (state.raceDistance === 'half' || state.raceDistance === 'marathon') {
      return !!(state.selectedRace || state.customRaceDate);
    }
    // 5K / 10K. Needs a plan duration (always set by default, so just confirm > 0).
    return state.planDurationWeeks >= minWeeksFor(state.raceDistance);
  }
  if (mode === 'fitness') return !!state.trainingFocus;
  return false;
}

/** Plain-language reason the Continue button is disabled, shown beneath it so a
 *  new user is never staring at a dead button with no idea what's required. */
function continueHint(mode: TrainingMode | null, state: OnboardingState): string {
  if (mode === 'running') {
    if (state.trainingForEvent === null) return 'Pick whether you have a race in mind.';
    if (state.trainingForEvent === false) return state.trainingFocus ? '' : 'Choose a focus to continue.';
    if (!state.raceDistance) return 'Pick a distance to continue.';
    if ((state.raceDistance === 'half' || state.raceDistance === 'marathon') && !(state.selectedRace || state.customRaceDate)) {
      // Custom-date mode (customRaceDate === '') with an empty field: the race
      // list is hidden, so ask for the date itself.
      if (state.customRaceDate === '') return 'Set your race date to continue.';
      return 'Pick a race, or set your own date, to continue.';
    }
    return '';
  }
  if (mode === 'fitness') return state.trainingFocus ? '' : 'Choose a focus to continue.';
  return '';
}

function resolveMode(state: OnboardingState): TrainingMode | null {
  if (state.trainingMode) return state.trainingMode;
  if (state.trainingForEvent === true) return 'running';
  if (state.trainingForEvent === false) return 'fitness';
  return null;
}

/* ---------- Handlers ---------- */

function wireHandlers(state: OnboardingState, mode: TrainingMode | null): void {
  const races = (state.raceDistance === 'half' || state.raceDistance === 'marathon')
    ? listedRaces(state.raceDistance === 'marathon' ? 'marathon' : 'half')
    : [];

  // Event Yes/No (running path).
  document.querySelectorAll<HTMLElement>('[data-event-answer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ans = btn.getAttribute('data-event-answer');
      if (ans === 'yes') {
        updateOnboarding({
          trainingForEvent: true,
          continuousMode: false,
          trainingFocus: null,
        });
      } else {
        updateOnboarding({
          trainingForEvent: false,
          continuousMode: true,
          raceDistance: null,
          selectedRace: null,
          customRaceDate: null,
        });
      }
      rerender();
    });
  });

  // Distance pick (running path).
  document.querySelectorAll<HTMLElement>('[data-dist]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dist = btn.getAttribute('data-dist') as RaceDistance;
      // Preserve the default plan duration from defaultOnboardingState when already set;
      // reset race + customDate when distance switches so stale selections don't persist.
      updateOnboarding({
        raceDistance: dist,
        selectedRace: null,
        customRaceDate: null,
      });
      rerender();
    });
  });

  // Race selection (half/marathon) — native <select>; iOS renders the glass popup.
  const raceSelect = document.getElementById('rt-race-select') as HTMLSelectElement | null;
  raceSelect?.addEventListener('change', () => {
    const id = raceSelect.value;
    // "Other / enter date manually" → drop into the custom-date card.
    if (id === '__custom') {
      updateOnboarding({ customRaceDate: '', selectedRace: null });
      rerender();
      return;
    }
    const race = races.find((r: Marathon) => r.id === id);
    updateOnboarding({
      selectedRace: race ?? null,
      // Training weeks of the plan built for this date (the calendar layout the
      // plan uses; initializeSimulator recomputes it from the date).
      planDurationWeeks: (race ? trainingWeeksForRace(race.date) : null) ?? state.planDurationWeeks,
      customRaceDate: null,
    });
    rerender();
  });

  // One-tap switch offered when a marathon block cannot build marathon
  // endurance: a half on the same date, or the first listed marathon far enough
  // away for a full build. Delegated so the custom-date handler can replace the
  // note in place.
  document.querySelectorAll<HTMLElement>('#rt-block-note').forEach(box => {
    box.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-switch]');
      if (!btn) return;
      if (btn.dataset.switch === 'half' && btn.dataset.date) {
        const date = btn.dataset.date;
        updateOnboarding({
          raceDistance: 'half', selectedRace: null, customRaceDate: date,
          planDurationWeeks: trainingWeeksForRace(date) ?? state.planDurationWeeks,
        });
      } else if (btn.dataset.switch === 'later' && btn.dataset.race) {
        const later = listedRaces('marathon').find(r => r.id === btn.dataset.race);
        if (!later) return;
        updateOnboarding({
          selectedRace: later, customRaceDate: null,
          planDurationWeeks: trainingWeeksForRace(later.date) ?? state.planDurationWeeks,
        });
      }
      rerender();
    });
  });

  // Toggle between race list and custom date (running half/marathon).
  document.getElementById('rt-toggle-date')?.addEventListener('click', () => {
    if (state.customRaceDate !== null) {
      updateOnboarding({ customRaceDate: null });
    } else {
      updateOnboarding({ customRaceDate: '', selectedRace: null });
    }
    rerender();
  });

  // Custom-date input (running half/marathon).
  // Listens to BOTH 'input' and 'change': the iOS picker and Chrome fire both,
  // desktop Safari and Firefox fire 'change' only on blur, so 'change' alone
  // left Continue disabled while a valid date sat in the field.
  // Everything updates in place. A re-render here would replace the input and
  // tear down the iOS wheel picker mid-spin.
  const dateInput = document.getElementById('rt-custom-date') as HTMLInputElement | null;
  if (dateInput) {
    const bounds = customDateBounds();
    dateInput.min = bounds.min;
    dateInput.max = bounds.max;
    const errorEl = document.getElementById('rt-date-error');
    const noteEl = document.getElementById('rt-block-note');
    const onDateValue = () => {
      const v = dateInput.value;
      const check = checkCustomDate(v);
      const cur = getOnboardingState() ?? state;
      if (!check.ok) {
        // Never leave a date in state that the field no longer shows. '' keeps
        // the custom-date card open with no date (Continue stays gated).
        if (cur.customRaceDate) updateOnboarding({ customRaceDate: '' });
        if (errorEl) {
          errorEl.textContent = check.reason;
          errorEl.style.display = check.reason ? 'block' : 'none';
        }
        if (noteEl) noteEl.innerHTML = '';
        syncContinueGate(mode, check.hint);
        return;
      }
      if (cur.customRaceDate !== v || cur.planDurationWeeks !== check.weeks || cur.selectedRace) {
        updateOnboarding({ customRaceDate: v, planDurationWeeks: check.weeks, selectedRace: null });
      }
      if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }
      // The plan note in place (a re-render would tear down the iOS picker).
      if (noteEl) noteEl.innerHTML = renderBlockNote(getOnboardingState() ?? state, v);
      syncContinueGate(mode);
    };
    dateInput.addEventListener('input', onDateValue);
    dateInput.addEventListener('change', onDateValue);
  }

  // Plan-duration slider (5K / 10K / fitness Set-duration).
  // `input` updates the readout + Continue gate live (cheap DOM); `change`
  // commits the value to state (saveState runs once per drag, not per tick).
  const slider = document.getElementById('rt-weeks-slider') as HTMLInputElement | null;
  if (slider) {
    const valueEl = document.getElementById('rt-weeks-value');
    const cta = document.getElementById('rt-continue') as HTMLButtonElement | null;
    slider.addEventListener('input', () => {
      const weeks = Number(slider.value);
      if (valueEl) valueEl.textContent = String(weeks);
      if (cta) cta.disabled = !canContinue(mode, { ...state, planDurationWeeks: weeks });
    });
    slider.addEventListener('change', () => {
      updateOnboarding({ planDurationWeeks: Number(slider.value) });
    });
  }

  // Focus picker (fitness path). The 'track' id flags Just-Track mode: activity
  // logging only, no plan. Clearing a prior target date keeps state consistent
  // with the date-picker being hidden for track-only.
  document.querySelectorAll<HTMLElement>('[data-focus]').forEach(btn => {
    btn.addEventListener('click', () => {
      const focus = btn.getAttribute('data-focus') as TrainingFocus;
      if (focus === 'track') {
        updateOnboarding({
          trainingFocus: 'track',
          trackOnly: true,
          customRaceDate: null,
          selectedRace: null,
          continuousMode: true,
        });
      } else {
        updateOnboarding({
          trainingFocus: focus,
          trackOnly: false,
          continuousMode: state.customRaceDate === null,
        });
      }
      rerender();
    });
  });

  // Fitness plan-length segmented. Ongoing (no end) vs Set duration (stepper).
  document.querySelectorAll<HTMLElement>('[data-fit-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.getAttribute('data-fit-mode');
      if (m === 'ongoing') {
        updateOnboarding({ continuousMode: true, customRaceDate: null });
      } else {
        // Default to 12 weeks when switching to Set-duration for the first time.
        const cur = state.planDurationWeeks;
        const weeks = cur >= 4 && cur <= MAX_PLAN_WEEKS ? cur : 12;
        updateOnboarding({ continuousMode: false, planDurationWeeks: weeks });
      }
      rerender();
    });
  });

  // Continue.
  document.getElementById('rt-continue')?.addEventListener('click', () => {
    import('../controller').then(({ getOnboardingState }) => {
      const cur = getOnboardingState() || state;
      if (!canContinue(mode, cur)) return;
      nextStep();
    });
  });
}

/**
 * Update the Continue button and the hint beneath it in place, from live
 * state. `hintOverride` carries a reason the state alone can't express (a
 * refused date that was never written to state).
 */
function syncContinueGate(mode: TrainingMode | null, hintOverride?: string): void {
  const cur = getOnboardingState();
  if (!cur) return;
  const ok = canContinue(mode, cur);
  const cta = document.getElementById('rt-continue') as HTMLButtonElement | null;
  if (cta) cta.disabled = !ok;
  const hint = document.getElementById('rt-continue-hint');
  if (hint) {
    const text = ok ? '' : (hintOverride ?? continueHint(mode, cur));
    hint.textContent = text;
    hint.style.display = text ? 'block' : 'none';
  }
}

function rerender(): void {
  import('../controller').then(({ getOnboardingState }) => {
    const cur = getOnboardingState();
    if (!cur) return;
    const container = document.getElementById('app-root');
    if (container) renderRaceTarget(container, cur);
  });
}
