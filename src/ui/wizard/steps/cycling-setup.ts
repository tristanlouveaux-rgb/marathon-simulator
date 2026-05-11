import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { getState } from '@/state/store';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { calculateWeeksUntil } from '@/data/marathons';

/**
 * Cycling setup — V1 single-step config for cycling-only mode.
 *
 * Modelled on triathlon-setup but stripped to a single discipline:
 *   - event distance (100km / 160km / 200km Gran Fondo)
 *   - target date (custom date input — no race database for cycling V1)
 *   - weekly time available (peak hours + weekday split)
 *   - optional strength sessions
 *
 * FTP refinement is handled downstream by plan-preview-v2 (Strava-derived
 * estimate with manual override) so this screen stays focused on scheduling
 * intent rather than benchmarks.
 */

type CyclingDistance = '50km' | '100km' | '160km' | '200km' | '300km';

const DISTANCE_LABELS: Record<CyclingDistance, { headline: string; sub: string }> = {
  '50km':  { headline: '50 km',  sub: 'Short sportive' },
  '100km': { headline: '100 km', sub: 'Standard sportive' },
  '160km': { headline: '160 km', sub: 'Gran Fondo' },
  '200km': { headline: '200 km', sub: 'Audax / long Fondo' },
  '300km': { headline: '300 km', sub: 'Audax randonneur' },
};

// Default weekly peak hours by event distance. Calibrated to coaching consensus
// for amateur Gran Fondo / audax finishers (Friel, *The Cyclist's Training
// Bible*): ~4h for a 50km, ~6h for a 100km, ~10h for a 160km, ~14h for a 200km,
// ~18h for a 300km at peak.
const DEFAULT_HOURS_BY_DISTANCE: Record<CyclingDistance, number> = {
  '50km':  4,
  '100km': 6,
  '160km': 10,
  '200km': 14,
  '300km': 18,
};

const HOURS_RANGE_BY_DISTANCE: Record<CyclingDistance, { min: number; max: number }> = {
  '50km':  { min: 3, max: 10 },
  '100km': { min: 4, max: 14 },
  '160km': { min: 6, max: 18 },
  '200km': { min: 8, max: 22 },
  '300km': { min: 10, max: 25 },
};

const DEFAULT_PLAN_WEEKS_BY_DISTANCE: Record<CyclingDistance, number> = {
  '50km':  8,
  '100km': 12,
  '160km': 16,
  '200km': 20,
  '300km': 22,
};

