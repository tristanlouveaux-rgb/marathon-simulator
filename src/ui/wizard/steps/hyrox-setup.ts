/**
 * HYROX setup. Onboarding step.
 *
 * Collects:
 *   - Competition format (Open / Pro × Singles / Doubles)
 *   - Division (doubles: Women / Men / Mixed; singles only when biological sex
 *     is unknown). Sets the station load tier (hyrox-division.ts).
 *   - Previous HYROX finish time (optional → shows derived ability band live)
 *   - Race date (optional)
 *   - Weekly hours available (slider)
 *   - Equipment: sled access, SkiErg, RowErg
 *
 * Modelled on cycling-setup.ts. Same glass card + pill visual system.
 */

import type { OnboardingState } from '@/types/onboarding';
import type { AbilityBand } from '@/types/triathlon';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { getState } from '@/state/store';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import {
  HYROX_HOURS_RANGE,
  HYROX_DEFAULT_PLAN_WEEKS,
  HYROX_WEEKLY_SESSIONS,
} from '@/constants/hyrox-constants';
import { HYROX_STATION_ORDER, STATION_DISPLAY, STATION_MIN_SEC, HYROX_RUN_PACE_MIN_SEC_KM } from '@/constants/hyrox-benchmarks';
// Pure, DOM-free results parser. Re-exported below for back-compat with the
// existing '@/ui/wizard/steps/hyrox-setup' import in log-prev-time-modal.
import { parseHyroxResultsText } from './hyrox-results-parse';
import type { HyroxDivision, HyroxStation } from '@/types/triathlon';
import {
  hyroxDivisionOptions,
  resolveHyroxDivision,
  hyroxDivisionLabel,
  hyroxLoadTier,
  hyroxWallBallTargetM,
  hyroxLoadsSentence,
  isHyroxDoublesFormat,
  isHyroxProFormat,
} from '@/calculations/hyrox-division';
import { getFutureHyroxEvents, getPastHyroxEvents, getHyroxEventById, getVenueIdForEvent } from '@/data/hyrox-events';
import { racePlanCalendarWeeks } from '@/workouts/race-week-layout';
import { hyroxPlanningBandFor } from '@/calculations/hyrox-planning-band';
// Venue normally derives from the race-event selection. Manual venue picker
// is shown as a fallback only when the user picks "Other / enter date manually".
import { HYROX_VENUES } from '@/data/hyrox-venues';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Band for this step's defaults (hours range, sessions, plan weeks): the
 *  planning band, the rule the initializer and every re-band use
 *  (hyroxPlanningBandFor: the time in Open Singles terms, banded on the Open
 *  Singles field of the athlete's sex). Before the previous format is picked,
 *  the time is read as an Open Singles finish. */
export function setupBand(ob: Pick<OnboardingState, 'previousHyroxTimeSec' | 'hyroxPreviousTimeFormat' | 'biologicalSex' | 'hyroxDivision'>): AbilityBand | null {
  const sec = ob.previousHyroxTimeSec;
  if (sec == null) return null;
  return hyroxPlanningBandFor(sec, ob.hyroxPreviousTimeFormat ?? 'open_singles', ob.biologicalSex, ob.hyroxDivision);
}

/** User-friendly target finish time message derived from ability band. */
function bandTargetLabel(band: AbilityBand): string {
  switch (band) {
    case 'total_beginner': return 'Target: first HYROX finish';
    case 'beginner':       return 'Target: sub-2:00 finish';
    case 'novice':         return 'Target: sub-1:40 finish';
    case 'intermediate':   return 'Target: sub-1:20 finish';
    case 'advanced':       return 'Target: sub-1:00 finish';
    case 'competitive':    return 'Target: sub-1:00 elite';
  }
}

/** Format seconds as mm:ss when under 1h, otherwise h:mm:ss. Drops the leading
 *  zero hours so a 3:48 station reads "3:48" not "00:03:48", while a 1:00:43
 *  total race time still shows the hour. */
function fmtMmSs(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Parse a mm:ss or h:mm:ss string to seconds. Returns NaN on failure.
 *  Spaces around each part and leading zeros are fine. An empty part ("1:",
 *  "1:12:") is a half-typed value, not zero, so it returns NaN: reading it as
 *  zero stored a stale 60 s while the user was still typing. */
function parseTime(raw: string): number {
  const rawParts = raw.trim().split(':').map(p => p.trim());
  if (rawParts.some(p => p === '')) return NaN;
  const parts = rawParts.map(Number);
  if (parts.some(n => isNaN(n) || n < 0)) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

/**
 * Fastest physically possible HYROX finish: the 8 × 1 km run legs at the
 * minimum plausible HYROX run pace, before any station time. Every format runs
 * all 8 legs (doubles partners each run every leg), so this holds for singles
 * and doubles alike. Derived from existing constants, not a new threshold.
 * A previous finish that parses below it was typed in the wrong format: "1:12"
 * meant as 1 h 12 min reads as 1 min 12 s under mm:ss.
 */
const HYROX_FINISH_FLOOR_SEC = HYROX_STATION_ORDER.length * HYROX_RUN_PACE_MIN_SEC_KM;

/**
 * Read the previous-finish field. `null` = empty (the time is optional).
 * Otherwise either a usable finish in seconds or the reason it can't be used.
 */
function readPrevFinish(raw: string): null | { sec: number } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const sec = parseTime(trimmed);
  if (isNaN(sec) || sec <= 0) return { error: 'Use h:mm:ss or mm:ss, e.g. 1:12:30.' };
  if (sec < HYROX_FINISH_FLOOR_SEC) {
    return { error: `That reads as ${fmtMmSs(sec)} (mm:ss), faster than any HYROX finish. For times over an hour use h:mm:ss, e.g. 1:12:30.` };
  }
  return { sec };
}

const PREV_FORMAT_PROMPT_TODO = 'Pick the format your time was set in. Doubles times scale differently to singles. Getting this right matters.';

type HyroxFormatValue = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
type BioSex = OnboardingState['biologicalSex'];

/** Pro note: the athlete's own division loads (26/27 Singles rulebook s4.1).
 *  Women Pro races the Men Open tier, so a single "Pro weights" line was wrong
 *  for half the field. */
function proNoteText(format: HyroxFormatValue, sex: BioSex, division: HyroxDivision | undefined): string {
  const label = hyroxDivisionLabel(format, sex, division);
  if (!label) return 'Pro loads depend on division. Pick Women or Men above.';
  const tier = hyroxLoadTier(format, sex, division);
  return `${label} loads: ${hyroxLoadsSentence(tier, hyroxWallBallTargetM(sex, division))}.`;
}

/** Hint under the Division row. Mixed spells out the shared Men Open loads and
 *  both wall-ball targets (26/27 Doubles rulebook s4.1, s8.8). */
function divisionHintText(format: HyroxFormatValue, sex: BioSex, division: HyroxDivision | undefined): string {
  if (!isHyroxDoublesFormat(format)) return 'Division sets the race loads. Women and men race different weights.';
  if (isHyroxProFormat(format)) return 'Division sets the race loads. There is no Pro Mixed division.';
  if (resolveHyroxDivision(format, sex, division) === 'mixed') {
    return `A Mixed pair races Men Open loads for both partners: ${hyroxLoadsSentence('M-Open', null)}.`;
  }
  return 'Division sets the race loads. A Mixed pair races Men Open loads for both partners.';
}
const PREV_FORMAT_PROMPT_DONE = 'Which format was that time in?';

// ─── Render ──────────────────────────────────────────────────────────────────

export function renderHyroxSetup(container: HTMLElement, state: OnboardingState): void {
  const format = state.hyroxFormat ?? 'open_singles';
  // Division row: doubles always (Women / Men / Mixed, no Pro Mixed); singles
  // only when biological sex is unknown. Prefilled from biological sex.
  const divisionOptions = hyroxDivisionOptions(format, state.biologicalSex);
  const activeDivision = resolveHyroxDivision(format, state.biologicalSex, state.hyroxDivision);
  const prevTimeSec = state.previousHyroxTimeSec;
  const prevTimeStr = prevTimeSec != null ? fmtMmSs(prevTimeSec) : '';
  const derivedBand: AbilityBand | null = setupBand(state);
  const hoursRange = HYROX_HOURS_RANGE[derivedBand ?? 'novice'];
  // Slider initial position lands at the midpoint of (min, default) so users
  // opt-in to more rather than dragging down from an anchored-high default.
  // Beginner range {min:2, default:5} → initial = 3 (was 5).
  const hoursInitialDefault = Math.round((hoursRange.min + hoursRange.default) / 2);
  const hoursPerWeek = state.triTimeAvailableHoursPerWeek ?? hoursInitialDefault;
  const sledAccess = state.hyroxSledAccess ?? 'always';
  const hasSkiErg = state.hyroxHasSkiErg ?? true;
  const hasRowErg = state.hyroxHasRowErg ?? true;
  // Stays undefined until the user explicitly picks a previous-format pill.
  // Defaulting to `format` here silently lit up the singles pill when target
  // was singles, so a user with a doubles previous race never knew the question
  // was unanswered. See ISSUE: doubles splits ended up in the Singles slot.
  const prevTimeFormat = state.hyroxPreviousTimeFormat;
  const prevTimeRaceId = state.hyroxPreviousTimeRaceId ?? '';
  const today = new Date().toISOString().slice(0, 10);
  const pastEvents = getPastHyroxEvents(today);

  container.innerHTML = `
    <style>
      @keyframes hxRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .hx-rise { opacity:0; animation: hxRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .hx-card { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:18px; margin-bottom:14px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.3); }
      .hx-label { font-size:13px; color:var(--c-muted); letter-spacing:0.01em; margin:0 0 10px; text-transform:uppercase; font-weight:500; }
      .hx-pill-row { display:flex; gap:8px; flex-wrap:wrap; }
      .hx-pill { flex:1; min-width:78px; padding:10px 11px; border-radius:12px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.9); font-size:13px; color:var(--c-black); cursor:pointer; text-align:left; transition: all 0.15s ease; }
      .hx-pill.active { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }
      .hx-pill .hx-pill-sub { display:block; font-size:11px; opacity:0.65; margin-top:2px; }
      .hx-row { display:flex; justify-content:space-between; align-items:baseline; font-size:13px; color:var(--c-black); }
      .hx-row .hx-value { font-size:16px; font-weight:500; font-variant-numeric: tabular-nums; }
      .hx-input { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.08); color:var(--c-black); border-radius:10px; padding:9px 12px; font-size:14px; width:100%; box-sizing:border-box; outline:none; font-family:inherit; }
      .hx-input:focus { border-color:var(--c-black); }
      .hx-hint { font-size:12px; color:var(--c-faint); margin:6px 0 0; line-height:1.5; }
      .hx-band-chip { display:inline-block; font-size:12px; font-weight:500; background:rgba(0,0,0,0.06); border-radius:8px; padding:3px 8px; margin-top:8px; }
      .hx-toggle-row { display:flex; gap:8px; }
      .hx-toggle { flex:1; padding:10px 8px; border-radius:12px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.9); font-size:13px; color:var(--c-black); cursor:pointer; text-align:center; transition: all 0.15s ease; }
      .hx-toggle.active { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }
      .hx-cta { width:100%; padding:14px 20px; height:50px; background:var(--c-black); color:#FDFCF7; border:none; border-radius:25px; font-size:15px; font-weight:500; cursor:pointer; margin-top:8px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;display:flex;flex-direction:column">
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('hyrox', { variant: 'asymmetric', side: 'right' })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:36px 20px 140px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(5, 8)}

        <div class="hx-rise" style="width:100%;max-width:480px;text-align:center;margin-bottom:20px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.5rem,5vw,1.9rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 6px;line-height:1.15">
            Hyrox setup
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">Configure your competition format and training setup.</p>
        </div>

        <div style="width:100%;max-width:480px">

          <!-- Format: 4-way selector -->
          <!-- Race event picker -->
          <div class="hx-card hx-rise" style="animation-delay:0.10s">
            <div class="hx-label">Which race?</div>
            <select id="hx-race-event" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,0.08);background:rgba(255,255,255,0.95);color:var(--c-black);font-size:14px;font-family:var(--f);outline:none;margin-bottom:10px">
              <option value="">Select a HYROX event</option>
              ${getFutureHyroxEvents(new Date().toISOString().slice(0, 10)).map(ev => {
                const d = new Date(ev.date);
                const label = `${d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${ev.city}`;
                const selected = state.hyroxRaceEventId === ev.id ? 'selected' : '';
                return `<option value="${ev.id}" ${selected}>${label}</option>`;
              }).join('')}
              <option value="custom" ${!state.hyroxRaceEventId && state.customRaceDate ? 'selected' : ''}>Other / enter date manually</option>
            </select>
            <input type="date" id="hx-race-date" class="hx-input" value="${state.customRaceDate ?? ''}" style="display:${!state.hyroxRaceEventId && state.customRaceDate ? 'block' : 'none'}">
            <p class="hx-hint">Confirm the date on hyrox.com before registering. Required so course factors and the training horizon know which race they're aiming at.</p>

            <!-- Venue fallback: only shown when user picks Other / enter date manually -->
            <div id="hx-venue-fallback" style="margin-top:12px;display:${!state.hyroxRaceEventId && state.customRaceDate ? 'block' : 'none'}">
              <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px">Race venue (for course factors)</div>
              <select id="hx-manual-venue" class="hx-input" style="font-size:13px">
                <option value="">No venue selected</option>
                ${HYROX_VENUES.slice().sort((a, b) => a.city.localeCompare(b.city)).map(v =>
                  `<option value="${v.id}" ${state.hyroxVenueId === v.id ? 'selected' : ''}>${v.city}: ${v.name}</option>`
                ).join('')}
              </select>
            </div>
          </div>

          <div class="hx-card hx-rise" style="animation-delay:0.12s">
            <div class="hx-label">Competition format</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <button class="hx-toggle ${format === 'open_singles' ? 'active' : ''}" data-format="open_singles">
                Open Singles<span style="display:block;font-size:11px;opacity:0.65;margin-top:2px">Standard solo</span>
              </button>
              <button class="hx-toggle ${format === 'open_doubles' ? 'active' : ''}" data-format="open_doubles">
                Open Doubles<span style="display:block;font-size:11px;opacity:0.65;margin-top:2px">2-person team</span>
              </button>
              <button class="hx-toggle ${format === 'pro_singles' ? 'active' : ''}" data-format="pro_singles">
                Pro Singles<span style="display:block;font-size:11px;opacity:0.65;margin-top:2px">Pro division</span>
              </button>
              <button class="hx-toggle ${format === 'pro_doubles' ? 'active' : ''}" data-format="pro_doubles">
                Pro Doubles<span style="display:block;font-size:11px;opacity:0.65;margin-top:2px">Pro 2-person</span>
              </button>
            </div>
            <div id="hx-division-row" style="margin-top:12px;display:${divisionOptions ? 'block' : 'none'}">
              <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px">Division</div>
              <div class="hx-toggle-row">
                <button class="hx-toggle ${activeDivision === 'women' ? 'active' : ''}" data-division="women">Women</button>
                <button class="hx-toggle ${activeDivision === 'men' ? 'active' : ''}" data-division="men">Men</button>
                <button class="hx-toggle ${activeDivision === 'mixed' ? 'active' : ''}" data-division="mixed" style="display:${divisionOptions?.includes('mixed') ? 'block' : 'none'}">Mixed</button>
              </div>
              <p id="hx-division-hint" class="hx-hint">${divisionHintText(format, state.biologicalSex, state.hyroxDivision)}</p>
            </div>
            <p id="hx-doubles-note" class="hx-hint" style="margin-top:10px;display:${(format === 'open_doubles' || format === 'pro_doubles') ? 'block' : 'none'}">You run all 8 legs together and split the work inside every station. Training covers all 8 stations.</p>
            <p id="hx-pro-note" class="hx-hint" style="margin-top:4px;display:${(format === 'pro_singles' || format === 'pro_doubles') ? 'block' : 'none'}">${proNoteText(format, state.biologicalSex, state.hyroxDivision)}</p>
            <p class="hx-hint" style="margin-top:10px">Your plan starts mostly aerobic and ramps into tempo + intervals through the build phase. Variety is intentional: base first, race-specific second.</p>
          </div>

          <!-- Previous time + which format it was set in -->
          <div class="hx-card hx-rise" style="animation-delay:0.14s">
            <div class="hx-label">Previous Hyrox time</div>
            <input type="text" id="hx-prev-time" class="hx-input" placeholder="e.g. 1:12:30" value="${prevTimeStr}" autocomplete="off">
            <p id="hx-prev-time-error" class="hx-hint" aria-live="polite" style="color:#b45309;display:none"></p>
            <p class="hx-hint" style="margin-bottom:12px">Enter as h:mm:ss or mm:ss. Used to calibrate your training load and pace targets.</p>
            <div id="hx-prev-time-format-row" style="display:${prevTimeSec != null ? 'block' : 'none'}">
              <div id="hx-prev-format-prompt" style="font-size:12px;color:${prevTimeFormat ? 'var(--c-muted)' : '#b45309'};margin-bottom:6px">${prevTimeFormat ? PREV_FORMAT_PROMPT_DONE : PREV_FORMAT_PROMPT_TODO}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
                <button class="hx-toggle ${prevTimeFormat === 'open_singles' ? 'active' : ''}" data-prev-format="open_singles" style="font-size:12px;padding:7px 8px">Open Singles</button>
                <button class="hx-toggle ${prevTimeFormat === 'open_doubles' ? 'active' : ''}" data-prev-format="open_doubles" style="font-size:12px;padding:7px 8px">Open Doubles</button>
                <button class="hx-toggle ${prevTimeFormat === 'pro_singles' ? 'active' : ''}" data-prev-format="pro_singles" style="font-size:12px;padding:7px 8px">Pro Singles</button>
                <button class="hx-toggle ${prevTimeFormat === 'pro_doubles' ? 'active' : ''}" data-prev-format="pro_doubles" style="font-size:12px;padding:7px 8px">Pro Doubles</button>
              </div>
              <div style="font-size:12px;color:var(--c-muted);margin:14px 0 6px">Which race was that?</div>
              <select id="hx-prev-race" class="hx-input" style="font-size:13px">
                <option value="" disabled ${!prevTimeRaceId && !state.hyroxPreviousRaceDate ? 'selected' : ''}>Select your race…</option>
                ${pastEvents.map(ev => {
                  const d = new Date(ev.date);
                  const label = `${d.toLocaleString('en-US', { month: 'short', year: 'numeric' })}, ${ev.city}`;
                  return `<option value="${ev.id}" ${prevTimeRaceId === ev.id ? 'selected' : ''}>${label}</option>`;
                }).join('')}
                <option value="other" ${!prevTimeRaceId && state.hyroxPreviousRaceDate ? 'selected' : ''}>Other / not listed</option>
              </select>
              <!-- Race-date picker, shown only when user explicitly picks "Other / not listed".
                   We need a date so the staleness model can decay confidence on year-old
                   benchmarks. Auto-derived from the event when one is selected. -->
              <div id="hx-prev-race-date-row" style="display:${!prevTimeRaceId && state.hyroxPreviousRaceDate && prevTimeSec != null ? 'block' : 'none'};margin-top:10px">
                <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px">When did you race? <span style="color:var(--c-faint)">(month + year)</span></div>
                <input type="month" id="hx-prev-race-date" class="hx-input" style="font-size:13px" value="${state.hyroxPreviousRaceDate ? state.hyroxPreviousRaceDate.slice(0, 7) : ''}">
              </div>
            </div>
          </div>

          <!-- Previous station splits (expandable, only shown when a finish time is entered) -->
          <div id="hx-splits-section" style="display:${prevTimeSec != null ? 'block' : 'none'}">
            <div class="hx-card hx-rise" style="animation-delay:0.16s">
              <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer" id="hx-splits-toggle">
                <div class="hx-label" style="margin:0">Station split times <span style="text-transform:none;font-weight:400;color:var(--c-faint)">(optional)</span></div>
                <span id="hx-splits-chevron" style="font-size:12px;color:var(--c-faint);transition:transform 0.2s">▼</span>
              </div>
              <div id="hx-splits-body" style="display:none;margin-top:12px">
                <p class="hx-hint" style="margin:0 0 4px">Open hyresult.com below, search your name, open your result, and go to the Timings tab. Copy as much of the splits as you can grab. A rough selection is fine: we pull out the station times and ignore everything else.</p>
                <p class="hx-hint" style="margin:0 0 10px;color:var(--c-faint)">Then come back and tap "Paste from clipboard". On a phone you don't need a clean copy. Or enter times by hand below.</p>
                <a id="hx-results-open" href="https://hyresult.com/" target="_blank" rel="noopener" style="display:block;margin:0 0 8px;padding:11px 14px;border-radius:10px;background:transparent;border:1px solid var(--c-border);color:var(--c-black);font-size:13px;font-weight:500;text-align:center;text-decoration:none">Search hyresult.com →</a>
                <button id="hx-paste-clip-btn" style="width:100%;padding:11px 14px;border:1px solid var(--c-border);border-radius:10px;background:transparent;font-size:13px;font-weight:500;cursor:pointer;color:var(--c-black);margin-bottom:10px">Paste from clipboard</button>
                <textarea id="hx-paste-results" class="hx-input" rows="3" placeholder="…or paste results here manually" style="resize:vertical;font-size:12px;line-height:1.4;margin-bottom:8px"></textarea>
                <button id="hx-parse-btn" style="width:100%;padding:9px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;background:rgba(0,0,0,0.04);font-size:13px;font-weight:500;cursor:pointer;color:var(--c-black);margin-bottom:14px">Parse splits from text</button>
                <div id="hx-parse-status" style="font-size:11px;color:var(--c-faint);margin-bottom:10px;display:none"></div>
                <div style="margin-bottom:12px;height:1px;background:rgba(0,0,0,0.06)"></div>
                ${HYROX_STATION_ORDER.map((st: HyroxStation) => {
                  const display = STATION_DISPLAY[st];
                  const existingSec = (state.hyroxPreviousStationSplits as any)?.[st] as number | undefined;
                  const existingStr = existingSec != null ? fmtMmSs(existingSec) : '';
                  return `
                    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                      <div style="flex:1;font-size:13px;color:var(--c-black)">${display.name}<span style="display:block;font-size:11px;color:var(--c-faint)">${display.distance}</span></div>
                      <input type="text" class="hx-input hx-split-input" data-station="${st}" placeholder="mm:ss" value="${existingStr}" style="width:80px;text-align:center;flex-shrink:0" autocomplete="off">
                    </div>
                  `;
                }).join('')}

                <!-- Average split fallback: fills any unfilled stations with this value. -->
                <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(0,0,0,0.06);display:flex;align-items:center;gap:10px">
                  <div style="flex:1">
                    <div style="font-size:13px;color:var(--c-black)">Average split (optional)</div>
                    <div style="font-size:11px;color:var(--c-faint)">Don't remember each one? Enter your average. We'll seed any blank stations above.</div>
                  </div>
                  <input type="text" id="hx-avg-split" class="hx-input" placeholder="mm:ss" style="width:80px;text-align:center;flex-shrink:0" autocomplete="off">
                </div>

                <!-- Read-only breakdown so the user can sanity-check that the
                     splits add up: Stations + Running & roxzone = Finish. -->
                <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,0.06)">
                  <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:7px">
                    <div style="font-size:13px;color:var(--c-black)">Station total</div>
                    <div id="hx-station-total" style="font-size:14px;font-variant-numeric:tabular-nums;color:var(--c-faint)">—</div>
                  </div>
                  <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:7px">
                    <div style="font-size:13px;color:var(--c-black)">Running + roxzone</div>
                    <div id="hx-run-total" style="font-size:14px;font-variant-numeric:tabular-nums;color:var(--c-faint)">—</div>
                  </div>
                  <div style="display:flex;align-items:baseline;justify-content:space-between;padding-top:7px;border-top:1px solid rgba(0,0,0,0.05)">
                    <div style="font-size:13px;color:var(--c-black);font-weight:500">Finish time</div>
                    <div id="hx-finish-total" style="font-size:14px;font-variant-numeric:tabular-nums;color:var(--c-black);font-weight:500">—</div>
                  </div>
                  <div id="hx-total-hint" style="font-size:11px;color:var(--c-faint);margin-top:8px;line-height:1.5">Stations plus running and roxzone should add up to your finish time.</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Weekly hours -->
          <div class="hx-card hx-rise" style="animation-delay:0.22s">
            <div class="hx-label">Time available per week</div>
            <div class="hx-row">
              <span>Peak weekly hours</span>
              <span class="hx-value" id="hx-hours-value">${hoursPerWeek}h</span>
            </div>
            <input type="range" min="${hoursRange.min}" max="${hoursRange.max}" step="1" value="${hoursPerWeek}" class="m-slider-glass" id="hx-hours">
            <p class="hx-hint">Peak-week target. Early and recovery weeks will be lighter.</p>
          </div>

          <!-- Sessions per week -->
          <div class="hx-card hx-rise" style="animation-delay:0.24s">
            <div class="hx-label">Sessions per week</div>
            ${(() => {
              // Sessions slider starts one step below the band default so users
              // opt-in to more sessions. Beginner band default = 5 → initial = 4.
              const bandDefault = derivedBand
                ? (() => { const s = HYROX_WEEKLY_SESSIONS[derivedBand]; return s.runs + s.stations + s.bricks; })()
                : 5;
              const initialSessions = Math.max(2, bandDefault - 1);
              const sessionCount = state.hyroxWeeklySessionCount ?? initialSessions;
              return `
                <div class="hx-row">
                  <span>Training days</span>
                  <span class="hx-value" id="hx-sessions-value">${sessionCount}</span>
                </div>
                <input type="range" min="2" max="7" step="1" value="${sessionCount}" class="m-slider-glass" id="hx-sessions">
                <p class="hx-hint">Runs, station sessions, and bricks combined. Adjust to fit your schedule.</p>
              `;
            })()}
          </div>

          <!-- Equipment -->
          <div class="hx-card hx-rise" style="animation-delay:0.26s">
            <div class="hx-label">Equipment access</div>

            <div style="margin-bottom:14px">
              <div style="font-size:13px;color:var(--c-black);margin-bottom:8px">Sled track</div>
              <div class="hx-pill-row">
                <button class="hx-pill ${sledAccess !== 'never' ? 'active' : ''}" data-sled="always" style="text-align:center">Have access</button>
                <button class="hx-pill ${sledAccess === 'never' ? 'active' : ''}" data-sled="never" style="text-align:center">No access</button>
              </div>
            </div>

            <div style="padding-top:14px;border-top:1px solid rgba(0,0,0,0.06);margin-bottom:14px">
              <div style="font-size:13px;color:var(--c-black);margin-bottom:8px">SkiErg</div>
              <div class="hx-pill-row">
                <button class="hx-pill ${hasSkiErg ? 'active' : ''}" data-equip="ski-yes" style="text-align:center">Have access</button>
                <button class="hx-pill ${!hasSkiErg ? 'active' : ''}" data-equip="ski-no" style="text-align:center">No access</button>
              </div>
            </div>

            <div style="padding-top:14px;border-top:1px solid rgba(0,0,0,0.06)">
              <div style="font-size:13px;color:var(--c-black);margin-bottom:8px">Row erg</div>
              <div class="hx-pill-row">
                <button class="hx-pill ${hasRowErg ? 'active' : ''}" data-equip="row-yes" style="text-align:center">Have access</button>
                <button class="hx-pill ${!hasRowErg ? 'active' : ''}" data-equip="row-no" style="text-align:center">No access</button>
              </div>
            </div>
          </div>

          <!-- CTA. The hint names whatever is blocking Continue, right where
               the user taps (the amber prompt can sit several cards above). -->
          <div class="hx-rise" style="margin-top:6px;animation-delay:0.30s">
            <p id="hx-continue-hint" class="hx-hint" aria-live="polite" style="text-align:center;margin:0 0 8px;display:none"></p>
            <button id="hx-continue" class="hx-cta">Continue</button>
          </div>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers();
  void state;
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

function wireEventHandlers(): void {
  // Format toggle
  document.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-format') as 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
      updateOnboarding({ hyroxFormat: value });
      document.querySelectorAll<HTMLButtonElement>('[data-format]').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-format') === value);
      });
      const isDoubles = value === 'open_doubles' || value === 'pro_doubles';
      const isPro = value === 'pro_singles' || value === 'pro_doubles';
      // No Pro Mixed: a Mixed pick does not survive a switch to Pro Doubles.
      if (getOnboarding().hyroxDivision === 'mixed' && value === 'pro_doubles') {
        updateOnboarding({ hyroxDivision: undefined });
      }
      const doublesNote = document.getElementById('hx-doubles-note');
      if (doublesNote) doublesNote.style.display = isDoubles ? 'block' : 'none';
      const proNote = document.getElementById('hx-pro-note');
      if (proNote) proNote.style.display = isPro ? 'block' : 'none';
      refreshDivisionUi();
    });
  });

  // Division toggle (doubles, or singles with unknown biological sex).
  document.querySelectorAll<HTMLButtonElement>('[data-division]').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-division') as HyroxDivision;
      updateOnboarding({ hyroxDivision: value });
      refreshDivisionUi();
    });
  });

  // Previous-time format toggle
  document.querySelectorAll<HTMLButtonElement>('[data-prev-format]').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-prev-format') as 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
      updateOnboarding({ hyroxPreviousTimeFormat: value });
      document.querySelectorAll<HTMLButtonElement>('[data-prev-format]').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-prev-format') === value);
      });
      // The amber "pick the format" prompt was fixed at render time, so it
      // kept asking after the user had answered. Settle it in place.
      const prompt = document.getElementById('hx-prev-format-prompt');
      if (prompt) {
        prompt.textContent = PREV_FORMAT_PROMPT_DONE;
        prompt.style.color = 'var(--c-muted)';
      }
    });
  });

  // Previous-time race picker. Selecting a real event auto-fills the race
  // date from the event record. Picking "Other / not listed" surfaces the
  // manual date input. The placeholder option is non-selectable, so we only
  // ask for a date when the user explicitly says they don't know the race.
  const prevRaceSelect = document.getElementById('hx-prev-race') as HTMLSelectElement | null;
  const prevRaceDateRow = document.getElementById('hx-prev-race-date-row');
  prevRaceSelect?.addEventListener('change', () => {
    const v = prevRaceSelect.value;
    if (v === 'other') {
      updateOnboarding({ hyroxPreviousTimeRaceId: undefined });
      if (prevRaceDateRow) prevRaceDateRow.style.display = 'block';
    } else if (v) {
      updateOnboarding({ hyroxPreviousTimeRaceId: v });
      const ev = getHyroxEventById(v);
      if (ev) updateOnboarding({ hyroxPreviousRaceDate: ev.date });
      if (prevRaceDateRow) prevRaceDateRow.style.display = 'none';
    } else {
      updateOnboarding({ hyroxPreviousTimeRaceId: undefined });
      if (prevRaceDateRow) prevRaceDateRow.style.display = 'none';
    }
  });

  const prevRaceDateInput = document.getElementById('hx-prev-race-date') as HTMLInputElement | null;
  prevRaceDateInput?.addEventListener('change', () => {
    const v = prevRaceDateInput.value; // YYYY-MM
    if (v && /^\d{4}-\d{2}$/.test(v)) {
      // Normalise to YYYY-MM-15 (mid-month) for stable parsing.
      updateOnboarding({ hyroxPreviousRaceDate: `${v}-15` });
    } else if (!v) {
      updateOnboarding({ hyroxPreviousRaceDate: undefined });
    }
  });

  // Previous time input → live band derivation + show format row
  const timeInput = document.getElementById('hx-prev-time') as HTMLInputElement | null;
  const timeError = document.getElementById('hx-prev-time-error');
  const setTimeError = (message: string): void => {
    if (!timeError) return;
    timeError.textContent = message;
    timeError.style.display = message ? 'block' : 'none';
  };
  timeInput?.addEventListener('input', () => {
    const read = readPrevFinish(timeInput.value);
    const splitsSection = document.getElementById('hx-splits-section');
    const prevFormatRow = document.getElementById('hx-prev-time-format-row');
    if (read != null && 'sec' in read) {
      const sec = read.sec;
      setTimeError('');
      updateOnboarding({ previousHyroxTimeSec: sec });
      const band = setupBand(getOnboarding()) ?? 'novice';
      if (splitsSection) splitsSection.style.display = 'block';
      if (prevFormatRow) prevFormatRow.style.display = 'block';
      // Reveal the date picker if no event ID is currently selected.
      if (prevRaceDateRow) {
        const raceSelected = (prevRaceSelect && prevRaceSelect.value);
        prevRaceDateRow.style.display = raceSelected ? 'none' : 'block';
      }
      // Rescope hours slider to new band range
      const newRange = HYROX_HOURS_RANGE[band];
      const hoursEl = document.getElementById('hx-hours') as HTMLInputElement | null;
      const hoursVal = document.getElementById('hx-hours-value');
      if (hoursEl) {
        hoursEl.min = String(newRange.min);
        hoursEl.max = String(newRange.max);
        const clamped = Math.min(newRange.max, Math.max(newRange.min, Number(hoursEl.value)));
        hoursEl.value = String(clamped);
        if (hoursVal) hoursVal.textContent = `${clamped}h`;
        updateOnboarding({ triTimeAvailableHoursPerWeek: clamped });
      }
    } else {
      // Empty, half-typed, or not a usable finish. Never keep the last good
      // value: backspacing "1:12:30" used to leave 60 s (from "1:") in state,
      // keeping the format requirement armed for a field that no longer parsed.
      if (getOnboarding().previousHyroxTimeSec != null) updateOnboarding({ previousHyroxTimeSec: undefined });
      if (splitsSection) splitsSection.style.display = 'none';
      if (prevFormatRow) prevFormatRow.style.display = 'none';
      // The message itself waits for 'change' (mid-typing values are expected
      // to be incomplete); once shown it tracks the field live.
      if (read == null) setTimeError('');
      else if (timeError && timeError.style.display !== 'none') setTimeError(read.error);
    }
    // Finish anchors the "Running + roxzone" remainder; keep the breakdown live.
    refreshTotalDisplay();
  });

  // On commit (blur / Return), normalise a usable time to h:mm:ss so a typed
  // "01:12:30" reads "1:12:30", consistent with every other duration field on
  // the page. Anything unusable gets a visible message instead of being ignored.
  timeInput?.addEventListener('change', () => {
    const read = readPrevFinish(timeInput.value);
    if (read == null) setTimeError('');
    else if ('sec' in read) { timeInput.value = fmtMmSs(read.sec); setTimeError(''); }
    else setTimeError(read.error);
    syncContinueGate();
  });

  // Station splits accordion toggle
  document.getElementById('hx-splits-toggle')?.addEventListener('click', () => {
    const body = document.getElementById('hx-splits-body');
    const chevron = document.getElementById('hx-splits-chevron');
    if (body) {
      const open = body.style.display === 'none';
      body.style.display = open ? 'block' : 'none';
      if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
    }
  });

  // Station split inputs (manual entry with lower-bound enforcement).
  // Both rejection paths now show a visible tooltip. Previously bare digits
  // ("4") were silently cleared, leading users to believe their value was
  // saved when it wasn't.
  function showSplitInputError(input: HTMLInputElement, message: string): void {
    input.style.borderColor = '#ef4444';
    // Re-use or create a tooltip element below the row.
    let tip = input.parentElement?.querySelector('.hx-split-tip') as HTMLElement | null;
    if (!tip && input.parentElement) {
      tip = document.createElement('div');
      tip.className = 'hx-split-tip';
      tip.style.cssText = 'font-size:11px;color:#ef4444;margin-top:4px;line-height:1.4';
      input.parentElement.appendChild(tip);
    }
    if (tip) {
      tip.textContent = message;
      tip.style.display = 'block';
    }
    setTimeout(() => {
      input.style.borderColor = '';
      if (tip) tip.style.display = 'none';
    }, 4000);
  }

  // Total-time display below the average split. Two modes:
  //   1. "race-total". Set when paste-parser finds a valid total (e.g. 1:00:43)
  //   2. "stations-sum". Sum of currently-filled station splits (always shown
  //                       when no race-total is set, even if partial)
  // Read-only breakdown: Station total + Running & roxzone = Finish. The splits
  // section only renders once a finish time exists, so the finish anchor is
  // always available; "Running + roxzone" is the remainder (finish − stations),
  // which lets the user check the splits add up. It's only well-defined once all
  // 8 stations are in — with a partial set the remainder still hides unentered
  // stations, so we hold it until the form is complete.
  function refreshTotalDisplay(): void {
    const stationEl = document.getElementById('hx-station-total');
    const runEl = document.getElementById('hx-run-total');
    const finishEl = document.getElementById('hx-finish-total');
    const hint = document.getElementById('hx-total-hint');
    if (!stationEl || !runEl || !finishEl || !hint) return;

    const ob = getOnboarding();
    const finishSec = ob.previousHyroxTimeSec ?? null;
    const splits = (ob.hyroxPreviousStationSplits ?? {}) as Record<string, number>;
    const values = Object.values(splits);
    const stationSum = values.reduce((a, b) => a + b, 0);
    const allStations = values.length === 8;

    // Finish (session) total.
    finishEl.textContent = finishSec != null ? fmtMmSs(finishSec) : '—';

    // Station total.
    if (values.length === 0) {
      stationEl.textContent = '—';
      stationEl.style.color = 'var(--c-faint)';
    } else {
      stationEl.textContent = fmtMmSs(stationSum);
      stationEl.style.color = 'var(--c-black)';
    }

    // Running + roxzone = finish − station total.
    if (finishSec == null || !allStations) {
      runEl.textContent = '—';
      runEl.style.color = 'var(--c-faint)';
      hint.style.color = 'var(--c-faint)';
      hint.textContent = values.length === 0
        ? 'Stations plus running and roxzone should add up to your finish time.'
        : `Enter all 8 stations (${values.length} in) to see your running and roxzone time.`;
      return;
    }
    const runSec = finishSec - stationSum;
    if (runSec <= 0) {
      // Stations sum to more than the finish: a typo somewhere in the splits.
      runEl.textContent = fmtMmSs(0);
      runEl.style.color = 'var(--c-caution)';
      hint.style.color = 'var(--c-caution)';
      hint.textContent = 'Your stations add up to more than your finish time. Check the splits above.';
      return;
    }
    runEl.textContent = fmtMmSs(runSec);
    runEl.style.color = 'var(--c-black)';
    hint.style.color = 'var(--c-faint)';
    hint.textContent = 'Stations plus running and roxzone add up to your finish time.';
  }

  document.querySelectorAll<HTMLInputElement>('.hx-split-input').forEach(input => {
    // Focusing a flagged field counts as reviewing it: drop the amber border.
    input.addEventListener('focus', () => {
      if (input.dataset.lowConfidence) {
        input.style.borderColor = '';
        delete input.dataset.lowConfidence;
      }
    });
    input.addEventListener('change', () => {
      const station = input.getAttribute('data-station') as HyroxStation;
      const raw = input.value.trim();
      const sec = parseTime(raw);
      const current = (getOnboarding().hyroxPreviousStationSplits ?? {}) as Record<string, number>;
      const minSec = STATION_MIN_SEC[station] ?? 0;

      // Empty input → clear from state silently (intentional reset).
      if (raw === '') {
        const updated = { ...current };
        delete updated[station];
        updateOnboarding({ hyroxPreviousStationSplits: Object.keys(updated).length ? updated : undefined });
        refreshTotalDisplay();
        return;
      }

      if (!isNaN(sec) && sec >= minSec) {
        // Normalise display to HH:MM:SS so all rows look consistent.
        input.value = fmtMmSs(sec);
        updateOnboarding({ hyroxPreviousStationSplits: { ...current, [station]: sec } });
        refreshTotalDisplay();
        return;
      }

      if (!isNaN(sec) && sec > 0 && sec < minSec) {
        // Parsed but below physical minimum.
        input.value = '';
        showSplitInputError(input, `That's below the minimum realistic time for this station (${Math.floor(minSec / 60)}:${String(minSec % 60).padStart(2, '0')}). Use mm:ss. E.g. 4:22.`);
        return;
      }

      // NaN. Bare digits, garbled text, etc.
      input.value = '';
      showSplitInputError(input, 'Use mm:ss format. E.g. 4:22 for 4 min 22 sec.');
    });
  });

  // Initial render: seed the total from any pre-existing splits in state.
  refreshTotalDisplay();

  // Parse-from-paste. Shared by the "Parse" button, the one-tap clipboard
  // button, and auto-parse on paste — so however the text arrives, the same
  // forgiving extraction runs. A rough or partial copy is fine: the parser
  // picks station names out of arbitrary text and ignores everything else.
  const applyParsedSplits = (rawText: string): void => {
    const status = document.getElementById('hx-parse-status');
    if (!status) return;

    const result = parseHyroxResultsText(rawText);
    const stationCount = Object.keys(result.stations).length;

    if (stationCount === 0 && result.runPaceSecKm == null) {
      status.style.display = 'block';
      status.textContent = rawText.trim()
        ? "Couldn't find any station times in that text. A rough selection of the splits is enough, or enter them by hand below."
        : 'Nothing to read yet. Copy your result page, then paste or tap "Paste from clipboard".';
      return;
    }

    // Populate the individual split inputs. Fields whose value came from the
    // looser fallback scan (not the structured In/Out pair) get an amber
    // "check this" border, since a messy copy can mis-grab those. The flag
    // clears the moment the user focuses the field (see the focus handler).
    let lowConfidenceCount = 0;
    document.querySelectorAll<HTMLInputElement>('.hx-split-input').forEach(input => {
      const station = input.getAttribute('data-station') as HyroxStation;
      const sec = (result.stations as Record<string, number>)[station];
      if (sec == null) return;
      input.value = fmtMmSs(sec);
      if (result.stationSource[station] === 'fallback') {
        input.style.borderColor = 'var(--c-caution)';
        input.dataset.lowConfidence = '1';
        lowConfidenceCount++;
      } else {
        input.style.borderColor = '';
        delete input.dataset.lowConfidence;
      }
    });

    // Auto-fill the avg-split input with the mean of the parsed stations so the
    // user can see at a glance what their average was. Field stays editable —
    // they can still type over it to seed blanks differently.
    const parsedStationSecs = Object.values(result.stations) as number[];
    if (parsedStationSecs.length > 0) {
      const avg = Math.round(parsedStationSecs.reduce((a, b) => a + b, 0) / parsedStationSecs.length);
      const avgEl = document.getElementById('hx-avg-split') as HTMLInputElement | null;
      if (avgEl) avgEl.value = fmtMmSs(avg);
    }

    // Merge into onboarding
    const current = (getOnboarding().hyroxPreviousStationSplits ?? {}) as Record<string, number>;
    const patch: Partial<OnboardingState> = {
      hyroxPreviousStationSplits: { ...current, ...result.stations } as any,
    };
    if (result.runPaceSecKm != null) patch.hyroxRunPaceSecKm = result.runPaceSecKm;

    // Auto-fill the previous finish time field when the parser found a total.
    if (result.totalRaceSec != null) {
      patch.previousHyroxTimeSec = result.totalRaceSec;
      const prevTimeEl = document.getElementById('hx-prev-time') as HTMLInputElement | null;
      if (prevTimeEl) {
        prevTimeEl.value = fmtMmSs(result.totalRaceSec);
        // Reveal the format/race-pick row + station-splits section, which the
        // existing 'input' handler is responsible for. Dispatch the event so
        // band derivation and section visibility update.
        prevTimeEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    updateOnboarding(patch);
    refreshTotalDisplay();

    const parts: string[] = [];
    if (stationCount > 0) parts.push(`${stationCount} of 8 station times`);
    if (result.runPaceSecKm != null) parts.push(`run pace ${fmtMmSs(result.runPaceSecKm)}/km`);
    status.style.display = 'block';
    // Be explicit about partial reads so a missing station reads as "fill the
    // rest", not "the paste failed". Always invite a review: a messy phone copy
    // can occasionally land a plausible-but-wrong time, and every field below is
    // editable.
    const missing = stationCount > 0 && stationCount < 8 ? ` Add the other ${8 - stationCount} below.` : '';
    const review = lowConfidenceCount > 0
      ? ` ${lowConfidenceCount} ${lowConfidenceCount === 1 ? 'time is' : 'times are'} highlighted as a looser match. Check ${lowConfidenceCount === 1 ? 'it' : 'those'} and tap to edit.`
      : ' Tap any time below to edit.';
    status.textContent = `Found ${parts.join(', ')}.${missing}${review}`;
  };

  document.getElementById('hx-parse-btn')?.addEventListener('click', () => {
    const textarea = document.getElementById('hx-paste-results') as HTMLTextAreaElement | null;
    if (textarea) applyParsedSplits(textarea.value);
  });

  // Auto-parse the moment text lands in the box, so the "Parse" button is a
  // fallback rather than a required second tap. `paste` fires before the value
  // updates, hence the microtask defer; `input` covers typing and programmatic
  // fills (e.g. the clipboard button).
  const pasteArea = document.getElementById('hx-paste-results') as HTMLTextAreaElement | null;
  pasteArea?.addEventListener('paste', () => { setTimeout(() => applyParsedSplits(pasteArea.value), 0); });

  // One-tap clipboard read. On iPhone, long-pressing the tiny textarea and
  // hunting for "Paste" is the fiddly step; this collapses it to a single tap.
  // Uses the web Clipboard API (works in WKWebView + browsers behind a user
  // gesture). If it's blocked or empty, fall back to manual paste.
  document.getElementById('hx-paste-clip-btn')?.addEventListener('click', async () => {
    const status = document.getElementById('hx-parse-status');
    try {
      const text = await navigator.clipboard?.readText();
      if (!text || !text.trim()) {
        if (status) { status.style.display = 'block'; status.textContent = 'Clipboard is empty. Copy your result page first, then tap this again.'; }
        return;
      }
      if (pasteArea) pasteArea.value = text;
      applyParsedSplits(text);
    } catch {
      // Permission denied or API unavailable. Steer them to the manual box.
      if (status) { status.style.display = 'block'; status.textContent = 'Couldn\'t read the clipboard. Paste into the box below instead.'; }
    }
  });
  // Race event picker. Also controls visibility of the manual venue fallback.
  // Race event picker. Also controls visibility of the manual venue fallback.
  const raceEventSelect = document.getElementById('hx-race-event') as HTMLSelectElement | null;
  const raceDateInput = document.getElementById('hx-race-date') as HTMLInputElement | null;
  const venueFallback = document.getElementById('hx-venue-fallback') as HTMLDivElement | null;
  raceEventSelect?.addEventListener('change', () => {
    const val = raceEventSelect.value;
    const isCustom = val === 'custom';
    if (raceDateInput) raceDateInput.style.display = isCustom ? 'block' : 'none';
    if (venueFallback) venueFallback.style.display = isCustom ? 'block' : 'none';
    if (isCustom) {
      updateOnboarding({ hyroxRaceEventId: undefined, hyroxVenueId: undefined });
    } else if (val) {
      const ev = getHyroxEventById(val);
      if (ev) {
        updateOnboarding({
          hyroxRaceEventId: ev.id,
          customRaceDate: ev.date,
          hyroxVenueId: getVenueIdForEvent(ev.id),
        });
      }
    } else {
      updateOnboarding({ hyroxRaceEventId: undefined, customRaceDate: null, hyroxVenueId: undefined });
    }
    syncContinueGate();
  });

  // Race date (custom). 'input' as well as 'change': desktop Safari and
  // Firefox fire 'change' only on blur, which left Continue gated while a
  // typed date sat in the field.
  const onRaceDate = () => {
    updateOnboarding({ customRaceDate: raceDateInput!.value || null });
    syncContinueGate();
  };
  raceDateInput?.addEventListener('input', onRaceDate);
  raceDateInput?.addEventListener('change', onRaceDate);

  // Manual venue fallback (only used when "Other / enter date manually" is selected).
  const manualVenueSelect = document.getElementById('hx-manual-venue') as HTMLSelectElement | null;
  manualVenueSelect?.addEventListener('change', () => {
    updateOnboarding({ hyroxVenueId: manualVenueSelect.value || undefined });
  });

  // Continue gate: a race date is required so course factors and the training
  // the format must also be picked. Silently defaulting it to the target
  // the format must also be picked. Silently defaulting it to the target
  // format mis-classifies doubles times as singles (and vice versa).
  //
  // The reason is written next to the button (#hx-continue-hint), because the
  // amber format prompt can sit four cards above it, off-screen on a phone, and
  // `title` tooltips never appear on touch. The button uses aria-disabled, not
  // native `disabled`, so a tap still arrives and can scroll to the field.
  function continueBlocker(): { reason: string; targetId: string } | null {
    const o = getOnboarding();
    if (!o.hyroxRaceEventId && !o.customRaceDate) {
      const custom = (document.getElementById('hx-race-event') as HTMLSelectElement | null)?.value === 'custom';
      return { reason: 'Pick a race or set a custom date to continue.', targetId: custom ? 'hx-race-date' : 'hx-race-event' };
    }
    const timeEl = document.getElementById('hx-prev-time') as HTMLInputElement | null;
    const read = timeEl ? readPrevFinish(timeEl.value) : null;
    if (read != null && 'error' in read) {
      return { reason: 'Check the previous time, or clear it, to continue.', targetId: 'hx-prev-time' };
    }
    if (o.previousHyroxTimeSec != null && !o.hyroxPreviousTimeFormat) {
      return { reason: 'Pick the format your previous time was set in to continue.', targetId: 'hx-prev-time-format-row' };
    }
    return null;
  }

  function syncContinueGate(): void {
    const cta = document.getElementById('hx-continue') as HTMLButtonElement | null;
    if (!cta) return;
    const blocker = continueBlocker();
    const ok = blocker == null;
    cta.disabled = false;
    cta.setAttribute('aria-disabled', ok ? 'false' : 'true');
    cta.style.opacity = ok ? '1' : '0.45';
    cta.style.cursor = ok ? 'pointer' : 'not-allowed';
    cta.title = blocker?.reason ?? '';
    const hint = document.getElementById('hx-continue-hint');
    if (hint) {
      hint.textContent = blocker?.reason ?? '';
      hint.style.display = ok ? 'none' : 'block';
    }
  }
  syncContinueGate();
  // edits the previous-time input. Both can flip the gate state.
  // edits the previous-time input. Both can flip the gate state.
  document.querySelectorAll<HTMLButtonElement>('[data-prev-format]').forEach(btn => {
    btn.addEventListener('click', () => syncContinueGate());
  });
  document.getElementById('hx-prev-time')?.addEventListener('input', () => syncContinueGate());
  // Average split fallback. Fills any blank station inputs with the entered
  // Average split fallback. Fills any blank station inputs with the entered
  // value and writes to onboarding. Per-station inputs the user already filled
  // are preserved.
  const avgSplitInput = document.getElementById('hx-avg-split') as HTMLInputElement | null;
  avgSplitInput?.addEventListener('change', () => {
    const sec = parseTime(avgSplitInput.value);
    if (isNaN(sec) || sec <= 0) return;
    avgSplitInput.value = fmtMmSs(sec);
    const current = (getOnboarding().hyroxPreviousStationSplits ?? {}) as Record<string, number>;
    const merged: Record<string, number> = { ...current };
    document.querySelectorAll<HTMLInputElement>('.hx-split-input').forEach(input => {
      const station = input.getAttribute('data-station') as HyroxStation;
      if (input.value.trim() === '' && current[station] == null) {
        const minSec = STATION_MIN_SEC[station] ?? 0;
        if (sec >= minSec) {
          merged[station] = sec;
          input.value = fmtMmSs(sec);
        }
      }
    });
    updateOnboarding({ hyroxPreviousStationSplits: Object.keys(merged).length ? merged : undefined });
    refreshTotalDisplay();
  });

  // Hours slider
  const hoursInput = document.getElementById('hx-hours') as HTMLInputElement | null;
  const hoursValue = document.getElementById('hx-hours-value');
  hoursInput?.addEventListener('input', () => {
    const h = Number(hoursInput.value);
    if (hoursValue) hoursValue.textContent = `${h}h`;
    updateOnboarding({ triTimeAvailableHoursPerWeek: h });
  });

  // Sessions per week slider
  const sessionsInput = document.getElementById('hx-sessions') as HTMLInputElement | null;
  const sessionsValue = document.getElementById('hx-sessions-value');
  sessionsInput?.addEventListener('input', () => {
    const n = Number(sessionsInput.value);
    if (sessionsValue) sessionsValue.textContent = String(n);
    updateOnboarding({ hyroxWeeklySessionCount: n });
  });

  // Sled access pills
  document.querySelectorAll<HTMLButtonElement>('[data-sled]').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-sled') as 'always' | 'sometimes' | 'never';
      updateOnboarding({ hyroxSledAccess: value });
      document.querySelectorAll<HTMLButtonElement>('[data-sled]').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-sled') === value);
      });
    });
  });

  // Equipment pills (SkiErg + Row erg)
  document.querySelectorAll<HTMLButtonElement>('[data-equip]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-equip')!;
      if (key === 'ski-yes' || key === 'ski-no') {
        const has = key === 'ski-yes';
        updateOnboarding({ hyroxHasSkiErg: has });
        document.querySelectorAll<HTMLButtonElement>('[data-equip^="ski"]').forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-equip') === (has ? 'ski-yes' : 'ski-no'));
        });
      } else if (key === 'row-yes' || key === 'row-no') {
        const has = key === 'row-yes';
        updateOnboarding({ hyroxHasRowErg: has });
        document.querySelectorAll<HTMLButtonElement>('[data-equip^="row"]').forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-equip') === (has ? 'row-yes' : 'row-no'));
        });
      }
    });
  });

  // Continue
  document.getElementById('hx-continue')?.addEventListener('click', () => {
    // Same rule as syncContinueGate (date, readable time, time format). A
    // gated tap scrolls to the field that needs attention; the reason is
    // already written above the button. Unlike manual-entry, mousedown is NOT
    // cancelled here: station splits commit on 'change', which needs the blur
    // that the press causes.
    syncContinueGate();
    const blocker = continueBlocker();
    if (blocker) {
      if (blocker.targetId === 'hx-prev-time' && timeInput) {
        const read = readPrevFinish(timeInput.value);
        if (read != null && 'error' in read) setTimeError(read.error);
      }
      document.getElementById(blocker.targetId)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      return;
    }
    const current = getOnboarding();
    const patch: Partial<OnboardingState> = {};
    if (!current.hyroxFormat) patch.hyroxFormat = 'open_singles';
    if (current.triTimeAvailableHoursPerWeek === undefined) {
      const band = setupBand(current) ?? 'novice';
      patch.triTimeAvailableHoursPerWeek = HYROX_HOURS_RANGE[band].default;
    }
    if (current.hyroxSledAccess === undefined) patch.hyroxSledAccess = 'always';
    if (current.hyroxHasSkiErg === undefined) patch.hyroxHasSkiErg = true;
    if (current.hyroxHasRowErg === undefined) patch.hyroxHasRowErg = true;
    // Plan length follows the picked race date when available: the calendar
    // weeks from this local Monday through the week holding race day
    // (racePlanCalendarWeeks), so the plan's final week holds race day. Falls
    // back to the band default otherwise, which can outrun the actual race.
    // Mirrors triathlon-setup.ts.
    const band = setupBand(current) ?? 'novice';
    const raceDateIso = current.customRaceDate;
    patch.planDurationWeeks = raceDateIso
      ? (racePlanCalendarWeeks(raceDateIso) ?? 1)
      : HYROX_DEFAULT_PLAN_WEEKS[band];
    patch.trainingForEvent = true;
    if (Object.keys(patch).length > 0) updateOnboarding(patch);
    nextStep();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Sync the Division row, its hint and the Pro note with the current format,
 *  biological sex and division pick, in place (no re-render). */
function refreshDivisionUi(): void {
  const ob = getOnboarding();
  const format = ob.hyroxFormat ?? 'open_singles';
  const options = hyroxDivisionOptions(format, ob.biologicalSex);
  const active = resolveHyroxDivision(format, ob.biologicalSex, ob.hyroxDivision);
  const row = document.getElementById('hx-division-row');
  if (row) row.style.display = options ? 'block' : 'none';
  document.querySelectorAll<HTMLButtonElement>('[data-division]').forEach(b => {
    const d = b.getAttribute('data-division') as HyroxDivision;
    b.classList.toggle('active', d === active);
    if (d === 'mixed') b.style.display = options?.includes('mixed') ? 'block' : 'none';
  });
  const hint = document.getElementById('hx-division-hint');
  if (hint) hint.textContent = divisionHintText(format, ob.biologicalSex, ob.hyroxDivision);
  const proNote = document.getElementById('hx-pro-note');
  if (proNote) proNote.textContent = proNoteText(format, ob.biologicalSex, ob.hyroxDivision);
}

function getOnboarding(): OnboardingState {
  return getState().onboarding as OnboardingState;
}

