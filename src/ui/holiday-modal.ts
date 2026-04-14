/**
 * Holiday modal — opened from the check-in overlay.
 *
 * Multi-step questionnaire that sets holidayState on the simulator state.
 * During holiday: workouts replaced with advisory text, "Generate session" button available.
 * On holiday end: welcome-back modal analyzes actual TSS and builds bridge weeks.
 */

import { getState, getMutableState, saveState } from '@/state';
import type { SimulatorState, Workout, Week } from '@/types';
import { computeWeekTSS, getTrailingEffortScore } from '@/calculations/fitness-model';
import { computeVdotLoss } from './welcome-back';
import { generateWeekWorkouts } from '@/workouts';


const MODAL_ID = 'holiday-modal';
const MAX_HOLIDAY_DAYS = 28; // 4 weeks

// ─── Helpers ────────────────────────────────────────────────────────────────

const QUALITY_TYPES = ['threshold', 'interval', 'tempo', 'marathon_pace', 'race_pace',
  'strides', 'fartlek', 'vo2', 'float', 'progressive'];
const NON_RUN_TYPES = ['cross', 'gym', 'strength', 'rest', 'yoga', 'swim', 'bike', 'cycl', 'row', 'hik', 'walk',
  'pilates', 'box', 'padel', 'tennis', 'football', 'soccer', 'basketball', 'rugby', 'elliptic', 'climb', 'ski'];

function isNonRun(w: any): boolean {
  const type = (w.t || '').toLowerCase();
  const name = (w.n || '').toLowerCase();
  return NON_RUN_TYPES.some(t => type.includes(t) || name.includes(t));
}