export function renderCyclingSetup(container: HTMLElement, state: OnboardingState): void {
  const distance: CyclingDistance = state.cyclingDistance ?? '160km';
  const hoursPerWeek = state.triTimeAvailableHoursPerWeek ?? DEFAULT_HOURS_BY_DISTANCE[distance];
  const hoursRange = HOURS_RANGE_BY_DISTANCE[distance];
  const defaultWeekdayHours = Math.round(hoursPerWeek * 0.4 * 2) / 2;
  const weekdayHours = state.triWeekdayHoursPerWeek ?? defaultWeekdayHours;
  const weekendHours = Math.max(0, hoursPerWeek - weekdayHours);
  const gymSessions = state.gymSessionsPerWeek ?? 0;

  // Benchmarks (FTP, 20-min test result, VO2max) are auto-derived from Strava
  // ride history during cycling-init and surfaced on the "Here's what we
  // found" review screen for confirmation/edit. Not collected here so the
  // user isn't asked for numbers we already have.

  container.innerHTML = `
    <style>
      @keyframes cRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .c-rise { opacity:0; animation: cRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .cyc-card { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:18px; margin-bottom:14px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.3); }
      .cyc-label { font-size:13px; color:var(--c-muted); letter-spacing:0.01em; margin:0 0 10px; text-transform:uppercase; font-weight:500; }
      .cyc-pill-row { display:flex; gap:8px; flex-wrap:wrap; }
      .cyc-pill { flex:1; min-width:78px; padding:10px 11px; border-radius:12px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.9); font-size:13px; color:var(--c-black); cursor:pointer; text-align:left; transition: all 0.15s ease; }
      .cyc-pill.active { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }
      .cyc-pill .cyc-pill-sub { display:block; font-size:11px; opacity:0.65; margin-top:2px; }
      .cyc-slider { -webkit-appearance:none; appearance:none; width:100%; height:4px; background:rgba(0,0,0,0.12); border-radius:4px; outline:none; margin:10px 0 2px; }
      .cyc-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:20px; height:20px; background:var(--c-black); border-radius:50%; cursor:pointer; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
      .cyc-slider::-moz-range-thumb { width:20px; height:20px; background:var(--c-black); border-radius:50%; cursor:pointer; border:none; box-shadow:0 1px 3px rgba(0,0,0,0.2); }
      .cyc-row { display:flex; justify-content:space-between; align-items:baseline; font-size:13px; color:var(--c-black); }
      .cyc-row .cyc-value { font-size:16px; font-weight:500; font-variant-numeric: tabular-nums; }
      .cyc-input { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.08); color:var(--c-black); border-radius:10px; padding:9px 12px; font-size:14px; width:100%; box-sizing:border-box; outline:none; }
      .cyc-input:focus { border-color:var(--c-black); }
      .cyc-hint { font-size:12px; color:var(--c-faint); margin:6px 0 0; line-height:1.5; }
      .cyc-cta { width:100%; padding:14px 20px; height:50px; background:var(--c-black); color:#FDFCF7; border:none; border-radius:25px; font-size:15px; font-weight:500; cursor:pointer; margin-top:8px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
      .cyc-cta:disabled { opacity:0.45; cursor:not-allowed; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;display:flex;flex-direction:column">
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('cyc', { variant: 'asymmetric', side: 'right' })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:36px 20px 140px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(5, 8)}

        <div class="c-rise" style="width:100%;max-width:480px;text-align:center;margin-bottom:20px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.5rem,5vw,1.9rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 6px;line-height:1.15">
            Cycling setup
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">Pick your event and how much you can ride.</p>
        </div>

        <div style="width:100%;max-width:480px">
          <!-- Event distance -->
          <div class="cyc-card c-rise" style="animation-delay:0.1s">
            <div class="cyc-label">Event distance</div>
            <div class="cyc-pill-row">
              ${(['50km', '100km', '160km', '200km', '300km'] as CyclingDistance[]).map((d) => `
                <button class="cyc-pill ${distance === d ? 'active' : ''}" data-distance="${d}">
                  ${DISTANCE_LABELS[d].headline}
                  <span class="cyc-pill-sub">${DISTANCE_LABELS[d].sub}</span>
                </button>
              `).join('')}
            </div>
            <p class="cyc-hint" id="cyc-plan-length-hint">Default plan length: ${DEFAULT_PLAN_WEEKS_BY_DISTANCE[distance]} weeks</p>
          </div>

          <!-- Target date -->
          <div class="cyc-card c-rise" style="animation-delay:0.14s">
            <div class="cyc-label">Target date <span style="text-transform:none;font-weight:400;color:var(--c-faint)">(optional)</span></div>
            <input type="date" id="cyc-race-date" class="cyc-input" value="${state.customRaceDate ?? ''}">
            <p class="cyc-hint">Leave blank to start the standard ${DEFAULT_PLAN_WEEKS_BY_DISTANCE[distance]}-week plan from this week.</p>
          </div>

          <!-- Time available -->
          <div class="cyc-card c-rise" style="animation-delay:0.18s">
            <div class="cyc-label">Time available per week</div>
            <div class="cyc-row">
              <span>Peak weekly hours</span>
              <span class="cyc-value" id="cyc-hours-value">${hoursPerWeek}h</span>
            </div>
            <input type="range" min="${hoursRange.min}" max="${hoursRange.max}" step="1" value="${hoursPerWeek}" class="cyc-slider" id="cyc-hours">
            <p class="cyc-hint" id="cyc-hours-hint">${hoursCommentary(distance, hoursPerWeek)}</p>

            <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(0,0,0,0.06)">
              <div class="cyc-row" style="margin-bottom:6px">
                <span style="font-size:13px;color:var(--c-black)">Mon–Fri split</span>
                <span class="cyc-value" id="cyc-weekday-value">${weekdayHours}h weekday / ${weekendHours.toFixed(1)}h weekend</span>
              </div>
              <input type="range" min="0" max="${hoursPerWeek}" step="0.5" value="${weekdayHours}" class="cyc-slider" id="cyc-weekday">
              <p class="cyc-hint">Long rides land Sat/Sun by default. Keep weekdays short if you work a 9-to-5.</p>
            </div>
          </div>

          <!-- Strength -->
          <div class="cyc-card c-rise" style="animation-delay:0.22s">
            <div class="cyc-label">Strength work</div>
            <div class="cyc-row" style="margin-bottom:4px">
              <span>Strength sessions per week</span>
              <span class="cyc-value" id="cyc-gym-value">${gymSessions}</span>
            </div>
            <input type="range" min="0" max="3" step="1" value="${gymSessions}" class="cyc-slider" id="cyc-gym">
            <p class="cyc-hint">Optional. 1–2 sessions/week of full-body strength supports power output and resilience over long rides. Set to 0 to skip.</p>
          </div>

          <!-- CTA -->
          <div class="c-rise" style="margin-top:6px;animation-delay:0.30s">
            <button id="cyc-continue" class="cyc-cta">Continue</button>
          </div>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers();
  void state;
}

// ──────────────────────────────────────────────────────────────────────────
// Wiring
// ──────────────────────────────────────────────────────────────────────────

function wireEventHandlers(): void {
  // Distance pills
  document.querySelectorAll<HTMLButtonElement>('[data-distance]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-distance') as CyclingDistance;
      updateOnboarding({ cyclingDistance: value });
      document.querySelectorAll<HTMLButtonElement>('[data-distance]').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-distance') === value);
      });

      const planLenHint = document.getElementById('cyc-plan-length-hint');
      if (planLenHint) planLenHint.textContent = `Default plan length: ${DEFAULT_PLAN_WEEKS_BY_DISTANCE[value]} weeks`;

      // Rescope hours slider min/max to the new distance
      const newRange = HOURS_RANGE_BY_DISTANCE[value];
      const hoursEl = document.getElementById('cyc-hours') as HTMLInputElement | null;
      if (hoursEl) {
        const current = Number(hoursEl.value);
        hoursEl.min = String(newRange.min);
        hoursEl.max = String(newRange.max);
        const clamped = Math.min(newRange.max, Math.max(newRange.min, current));
        if (clamped !== current) {
          hoursEl.value = String(clamped);
          const hv = document.getElementById('cyc-hours-value');
          if (hv) hv.textContent = `${clamped}h`;
          updateOnboarding({ triTimeAvailableHoursPerWeek: clamped });
        }
        const hint = document.getElementById('cyc-hours-hint');
        if (hint) hint.innerHTML = hoursCommentary(value, Number(hoursEl.value));
      }
    });
  });

  // Date input
  const dateInput = document.getElementById('cyc-race-date') as HTMLInputElement | null;
  dateInput?.addEventListener('change', () => {
    updateOnboarding({ customRaceDate: dateInput.value || null, selectedRace: null });
  });

  // Hours slider
  const hoursInput = document.getElementById('cyc-hours') as HTMLInputElement | null;
  const hoursValue = document.getElementById('cyc-hours-value');
  hoursInput?.addEventListener('input', () => {
    const h = Number(hoursInput.value);
    if (hoursValue) hoursValue.textContent = `${h}h`;
    updateOnboarding({ triTimeAvailableHoursPerWeek: h });
    const hint = document.getElementById('cyc-hours-hint');
    if (hint) hint.innerHTML = hoursCommentary(getCurrentOnboarding().cyclingDistance ?? '160km', h);

    const weekdaySlider = document.getElementById('cyc-weekday') as HTMLInputElement | null;
    if (weekdaySlider) {
      const current = Number(weekdaySlider.value);
      const prevMax = Number(weekdaySlider.max) || h;
      weekdaySlider.max = String(h);
      const scaled = prevMax > 0 ? Math.min(h, Math.round((current / prevMax) * h * 2) / 2) : h * 0.4;
      weekdaySlider.value = String(scaled);
      updateWeekdayLabel(scaled, h);
      updateOnboarding({ triWeekdayHoursPerWeek: scaled });
    }
  });

  // Weekday/weekend split slider
  const weekdayInput = document.getElementById('cyc-weekday') as HTMLInputElement | null;
  weekdayInput?.addEventListener('input', () => {
    const wd = Number(weekdayInput.value);
    const total = Number(hoursInput?.value ?? getCurrentOnboarding().triTimeAvailableHoursPerWeek ?? 10);
    updateWeekdayLabel(wd, total);
    updateOnboarding({ triWeekdayHoursPerWeek: wd });
  });

  // Gym slider
  const gymInput = document.getElementById('cyc-gym') as HTMLInputElement | null;
  const gymValue = document.getElementById('cyc-gym-value');
  gymInput?.addEventListener('input', () => {
    const v = Number(gymInput.value);
    if (gymValue) gymValue.textContent = String(v);
    updateOnboarding({ gymSessionsPerWeek: v });
  });


  // Continue
  document.getElementById('cyc-continue')?.addEventListener('click', () => {
    const current = getCurrentOnboarding();
    const finalPatch: Partial<OnboardingState> = {};
    if (!current.cyclingDistance) finalPatch.cyclingDistance = '160km';
    const dist = current.cyclingDistance ?? finalPatch.cyclingDistance ?? '160km';
    if (!current.triTimeAvailableHoursPerWeek) {
      finalPatch.triTimeAvailableHoursPerWeek = DEFAULT_HOURS_BY_DISTANCE[dist];
    }
    const totalH = current.triTimeAvailableHoursPerWeek ?? finalPatch.triTimeAvailableHoursPerWeek ?? 10;
    if (current.triWeekdayHoursPerWeek === undefined) {
      finalPatch.triWeekdayHoursPerWeek = Math.round(totalH * 0.4 * 2) / 2;
    }
    // Plan length follows the picked race date when set, falling back to the
    // distance default otherwise. Mirrors triathlon-setup.ts:408 and the
    // 2026-05-07 HYROX fix — without this a user with a 6-week race window
    // sees "Week 1 of 16" because the distance default ignores the date.
    finalPatch.planDurationWeeks = current.customRaceDate
      ? Math.max(1, calculateWeeksUntil(current.customRaceDate))
      : DEFAULT_PLAN_WEEKS_BY_DISTANCE[dist];
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

function updateWeekdayLabel(wd: number, total: number): void {
  const label = document.getElementById('cyc-weekday-value');
  if (!label) return;
  const we = Math.max(0, total - wd);
  label.textContent = `${wd}h weekday / ${we.toFixed(1)}h weekend`;
}

/**
 * Commentary calibrated for amateur Gran Fondo finishers (Friel, *The Cyclist's
 * Training Bible*, Allen & Coggan 2019). Below the floor the plan is "just
 * finish" territory; above the ceiling diminishing returns kick in for non-pros.
 */
function hoursCommentary(distance: CyclingDistance, hours: number): string {
  const base = `Peak-week target. Early and recovery weeks will be lighter.`;
  if (distance === '50km') {
    if (hours < 4) return `${base}<br>Light volume. Plenty for a confident 50km finish.`;
    if (hours < 7) return `${base}<br>Strong base for a fast 50km — comfortable margin.`;
    return `${base}<br>Advanced volume — well above what 50km demands.`;
  }
  if (distance === '100km') {
    if (hours < 5) return `${base}<br><span style="color:#c06a50">Aggressive minimum. 6–10h/week at peak is the typical range for a confident 100km finisher.</span>`;
    if (hours < 8) return `${base}<br>Realistic for a first 100km or time-constrained rider.`;
    if (hours < 12) return `${base}<br>Strong intermediate range. Good balance of volume and recovery.`;
    return `${base}<br>Advanced volume — well above what most amateurs need for 100km.`;
  }
  if (distance === '160km') {
    if (hours < 7) return `${base}<br><span style="color:#c06a50">Tight for 160km. Most first-timers need 9–12h+ at peak to ride the back half strong.</span>`;
    if (hours < 11) return `${base}<br>Realistic for a first Gran Fondo or time-constrained rider.`;
    if (hours < 15) return `${base}<br>Competitive intermediate range.</br>`;
    return `${base}<br>Advanced / podium-target volume. Make sure recovery is matched.`;
  }
  if (distance === '200km') {
    if (hours < 9) return `${base}<br><span style="color:#c06a50">Very tight for 200km. Most first-timers need 12h+ at peak.</span>`;
    if (hours < 14) return `${base}<br>Realistic for a first 200km audax with a solid base.`;
    if (hours < 18) return `${base}<br>Competitive endurance volume.`;
    return `${base}<br>Elite endurance volume. Recovery and fueling matter more than added hours past this point.`;
  }
  // 300km
  if (hours < 12) return `${base}<br><span style="color:#c06a50">Tight for 300km. Most randonneurs build to 14h+ at peak before ride day.</span>`;
  if (hours < 17) return `${base}<br>Realistic for a first 300km randonnée with strong base.`;
  if (hours < 22) return `${base}<br>Strong endurance volume. Match recovery carefully.`;
  return `${base}<br>Elite endurance volume. Past this point, fueling and pacing matter more than hours.`;
}
