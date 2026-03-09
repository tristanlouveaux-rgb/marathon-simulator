/**
 * Welcome Back — gap detection and skip-cascade flow.
 *
 * Called on every app launch (after state is loaded) for users who have
 * completed onboarding. If the calendar has moved past their current
 * training week, we show a contextual modal that:
 *  1. Explains what happened (detraining, aerobic base reduction)
 *  2. Applies a VDOT detraining penalty proportional to weeks missed
 *  3. Advances the week counter to the correct calendar week
 *  4. For 3+ week gaps: marks the landing week as 'base' (lighter volume)
 *
 * Guard: stored in localStorage so the user sees the modal at most once
 * per calendar day (prevents re-showing on multiple app opens).
 */

import { getMutableState, saveState } from '@/state';

const GAP_SEEN_KEY = 'mosaic_gap_seen';
const LAST_OPENED_KEY = 'mosaic_last_opened_at';
const WELCOME_BACK_MIN_HOURS = 24;

// ---------------------------------------------------------------------------
// Detection + silent advancement
// ---------------------------------------------------------------------------

/**
 * How many complete weeks has the user missed relative to today?
 * Returns 0 when the user is still within their current training week.
 */
export function detectMissedWeeks(): number {
  const s = getMutableState();
  if (!s.planStartDate || !s.w || !s.hasCompletedOnboarding) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // End of the current training week (exclusive upper bound)
  const weekStart = new Date(s.planStartDate);
  weekStart.setDate(weekStart.getDate() + (s.w - 1) * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  if (today < weekEnd) return 0;

  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.floor((today.getTime() - weekEnd.getTime()) / msPerWeek) + 1;
}

/**
 * Silently advance s.w to the correct calendar week and apply proportional
 * VDOT detraining. Called on every launch — replaces the modal trigger now
 * that the welcome-back modal is removed (ISSUE-81).
 *
 * Safe to call when gap = 0 (no-op) or repeatedly (idempotent within a day).
 */
export function advanceWeekToToday(): void {
  const gap = detectMissedWeeks();
  if (gap <= 0) return;

  const s = getMutableState();

  // Advance week pointer — never exceed wks array length
  const targetWeek = computeCurrentCalendarWeek(s);
  const maxWeek = (s.tw && s.tw > 0) ? s.tw : (s.wks?.length ?? s.w);

  // In continuous mode, extend wks array if calendar is ahead of planned weeks
  if (s.continuousMode && targetWeek > maxWeek && s.wks) {
    const BLOCK_SIZE = 4;
    const blockPhases: Array<'base' | 'build' | 'peak' | 'taper'> = ['base', 'build', 'peak', 'taper'];
    while ((s.tw ?? s.wks.length) < targetWeek) {
      s.blockNumber = (s.blockNumber || 1) + 1;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        s.wks.push({
          w: (s.tw ?? s.wks.length) + i + 1,
          ph: blockPhases[i],
          rated: {},
          skip: [],
          cross: [],
          wkGain: 0,
          workoutMods: [],
          adjustments: [],
          unspentLoad: 0,
          extraRunLoad: 0,
        });
      }
      s.tw = (s.tw ?? 0) + BLOCK_SIZE;
    }
  }

  // Clamp to the smaller of target and available weeks
  const effectiveMax = Math.min(s.tw ?? s.wks?.length ?? s.w, s.wks?.length ?? s.w);
  s.w = Math.min(targetWeek, effectiveMax);

  // Apply VDOT detraining silently
  if (s.v && gap > 0) {
    const loss = computeVdotLoss(s.v, gap);
    if (loss > 0) s.v = Math.max(Math.round((s.v - loss) * 10) / 10, 20);
  }

  // 3+ week gap: mark landing week as base (reduced volume)
  if (gap >= 3 && s.wks?.[s.w - 1]) {
    s.wks[s.w - 1].ph = 'base';
  }

  saveState();
}

// ---------------------------------------------------------------------------
// Detraining calculation
// ---------------------------------------------------------------------------

/**
 * Estimate VDOT loss for a given number of missed weeks.
 * Based on ~1.2% VO2max loss/week (weeks 1–2), ~0.8% thereafter.
 * Diminishing returns modelled by compounding the loss.
 */
function computeVdotLoss(currentVdot: number, weeksGap: number): number {
  let loss = 0;
  for (let i = 0; i < weeksGap; i++) {
    const rate = i < 2 ? 0.012 : 0.008;
    loss += (currentVdot - loss) * rate;
  }
  return Math.round(loss * 10) / 10;
}

// ---------------------------------------------------------------------------
// Week advancement
// ---------------------------------------------------------------------------