export function parseKmFromDesc(d: string): number {
  const matches = (d || '').matchAll(/(\d+\.?\d*)km/g);
  let total = 0;
  let count = 0;
  for (const m of matches) {
    total += parseFloat(m[1]);
    count++;
  }
  // For structured descriptions (warm-up + main + cool-down), return the sum.
  // For simple descriptions (single distance), returns that distance.
  return count > 1 ? total : (count === 1 ? total : 0);
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

/** Week number (1-based) for a given ISO date, relative to planStartDate. */
function weekNumForDate(date: string, planStartDate: string): number {
  const d = new Date(date + 'T12:00:00');
  const start = new Date(planStartDate + 'T12:00:00');
  const days = Math.floor((d.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.floor(days / 7) + 1);
}

/** Day of week index (0=Mon..6=Sun) for an ISO date. */
function dayOfWeekIndex(date: string): number {
  const js = new Date(date + 'T12:00:00').getDay();
  return js === 0 ? 6 : js - 1;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T12:00:00');
  const db = new Date(b + 'T12:00:00');
  return Math.round((db.getTime() - da.getTime()) / (24 * 60 * 60 * 1000));
}

function maxEndDate(start: string): string {
  const d = new Date(start + 'T12:00:00');
  d.setDate(d.getDate() + MAX_HOLIDAY_DAYS - 1);
  return d.toISOString().split('T')[0];
}

/** Format ISO date as "8 Apr 2026" */
function fmtDateReadable(iso: string): string {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const PHASE_LABELS: Record<string, string> = {
  base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper',
};

// ─── Questionnaire ──────────────────────────────────────────────────────────

export function openHolidayModal(): void {
  document.getElementById(MODAL_ID)?.remove();

  const s = getState();
  const today = todayISO();

  let step = 1;
  let startDate = today;
  let endDate = '';
  let startingToday = true;
  let canRun: 'yes' | 'maybe' | 'no' = 'maybe';
  let holidayType: 'relaxation' | 'active' | 'working' = 'relaxation';

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  function render() {
    if (step === 1) renderStep1();
    else if (step === 2) renderStep2();
    else if (step === 3) renderStep3();
    else if (step === 4) renderStep4();
  }

  function renderStep1() {
    // Compute initial duration from existing dates
    let duration = endDate && startDate ? daysBetween(startDate, endDate) + 1 : 5;
    if (duration < 1) duration = 5;

    function computeEndFromDuration(d: number): string {
      const dt = new Date((startDate || today) + 'T12:00:00');
      dt.setDate(dt.getDate() + d - 1);
      return dt.toISOString().split('T')[0];
    }

    function getWeekPhaseInfo(sd: string, ed: string): { text: string; hasTaper: boolean } {
      if (!sd || !ed || !s.planStartDate) return { text: '', hasTaper: false };
      const sw = weekNumForDate(sd, s.planStartDate);
      const ew = weekNumForDate(ed, s.planStartDate);
      const phases = new Set<string>();
      let hasTaper = false;
      for (let w = sw; w <= ew && w <= (s.wks?.length || 0); w++) {
        const ph = s.wks?.[w - 1]?.ph;
        if (ph) { phases.add(PHASE_LABELS[ph] || ph); if (ph === 'taper') hasTaper = true; }
      }
      const weekLabel = sw === ew ? `Week ${sw}` : `Weeks ${sw} to ${ew}`;
      return { text: `${weekLabel} (${[...phases].join(', ')})`, hasTaper };
    }

    endDate = computeEndFromDuration(duration);
    const { text: weekText, hasTaper } = getWeekPhaseInfo(startDate, endDate);

    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
        <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">Holiday</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px">When are you away?</div>

        <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer">
          <input type="checkbox" id="hol-starting-today" ${startingToday ? 'checked' : ''}
            style="width:16px;height:16px;accent-color:var(--c-accent)">
          <span style="font-size:13px;color:var(--c-black)">Starting today</span>
        </label>

        <div id="hol-start-row" style="margin-bottom:14px;${startingToday ? 'display:none' : ''}">
          <div style="font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">Start date</div>
          <input type="date" id="hol-start" value="${startDate}"
            min="${today}"
            style="width:100%;padding:9px 10px;border:1px solid var(--c-border);border-radius:10px;
                   font-size:13px;font-family:var(--f);color:var(--c-black);background:var(--c-surface)">
        </div>

        <div style="margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em">Duration</div>
            <div id="hol-dur-label" style="font-size:14px;font-weight:600;color:var(--c-black)">${duration} day${duration === 1 ? '' : 's'}</div>
          </div>
          <input type="range" id="hol-dur-slider" min="1" max="${MAX_HOLIDAY_DAYS}" value="${duration}"
            style="width:100%;accent-color:var(--c-black)">
          <div style="display:flex;justify-content:space-between;margin-top:2px">
            <span style="font-size:10px;color:var(--c-faint)">1 day</span>
            <span style="font-size:10px;color:var(--c-faint)">${MAX_HOLIDAY_DAYS} days</span>
          </div>
        </div>

        <div id="hol-date-label" style="font-size:12px;color:var(--c-black);margin-bottom:4px;font-weight:500">${fmtDateReadable(startDate)} to ${fmtDateReadable(endDate)}</div>
        <div id="hol-week-info" style="font-size:12px;color:var(--c-muted);margin-bottom:4px">${weekText}</div>
        <div id="hol-taper-warn" style="margin-bottom:14px">${hasTaper ? `
          <div style="margin-top:6px;padding:10px 12px;border-radius:10px;background:var(--c-caution-bg);border:1px solid rgba(245,158,11,0.3)">
            <div style="font-size:12px;font-weight:600;color:var(--c-caution-text);margin-bottom:2px">Taper overlap</div>
            <div style="font-size:11px;color:var(--c-caution-text);opacity:0.8;line-height:1.4">This overlaps your taper window. Taper workouts are specifically sequenced for race day. Skipping them may affect race-day readiness.</div>
          </div>` : ''}</div>

        <div style="display:flex;gap:8px">
          <button id="hol-cancel"
            style="flex:1;padding:11px;border-radius:12px;border:1px solid var(--c-border);
                   background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f)">
            Cancel
          </button>
          <button id="hol-next-1"
            style="flex:1;padding:11px;border-radius:12px;border:1px solid var(--c-border);
                   background:transparent;font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer;font-family:var(--f)">
            Next
          </button>
        </div>
      </div>
    `;

    const startInput = document.getElementById('hol-start') as HTMLInputElement;
    const slider = document.getElementById('hol-dur-slider') as HTMLInputElement;
    const todayCheck = document.getElementById('hol-starting-today') as HTMLInputElement;
    const startRow = document.getElementById('hol-start-row')!;

    function updateFromSlider() {
      duration = parseInt(slider.value, 10);
      endDate = computeEndFromDuration(duration);
      document.getElementById('hol-dur-label')!.textContent = `${duration} day${duration === 1 ? '' : 's'}`;
      document.getElementById('hol-date-label')!.textContent = `${fmtDateReadable(startDate)} to ${fmtDateReadable(endDate)}`;
      const info = getWeekPhaseInfo(startDate, endDate);
      document.getElementById('hol-week-info')!.textContent = info.text;
      const warnEl = document.getElementById('hol-taper-warn')!;
      if (info.hasTaper) {
        warnEl.innerHTML = `
          <div style="margin-top:6px;padding:10px 12px;border-radius:10px;background:var(--c-caution-bg);border:1px solid rgba(245,158,11,0.3)">
            <div style="font-size:12px;font-weight:600;color:var(--c-caution-text);margin-bottom:2px">Taper overlap</div>
            <div style="font-size:11px;color:var(--c-caution-text);opacity:0.8;line-height:1.4">This overlaps your taper window. Taper workouts are specifically sequenced for race day. Skipping them may affect race-day readiness.</div>
          </div>`;
      } else {
        warnEl.innerHTML = '';
      }
    }

    slider.addEventListener('input', updateFromSlider);

    todayCheck.addEventListener('change', () => {
      startingToday = todayCheck.checked;
      if (startingToday) { startDate = today; startRow.style.display = 'none'; }
      else { startRow.style.display = ''; }
      updateFromSlider();
    });
    startInput.addEventListener('change', () => {
      startDate = startInput.value;
      updateFromSlider();
    });

    document.getElementById('hol-cancel')?.addEventListener('click', () => modal.remove());
    document.getElementById('hol-next-1')?.addEventListener('click', () => {
      startDate = startingToday ? today : startInput.value;
      endDate = computeEndFromDuration(duration);
      step = 2; render();
    });
  }

  function renderStep2() {
    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
        <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">Running on holiday</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px">Are you planning on running?</div>

        <button id="hol-run-yes"
          style="width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;
                 border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:8px;text-align:left">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:2px">Yes, regularly</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.4">Safe routes or treadmill available. Planning to run most days.</div>
        </button>

        <button id="hol-run-maybe"
          style="width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;
                 border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:8px;text-align:left">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:2px">Maybe once or twice</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.4">Might fit a run in if opportunity arises.</div>
        </button>

        <button id="hol-run-no"
          style="width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;
                 border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:14px;text-align:left">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:2px">No</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.4">No running planned.</div>
        </button>

        <button id="hol-back-2"
          style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
                 background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f)">
          Back
        </button>
      </div>
    `;
    document.getElementById('hol-run-yes')?.addEventListener('click', () => { canRun = 'yes'; step = 3; render(); });
    document.getElementById('hol-run-maybe')?.addEventListener('click', () => { canRun = 'maybe'; step = 3; render(); });
    document.getElementById('hol-run-no')?.addEventListener('click', () => { canRun = 'no'; step = 3; render(); });
    document.getElementById('hol-back-2')?.addEventListener('click', () => { step = 1; render(); });
  }

  function renderStep3() {
    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
        <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">Type of holiday</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px">This helps calibrate your return plan.</div>

        <button id="hol-type-relax"
          style="width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;
                 border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:8px;text-align:left">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:2px">Beach / relaxation</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.4">Minimal physical activity expected.</div>
        </button>

        <button id="hol-type-active"
          style="width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;
                 border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:8px;text-align:left">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:2px">Active holiday</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.4">Hiking, ski touring, cycling, sport camps, daily activity.</div>
        </button>

        <button id="hol-type-work"
          style="width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;
                 border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:14px;text-align:left">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:2px">Working trip</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.4">Routine disrupted but gym or running possible.</div>
        </button>

        <button id="hol-back-3"
          style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
                 background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f)">
          Back
        </button>
      </div>
    `;
    document.getElementById('hol-type-relax')?.addEventListener('click', () => { holidayType = 'relaxation'; step = 4; render(); });
    document.getElementById('hol-type-active')?.addEventListener('click', () => { holidayType = 'active'; step = 4; render(); });
    document.getElementById('hol-type-work')?.addEventListener('click', () => { holidayType = 'working'; step = 4; render(); });
    document.getElementById('hol-back-3')?.addEventListener('click', () => { step = 2; render(); });
  }

  function renderStep4() {
    const daysAway = daysBetween(startDate, endDate) + 1;
    const isFuture = startDate > today;
    const fmtStart = new Date(startDate + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const fmtEnd = new Date(endDate + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

    // Short, direct summary — 2 sentences max
    let summary: string;
    if (canRun === 'yes') {
      summary = 'Quality sessions paused. Easy runs available throughout.';
    } else if (canRun === 'maybe') {
      summary = 'Fit in 1 to 2 easy runs if you can. Any logged activity counts toward load.';
    } else {
      summary = 'No running planned. Logged activities (Strava/Garmin) still count toward load.';
    }

    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
        <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">Summary</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">${summary}</div>

        <div style="padding:10px 12px;border-radius:10px;background:rgba(0,0,0,0.04);margin-bottom:18px">
          <div style="font-size:12px;color:var(--c-muted);line-height:1.5">
            <div style="margin-bottom:4px"><strong style="color:var(--c-black)">${daysAway} day${daysAway === 1 ? '' : 's'}</strong> (${fmtStart} to ${fmtEnd})</div>
            ${isFuture ? '<div>Holiday weeks will be treated as deload. Plan adjusts around it.</div>' : '<div>Activities logged during holiday count toward your training load.</div>'}
          </div>
        </div>

        <button id="hol-confirm"
          style="width:100%;padding:12px;border-radius:12px;border:none;
                 background:var(--c-accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--f);margin-bottom:8px">
          Confirm holiday
        </button>
        <button id="hol-back-4"
          style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
                 background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f)">
          Back
        </button>
      </div>
    `;

    document.getElementById('hol-back-4')?.addEventListener('click', () => { step = 3; render(); });
    document.getElementById('hol-confirm')?.addEventListener('click', () => {
      modal.remove();
      confirmHoliday(startDate, endDate, canRun, holidayType);
    });
  }

  render();
}

// ─── Confirm + persist ──────────────────────────────────────────────────────

function confirmHoliday(
  startDate: string,
  endDate: string,
  canRun: 'yes' | 'maybe' | 'no',
  holidayType: 'relaxation' | 'active' | 'working',
): void {
  const s = getMutableState();

  // Snapshot pre-holiday weekly TSS from most recent completed week
  let preHolidayWeeklyTSS = 0;
  if (s.wks && s.w > 1) {
    const prevWk = s.wks[s.w - 2];
    if (prevWk) {
      preHolidayWeeklyTSS = prevWk.actualTSS ?? computeWeekTSS(prevWk, prevWk.rated ?? {}, s.planStartDate);
    }
  }

  const today = todayISO();
  const isFuture = startDate > today;

  // Pre-holiday shifts: move quality sessions within 2 days of start earlier
  const preHolidayShifts = isFuture ? {} : computePreHolidayShifts(s, startDate);

  s.holidayState = {
    startDate,
    endDate,
    canRun,
    holidayType,
    active: true,
    preHolidayShifts: Object.keys(preHolidayShifts).length > 0 ? preHolidayShifts : undefined,
    preHolidayWeeklyTSS,
  };

  // For future holidays: mark holiday weeks as forced deload so the plan engine
  // generates lighter workouts. This lets the surrounding weeks absorb more load.
  if (isFuture && s.planStartDate && s.wks) {
    const sw = weekNumForDate(startDate, s.planStartDate);
    const ew = weekNumForDate(endDate, s.planStartDate);
    for (let w = sw; w <= ew && w <= s.wks.length; w++) {
      const wk = s.wks[w - 1];
      if (wk.ph !== 'taper') {
        (wk as any).forceDeload = true;
      }
    }
  }

  saveState();
  import('./plan-view').then(({ renderPlanView }) => renderPlanView());
}

/** Generate workouts for a given week using state — centralises the parameter list. */
function generateWorkoutsForWeek(s: SimulatorState, weekNum: number): Workout[] {
  const wk = s.wks?.[weekNum - 1];
  if (!wk) return [];
  return generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, weekNum, s.tw, s.v, s.gs,
    getTrailingEffortScore(s.wks, weekNum), wk.scheduledAcwrStatus,
  );
}

