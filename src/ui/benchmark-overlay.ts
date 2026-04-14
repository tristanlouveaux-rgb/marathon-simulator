/**
 * Benchmark check-in overlay — post-deload fitness assessment.
 *
 * Shown at the start of the first week after a deload block in continuous mode.
 * Instead of manual pace entry, selecting a check-in type generates a structured
 * workout (identical to the session generator) and adds it to the current week.
 * When watch/Strava data lands for that workout, it gets recorded as a benchmark.
 */

import { getState, getMutableState, saveState } from '@/state';
import type { Workout, BenchmarkType } from '@/types/state';
import { getBenchmarkOptions, skipBenchmark } from './events';
import { intentToWorkout } from '@/workouts/intent_to_workout';
import type { SessionIntent, SlotType } from '@/workouts/intent_to_workout';

const OVERLAY_ID = 'benchmark-overlay';

/** Map benchmark type → session generator slot + duration */
const BM_SESSION_MAP: Record<BenchmarkType, { slot: SlotType; totalMin: number; workRatio: number }> = {
  easy_checkin:    { slot: 'easy',      totalMin: 30, workRatio: 1.0 },
  threshold_check: { slot: 'threshold', totalMin: 35, workRatio: 0.57 },  // 20 min work in 35 min session
  speed_check:     { slot: 'vo2',       totalMin: 25, workRatio: 0.48 },  // 12 min work in 25 min session
  race_simulation: { slot: 'easy',      totalMin: 40, workRatio: 1.0 },   // 5k TT — easy slot, user runs hard
};

/** Threshold variant for benchmark (always continuous 20-min tempo) */
const BM_THRESH = { id: 'thr_20cont', reps: undefined, repMin: undefined, recMin: undefined };
/** VO2 variant for benchmark (Cooper test: single 12-min effort) */
const BM_VO2 = { id: 'vo2_cooper', reps: 1, repMin: 12, recMin: 0 };

function buildBenchmarkIntent(bmType: BenchmarkType): SessionIntent {
  const cfg = BM_SESSION_MAP[bmType];
  const workMin = Math.round(cfg.totalMin * cfg.workRatio);
  const jsDay = new Date().getDay();
  const dayIndex = jsDay === 0 ? 6 : jsDay - 1;

  let reps: number | undefined;
  let repMinutes: number | undefined;
  let recoveryMinutes: number | undefined;
  let variantId = cfg.slot as string;

  if (bmType === 'threshold_check') {
    variantId = BM_THRESH.id;
    reps = BM_THRESH.reps;
    repMinutes = BM_THRESH.repMin;
    recoveryMinutes = BM_THRESH.recMin;
  } else if (bmType === 'speed_check') {
    variantId = BM_VO2.id;
    reps = BM_VO2.reps;
    repMinutes = BM_VO2.repMin;
    recoveryMinutes = BM_VO2.recMin;
  }

  return {
    dayIndex,
    slot: cfg.slot,
    totalMinutes: cfg.totalMin,
    workMinutes: workMin,
    reps,
    repMinutes,
    recoveryMinutes,
    variantId,
    notes: '',
  };
}

function generateBenchmarkWorkout(bmType: BenchmarkType): Workout {
  const s = getState();
  const easyPace = s.pac?.e || 330;
  const intent = buildBenchmarkIntent(bmType);
  const wo = intentToWorkout(intent, s.rd, s.typ, easyPace);

  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;

  return {
    id: `benchmark-${bmType}-${Date.now()}`,
    t: wo.t,
    n: `Check-in: ${wo.n}`,
    d: wo.d,
    r: wo.r,
    rpe: wo.rpe ?? wo.r,
    dayOfWeek: ourDay,
  };
}

function addBenchmarkToWeek(bmType: BenchmarkType): void {
  const workout = generateBenchmarkWorkout(bmType);
  const ms = getMutableState();
  const wk = ms.wks?.[ms.w - 1];
  if (!wk) return;

  if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
  wk.adhocWorkouts.push(workout);

  saveState();
}

/** Open the benchmark check-in overlay. */
export function openBenchmarkOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();

  const s = getState();
  const options = getBenchmarkOptions(s.onboarding?.trainingFocus, s.onboarding?.experienceLevel);

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl" style="background:var(--c-surface);overflow:hidden;max-height:85vh;overflow-y:auto">

      <!-- Header with subtle gradient -->
      <div style="padding:24px 20px 18px;background:linear-gradient(to bottom,rgba(59,130,246,0.06),transparent)">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#64748B;margin-bottom:6px">Post-deload</div>
        <div style="font-size:18px;font-weight:700;color:#0F172A;line-height:1.3;margin-bottom:6px">Fitness check-in</div>
        <div style="font-size:13px;color:#64748B;line-height:1.5">End of deload week. Fatigue should be cleared and fitness at its peak. Good time to measure where things stand.</div>
      </div>

      <!-- Options -->
      <div style="padding:0 20px 8px;display:flex;flex-direction:column;gap:10px">
        ${options.map(opt => `
          <button class="bm-opt-btn" data-bm-type="${opt.type}"
            style="text-align:left;padding:14px 16px;border-radius:14px;
                   border:1px solid ${opt.recommended ? 'rgba(59,130,246,0.25)' : 'var(--c-border)'};
                   background:${opt.recommended ? 'rgba(59,130,246,0.04)' : 'var(--c-surface)'};
                   cursor:pointer;transition:border-color 0.15s;-webkit-tap-highlight-color:transparent">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:14px;font-weight:600;color:#0F172A">${opt.label}</span>
              ${opt.recommended ? `<span style="font-size:10px;font-weight:600;color:#64748B;background:rgba(0,0,0,0.05);padding:3px 9px;border-radius:100px;letter-spacing:0.02em">Recommended</span>` : ''}
            </div>
            <div style="font-size:12px;color:#64748B;line-height:1.45">${opt.description}</div>
            <div style="font-size:11px;color:#94A3B8;margin-top:6px">Adds a workout to this week's plan</div>
          </button>
        `).join('')}
      </div>

      <!-- Footer -->
      <div style="padding:10px 20px 22px">
        <button id="bm-overlay-skip"
          style="width:100%;padding:12px;border-radius:12px;border:none;
                 background:transparent;font-size:13px;font-weight:500;color:#94A3B8;cursor:pointer;font-family:var(--f)">
          Skip this check-in
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Wire option buttons
  overlay.querySelectorAll('.bm-opt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const bmType = (btn as HTMLElement).dataset.bmType as BenchmarkType;
      if (!bmType) return;
      overlay.remove();
      addBenchmarkToWeek(bmType);
      // Re-render the plan view to show the new workout
      import('./plan-view').then(({ renderPlanView }) => renderPlanView());
    });
  });

  // Wire skip
  document.getElementById('bm-overlay-skip')?.addEventListener('click', () => {
    overlay.remove();
    skipBenchmark();
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });
}

/**
 * Check whether to auto-show the benchmark overlay on page load.
 * Only fires once per benchmark week (tracks via benchmarkResults).
 */
export function maybeTriggerBenchmarkOverlay(): void {
  const s = getState();
  if (!s.continuousMode) return;

  // Only on post-deload weeks (week 5, 9, 13, …)
  if (s.w <= 4 || (s.w - 1) % 4 !== 0) return;

  // Already have a result for this week (recorded, skipped, or workout added)
  const existing = s.benchmarkResults?.find(b => b.week === s.w);
  if (existing) return;

  // Small delay so the plan view renders first
  setTimeout(() => openBenchmarkOverlay(), 400);
}
