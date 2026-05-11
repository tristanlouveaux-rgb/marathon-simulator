import type { OnboardingState } from '@/types/onboarding';
import type { TriathlonDistance, TriVolumeSplit } from '@/types/triathlon';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { getState } from '@/state/store';
import {
  DEFAULT_VOLUME_SPLIT,
  DEFAULT_WEEKLY_PEAK_HOURS,
  PLAN_WEEKS_DEFAULT,
  RACE_LEG_DISTANCES,
  HOURS_RANGE,
} from '@/constants/triathlon-constants';
import { getTriathlonsByDistance, getTriathlonById } from '@/data/triathlons';
import { formatRaceDate, calculateWeeksUntil, formatTimeUntil } from '@/data/marathons';
import type { Triathlon } from '@/types/onboarding';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';

/**
 * Triathlon setup — the single consolidated step that replaces
 * race-target + schedule + runner-type for triathlon users.
 *
 * Collects everything the triathlon plan engine needs (§18.9):
 *   - distance (70.3 / IM)
 *   - race date (optional)
 *   - weekly time available
 *   - volume split across swim/bike/run
 *   - (legacy) self-rating slider per discipline — removed in favour of
 *     benchmark-derived tier (CSS / FTP+W/kg / VDOT). The state field
 *     `triSkillRating` remains as a fallback only.
 *   - bike FTP + has-power-meter flag
 *   - swim CSS (direct) OR 400m test time (derived)
 *
 * Form is one long scrollable card rather than five sub-steps so the user
 * can skim the entire setup at once and spot anything they're not sure
 * about before hitting continue.
 */