function computePreHolidayShifts(s: SimulatorState, startDate: string): Record<string, number> {
  if (!s.planStartDate || !s.wks) return {};

  const startWeek = weekNumForDate(startDate, s.planStartDate);
  const wk = s.wks[startWeek - 1];
  if (!wk) return {};

  const holidayStartDay = dayOfWeekIndex(startDate);
  const shifts: Record<string, number> = {};

  const workouts = generateWorkoutsForWeek(s, startWeek);

  // Apply existing workoutMoves to get effective day positions
  const existingMoves = wk.workoutMoves || {};
  for (const w of workouts) {
    const wId = w.id || w.n;
    if (existingMoves[wId] != null) {
      w.dayOfWeek = existingMoves[wId];
    }
  }

  // Collect days already occupied by hard workouts (to avoid stacking)
  const occupiedDays = new Set<number>();
  for (const w of workouts) {
    if (w.dayOfWeek != null) occupiedDays.add(w.dayOfWeek);
  }

  // Shift quality sessions that fall on holiday start day or the 2 days before
  const shiftableTypes = ['threshold', 'vo2', 'long', 'marathon_pace', 'float', 'race_pace', 'progressive'];
  for (const w of workouts) {
    const wId = w.id || w.n;
    const effectiveDay = w.dayOfWeek ?? 0;
    const isShiftable = shiftableTypes.some(t => (w.t || '').toLowerCase().includes(t));

    // Only shift if this workout is on the holiday start day or the 2 days before it
    if (!isShiftable || effectiveDay < holidayStartDay - 2 || effectiveDay > holidayStartDay) continue;

    // Find the nearest earlier free day (at least 2 days before holiday)
    let targetDay = Math.max(0, effectiveDay - 2);
    while (targetDay < effectiveDay && occupiedDays.has(targetDay)) {
      targetDay++;
    }
    if (targetDay >= effectiveDay) continue; // no free day found

    shifts[wId] = targetDay;
    occupiedDays.add(targetDay);
  }

  // Merge shifts into workoutMoves
  if (Object.keys(shifts).length > 0) {
    if (!wk.workoutMoves) wk.workoutMoves = {};
    Object.assign(wk.workoutMoves, shifts);
  }

  return shifts;
}

