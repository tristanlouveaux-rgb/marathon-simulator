/**
 * HYROX setup — onboarding step.
 *
 * Collects:
 *   - Competition format (Open / Pro)
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
  HYROX_TIME_TO_BAND_THRESHOLDS,
  HYROX_HOURS_RANGE,
  HYROX_DEFAULT_PLAN_WEEKS,
  HYROX_WEEKLY_SESSIONS,
} from '@/constants/hyrox-constants';
import { HYROX_STATION_ORDER, STATION_DISPLAY, STATION_MIN_SEC, HYROX_RUN_PACE_MIN_SEC_KM } from '@/constants/hyrox-benchmarks';
import type { HyroxStation } from '@/types/triathlon';
import { getFutureHyroxEvents, getPastHyroxEvents, getHyroxEventById, getVenueIdForEvent } from '@/data/hyrox-events';
import { calculateWeeksUntil } from '@/data/marathons';
// Venue normally derives from the race-event selection. Manual venue picker
// is shown as a fallback only when the user picks "Other / enter date manually".
import { HYROX_VENUES } from '@/data/hyrox-venues';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Derive ability band from previous finish time (seconds). */
function bandFromTime(sec: number): AbilityBand {
  for (const { maxSec, band } of HYROX_TIME_TO_BAND_THRESHOLDS) {
    if (sec < maxSec) return band;
  }
  return 'beginner';
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

/** Parse a mm:ss or h:mm:ss string to seconds. Returns NaN on failure. */
function parseTime(raw: string): number {
  const parts = raw.trim().split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

// ─── Render ──────────────────────────────────────────────────────────────────

export function renderHyroxSetup(container: HTMLElement, state: OnboardingState): void {
  const format = state.hyroxFormat ?? 'open_singles';
  const prevTimeSec = state.previousHyroxTimeSec;
  const prevTimeStr = prevTimeSec != null ? fmtMmSs(prevTimeSec) : '';
  const derivedBand: AbilityBand | null = prevTimeSec != null ? bandFromTime(prevTimeSec) : null;
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
  // was unanswered — see ISSUE: doubles splits ended up in the Singles slot.
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
      .hx-slider { -webkit-appearance:none; appearance:none; width:100%; height:4px; background:rgba(0,0,0,0.12); border-radius:4px; outline:none; margin:10px 0 2px; }
      .hx-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:20px; height:20px; background:var(--c-black); border-radius:50%; cursor:pointer; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
      .hx-slider::-moz-range-thumb { width:20px; height:20px; background:var(--c-black); border-radius:50%; cursor:pointer; border:none; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
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
          <div class="hx-card hx-rise" style="animation-delay:0.10s">
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
            <p id="hx-doubles-note" class="hx-hint" style="margin-top:10px;display:${(format === 'open_doubles' || format === 'pro_doubles') ? 'block' : 'none'}">You each run all 8 legs. Stations are split — training covers all 8 for flexibility, but at half the weekly station volume.</p>
            <p id="hx-pro-note" class="hx-hint" style="margin-top:4px;display:${(format === 'pro_singles' || format === 'pro_doubles') ? 'block' : 'none'}">Pro division uses heavier weights: sled push 202 kg, sandbag 30 kg, wall balls 9 kg.</p>
            <p class="hx-hint" style="margin-top:10px">Your plan starts mostly aerobic and ramps into tempo + intervals through the build phase. Variety is intentional — base first, race-specific second.</p>
          </div>

          <!-- Race event picker -->
          <div class="hx-card hx-rise" style="animation-delay:0.12s">
            <div class="hx-label">Which race?</div>
            <select id="hx-race-event" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,0.08);background:rgba(255,255,255,0.95);color:var(--c-black);font-size:14px;font-family:var(--f);outline:none;margin-bottom:10px">
              <option value="">Select a HYROX event</option>
              ${getFutureHyroxEvents(new Date().toISOString().slice(0, 10)).map(ev => {
                const d = new Date(ev.date);
                const label = `${d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — ${ev.city}`;
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
                  `<option value="${v.id}" ${state.hyroxVenueId === v.id ? 'selected' : ''}>${v.city} — ${v.name}</option>`
                ).join('')}
              </select>
            </div>
          </div>

          <!-- Previous time + which format it was set in -->
          <div class="hx-card hx-rise" style="animation-delay:0.14s">
            <div class="hx-label">Previous Hyrox time</div>
            <input type="text" id="hx-prev-time" class="hx-input" placeholder="e.g. 1:12:30" value="${prevTimeStr}" autocomplete="off">
            <p class="hx-hint" style="margin-bottom:12px">Enter as h:mm:ss or mm:ss. Used to calibrate your training load and pace targets.</p>
            <div id="hx-prev-time-format-row" style="display:${prevTimeSec != null ? 'block' : 'none'}">
              <div style="font-size:12px;color:${prevTimeFormat ? 'var(--c-muted)' : '#b45309'};margin-bottom:6px">${prevTimeFormat ? 'Which format was that time in?' : 'Pick the format your time was set in. Doubles times scale differently to singles — getting this right matters.'}</div>
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
                  const label = `${d.toLocaleString('en-US', { month: 'short', year: 'numeric' })} — ${ev.city}`;
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
                <p class="hx-hint" style="margin:0 0 10px">Paste your results text from hyrox.com — go to your result page, select all (Cmd+A / Ctrl+A), copy, and paste below. We accept either format: simple "Station name + time" lines, or the cumulative "Station In / Station Out" splits from the timing-system export. Or enter times manually below.</p>
                <textarea id="hx-paste-results" class="hx-input" rows="3" placeholder="Paste hyrox.com results here…" style="resize:vertical;font-size:12px;line-height:1.4;margin-bottom:10px"></textarea>
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
                    <div style="font-size:11px;color:var(--c-faint)">Don't remember each one? Enter your average — we'll seed any blank stations above.</div>
                  </div>
                  <input type="text" id="hx-avg-split" class="hx-input" placeholder="mm:ss" style="width:80px;text-align:center;flex-shrink:0" autocomplete="off">
                </div>

                <!-- Read-only total-time display: race total when parsed, else sum of station splits. -->
                <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,0.06);display:flex;align-items:center;gap:10px">
                  <div style="flex:1">
                    <div style="font-size:13px;color:var(--c-black)">Total time</div>
                    <div id="hx-total-hint" style="font-size:11px;color:var(--c-faint)">Sum of the splits above. Updates as you fill them in.</div>
                  </div>
                  <div id="hx-total-display" style="width:80px;text-align:center;flex-shrink:0;font-size:14px;font-variant-numeric:tabular-nums;color:var(--c-faint);padding:9px 12px;border:1px solid rgba(0,0,0,0.06);border-radius:10px;background:rgba(0,0,0,0.02)">—</div>
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
            <input type="range" min="${hoursRange.min}" max="${hoursRange.max}" step="1" value="${hoursPerWeek}" class="hx-slider" id="hx-hours">
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
                <input type="range" min="2" max="7" step="1" value="${sessionCount}" class="hx-slider" id="hx-sessions">
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

          <!-- CTA -->
          <div class="hx-rise" style="margin-top:6px;animation-delay:0.30s">
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
      const doublesNote = document.getElementById('hx-doubles-note');
      const proNote = document.getElementById('hx-pro-note');
      if (doublesNote) doublesNote.style.display = isDoubles ? 'block' : 'none';
      if (proNote) proNote.style.display = isPro ? 'block' : 'none';
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
  timeInput?.addEventListener('input', () => {
    const sec = parseTime(timeInput.value);
    const hasTime = !isNaN(sec) && sec > 0;
    const splitsSection = document.getElementById('hx-splits-section');
    const prevFormatRow = document.getElementById('hx-prev-time-format-row');
    if (hasTime) {
      const band = bandFromTime(sec);
      updateOnboarding({ previousHyroxTimeSec: sec });
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
    } else if (timeInput.value.trim() === '') {
      updateOnboarding({ previousHyroxTimeSec: undefined });
      if (splitsSection) splitsSection.style.display = 'none';
      if (prevFormatRow) prevFormatRow.style.display = 'none';
    }
  });

  // On blur, normalise the previous-time input to HH:MM:SS so a typed "1:12:30"
  // becomes "01:12:30", consistent with every other duration field on the page.
  timeInput?.addEventListener('change', () => {
    const sec = parseTime(timeInput.value);
    if (!isNaN(sec) && sec > 0) timeInput.value = fmtMmSs(sec);
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
  // Both rejection paths now show a visible tooltip — previously bare digits
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
  //   1. "race-total"   — set when paste-parser finds a valid total (e.g. 1:00:43)
  //   2. "stations-sum" — sum of currently-filled station splits (always shown
  //                       when no race-total is set, even if partial)
  // We track which mode we're in so a subsequent station edit doesn't clobber
  // a parsed race-total with a partial sum.
  let totalDisplayMode: 'race-total' | 'stations-sum' = 'stations-sum';

  function refreshTotalDisplay(): void {
    const display = document.getElementById('hx-total-display');
    const hint = document.getElementById('hx-total-hint');
    if (!display || !hint) return;
    if (totalDisplayMode === 'race-total') return; // parsed value, leave as-is
    const splits = (getOnboarding().hyroxPreviousStationSplits ?? {}) as Record<string, number>;
    const values = Object.values(splits);
    if (values.length === 0) {
      display.textContent = '—';
      display.style.color = 'var(--c-faint)';
      hint.textContent = 'Sum of the splits above. Updates as you fill them in.';
      return;
    }
    const sum = values.reduce((a, b) => a + b, 0);
    display.textContent = fmtMmSs(sum);
    display.style.color = 'var(--c-black)';
    hint.textContent = values.length < 8
      ? `Sum of ${values.length} of 8 station splits.`
      : 'Sum of all 8 station splits (work time only — excludes runs and roxzone).';
  }

  function setRaceTotalDisplay(sec: number): void {
    const display = document.getElementById('hx-total-display');
    const hint = document.getElementById('hx-total-hint');
    if (!display || !hint) return;
    totalDisplayMode = 'race-total';
    display.textContent = fmtMmSs(sec);
    display.style.color = 'var(--c-black)';
    hint.textContent = 'Total race time — parsed from your results.';
  }

  document.querySelectorAll<HTMLInputElement>('.hx-split-input').forEach(input => {
    input.addEventListener('change', () => {
      const station = input.getAttribute('data-station') as HyroxStation;
      const raw = input.value.trim();
      const sec = parseTime(raw);
      const current = (getOnboarding().hyroxPreviousStationSplits ?? {}) as Record<string, number>;
      const minSec = STATION_MIN_SEC[station] ?? 0;

      // Manual edits override a parsed race-total — switch back to sum mode so
      // the total reflects what's actually in the form.
      totalDisplayMode = 'stations-sum';

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
        showSplitInputError(input, `That's below the minimum realistic time for this station (${Math.floor(minSec / 60)}:${String(minSec % 60).padStart(2, '0')}). Use mm:ss — e.g. 4:22.`);
        return;
      }

      // NaN — bare digits, garbled text, etc.
      input.value = '';
      showSplitInputError(input, 'Use mm:ss format — e.g. 4:22 for 4 min 22 sec.');
    });
  });

  // Initial render: seed the total from any pre-existing splits in state.
  refreshTotalDisplay();

  // Parse-from-paste button
  document.getElementById('hx-parse-btn')?.addEventListener('click', () => {
    const textarea = document.getElementById('hx-paste-results') as HTMLTextAreaElement | null;
    const status = document.getElementById('hx-parse-status');
    if (!textarea || !status) return;

    const result = parseHyroxResultsText(textarea.value);
    const stationCount = Object.keys(result.stations).length;

    if (stationCount === 0 && result.runPaceSecKm == null) {
      status.style.display = 'block';
      status.textContent = 'No times found. Make sure you selected and copied all text from the result page.';
      return;
    }

    // Populate the individual split inputs
    document.querySelectorAll<HTMLInputElement>('.hx-split-input').forEach(input => {
      const station = input.getAttribute('data-station') as HyroxStation;
      const sec = (result.stations as Record<string, number>)[station];
      if (sec != null) input.value = fmtMmSs(sec);
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

    // Auto-fill the previous finish time field if the parser found a race
    // total. Only overwrite an existing value when the parsed total clearly
    // disagrees — typed-then-pasted should respect the paste.
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
      setRaceTotalDisplay(result.totalRaceSec);
    } else {
      // No parsed race total — show sum of the stations we just filled in.
      totalDisplayMode = 'stations-sum';
    }

    updateOnboarding(patch);
    refreshTotalDisplay();

    const parts: string[] = [];
    if (stationCount > 0) parts.push(`${stationCount} of 8 station times`);
    if (result.runPaceSecKm != null) parts.push(`run pace ${fmtMmSs(result.runPaceSecKm)}/km`);
    status.style.display = 'block';
    status.textContent = `Found: ${parts.join(', ')}.`;
  });

  // Race event picker — also controls visibility of the manual venue fallback.
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

  // Race date (custom)
  raceDateInput?.addEventListener('change', () => {
    updateOnboarding({ customRaceDate: raceDateInput.value || null });
    syncContinueGate();
  });

  // Manual venue fallback (only used when "Other / enter date manually" is selected).
  const manualVenueSelect = document.getElementById('hx-manual-venue') as HTMLSelectElement | null;
  manualVenueSelect?.addEventListener('change', () => {
    updateOnboarding({ hyroxVenueId: manualVenueSelect.value || undefined });
  });

  // Continue gate: a race date is required so course factors and the training
  // horizon know which race they're aiming at. If a previous time is entered,
  // the format must also be picked — silently defaulting it to the target
  // format mis-classifies doubles times as singles (and vice versa).
  function syncContinueGate(): void {
    const cta = document.getElementById('hx-continue') as HTMLButtonElement | null;
    if (!cta) return;
    const o = getOnboarding();
    const hasDate = !!o.hyroxRaceEventId || !!o.customRaceDate;
    const prevTimeSetWithoutFormat =
      o.previousHyroxTimeSec != null && !o.hyroxPreviousTimeFormat;
    const ok = hasDate && !prevTimeSetWithoutFormat;
    cta.disabled = !ok;
    cta.style.opacity = ok ? '1' : '0.45';
    cta.style.cursor = ok ? 'pointer' : 'not-allowed';
    cta.title = !hasDate
      ? 'Pick a race or set a custom date to continue.'
      : prevTimeSetWithoutFormat
      ? 'Pick the format your previous time was set in.'
      : '';
  }
  syncContinueGate();
  // Re-evaluate the gate whenever the user picks a previous-format pill or
  // edits the previous-time input — both can flip the gate state.
  document.querySelectorAll<HTMLButtonElement>('[data-prev-format]').forEach(btn => {
    btn.addEventListener('click', () => syncContinueGate());
  });
  document.getElementById('hx-prev-time')?.addEventListener('input', () => syncContinueGate());

  // Average split fallback — fills any blank station inputs with the entered
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
    totalDisplayMode = 'stations-sum';
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
    const current = getOnboarding();
    if (!current.hyroxRaceEventId && !current.customRaceDate) return; // gated by syncContinueGate
    const patch: Partial<OnboardingState> = {};
    if (!current.hyroxFormat) patch.hyroxFormat = 'open_singles';
    if (current.triTimeAvailableHoursPerWeek === undefined) {
      const prevSec = current.previousHyroxTimeSec;
      const band = prevSec != null ? bandFromTime(prevSec) : 'novice';
      patch.triTimeAvailableHoursPerWeek = HYROX_HOURS_RANGE[band].default;
    }
    if (current.hyroxSledAccess === undefined) patch.hyroxSledAccess = 'always';
    if (current.hyroxHasSkiErg === undefined) patch.hyroxHasSkiErg = true;
    if (current.hyroxHasRowErg === undefined) patch.hyroxHasRowErg = true;
    // Plan length follows the picked race date when available, falling back to
    // the band default otherwise. Mirrors the triathlon setup pattern in
    // `triathlon-setup.ts:408` so HYROX users see "Week 1 of N" matching the
    // weeks-until-race countdown rather than a band default that can outrun
    // the actual race.
    const prevSec = current.previousHyroxTimeSec;
    const band = prevSec != null ? bandFromTime(prevSec) : 'novice';
    const raceDateIso = current.customRaceDate;
    patch.planDurationWeeks = raceDateIso
      ? Math.max(1, calculateWeeksUntil(raceDateIso))
      : HYROX_DEFAULT_PLAN_WEEKS[band];
    patch.trainingForEvent = true;
    if (Object.keys(patch).length > 0) updateOnboarding(patch);
    nextStep();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOnboarding(): OnboardingState {
  return getState().onboarding as OnboardingState;
}

/**
 * Parses station split times from free-form text copied from hyrox.com results.
 * Strategy: find each station name, then grab the first mm:ss within 200 chars after it.
 * Handles variations: "SkiErg" / "Ski Erg" / "Ski-Erg", "Rowing" / "Row Erg", etc.
 */
function parseHyroxResultsText(text: string): {
  stations: Partial<Record<HyroxStation, number>>;
  runPaceSecKm?: number;
  /** "Total time" parsed from the export, in seconds. Used for sanity-check display. */
  totalRaceSec?: number;
} {
  const STATION_PATTERNS: Array<{ pattern: RegExp; station: HyroxStation }> = [
    { pattern: /ski[\s-]*erg/i,              station: 'ski_erg' },
    { pattern: /sled\s+push/i,               station: 'sled_push' },
    { pattern: /sled\s+pull/i,               station: 'sled_pull' },
    { pattern: /burpee/i,                    station: 'burpee_broad_jumps' },
    { pattern: /\brow(?:ing|\s*erg)?\b/i,     station: 'row_erg' },
    { pattern: /farmers?[\s']*\s*carry/i,    station: 'farmer_carry' },
    { pattern: /sandbag/i,                   station: 'sandbag_lunges' },
    { pattern: /wall[\s-]*ball/i,            station: 'wall_balls' },
  ];

  /**
   * Extract time in seconds from a short string window.
   * Handles both h:mm:ss (e.g. 00:02:56 from hyrox.com) and mm:ss.
   * h:mm:ss is tried first so "00:02:56" yields 176s not 2s.
   */
  function extractTimeSec(window: string): number | null {
    // h:mm:ss (hyrox.com format: 00:mm:ss)
    const longM = /\b(\d+):(\d{2}):(\d{2})\b/.exec(window);
    if (longM) {
      const h = Number(longM[1]), m = Number(longM[2]), s = Number(longM[3]);
      if (s < 60 && m < 60) return h * 3600 + m * 60 + s;
    }
    // mm:ss fallback
    const shortM = /\b(\d{1,2}):(\d{2})\b/.exec(window);
    if (shortM) {
      const m = Number(shortM[1]), s = Number(shortM[2]);
      if (s < 60 && m <= 30) return m * 60 + s;
    }
    return null;
  }

  const stations: Partial<Record<HyroxStation, number>> = {};

  // ── Strategy 1: "Station In / Station Out" timestamp-pair format ─────────
  // Hyrox timing-system export. Each station has two lines, each with multiple
  // columns (Time of Day, cumulative race time, diff):
  //   "SkiErg In   10:43:16  03:08  0:14"
  //   "SkiErg Out  10:47:03  06:56  03:48"
  // Duration = (Out time of day) − (In time of day). The first time on each
  // line is used; cumulative and diff columns are ignored. Any consistent
  // HH:MM:SS or MM:SS scheme works because subtraction cancels the offset.
  //
  // Wall Balls has no "Out" line in the export (it's the last station); we
  // fall back to the "Total time" timestamp for its duration.
  //
  // Labels can be multi-word ("Burpee Broad Jump", "Sandbag Lunges",
  // "Wall Balls"), so we collect events independently rather than pairing
  // them with a single regex.
  const stationEvents = new Map<HyroxStation, { in?: number; out?: number }>();
  const EVENT_RE = /^[ \t]*(.+?)\s+(In|Out)\b[ \t]+(\d{1,2}:\d{2}(?::\d{2})?)/gim;
  let evMatch: RegExpExecArray | null;
  while ((evMatch = EVENT_RE.exec(text)) !== null) {
    const label = evMatch[1].trim();
    const kind = evMatch[2].toLowerCase() as 'in' | 'out';
    const sec = parseTime(evMatch[3]);
    if (isNaN(sec)) continue;
    const matched = STATION_PATTERNS.find(({ pattern }) => pattern.test(label));
    if (!matched) continue; // skips Roxzone In/Out and any other non-station label
    const ev = stationEvents.get(matched.station) ?? {};
    if (kind === 'in' && ev.in == null) ev.in = sec;
    else if (kind === 'out' && ev.out == null) ev.out = sec;
    stationEvents.set(matched.station, ev);
  }

  // The "Total time" line carries up to three distinct numbers in the
  // timing-system export:
  //   "Total time   11:40:50   1:00:43   03:48"
  //                 time-of-day cumulative diff
  // We need BOTH:
  //   - cumulative race duration → for `totalRaceSec` display (1:00:43)
  //   - time-of-day at finish    → to compute Wall Balls duration when the
  //                                 export omits a "Wall Balls Out" line
  //                                 (we subtract Wall-Balls-In time-of-day
  //                                 from finish time-of-day).
  let totalSec: number | null = null;
  let totalEndTimeOfDay: number | null = null;
  const totalLineMatch = /total\s*time([^\n]+)/i.exec(text);
  if (totalLineMatch) {
    const candidates: number[] = [];
    const timeRe = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g;
    let tm: RegExpExecArray | null;
    while ((tm = timeRe.exec(totalLineMatch[1])) !== null) {
      const a = Number(tm[1]), b = Number(tm[2]), c = tm[3] != null ? Number(tm[3]) : null;
      const sec = c == null ? a * 60 + b : a * 3600 + b * 60 + c;
      if (!isNaN(sec) && sec > 0) candidates.push(sec);
    }
    // Cumulative race duration: realistic Hyrox window (10 min – 4 h).
    const inWindow = candidates.filter(s => s >= 600 && s <= 14400);
    if (inWindow.length > 0) totalSec = Math.min(...inWindow);
    else if (candidates.length > 0) totalSec = candidates[0];
    // Time-of-day timestamp: the largest value, only kept if it lands above
    // any station "In" time-of-day we collected (i.e. it's plausibly later
    // in the day on the same race clock).
    if (candidates.length > 0) {
      const maxIn = Math.max(0, ...Array.from(stationEvents.values()).map(e => e.in ?? 0));
      const todCandidates = candidates.filter(s => s > maxIn);
      if (todCandidates.length > 0) totalEndTimeOfDay = Math.max(...todCandidates);
    }
  }

  // Hard sanity ceiling: no Hyrox station takes more than 25 min in any
  // realistic finish. Anything above is almost certainly a time-of-day
  // timestamp leaking through (root cause of the 11:37:02 = 41822s bug
  // on Wall Balls when the parser fell through to Strategy 2).
  const STATION_MAX_SEC = 1500;

  for (const [station, ev] of stationEvents) {
    if (ev.in == null) continue;
    let outSec = ev.out;
    // Wall-Balls fallback: use the finish time-of-day, not the cumulative
    // race duration. Both `ev.in` and `totalEndTimeOfDay` are time-of-day,
    // so subtraction yields the station duration directly.
    if (outSec == null && totalEndTimeOfDay != null && totalEndTimeOfDay > ev.in) {
      outSec = totalEndTimeOfDay;
    }
    if (outSec == null || outSec <= ev.in) continue;
    const dur = outSec - ev.in;
    const minSec = STATION_MIN_SEC[station];
    if (dur >= minSec && dur <= STATION_MAX_SEC) stations[station] = dur;
  }

  // ── Strategy 2: "Station Name  time" single-value format ─────────────────
  for (const { pattern, station } of STATION_PATTERNS) {
    if (station in stations) continue; // already resolved by In/Out strategy
    const nameMatch = pattern.exec(text);
    if (!nameMatch) continue;

    const after = text.slice(nameMatch.index + nameMatch[0].length, nameMatch.index + nameMatch[0].length + 300);
    const sec = extractTimeSec(after);
    if (sec == null) continue;

    // Enforce physical bounds. The upper bound is critical: previously a
    // time-of-day value (e.g. 11:37:02 → 41822s) would slip through and
    // poison the prediction with a 12-hour station total.
    const minSec = STATION_MIN_SEC[station];
    if (sec < minSec || sec > STATION_MAX_SEC) continue;

    stations[station] = sec;
  }

  // Parse run leg times: lines like "Running 1  00:03:22" or "Run 1  3:22"
  // Average all found run legs to derive a 1km pace.
  const runLegTimes: number[] = [];
  const RUN_LINE_RE = /\brun(?:ning)?\s+\d+\b/gi;
  let runMatch: RegExpExecArray | null;
  while ((runMatch = RUN_LINE_RE.exec(text)) !== null) {
    const after = text.slice(runMatch.index + runMatch[0].length, runMatch.index + runMatch[0].length + 60);
    const sec = extractTimeSec(after);
    if (sec != null && sec >= HYROX_RUN_PACE_MIN_SEC_KM && sec <= 720) { // 3:10–12:00/km
      runLegTimes.push(sec);
    }
  }

  let runPaceSecKm: number | undefined;
  if (runLegTimes.length > 0) {
    runPaceSecKm = Math.round(runLegTimes.reduce((s, v) => s + v, 0) / runLegTimes.length);
  }

  // Fallback 1: "Run Total" / "Running Total" → divide by 8 legs to get per-km pace
  if (runPaceSecKm == null) {
    const runTotalMatch = /\brun(?:ning)?\s+total\b/i.exec(text);
    if (runTotalMatch) {
      const after = text.slice(runTotalMatch.index + runTotalMatch[0].length, runTotalMatch.index + runTotalMatch[0].length + 80);
      const sec = extractTimeSec(after);
      if (sec != null) {
        const perLeg = Math.round(sec / 8);
        if (perLeg >= HYROX_RUN_PACE_MIN_SEC_KM && perLeg <= 720) runPaceSecKm = perLeg;
      }
    }
  }

  // Fallback 2: "Best Run Lap" / "Best Run" → fastest 1km lap = best pace achieved
  if (runPaceSecKm == null) {
    const bestMatch = /\bbest\s+run(?:\s+lap)?\b/i.exec(text);
    if (bestMatch) {
      const after = text.slice(bestMatch.index + bestMatch[0].length, bestMatch.index + bestMatch[0].length + 60);
      const sec = extractTimeSec(after);
      if (sec != null && sec >= HYROX_RUN_PACE_MIN_SEC_KM && sec <= 720) {
        // Best lap is fastest, so average pace is ~5% slower
        runPaceSecKm = Math.round(sec * 1.05);
      }
    }
  }

  return { stations, runPaceSecKm, totalRaceSec: totalSec ?? undefined };
}