export function renderTriathlonSetup(container: HTMLElement, state: OnboardingState): void {
  const distance: TriathlonDistance = state.triDistance ?? '70.3';
  const defaultHours = DEFAULT_WEEKLY_PEAK_HOURS[distance][3];
  const hoursPerWeek = state.triTimeAvailableHoursPerWeek ?? defaultHours;
  const split: TriVolumeSplit = state.triVolumeSplit ?? { ...DEFAULT_VOLUME_SPLIT };
  const raceDate = state.customRaceDate ?? '';
  const gymSessions = state.gymSessionsPerWeek ?? 0;
  const hoursRange = HOURS_RANGE[distance];
  // Default weekday share: ~40% of total on Mon–Fri, leaving ~60% for the
  // weekend. Fits a 9-to-5 lifestyle where long sessions land Sat/Sun.
  const defaultWeekdayHours = Math.round(hoursPerWeek * 0.4 * 2) / 2;  // nearest 0.5h
  const weekdayHours = state.triWeekdayHoursPerWeek ?? defaultWeekdayHours;
  const weekendHours = Math.max(0, hoursPerWeek - weekdayHours);

  container.innerHTML = `
    <style>
      @keyframes tRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .t-rise { opacity:0; animation: tRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .tri-card { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:18px; margin-bottom:14px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.3); }
      .tri-label { font-size:13px; color:var(--c-muted); letter-spacing:0.01em; margin:0 0 10px; text-transform:uppercase; font-weight:500; }
      .tri-pill-row { display:flex; gap:8px; flex-wrap:wrap; }
      .tri-pill { flex:1; min-width:120px; padding:12px 14px; border-radius:12px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.9); font-size:14px; color:var(--c-black); cursor:pointer; text-align:left; transition: all 0.15s ease; }
      .tri-pill.active { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }
      .tri-pill .tri-pill-sub { display:block; font-size:11px; opacity:0.65; margin-top:2px; }
      /* Single sliders use the canonical .m-slider-glass class from styles.css. */
      .tri-row { display:flex; justify-content:space-between; align-items:baseline; font-size:13px; color:var(--c-black); }
      .tri-row .tri-value { font-size:16px; font-weight:500; font-variant-numeric: tabular-nums; }
      .tri-input { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.08); color:var(--c-black); border-radius:10px; padding:9px 12px; font-size:14px; width:100%; box-sizing:border-box; outline:none; }
      .tri-input:focus { border-color:var(--c-black); }
      .tri-hint { font-size:12px; color:var(--c-faint); margin:6px 0 0; line-height:1.5; }
      .tri-cta { width:100%; padding:14px 20px; height:50px; background:var(--c-black); color:#FDFCF7; border:none; border-radius:25px; font-size:15px; font-weight:500; cursor:pointer; margin-top:8px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
      .tri-cta:disabled { opacity:0.45; cursor:not-allowed; }
      .tri-toggle { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--c-black); cursor:pointer; user-select:none; }
      .tri-toggle input { accent-color: var(--c-black); }
      .tri-split-grid { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
      .tri-split-cell { text-align:center; padding:10px 6px; border-radius:10px; border:1px solid rgba(0,0,0,0.06); background:rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; }
      .tri-split-cell .tri-split-pct { font-size:18px; font-weight:500; }
      .tri-split-cell .tri-split-lbl { font-size:11px; color:var(--c-muted); margin-top:2px; text-transform:uppercase; letter-spacing:0.05em; }
      .tri-split-cell .tri-split-hrs { font-size:11px; color:var(--c-faint); margin-top:3px; }
      .tri-split-bar { position:relative; display:flex; height:10px; border-radius:6px; background:rgba(255,255,255,0.55); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border:1px solid rgba(0,0,0,0.06); user-select:none; touch-action:pan-y; margin:18px 6px 12px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.04); }
      .tri-split-seg { height:100%; transition: width 0.06s linear; }
      .tri-split-seg-swim { background:rgba(0,0,0,0.05); border-radius:6px 0 0 6px; }
      .tri-split-seg-bike { background:rgba(0,0,0,0.10); }
      .tri-split-seg-run  { background:rgba(0,0,0,0.05); border-radius:0 6px 6px 0; }
      .tri-split-handle { position:absolute; top:50%; transform:translate(-50%, -50%); width:22px; height:22px; border-radius:50%; background:rgba(255,255,255,0.7); backdrop-filter:blur(12px) saturate(1.4); -webkit-backdrop-filter:blur(12px) saturate(1.4); border:1px solid rgba(255,255,255,0.8); box-shadow: 0 1px 2px rgba(0,0,0,0.1), 0 4px 12px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.9), inset 0 -1px 0 rgba(0,0,0,0.06); cursor:ew-resize; z-index:2; touch-action:none; transition: transform 120ms ease, box-shadow 120ms ease; }
      .tri-split-handle:active { transform:translate(-50%, -50%) scale(1.08); box-shadow: 0 2px 4px rgba(0,0,0,0.12), 0 6px 18px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.9); }
      .tri-race-list { display:flex; flex-direction:column; gap:8px; max-height:340px; overflow-y:auto; padding-right:4px; }
      .tri-race-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px 13px; border-radius:10px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.9); text-align:left; cursor:pointer; transition:all 0.15s ease; width:100%; }
      .tri-race-row.selected { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }
      .tri-race-row .tri-race-name { font-size:14px; font-weight:500; line-height:1.25; }
      .tri-race-row .tri-race-sub { font-size:12px; opacity:0.7; margin-top:2px; }
      .tri-race-row .tri-race-weeks { font-size:12px; font-weight:600; flex-shrink:0; opacity:0.85; font-variant-numeric: tabular-nums; }
      .tri-toggle-link { background:transparent; border:none; color:var(--c-muted); font-size:13px; cursor:pointer; padding:6px 4px; }
      .tri-toggle-link:hover { color:var(--c-black); }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;display:flex;flex-direction:column">
      <!-- Background: atmosphere → asymmetric (right) rings → mid glint. Mirrors connect-strava. -->
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('tri', { variant: 'asymmetric', side: 'right' })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:36px 20px 140px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(5, 8)}

        <div class="t-rise" style="width:100%;max-width:480px;text-align:center;margin-bottom:20px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.5rem,5vw,1.9rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 6px;line-height:1.15">
            Triathlon setup
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">Everything we need to build your plan.</p>
        </div>

        <div style="width:100%;max-width:480px">
          <!-- Distance -->
          <div class="tri-card t-rise" style="animation-delay:0.1s">
            <div class="tri-label">Race distance</div>
            <div class="tri-pill-row">
              <button class="tri-pill ${distance === '70.3' ? 'active' : ''}" data-distance="70.3">
                70.3 (Half)
                <span class="tri-pill-sub">1.9 km / 90 km / 21.1 km</span>
              </button>
              <button class="tri-pill ${distance === 'ironman' ? 'active' : ''}" data-distance="ironman">
                Ironman
                <span class="tri-pill-sub">3.8 km / 180 km / 42.2 km</span>
              </button>
            </div>
            <p class="tri-hint" id="tri-plan-length-hint">Default plan length: ${PLAN_WEEKS_DEFAULT[distance]} weeks</p>
          </div>

          <!-- Race picker -->
          <div class="tri-card t-rise" id="tri-race-card" style="animation-delay:0.14s">
            ${renderRacePicker(state, distance)}
          </div>

          <!-- Time available -->
          <div class="tri-card t-rise" style="animation-delay:0.18s">
            <div class="tri-label">Time available per week</div>
            <div class="tri-row">
              <span>Peak weekly hours</span>
              <span class="tri-value" id="tri-hours-value">${hoursPerWeek}h</span>
            </div>
            <input type="range" min="${hoursRange.min}" max="${hoursRange.max}" step="1" value="${hoursPerWeek}" class="m-slider-glass" id="tri-hours">
            <p class="tri-hint" id="tri-hours-hint">${hoursCommentary(distance, hoursPerWeek)}</p>

            <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(0,0,0,0.06)">
              <div class="tri-row" style="margin-bottom:6px">
                <span style="font-size:13px;color:var(--c-black)">Mon–Fri split</span>
                <span class="tri-value" id="tri-weekday-value">${weekdayHours}h weekday / ${weekendHours.toFixed(1)}h weekend</span>
              </div>
              <input type="range" min="0" max="${hoursPerWeek}" step="0.5" value="${weekdayHours}" class="m-slider-glass" id="tri-weekday">
              <p class="tri-hint">How much of the week's training fits into weekdays. Long bike + long run always land Sat/Sun. If you work a 9-to-5, keeping weekdays short and piling the weekend is a good default.</p>
            </div>
          </div>

          <!-- Volume split -->
          <div class="tri-card t-rise" style="animation-delay:0.22s">
            <div class="tri-label">Volume split</div>
            <p class="tri-hint" style="margin:-4px 0 12px">Recommended default shown. Drag the dividers to emphasise a discipline.</p>
            <div class="tri-split-grid" id="tri-split-grid">
              ${renderSplitCells(split, hoursPerWeek)}
            </div>
            <div class="tri-split-bar" id="tri-split-bar" role="group" aria-label="Volume split between swim, bike and run">
              <div class="tri-split-seg tri-split-seg-swim" data-seg="swim" style="width:${(split.swim * 100).toFixed(2)}%"></div>
              <div class="tri-split-seg tri-split-seg-bike" data-seg="bike" style="width:${(split.bike * 100).toFixed(2)}%"></div>
              <div class="tri-split-seg tri-split-seg-run"  data-seg="run"  style="width:${(split.run  * 100).toFixed(2)}%"></div>
              <div class="tri-split-handle" data-handle="swim-bike" role="slider" aria-label="Swim/bike divider" aria-valuemin="5" aria-valuemax="40" aria-valuenow="${Math.round(split.swim * 100)}" tabindex="0" style="left:${(split.swim * 100).toFixed(2)}%"></div>
              <div class="tri-split-handle" data-handle="bike-run"  role="slider" aria-label="Bike/run divider"  aria-valuemin="40" aria-valuemax="85" aria-valuenow="${Math.round((split.swim + split.bike) * 100)}" tabindex="0" style="left:${((split.swim + split.bike) * 100).toFixed(2)}%"></div>
            </div>
          </div>

          <!-- Gym -->
          <div class="tri-card t-rise" style="animation-delay:0.38s">
            <div class="tri-label">Strength work</div>
            <div class="tri-row" style="margin-bottom:4px">
              <span>Strength sessions per week</span>
              <span class="tri-value" id="tri-gym-value">${gymSessions}</span>
            </div>
            <input type="range" min="0" max="3" step="1" value="${gymSessions}" class="m-slider-glass" id="tri-gym">
            <p class="tri-hint">Optional. 1–2 sessions/week of full-body strength helps running economy and injury resilience but isn't required. Set to 0 to skip.</p>
          </div>

          <!-- CTA -->
          <div style="margin-top:6px">
            <p id="tri-continue-hint" class="tri-hint" style="text-align:center;margin:0 0 8px;display:none">Pick a race or enter a date to continue.</p>
            <button id="tri-continue" class="tri-cta">Continue</button>
          </div>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers();
  refreshContinueGate();
  void state;
}

/**
 * Triathlon plan generation requires a target date — without it the engine has
 * nothing to schedule against. Disable the CTA until the user has either
 * picked a race or entered a custom date. Re-runs after every state change
 * that could affect either field.
 */
function refreshContinueGate(): void {
  const cta = document.getElementById('tri-continue') as HTMLButtonElement | null;
  const hint = document.getElementById('tri-continue-hint') as HTMLElement | null;
  if (!cta) return;
  const current = getCurrentOnboarding();
  const hasDate = !!current.selectedTriathlonId || !!current.customRaceDate;
  cta.disabled = !hasDate;
  if (hint) hint.style.display = hasDate ? 'none' : 'block';
}

function renderRacePicker(state: OnboardingState, distance: TriathlonDistance): string {
  const races = getTriathlonsByDistance(distance, 0);
  const selectedId = state.selectedTriathlonId ?? null;
  const usingCustomDate = !selectedId && !!state.customRaceDate;
  const showCustom = usingCustomDate || races.length === 0;

  const headingLabel = distance === 'ironman' ? 'Pick your Ironman' : 'Pick your 70.3';

  if (showCustom) {
    return `
      <div class="tri-label">Race date <span style="text-transform:none;font-weight:400;color:var(--c-faint)">(optional)</span></div>
      <input type="date" id="tri-race-date" class="tri-input" value="${state.customRaceDate ?? ''}">
      <p class="tri-hint">Leave blank to start the standard ${PLAN_WEEKS_DEFAULT[distance]}-week plan from this week.</p>
      ${races.length === 0 ? '' : `
        <div style="text-align:center;margin-top:10px">
          <button id="tri-toggle-picker" class="tri-toggle-link">Browse races instead</button>
        </div>
      `}
    `;
  }

  return `
    <div class="tri-label">${headingLabel}</div>
    <div class="tri-race-list">
      ${races.map((race) => {
        const selected = selectedId === race.id;
        return `
          <button class="tri-race-row ${selected ? 'selected' : ''}" data-race-id="${race.id}">
            <div style="min-width:0">
              <div class="tri-race-name">${race.name}</div>
              <div class="tri-race-sub">${formatRaceDate(race.date)} · ${race.city}, ${race.country}</div>
              ${race.profile?.notes ? `<div class="tri-race-sub" style="margin-top:4px">${race.profile.notes}</div>` : ''}
            </div>
            <span class="tri-race-weeks">${formatTimeUntil(race.date) ?? '--'}</span>
          </button>
        `;
      }).join('')}
    </div>
    <div style="text-align:center;margin-top:10px">
      <button id="tri-toggle-picker" class="tri-toggle-link">Enter a custom date instead</button>
    </div>
  `;
}

function rerenderRaceCard(): void {
  const card = document.getElementById('tri-race-card');
  if (!card) return;
  const current = getCurrentOnboarding();
  card.innerHTML = renderRacePicker(current, current.triDistance ?? '70.3');
  wireRaceCardHandlers();
  refreshContinueGate();
}

function renderSplitCells(split: TriVolumeSplit, totalHours: number): string {
  const cells: Array<[keyof TriVolumeSplit, string]> = [
    ['swim', 'Swim'],
    ['bike', 'Bike'],
    ['run', 'Run'],
  ];
  return cells.map(([key, label]) => `
    <div class="tri-split-cell">
      <div class="tri-split-pct" data-pct="${key}">${Math.round(split[key] * 100)}%</div>
      <div class="tri-split-lbl">${label}</div>
      <div class="tri-split-hrs" data-hrs="${key}">${(split[key] * totalHours).toFixed(1)}h</div>
    </div>
  `).join('');
}

// ──────────────────────────────────────────────────────────────────────────
// Wiring
// ──────────────────────────────────────────────────────────────────────────

function wireEventHandlers(): void {
  // Distance pills — toggle + refresh every dependent field
  document.querySelectorAll<HTMLButtonElement>('[data-distance]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-distance') as TriathlonDistance;
      updateOnboarding({ triDistance: value });
      document.querySelectorAll<HTMLButtonElement>('[data-distance]').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-distance') === value);
      });

      // Update default plan length text
      const planLenHint = document.getElementById('tri-plan-length-hint');
      if (planLenHint) planLenHint.textContent = `Default plan length: ${PLAN_WEEKS_DEFAULT[value]} weeks`;

      // Distance changed — clear any selected race that's now in the wrong category and re-render the picker.
      const current = getCurrentOnboarding();
      if (current.selectedTriathlonId) {
        const sel = getTriathlonById(current.selectedTriathlonId);
        if (!sel || sel.distance !== value) {
          updateOnboarding({ selectedTriathlonId: null, customRaceDate: null });
        }
      }
      rerenderRaceCard();

      // Rescope the hours slider min/max to the new distance
      const newRange = HOURS_RANGE[value];
      const hoursEl = document.getElementById('tri-hours') as HTMLInputElement | null;
      if (hoursEl) {
        const current = Number(hoursEl.value);
        hoursEl.min = String(newRange.min);
        hoursEl.max = String(newRange.max);
        const clamped = Math.min(newRange.max, Math.max(newRange.min, current));
        if (clamped !== current) {
          hoursEl.value = String(clamped);
          const hv = document.getElementById('tri-hours-value');
          if (hv) hv.textContent = `${clamped}h`;
          updateOnboarding({ triTimeAvailableHoursPerWeek: clamped });
        }
        // Refresh commentary against new distance + (possibly clamped) hours
        const hint = document.getElementById('tri-hours-hint');
        if (hint) hint.innerHTML = hoursCommentary(value, Number(hoursEl.value));
      }
    });
  });

  // Race picker (race-list rows + custom date toggle + custom date input)
  wireRaceCardHandlers();

  // Hours slider
  const hoursInput = document.getElementById('tri-hours') as HTMLInputElement | null;
  const hoursValue = document.getElementById('tri-hours-value');
  hoursInput?.addEventListener('input', () => {
    const h = Number(hoursInput.value);
    if (hoursValue) hoursValue.textContent = `${h}h`;
    updateOnboarding({ triTimeAvailableHoursPerWeek: h });
    const hint = document.getElementById('tri-hours-hint');
    if (hint) hint.innerHTML = hoursCommentary(getCurrentOnboarding().triDistance ?? '70.3', h);
    // Clamp weekday slider max to new total, scale weekday hours proportionally.
    const weekdaySlider = document.getElementById('tri-weekday') as HTMLInputElement | null;
    if (weekdaySlider) {
      const current = Number(weekdaySlider.value);
      const prevMax = Number(weekdaySlider.max) || h;
      weekdaySlider.max = String(h);
      const scaled = prevMax > 0 ? Math.min(h, Math.round((current / prevMax) * h * 2) / 2) : h * 0.4;
      weekdaySlider.value = String(scaled);
      updateWeekdayLabel(scaled, h);
      updateOnboarding({ triWeekdayHoursPerWeek: scaled });
    }
    refreshSplitCells();
  });

  // Weekday/weekend split slider
  const weekdayInput = document.getElementById('tri-weekday') as HTMLInputElement | null;
  weekdayInput?.addEventListener('input', () => {
    const wd = Number(weekdayInput.value);
    const total = Number(hoursInput?.value ?? getCurrentOnboarding().triTimeAvailableHoursPerWeek ?? 10);
    updateWeekdayLabel(wd, total);
    updateOnboarding({ triWeekdayHoursPerWeek: wd });
  });

  // Split bar — drag the swim|bike and bike|run dividers
  wireSplitBarHandlers();

  // Gym sessions slider
  const gymInput = document.getElementById('tri-gym') as HTMLInputElement | null;
  const gymValue = document.getElementById('tri-gym-value');
  gymInput?.addEventListener('input', () => {
    const v = Number(gymInput.value);
    if (gymValue) gymValue.textContent = String(v);
    updateOnboarding({ gymSessionsPerWeek: v });
  });

  // Continue CTA
  document.getElementById('tri-continue')?.addEventListener('click', () => {
    const guard = getCurrentOnboarding();
    if (!guard.selectedTriathlonId && !guard.customRaceDate) {
      refreshContinueGate();
      return;
    }
    // Ensure all defaults are saved before leaving (volumeSplit is already saved
    // on slider change, but if the user never touched them, persist defaults).
    const current = getCurrentOnboarding();
    const finalPatch: Partial<OnboardingState> = {};
    if (!current.triVolumeSplit) finalPatch.triVolumeSplit = { ...DEFAULT_VOLUME_SPLIT };
    if (!current.triSkillRating) finalPatch.triSkillRating = { swim: 3, bike: 3, run: 3 };
    if (!current.triTimeAvailableHoursPerWeek) {
      const d = current.triDistance ?? '70.3';
      const avg = current.triSkillRating
        ? (Math.round((current.triSkillRating.swim + current.triSkillRating.bike + current.triSkillRating.run) / 3) as 1 | 2 | 3 | 4 | 5)
        : 3;
      finalPatch.triTimeAvailableHoursPerWeek = DEFAULT_WEEKLY_PEAK_HOURS[d][avg];
    }
    // Default weekday hours to 40% of total if the user never touched the slider.
    const totalH = current.triTimeAvailableHoursPerWeek ?? finalPatch.triTimeAvailableHoursPerWeek ?? 10;
    if (current.triWeekdayHoursPerWeek === undefined) {
      finalPatch.triWeekdayHoursPerWeek = Math.round(totalH * 0.4 * 2) / 2;
    }
    if (!current.triDistance) finalPatch.triDistance = '70.3';
    // Plan length follows the actual race date when one is picked, so a race
    // 6 weeks out produces a 6-week plan rather than the 20/24-week distance
    // default. The default is only used when no date is set.
    const distanceForDefault = current.triDistance ?? finalPatch.triDistance ?? '70.3';
    const raceDateIso = current.customRaceDate ?? null;
    finalPatch.planDurationWeeks = raceDateIso
      ? Math.max(1, calculateWeeksUntil(raceDateIso))
      : PLAN_WEEKS_DEFAULT[distanceForDefault];
    // Anchor trainingForEvent = true. Triathlon is always race-mode (§18.10).
    finalPatch.trainingForEvent = true;
    if (Object.keys(finalPatch).length > 0) updateOnboarding(finalPatch);
    nextStep();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function getCurrentOnboarding(): OnboardingState {
  return getState().onboarding as OnboardingState;
}

function wireRaceCardHandlers(): void {
  // Race row → select race + auto-fill customRaceDate. Selection updates the
  // .selected class in place (rather than re-rendering the card) so the list
  // doesn't flicker or jump scroll position when the user picks a race.
  document.querySelectorAll<HTMLButtonElement>('[data-race-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-race-id') ?? '';
      const race: Triathlon | undefined = getTriathlonById(id);
      if (!race) return;
      const current = getCurrentOnboarding();
      const sameRace = current.selectedTriathlonId === race.id;
      if (sameRace) {
        updateOnboarding({ selectedTriathlonId: null, customRaceDate: null });
        btn.classList.remove('selected');
      } else {
        updateOnboarding({ selectedTriathlonId: race.id, customRaceDate: race.date });
        document.querySelectorAll<HTMLButtonElement>('[data-race-id]').forEach((b) => {
          b.classList.toggle('selected', b === btn);
        });
      }
      refreshContinueGate();
    });
  });

  // Toggle between race list and custom date input
  document.getElementById('tri-toggle-picker')?.addEventListener('click', () => {
    const current = getCurrentOnboarding();
    const usingCustom = !current.selectedTriathlonId && !!current.customRaceDate;
    if (usingCustom) {
      // Was on custom → switch back to list
      updateOnboarding({ customRaceDate: null });
    } else {
      // Was on list → switch to custom (clear selection, keep any picked date as starting value)
      const keptDate = current.selectedTriathlonId ? current.customRaceDate : null;
      updateOnboarding({ selectedTriathlonId: null, customRaceDate: keptDate });
      // Force custom mode by setting a non-null sentinel only if user has nothing — handled by render.
    }
    // If switching to custom and nothing prior, show empty input. The render checks for selection
    // first; without selection and without a date, it shows the list. Force custom view explicitly:
    rerenderRaceCardForceMode(usingCustom ? 'list' : 'custom');
  });

  // Custom date input
  const dateInput = document.getElementById('tri-race-date') as HTMLInputElement | null;
  dateInput?.addEventListener('change', () => {
    updateOnboarding({ customRaceDate: dateInput.value || null, selectedTriathlonId: null });
    refreshContinueGate();
  });
}

/**
 * Like rerenderRaceCard but lets the caller force "custom date input" mode even when
 * customRaceDate is null (i.e. the user just clicked "Enter a custom date instead" with
 * no date set yet). Stays in custom mode until the user clicks the toggle back.
 */
let _forceMode: 'list' | 'custom' | null = null;
function rerenderRaceCardForceMode(mode: 'list' | 'custom'): void {
  _forceMode = mode;
  const card = document.getElementById('tri-race-card');
  if (!card) return;
  const current = getCurrentOnboarding();
  const distance = current.triDistance ?? '70.3';
  if (mode === 'custom') {
    card.innerHTML = `
      <div class="tri-label">Race date <span style="text-transform:none;font-weight:400;color:var(--c-faint)">(optional)</span></div>
      <input type="date" id="tri-race-date" class="tri-input" value="${current.customRaceDate ?? ''}">
      <p class="tri-hint">Leave blank to start the standard ${PLAN_WEEKS_DEFAULT[distance]}-week plan from this week.</p>
      <div style="text-align:center;margin-top:10px">
        <button id="tri-toggle-picker" class="tri-toggle-link">Browse races instead</button>
      </div>
    `;
  } else {
    card.innerHTML = renderRacePicker(current, distance);
  }
  wireRaceCardHandlers();
  refreshContinueGate();
}
void _forceMode;

// Hard limits for each leg's share of weekly volume. Same bounds as the
// previous slider min/max — they keep the user from picking a split that the
// plan engine can't honour (e.g. 70% swim).
const SPLIT_BOUNDS = {
  swim: { min: 5, max: 40 },
  bike: { min: 20, max: 70 },
  run: { min: 15, max: 60 },
} as const;

/**
 * Single horizontal bar with two draggable dividers replaces the three
 * independent sliders. Mental model: dragging the swim|bike divider resizes
 * swim vs bike while run stays fixed; dragging the bike|run divider resizes
 * bike vs run while swim stays fixed. Constraints below clamp each handle so
 * all three legs stay inside SPLIT_BOUNDS.
 */
function wireSplitBarHandlers(): void {
  const bar = document.getElementById('tri-split-bar');
  if (!bar) return;

  const handles = bar.querySelectorAll<HTMLElement>('[data-handle]');
  handles.forEach((handle) => {
    handle.addEventListener('pointerdown', (ev) => onSplitHandlePointerDown(ev, handle, bar));
    handle.addEventListener('keydown', (ev) => onSplitHandleKeyDown(ev, handle));
  });
}

function onSplitHandlePointerDown(ev: PointerEvent, handle: HTMLElement, bar: HTMLElement): void {
  ev.preventDefault();
  handle.setPointerCapture(ev.pointerId);

  const which = handle.getAttribute('data-handle') as 'swim-bike' | 'bike-run';

  const move = (e: PointerEvent) => {
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    const pct = Math.max(0, Math.min(100, ratio * 100));
    applySplitFromHandle(which, pct);
  };
  const up = (e: PointerEvent) => {
    handle.releasePointerCapture(e.pointerId);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

function onSplitHandleKeyDown(ev: KeyboardEvent, handle: HTMLElement): void {
  const step = ev.shiftKey ? 5 : 1;
  let delta = 0;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') delta = -step;
  else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') delta = step;
  else return;
  ev.preventDefault();

  const which = handle.getAttribute('data-handle') as 'swim-bike' | 'bike-run';
  const current = Number(handle.getAttribute('aria-valuenow') ?? '0');
  applySplitFromHandle(which, current + delta);
}

function applySplitFromHandle(which: 'swim-bike' | 'bike-run', pctRaw: number): void {
  const onb = getCurrentOnboarding();
  const split = { ...(onb.triVolumeSplit ?? DEFAULT_VOLUME_SPLIT) };
  const swimPct = split.swim * 100;
  const bikePct = split.bike * 100;
  const handle1 = swimPct;                  // swim|bike position
  const handle2 = swimPct + bikePct;        // bike|run position

  let h1 = handle1;
  let h2 = handle2;

  if (which === 'swim-bike') {
    // h1 must respect swim bounds AND keep bike inside its bounds (h2 fixed).
    const lo = Math.max(SPLIT_BOUNDS.swim.min, h2 - SPLIT_BOUNDS.bike.max);
    const hi = Math.min(SPLIT_BOUNDS.swim.max, h2 - SPLIT_BOUNDS.bike.min);
    h1 = Math.max(lo, Math.min(hi, pctRaw));
  } else {
    // h2 must keep run inside its bounds AND bike inside its bounds (h1 fixed).
    const lo = Math.max(h1 + SPLIT_BOUNDS.bike.min, 100 - SPLIT_BOUNDS.run.max);
    const hi = Math.min(h1 + SPLIT_BOUNDS.bike.max, 100 - SPLIT_BOUNDS.run.min);
    h2 = Math.max(lo, Math.min(hi, pctRaw));
  }

  const swim = h1 / 100;
  const bike = (h2 - h1) / 100;
  const run = (100 - h2) / 100;
  const next: TriVolumeSplit = { swim, bike, run };

  updateOnboarding({ triVolumeSplit: next });
  refreshSplitCells();
}

/**
 * Commentary shown under the hours slider. Calibrated against coaching
 * consensus (Friel, Fitzgerald): 70.3 expects ~8–12h at peak for a
 * competitive finish, IM ~12–18h. Anything below that is "just finish"
 * territory; at the bottom edge the user is deliberately under-training
 * and should know.
 */
function hoursCommentary(distance: TriathlonDistance, hours: number): string {
  const base = `This is your peak-week target. Early and recovery weeks will be lighter.`;
  if (distance === '70.3') {
    if (hours < 5) return `${base}<br><span style="color:#c06a50">Minimum viable. At 4h/week the plan is completion-only with no margin for missed sessions. 8–12h/week at peak is the typical competitive range.</span>`;
    if (hours < 7) return `${base}<br><span style="color:#c06a50">Aggressive for 70.3 — this is a "just finish" plan. 8–12h/week at peak is the typical competitive range.</span>`;
    if (hours < 10) return `${base}<br>Realistic for a first 70.3 or a time-constrained athlete.`;
    if (hours < 14) return `${base}<br>Competitive intermediate range. Good balance of volume and recovery.`;
    return `${base}<br>Advanced / podium-target volume. Make sure recovery is matched.`;
  }
  // Ironman
  if (hours < 10) return `${base}<br><span style="color:#c06a50">Very aggressive for full Ironman. Most first-timers need 12h+ at peak to avoid late-race trouble.</span>`;
  if (hours < 14) return `${base}<br>Realistic for a first Ironman, especially with a solid training background.`;
  if (hours < 20) return `${base}<br>Competitive age-grouper range.`;
  return `${base}<br>Elite / KQ-target volume. Recovery and life balance matter more than volume past this point.`;
}


function updateWeekdayLabel(wd: number, total: number): void {
  const label = document.getElementById('tri-weekday-value');
  if (!label) return;
  const we = Math.max(0, total - wd);
  label.textContent = `${wd}h weekday / ${we.toFixed(1)}h weekend`;
}

function refreshSplitCells(): void {
  const current = getCurrentOnboarding();
  const split = current.triVolumeSplit ?? DEFAULT_VOLUME_SPLIT;
  const hours = current.triTimeAvailableHoursPerWeek ?? DEFAULT_WEEKLY_PEAK_HOURS[current.triDistance ?? '70.3'][3];
  (['swim', 'bike', 'run'] as const).forEach((k) => {
    const pct = document.querySelector(`[data-pct="${k}"]`);
    const hrs = document.querySelector(`[data-hrs="${k}"]`);
    if (pct) pct.textContent = `${Math.round(split[k] * 100)}%`;
    if (hrs) hrs.textContent = `${(split[k] * hours).toFixed(1)}h`;
    const seg = document.querySelector<HTMLElement>(`[data-seg="${k}"]`);
    if (seg) seg.style.width = `${(split[k] * 100).toFixed(2)}%`;
  });

  const swimPct = split.swim * 100;
  const handle1 = swimPct;
  const handle2 = swimPct + split.bike * 100;
  const h1 = document.querySelector<HTMLElement>('[data-handle="swim-bike"]');
  const h2 = document.querySelector<HTMLElement>('[data-handle="bike-run"]');
  if (h1) {
    h1.style.left = `${handle1.toFixed(2)}%`;
    h1.setAttribute('aria-valuenow', String(Math.round(handle1)));
  }
  if (h2) {
    h2.style.left = `${handle2.toFixed(2)}%`;
    h2.setAttribute('aria-valuenow', String(Math.round(handle2)));
  }
}

// Keep unused distance helper around for reference until scheduling uses it (§3).
void RACE_LEG_DISTANCES;