// ─── Render-time workout mods ───────────────────────────────────────────────

/**
 * Apply holiday modifications to a workouts array IN MEMORY (render-time only).
 *
 * Only modifies workouts whose dayOfWeek falls within the holiday window for this week.
 * no: all running → rest.
 * maybe: all running → optional advisory.
 * yes: quality → easy at 70%; easy/long kept.
 *
 * @param holidayDays - Set of day-of-week indices (0=Mon..6=Sun) that fall within the holiday for this week. If null, all days are treated as holiday.
 */
export function applyHolidayMods(workouts: any[], canRun: 'yes' | 'maybe' | 'no', holidayDays?: Set<number> | null): void {
  for (const w of workouts) {
    if (isNonRun(w)) continue;
    // Skip user-generated holiday sessions — these were deliberately created via "Generate session"
    if ((w.id || '').startsWith('holiday-')) continue;

    // If holidayDays is provided, only modify workouts on holiday days
    if (holidayDays && w.dayOfWeek != null && !holidayDays.has(w.dayOfWeek)) continue;

    w.holidayMod = true;
    w.originalDistance = w.d || w.n;
    w.originalName = w.n;
    w.status = 'holiday';
    w.modReason = 'Holiday';

    if (canRun === 'no') {
      w.n = 'Holiday — rest day';
      w.d = 'On holiday. No running planned.';
      w.t = 'easy'; // keep as easy so it renders as a card, not a plain "Rest" row
      w.r = 0;
      w.km = 0;
      w.dur = 0;
    } else if (canRun === 'maybe') {
      w.n = 'Holiday — optional run';
      w.d = 'Easy run if opportunity arises';
      w.t = 'easy';
      w.r = 2;
      w.km = 0;
      w.dur = 0;
    } else {
      // yes: downgrade quality to easy at 70%, keep easy runs as-is
      const isQuality = QUALITY_TYPES.some(t => (w.t || '').toLowerCase().includes(t));
      if (isQuality) {
        const origKm = parseKmFromDesc(w.d);
        if (origKm > 0) {
          const newKm = Math.max(3, Math.round(origKm * 0.7 * 2) / 2);
          w.n = 'Easy Run';
          w.d = `${newKm}km easy pace`;
          w.t = 'easy';
          w.r = 3;
          w.km = newKm;
        } else {
          w.n = 'Easy Run';
          w.d = 'Easy run';
          w.t = 'easy';
          w.r = 3;
        }
      }
      // Non-quality runs (easy, long) keep their name but are slightly flagged
    }
  }
}

// ─── Check if a week overlaps the holiday ───────────────────────────────────

export function isWeekInHoliday(weekNum: number, planStartDate: string, holiday: { startDate: string; endDate: string }): boolean {
  const weekStart = new Date(planStartDate + 'T12:00:00');
  weekStart.setDate(weekStart.getDate() + (weekNum - 1) * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const hStart = new Date(holiday.startDate + 'T12:00:00');
  const hEnd = new Date(holiday.endDate + 'T12:00:00');

  return weekStart <= hEnd && weekEnd >= hStart;
}

/**
 * Returns the set of day-of-week indices (0=Mon..6=Sun) within a given week
 * that fall inside the holiday window. Returns null if the entire week is covered.
 */
export function getHolidayDaysForWeek(weekNum: number, planStartDate: string, holiday: { startDate: string; endDate: string }): Set<number> | null {
  const weekStart = new Date(planStartDate + 'T12:00:00');
  weekStart.setDate(weekStart.getDate() + (weekNum - 1) * 7);

  const hStart = new Date(holiday.startDate + 'T12:00:00');
  const hEnd = new Date(holiday.endDate + 'T12:00:00');

  const days = new Set<number>();
  let allDays = true;
  for (let d = 0; d < 7; d++) {
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + d);
    if (dayDate >= hStart && dayDate <= hEnd) {
      days.add(d);
    } else {
      allDays = false;
    }
  }

  return allDays ? null : days; // null = entire week is holiday
}