/** Compute the week number that today's date falls in, relative to planStartDate. */
function computeCurrentCalendarWeek(s: ReturnType<typeof getMutableState>): number {
  if (!s.planStartDate) return s.w;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(s.planStartDate);
  start.setHours(0, 0, 0, 0);
  const days = Math.floor((today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.floor(days / 7) + 1);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * Show the welcome-back modal for a user returning after a missed-week gap.
 * Calls `onComplete` when the user confirms (state already updated by then).
 */
/**
 * Record the current timestamp as the last time the app was opened.
 * Call this on every app launch after state is loaded.
 */
export function recordAppOpen(): void {
  localStorage.setItem(LAST_OPENED_KEY, new Date().toISOString());
}

export function showWelcomeBackModal(weeksGap: number, onComplete: () => void): void {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Guard: only show once per calendar day (existing guard)
  if (localStorage.getItem(GAP_SEEN_KEY) === today) {
    recordAppOpen();
    onComplete();
    return;
  }

  // Guard: only show if the app was last opened more than 20 hours ago
  const lastOpenedStr = localStorage.getItem(LAST_OPENED_KEY);
  if (lastOpenedStr) {
    const lastOpened = new Date(lastOpenedStr);
    const hoursSinceLast = (now.getTime() - lastOpened.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLast < WELCOME_BACK_MIN_HOURS) {
      recordAppOpen();
      onComplete();
      return;
    }
  }

  const s = getMutableState();
  const vdotLoss = s.v ? computeVdotLoss(s.v, weeksGap) : 0;
  const isLong = weeksGap >= 3;
  const weeksLabel = weeksGap === 1 ? '1 week' : `${weeksGap} weeks`;

  // Experience level determines tone
  const exp = s.onboarding?.experienceLevel as string | undefined;
  const isDataFirst = exp === 'competitive' || exp === 'sub_elite' || exp === 'elite' ||
                      exp === 'hybrid' || exp === 'returning';

  // ── Copy ──────────────────────────────────────────────────────────────────
  let titleText: string;
  let bodyText: string;
  const bullets: string[] = [];

  if (weeksGap === 1) {
    titleText = isDataFirst ? `Back after ${weeksLabel}` : 'Welcome back!';
    bodyText = isDataFirst
      ? 'One week off means minimal detraining — aerobic base is intact.'
      : "You've missed one week. Your aerobic base is still solid — let's pick right back up.";
    bullets.push('Light detraining — your fitness is largely preserved.');
    bullets.push('Your plan continues from today, no changes needed.');
  } else if (weeksGap === 2) {
    titleText = isDataFirst ? `Back after ${weeksLabel}` : `Welcome back — ${weeksLabel} away`;
    bodyText = isDataFirst
      ? 'Two weeks off: moderate detraining, aerobic base is reducing.'
      : "You've been away for 2 weeks — aerobic base is starting to reduce but is still strong.";
    bullets.push('Moderate detraining detected.');
    bullets.push('Keep early sessions comfortable to ease back in.');
    bullets.push('Your plan jumps to today\'s week.');
  } else {
    titleText = isDataFirst
      ? `Return after ${weeksLabel} — ease-in week active`
      : `Good to have you back — ${weeksLabel} away`;
    bodyText = isDataFirst
      ? `Significant detraining over ${weeksLabel}. This week is set to Base phase (reduced volume) to minimise injury risk.`
      : `You\'ve been away for ${weeksLabel}. We\'ll ease you back in with a lighter week — prioritise consistency over pace.`;
    bullets.push('Your aerobic base has reduced — intensity targets are just guides.');
    bullets.push('This week is a return week with reduced volume.');
    bullets.push('Run by feel, don\'t chase pace targets.');
  }

  if (vdotLoss > 0) {
    bullets.push(isDataFirst
      ? `Fitness adjusted down by ~${vdotLoss.toFixed(1)} points.`
      : `Fitness adjusted to reflect time away.`);
  }

  // ── Modal HTML ─────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4';

  overlay.innerHTML = `
    <div class="max-w-sm w-full shadow-2xl rounded-xl overflow-hidden" style="background:var(--c-surface);border:1px solid var(--c-border-strong)">

      <!-- Header -->
      <div class="p-5" style="border-bottom:1px solid var(--c-border)">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style="background:var(--c-ok-bg);border:1px solid rgba(34,197,94,0.3)">
            <svg class="w-5 h-5" style="color:var(--c-ok)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
          </div>
          <h3 class="font-bold text-lg" style="color:var(--c-black)">${titleText}</h3>
        </div>
        <p class="text-sm leading-relaxed" style="color:var(--c-muted)">${bodyText}</p>
      </div>

      <!-- Bullet details -->
      <div class="p-5 space-y-1.5" style="border-bottom:1px solid var(--c-border)">
        ${bullets.map(b => `<p class="text-sm" style="color:var(--c-muted)">${b}</p>`).join('')}
        ${isLong ? `
          <div class="mt-3 p-3 rounded-lg" style="background:var(--c-caution-bg);border:1px solid rgba(245,158,11,0.3)">
            <p class="text-xs font-semibold" style="color:var(--c-caution-text)">Return week active</p>
            <p class="text-xs mt-0.5" style="color:var(--c-caution-text);opacity:0.75">Intensity targets are reduced this week. Consistency beats performance right now.</p>
          </div>
        ` : ''}
      </div>

      <!-- CTA -->
      <div class="p-5">
        <button id="wb-confirm" class="w-full m-btn-primary py-3 rounded-xl font-semibold text-sm">
          Let's go →
        </button>
      </div>

    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#wb-confirm')?.addEventListener('click', () => {
    const ms = getMutableState();

    // 1. Apply VDOT detraining
    if (vdotLoss > 0 && ms.v) {
      ms.v = Math.max(Math.round((ms.v - vdotLoss) * 10) / 10, 20);
    }

    // 2. Advance week counter to today's calendar week
    const targetWeek = computeCurrentCalendarWeek(ms);
    const maxWeek = ms.tw || targetWeek;
    ms.w = Math.min(targetWeek, maxWeek);

    // 3. For 3+ week gaps: mark landing week as 'base' (lighter load)
    if (isLong && ms.wks?.[ms.w - 1]) {
      ms.wks[ms.w - 1].ph = 'base';
    }

    localStorage.setItem(GAP_SEEN_KEY, today);
    recordAppOpen();
    saveState();
    overlay.remove();
    onComplete();
  });
}