// ─── Banners ────────────────────────────────────────────────────────────────

export function buildHolidayBannerPlan(s: SimulatorState): string {
  const holiday = s.holidayState;
  if (!holiday?.active) return '';

  const today = todayISO();
  const isFuture = today < holiday.startDate;
  const daysTotal = daysBetween(holiday.startDate, holiday.endDate) + 1;

  // ── Future holiday: "Scheduled" banner ──
  if (isFuture) {
    const daysUntilStart = daysBetween(today, holiday.startDate);
    const fmtStart = new Date(holiday.startDate + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const fmtEnd = new Date(holiday.endDate + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `
      <div id="holiday-banner" style="margin:14px 16px 0;border-radius:14px;overflow:hidden;
                  border:1px solid rgba(0,0,0,0.08);background:var(--c-surface)">
        <div style="height:3px;background:var(--c-border-strong)"></div>
        <div style="padding:14px 16px">
          <div style="margin-bottom:12px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
              <span style="font-size:14px;font-weight:600;letter-spacing:-0.01em;color:var(--c-black)">Holiday scheduled</span>
              <span style="font-size:10px;font-weight:600;color:var(--c-muted);border:1px solid var(--c-border);border-radius:100px;padding:1px 8px;text-transform:uppercase;letter-spacing:0.04em">In ${daysUntilStart} day${daysUntilStart === 1 ? '' : 's'}</span>
            </div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.5">${fmtStart} to ${fmtEnd} (${daysTotal} days). Holiday weeks treated as deload.</div>
          </div>
          <div style="display:flex;gap:8px">
            <button id="holiday-change-btn" class="m-btn-secondary"
              style="flex:1;font-size:13px;padding:9px 0;text-align:center;justify-content:center">
              Change
            </button>
            <button id="holiday-cancel-btn" class="m-btn-secondary"
              style="flex:1;font-size:13px;padding:9px 0;text-align:center;justify-content:center">
              Cancel holiday
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ── Active holiday: "Day N of M" banner ──
  const dayNum = Math.max(1, daysBetween(holiday.startDate, today) + 1);
  const daysLeft = Math.max(0, daysTotal - dayNum);

  const runLabel = holiday.canRun === 'yes' ? 'Easy runs only'
    : holiday.canRun === 'maybe' ? 'Optional runs'
    : 'No running';

  const detail = holiday.canRun === 'no'
    ? 'All running workouts paused. Logged activities still count.'
    : holiday.canRun === 'maybe'
    ? 'Fit in an easy run if opportunity arises. Logged activities count.'
    : 'Quality sessions paused. Easy runs available.';

  const generateBtn = `
    <button id="holiday-generate-btn" class="m-btn-secondary"
      style="flex:1;font-size:13px;padding:9px 0;text-align:center;justify-content:center">
      Generate session
    </button>`;

  return `
    <div id="holiday-banner" style="margin:14px 16px 0;border-radius:14px;overflow:hidden;
                border:1px solid rgba(0,0,0,0.08);background:var(--c-surface)">
      <div style="height:3px;background:var(--c-border-strong)"></div>
      <div style="padding:14px 16px">
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:12px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
              <span style="font-size:14px;font-weight:600;letter-spacing:-0.01em;color:var(--c-black)">Holiday · Day ${dayNum} of ${daysTotal}</span>
              <span style="font-size:10px;font-weight:600;color:var(--c-muted);border:1px solid var(--c-border);border-radius:100px;padding:1px 8px;text-transform:uppercase;letter-spacing:0.04em">${runLabel}</span>
            </div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.5">${detail}${daysLeft > 0 ? ` ${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining.` : ' Last day.'}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          ${generateBtn}
          <button id="holiday-end-btn" class="m-btn-secondary"
            style="flex:1;font-size:13px;padding:9px 0;text-align:center;justify-content:center">
            End holiday
          </button>
        </div>
      </div>
    </div>
  `;
}

export function buildHolidayBannerHome(s: SimulatorState): string {
  const holiday = s.holidayState;
  if (!holiday?.active) return '';

  const today = todayISO();
  const isFuture = today < holiday.startDate;

  if (isFuture) {
    const daysUntil = daysBetween(today, holiday.startDate);
    return `
      <div id="home-holiday-banner" style="margin:0 14px 8px;border-radius:16px;overflow:hidden;
                  border:1px solid rgba(0,0,0,0.08);background:var(--c-surface);
                  box-shadow:0 1px 8px rgba(0,0,0,0.06)">
        <div style="height:3px;background:var(--c-border-strong)"></div>
        <div style="padding:12px 14px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="flex:1;min-width:0">
              <span style="font-size:13px;font-weight:600;letter-spacing:-0.01em;color:var(--c-black)">Holiday in ${daysUntil} day${daysUntil === 1 ? '' : 's'}</span>
            </div>
            <button id="home-holiday-end"
              style="flex-shrink:0;padding:6px 11px;border-radius:100px;
                     border:1px solid var(--c-border-strong);background:transparent;
                     font-size:11px;font-weight:600;color:var(--c-muted);cursor:pointer;white-space:nowrap">
              Cancel
            </button>
          </div>
        </div>
      </div>
    `;
  }

  const daysTotal = daysBetween(holiday.startDate, holiday.endDate) + 1;
  const dayNum = Math.max(1, daysBetween(holiday.startDate, today) + 1);
  const daysLeft = Math.max(0, daysTotal - dayNum);

  const runLabel = holiday.canRun === 'yes' ? 'Easy runs'
    : holiday.canRun === 'maybe' ? 'Optional runs'
    : 'No running';

  return `
    <div id="home-holiday-banner" style="margin:0 14px 8px;border-radius:16px;overflow:hidden;
                border:1px solid rgba(0,0,0,0.08);
                background:var(--c-surface);
                box-shadow:0 1px 8px rgba(0,0,0,0.06)">
      <div style="height:3px;background:var(--c-border-strong)"></div>
      <div style="padding:12px 14px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
              <span style="font-size:13px;font-weight:600;letter-spacing:-0.01em;color:var(--c-black)">Holiday · Day ${dayNum}</span>
              <span style="font-size:10px;font-weight:600;color:var(--c-muted);background:rgba(0,0,0,0.04);
                           border:1px solid var(--c-border);border-radius:100px;padding:1px 7px;text-transform:uppercase;letter-spacing:0.04em">${runLabel}</span>
            </div>
            <div style="font-size:11px;color:rgba(0,0,0,0.45)">${daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining` : 'Last day'}</div>
          </div>
          <button id="home-holiday-end"
            style="flex-shrink:0;display:flex;align-items:center;gap:4px;padding:6px 11px;border-radius:100px;
                   border:1px solid var(--c-border-strong);background:transparent;
                   font-size:11px;font-weight:600;color:var(--c-muted);cursor:pointer;white-space:nowrap">
            End holiday
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─── Holiday cleanup helpers ────────────────────────────────────────────────

/** Remove holiday-generated adhoc sessions from all weeks. */
function cleanupHolidayAdhocWorkouts(s: SimulatorState): void {
  for (const wk of s.wks || []) {
    if (wk.adhocWorkouts?.length) {
      wk.adhocWorkouts = wk.adhocWorkouts.filter((w: any) => !(w.id || '').startsWith('holiday-'));
    }
  }
}

/** Remove forceDeload flags from weeks that overlap a holiday window. */
function clearForceDeloadFlags(s: SimulatorState, holiday: { startDate: string; endDate: string }): void {
  if (!s.planStartDate || !s.wks) return;
  const sw = weekNumForDate(holiday.startDate, s.planStartDate);
  const ew = weekNumForDate(holiday.endDate, s.planStartDate);
  for (let w = sw; w <= ew && w <= s.wks.length; w++) {
    delete (s.wks[w - 1] as any).forceDeload;
  }
}

// ─── Cancel scheduled (future) holiday ───────────────────────────────────────

/** Cancel a future holiday — no penalty, just clear state and forceDeload flags. */
export function cancelScheduledHoliday(onComplete?: () => void): void {
  const s = getMutableState();
  const holiday = s.holidayState;
  if (!holiday) return;

  clearForceDeloadFlags(s, holiday);
  cleanupHolidayAdhocWorkouts(s);
  s.holidayState = undefined as any;
  saveState();
  if (onComplete) onComplete();
  else import('./plan-view').then(({ renderPlanView }) => renderPlanView());
}

// ─── Clear holiday ──────────────────────────────────────────────────────────

/** Minimum days a holiday must have been active before VDOT docking / bridge weeks apply. */
const MIN_HOLIDAY_DAYS_FOR_REBUILD = 3;

/**
 * End holiday — if the holiday has barely started (< 3 days), cancel silently
 * with no fitness penalty. Otherwise show a confirmation dialog and trigger
 * the welcome-back flow (TSS analysis + bridge weeks).
 */
export function clearHoliday(onComplete?: () => void): void {
  const s = getState();
  const holiday = s.holidayState;
  if (!holiday?.active) return;

  const rerender = onComplete ?? (() => import('./plan-view').then(({ renderPlanView }) => renderPlanView()));
  const daysActive = daysBetween(holiday.startDate, todayISO()) + 1;

  // Short holiday (< 3 days): just cancel, no penalty
  if (daysActive < MIN_HOLIDAY_DAYS_FOR_REBUILD) {
    const ms = getMutableState();
    cleanupHolidayAdhocWorkouts(ms);
    if (ms.holidayState) {
      clearForceDeloadFlags(ms, ms.holidayState);
      ms.holidayState.active = false;
    }
    saveState();
    rerender();
    return;
  }

  // Longer holiday: confirm + welcome-back
  const existing = document.getElementById('holiday-end-confirm');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'holiday-end-confirm';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';

  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:6px">End holiday early?</div>
      <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">Your plan will be rebuilt based on activity logged during the holiday. The next few weeks may be adjusted to bridge you back.</div>
      <button id="hol-end-yes"
        style="width:100%;padding:12px;border-radius:12px;border:none;
               background:var(--c-accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--f);margin-bottom:8px">
        End holiday
      </button>
      <button id="hol-end-no"
        style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
               background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f)">
        Cancel
      </button>
    </div>
  `;

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  document.getElementById('hol-end-no')?.addEventListener('click', () => overlay.remove());
  document.getElementById('hol-end-yes')?.addEventListener('click', () => {
    overlay.remove();
    const ms = getMutableState();
    if (ms.holidayState) {
      // Deactivate immediately so mods stop applying on next render
      ms.holidayState.active = false;
      ms.holidayState.endDate = todayISO();
      clearForceDeloadFlags(ms, ms.holidayState);
      cleanupHolidayAdhocWorkouts(ms);
      saveState();
    }
    // Trigger welcome-back flow (TSS analysis + bridge weeks)
    showHolidayWelcomeBack(rerender);
  });
}

// ─── Holiday end detection (called from main.ts on launch) ──────────────────

/**
 * Called from main.ts on launch. Returns true if the holiday ended by date
 * and was long enough to warrant the welcome-back flow.
 * Short holidays (< 3 days) are silently cleared instead.
 */
export function checkHolidayEnd(): boolean {
  const s = getMutableState();
  if (!s.holidayState?.active) return false;
  if (s.holidayState.welcomeBackShown) return false;

  const today = todayISO();
  if (today <= s.holidayState.endDate) return false;

  // Holiday ended. Check if it was long enough to matter.
  const daysActive = daysBetween(s.holidayState.startDate, s.holidayState.endDate) + 1;
  if (daysActive < MIN_HOLIDAY_DAYS_FOR_REBUILD) {
    // Short holiday — just cancel silently, no penalty
    clearForceDeloadFlags(s, s.holidayState);
    cleanupHolidayAdhocWorkouts(s);
    s.holidayState.active = false;
    saveState();
    return false;
  }

  // Long holiday — caller shows welcome-back modal; clean forceDeload now
  clearForceDeloadFlags(s, s.holidayState);
  saveState();
  return true;
}

// ─── Post-holiday welcome back ──────────────────────────────────────────────

type ActivityLevel = 'veryActive' | 'moderate' | 'sedentary';

function classifyHolidayActivity(s: SimulatorState): { ratio: number; level: ActivityLevel } {
  const holiday = s.holidayState;
  if (!holiday || !s.planStartDate) return { ratio: 0, level: 'sedentary' };

  const preWeeklyTSS = holiday.preHolidayWeeklyTSS || 0;
  if (preWeeklyTSS === 0) return { ratio: 0, level: 'sedentary' };

  const startWeek = weekNumForDate(holiday.startDate, s.planStartDate);
  const endWeek = weekNumForDate(holiday.endDate, s.planStartDate);

  let totalActualTSS = 0;
  let weekCount = 0;
  for (let w = startWeek; w <= endWeek && w <= (s.wks?.length || 0); w++) {
    const wk = s.wks![w - 1];
    if (wk) {
      totalActualTSS += wk.actualTSS ?? computeWeekTSS(wk, wk.rated ?? {}, s.planStartDate);
      weekCount++;
    }
  }

  const avgWeeklyTSS = weekCount > 0 ? totalActualTSS / weekCount : 0;
  const ratio = avgWeeklyTSS / preWeeklyTSS;

  let level: ActivityLevel;
  if (ratio > 0.70) level = 'veryActive';
  else if (ratio >= 0.30) level = 'moderate';
  else level = 'sedentary';

  return { ratio, level };
}

function buildBridgeWeekMods(s: SimulatorState, level: ActivityLevel): void {
  if (!s.wks) return;

  const resumeWeek = s.w; // already advanced by advanceWeekToToday
  const maxBridge = level === 'veryActive' ? 1 : level === 'moderate' ? 2 : 3;

  for (let offset = 0; offset < maxBridge; offset++) {
    const weekIdx = resumeWeek + offset - 1; // 0-based
    if (weekIdx >= s.wks.length) break;

    const wk = s.wks[weekIdx];
    if (wk.ph === 'taper') break; // never modify taper weeks

    // Clear any stale bridge mods from a previous holiday
    wk.workoutMods = (wk.workoutMods || []).filter(m => !m.modReason?.startsWith('Post-holiday'));

    if (level === 'veryActive') {
      // Week 1: quality at 85%
      wk.weekAdjustmentReason = 'Post-holiday bridge: intensity slightly reduced for the first week.';
      // Mods will be applied at render time by checking weekAdjustmentReason
      // For now, add a marker mod for each quality workout
      applyBridgeMods(wk, 0.85, 'Post-holiday bridge (returning from active holiday)');

    } else if (level === 'moderate') {
      if (offset === 0) {
        // Week 1: easy only, 60% volume
        wk.weekAdjustmentReason = 'Post-holiday bridge: easy runs only, easing back in.';
        applyBridgeMods(wk, 0.60, 'Post-holiday bridge (easing back in)', true);
      } else {
        // Week 2: quality at 80%
        wk.weekAdjustmentReason = 'Post-holiday bridge: quality returning at reduced intensity.';
        applyBridgeMods(wk, 0.80, 'Post-holiday bridge (quality returning)');
      }

    } else {
      // sedentary
      if (offset === 0) {
        // Week 1: easy at 50%, phase→base
        wk.ph = 'base';
        wk.weekAdjustmentReason = 'Post-holiday bridge: rebuilding volume after time off.';
        applyBridgeMods(wk, 0.50, 'Post-holiday bridge (rebuilding volume)', true);
      } else if (offset === 1) {
        // Week 2: easy + 1 quality at 70%
        wk.weekAdjustmentReason = 'Post-holiday bridge: introducing quality at reduced load.';
        applyBridgeMods(wk, 0.70, 'Post-holiday bridge (reintroducing quality)');
      } else {
        // Week 3: quality at 85%
        wk.weekAdjustmentReason = 'Post-holiday bridge: quality sessions approaching normal.';
        applyBridgeMods(wk, 0.85, 'Post-holiday bridge (approaching normal)');
      }
    }
  }
}

/**
 * Write WorkoutMod entries onto a week to scale distances.
 * If downgradeQuality is true, all quality sessions become easy runs.
 */
function applyBridgeMods(wk: Week, scale: number, reason: string, downgradeQuality = false): void {
  // We don't have access to the generated workouts at this point (they're render-time),
  // so we write generic mods that the renderer checks by workout name.
  // The actual mod application happens when plan-view generates workouts and finds
  // a matching mod by name. If no match, the weekAdjustmentReason banner still shows.

  // Add a sentinel mod so the renderer knows to apply scaling
  if (!wk.workoutMods) wk.workoutMods = [];

  wk.workoutMods.push({
    name: '__holiday_bridge__',
    status: 'reduced',
    modReason: reason,
    originalDistance: '',
    newDistance: '',
    newType: downgradeQuality ? 'easy' : undefined,
    newRpe: downgradeQuality ? 3 : undefined,
  });

  // Store scale factor for render-time use
  (wk as any)._holidayBridgeScale = scale;
  (wk as any)._holidayBridgeDowngrade = downgradeQuality;
}

/**
 * Apply bridge modifications at render time (called from plan-view after workout generation).
 * Reads _holidayBridgeScale from the week and scales workout distances accordingly.
 */
export function applyBridgeMods_renderTime(workouts: any[], wk: Week): void {
  const scale = (wk as any)?._holidayBridgeScale;
  if (!scale) return;

  const downgrade = (wk as any)?._holidayBridgeDowngrade;

  for (const w of workouts) {
    if (isNonRun(w)) continue;
    if ((w as any).holidayMod) continue; // already modified by holiday mods
    // Skip user-generated sessions — the user explicitly chose the distance/structure
    if ((w.id || '').startsWith('adhoc-') || (w.id || '').startsWith('holiday-')) continue;

    const isQuality = QUALITY_TYPES.some(t => (w.t || '').toLowerCase().includes(t));

    if (downgrade && isQuality) {
      // Convert quality to easy
      const origKm = parseKmFromDesc(w.d);
      w.originalDistance = w.d;
      if (origKm > 0) {
        const newKm = Math.max(2, Math.round(origKm * scale * 2) / 2);
        w.d = `${newKm}km easy pace`;
      } else {
        w.d = 'Easy run';
      }
      w.t = 'easy';
      w.r = 3;
      w.modReason = 'Post-holiday bridge';
      w.status = 'reduced';
    } else {
      // Scale distance
      const origKm = parseKmFromDesc(w.d);
      if (origKm > 0) {
        const newKm = Math.max(2, Math.round(origKm * scale * 2) / 2);
        if (newKm !== origKm) {
          w.originalDistance = w.d;
          w.d = w.d.replace(/(\d+\.?\d*)km/, `${newKm}km`);
          w.modReason = 'Post-holiday bridge';
          w.status = 'reduced';
        }
      }
    }
  }
}

export function showHolidayWelcomeBack(onComplete: () => void): void {
  const s = getMutableState();
  const holiday = s.holidayState;
  if (!holiday) { onComplete(); return; }

  const { ratio, level } = classifyHolidayActivity(s);
  const daysAway = daysBetween(holiday.startDate, holiday.endDate) + 1;
  const weeksAway = Math.ceil(daysAway / 7);

  // Apply VDOT detraining
  const vdotLoss = s.v ? computeVdotLoss(s.v, weeksAway) : 0;
  if (vdotLoss > 0 && s.v) {
    s.v = Math.max(Math.round((s.v - vdotLoss) * 10) / 10, 20);
  }

  // Build bridge weeks
  buildBridgeWeekMods(s, level);

  // Build copy
  let title: string;
  let body: string;
  const pctText = Math.round(ratio * 100);

  if (level === 'veryActive') {
    title = 'Back from holiday';
    body = `Holiday load was ${pctText}% of your pre-holiday average. Aerobic fitness largely maintained. Quality sessions return this week at slightly reduced intensity.`;
  } else if (level === 'moderate') {
    title = 'Back from holiday';
    body = `Holiday load was ${pctText}% of your pre-holiday average. One easy week followed by gradual quality reintroduction. The next 2 weeks bridge you back to the normal plan.`;
  } else {
    title = `Back after ${weeksAway === 1 ? '1 week' : weeksAway + ' weeks'} away`;
    body = `Minimal activity during holiday. ${weeksAway >= 2 ? 'Two to three' : 'One to two'} weeks of progressive volume before quality sessions resume. Run by feel, not pace targets.`;
  }

  if (vdotLoss > 0) {
    body += ` Fitness adjusted down by ${vdotLoss.toFixed(1)} points to reflect time away.`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';

  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl overflow-hidden" style="background:var(--c-surface);border:1px solid var(--c-border)">
      <div style="height:3px;background:var(--c-border-strong)"></div>
      <div style="padding:20px">
        <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:8px">${title}</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.6;margin-bottom:18px">${body}</div>

        <button id="hol-wb-confirm"
          style="width:100%;padding:12px;border-radius:12px;border:none;
                 background:var(--c-accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--f)">
          Continue
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('hol-wb-confirm')?.addEventListener('click', () => {
    // Finalize: clean up holiday sessions, archive holiday, mark inactive
    cleanupHolidayAdhocWorkouts(s);
    holiday.welcomeBackShown = true;
    if (!s.holidayHistory) s.holidayHistory = [];
    s.holidayHistory.push({
      startDate: holiday.startDate,
      endDate: holiday.endDate,
      holidayType: holiday.holidayType,
      actualTSSRatio: Math.round(ratio * 100) / 100,
    });
    holiday.active = false;

    saveState();
    overlay.remove();
    onComplete();
  });
}
