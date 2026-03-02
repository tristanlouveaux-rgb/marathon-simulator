/**
 * Activity Review Screen
 *
 * Processing order on Apply:
 *   1. Log Only  → adhoc, no plan change
 *   2. Runs      → matched to closest planned run; unmatched → extra adhoc run
 *   3. Gym (HIIT/strength only) → matched to planned gym session; unmatched → cross pool
 *   4. Remaining cross-training (sports, fitness classes, walks, rides, etc.)
 *      → combined load → one reduce/replace/keep modal
 *      → user approves before anything changes
 *
 *   Modal dismiss → re-opens review with still-pending items (no intro repeat).
 */

import { getMutableState, saveState } from '@/state';
import { render, log } from '@/ui/renderer';
import {
  addAdhocWorkoutFromPending,
  formatActivityType,
  mapAppTypeToSport,
  deriveRPE,
} from '@/calculations/activity-matcher';
import {
  normalizeSport,
  buildCrossTrainingPopup,
  workoutsToPlannedRuns,
  applyAdjustments,
  createActivity,
} from '@/cross-training';
import { showSuggestionModal } from '@/ui/suggestion-modal';
import { generateWeekWorkouts } from '@/workouts';
import {
  findMatchingWorkout,
  type ExternalActivity,
  type MatchResult,
} from '@/calculations/matching';
import type { GarminPendingItem, GarminActual, WorkoutMod, UnspentLoadItem } from '@/types';
import type { SportKey } from '@/types/activities';
import { showMatchingScreen, type ProposedPairing } from '@/ui/matching-screen';
import { showAssignmentToast } from '@/ui/toast';
import { TL_PER_MIN, SPORTS_DB } from '@/constants';

// Intro screen removed — flow goes directly to matching screen

// ---------------------------------------------------------------------------
// Week workouts helper

function getWeekWorkoutsForReview() {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) return [];
  // CRITICAL: must use IDENTICAL parameters to getPlanHTML's generateWeekWorkouts call
  // so that workout IDs (w.id || w.n) match exactly — matching breaks if they differ.
  return generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
  );
}

// ---------------------------------------------------------------------------
// Helpers

function buildExternalActivity(item: GarminPendingItem): ExternalActivity {
  const distanceKm = (item.distanceM ?? 0) / 1000;
  const durationMin = item.durationSec / 60;
  const jsDay = new Date(item.startTime).getDay();
  return {
    type: item.appType as ExternalActivity['type'],
    name: formatActivityType(item.activityType), // used for sport-name matching against recurring activities
    distanceKm,
    durationMin,
    dayOfWeek: jsDay === 0 ? 6 : jsDay - 1,
    avgPaceSecPerKm: distanceKm > 0.1 && durationMin > 0
      ? (durationMin * 60) / distanceKm
      : undefined,
    avgHR: item.avgHR ?? undefined,
  };
}

function deriveItemRPE(
  item: GarminPendingItem,
  s: ReturnType<typeof getMutableState>,
): number {
  return deriveRPE(
    {
      garmin_id: item.garminId,
      activity_type: item.activityType,
      start_time: item.startTime,
      duration_sec: item.durationSec,
      distance_m: item.distanceM,
      avg_pace_sec_km: null,
      avg_hr: item.avgHR,
      max_hr: item.maxHR,
      calories: item.calories,
      aerobic_effect: item.aerobicEffect,
      anaerobic_effect: item.anaerobicEffect,
      garmin_rpe: item.garminRpe,
    },
    5,
    s.maxHR,
    s.restingHR,
    s.onboarding?.age,
  );
}

/** Default: integrate runs/gym/matched-sports, long/intense cross-training, log-only otherwise */
function defaultsToIntegrate(item: GarminPendingItem, match: MatchResult | null): boolean {
  if (item.appType === 'run' || item.appType === 'gym' || item.appType === 'other') return match !== null;
  return item.durationSec > 2700 || (item.aerobicEffect != null && item.aerobicEffect >= 2.5);
}

// ---------------------------------------------------------------------------
// Public entry point

export function showActivityReview(
  pending: GarminPendingItem[],
  onComplete: () => void,
  _skipIntro = false, // kept for call-site compatibility
  savedChoices?: Record<string, 'integrate' | 'log'>,
  onCancel?: () => void,
): void {
  const overlay = document.createElement('div');
  overlay.id = 'activity-review-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:var(--c-bg);display:flex;flex-direction:column';
  document.body.appendChild(overlay);

  // All activities default to 'integrate'; matching screen's Log Only bucket handles exceptions
  // Use persisted choices as fallback (re-review preserves previous assignments)
  const sAr = getMutableState();
  const effectiveSavedChoices = savedChoices ?? sAr.wks?.[sAr.w - 1]?.garminReviewChoices;
  showMatchingEntryScreen(overlay, pending, onComplete, effectiveSavedChoices, onCancel);
}

/**
 * Re-open Activity Review for already-processed Garmin activities.
 * Undoes previous processing, pre-populates with saved choices, shows review.
 * Called from the "Review Garmin activities" button in the Garmin section.
 */
export function openActivityReReview(onDone?: () => void): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk?.garminPending?.length) return;

  // Capture previous choices before undoing
  const savedChoices = { ...(wk.garminReviewChoices || {}) };

  // Snapshot state so Cancel can restore it exactly
  const snapshot = {
    rated: { ...wk.rated },
    garminActuals: JSON.parse(JSON.stringify(wk.garminActuals || {})),
    garminMatched: { ...(wk.garminMatched || {}) },
    adhocWorkouts: JSON.parse(JSON.stringify(wk.adhocWorkouts || [])),
    workoutMods: JSON.parse(JSON.stringify(wk.workoutMods || [])),
  };

  // Undo all previous Garmin processing for every pending item
  for (const item of wk.garminPending) {
    const id = item.garminId;
    const matchedId = wk.garminMatched?.[id];

    // Remove garmin adhoc entry
    const adhocId = `garmin-${id}`;
    if (wk.adhocWorkouts) {
      wk.adhocWorkouts = wk.adhocWorkouts.filter(w => w.id !== adhocId);
    }

    // Un-rate a matched planned workout (not an adhoc fallback)
    if (matchedId && !matchedId.startsWith('garmin-') && matchedId !== '__pending__') {
      delete wk.rated[matchedId];
      if (wk.garminActuals) delete wk.garminActuals[matchedId];
    }

    // Reset to pending so auto-review can present them again
    if (wk.garminMatched) {
      wk.garminMatched[id] = '__pending__';
    }
  }

  // Remove all Garmin-sourced workout modifications
  if (wk.workoutMods) {
    wk.workoutMods = wk.workoutMods.filter(m => !m.modReason?.startsWith('Garmin:'));
  }

  saveState();

  const done = () => { if (onDone) onDone(); else render(); };
  showActivityReview(
    wk.garminPending,
    done,
    /* skipIntro */ true,
    savedChoices,
    /* onCancel */ () => {
      // Restore state to exactly what it was before the user opened the review
      const s2 = getMutableState();
      const wk2 = s2.wks?.[s2.w - 1];
      if (wk2) {
        wk2.rated = snapshot.rated;
        wk2.garminActuals = snapshot.garminActuals;
        wk2.garminMatched = snapshot.garminMatched;
        wk2.adhocWorkouts = snapshot.adhocWorkouts;
        wk2.workoutMods = snapshot.workoutMods;
        saveState();
      }
      done();
    },
  );
}

// ---------------------------------------------------------------------------
// Direct entry: skip integrate/log toggle page, go straight to matching screen

function showMatchingEntryScreen(
  overlay: HTMLElement,
  pending: GarminPendingItem[],
  onComplete: () => void,
  savedChoices?: Record<string, 'integrate' | 'log'>,
  onCancel?: () => void,
): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  const allWorkouts = getWeekWorkoutsForReview();

  // Default all to 'integrate'; Log Only bucket on the matching screen handles exceptions
  const choices: Record<string, 'integrate' | 'log'> = {};
  for (const item of pending) {
    choices[item.garminId] = savedChoices?.[item.garminId] === 'log' ? 'log' : 'integrate';
  }

  const pairings = proposeMatchings(pending, choices, buildMatchCache(pending, allWorkouts, wk), allWorkouts);
  const unrated = allWorkouts.filter(w => wk?.rated[w.id || w.n] === undefined);

  let weekStartDate: Date | undefined;
  let weekLabel: string | undefined;
  if (s.planStartDate) {
    weekStartDate = new Date(s.planStartDate);
    weekStartDate.setDate(weekStartDate.getDate() + (s.w - 1) * 7);
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekEndDate.getDate() + 6);
    const fmtD = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    weekLabel = `Week ${s.w}${s.tw ? ` of ${s.tw}` : ''} · ${fmtD(weekStartDate)} – ${fmtD(weekEndDate)}`;
  }

  showMatchingScreen(
    overlay,
    pending,
    choices,
    pairings,
    unrated,
    (confirmedMatchings, reductionItems, logonlyItems) => {
      const sOrig = getMutableState();
      const wkOrig = sOrig.wks?.[sOrig.w - 1];
      if (wkOrig) {
        if (!wkOrig.garminReviewChoices) wkOrig.garminReviewChoices = {};
        for (const [id, choice] of Object.entries(choices)) {
          wkOrig.garminReviewChoices[id] = choice;
        }
      }

      const updatedChoices = { ...choices };
      for (const item of reductionItems) updatedChoices[item.garminId] = 'log';
      for (const item of logonlyItems)   updatedChoices[item.garminId] = 'log';

      populateUnspentLoadItems(reductionItems);

      const toastLines = buildAssignmentLines(pending, choices, updatedChoices, confirmedMatchings, allWorkouts);
      overlay.remove();
      saveState();
      showAssignmentToast(toastLines);
      applyReview(pending, updatedChoices, buildMatchCache(pending, allWorkouts, wk), onComplete, confirmedMatchings);
    },
    () => {
      overlay.remove();
      if (onCancel) onCancel();
      else onComplete();
    },
    weekStartDate,
    weekLabel,
  );
}

/** Build matchCache from pending items against unrated workouts */
function buildMatchCache(
  pending: GarminPendingItem[],
  allWorkouts: ReturnType<typeof getWeekWorkoutsForReview>,
  wk: ReturnType<typeof getMutableState>['wks'][0] | undefined,
): Map<string, import('@/calculations/matching').MatchResult | null> {
  const unratedWorkouts = allWorkouts.filter(w => wk?.rated[w.id || w.n] === undefined);
  const matchCache = new Map<string, import('@/calculations/matching').MatchResult | null>();
  for (const item of pending) {
    matchCache.set(item.garminId, findMatchingWorkout(buildExternalActivity(item), unratedWorkouts));
  }
  return matchCache;
}

// ---------------------------------------------------------------------------
// Step 1: Intro (kept for reference but no longer called)

function showIntroScreen(
  overlay: HTMLElement,
  pending: GarminPendingItem[],
  onComplete: () => void,
): void {
  overlay.innerHTML = `
    <div class="border-b" style="background:var(--c-surface);border-color:var(--c-border)">
      <div class="max-w-7xl mx-auto px-4 py-4">
        <h1 class="text-xl font-semibold" style="color:var(--c-black)">Activity Review</h1>
        <p class="text-sm mt-0.5" style="color:var(--c-muted)">${pending.length} activit${pending.length === 1 ? 'y' : 'ies'} from Garmin</p>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-4 py-6">
      <p class="text-base mb-5" style="color:var(--c-black)">
        Choose how each Garmin activity should be handled before your plan is updated.
      </p>

      <div class="mb-6">
        <p class="font-semibold mb-3" style="color:var(--c-black)">Integrate</p>
        <ul class="space-y-2 text-sm" style="color:var(--c-muted)">
          <li class="flex gap-2"><span class="shrink-0" style="color:var(--c-faint)">—</span>Runs are matched to the closest planned session and marked complete at your recorded effort.</li>
          <li class="flex gap-2"><span class="shrink-0" style="color:var(--c-faint)">—</span>Strength and HIIT sessions slot against planned gym work.</li>
          <li class="flex gap-2"><span class="shrink-0" style="color:var(--c-faint)">—</span>Any remaining cross-training load is assessed and we may suggest reducing or replacing an upcoming run. You approve the change before it's applied.</li>
        </ul>
      </div>

      <div class="border-t pt-5" style="border-color:var(--c-border)">
        <p class="font-semibold mb-3" style="color:var(--c-black)">Log Only</p>
        <ul class="space-y-2 text-sm" style="color:var(--c-muted)">
          <li class="flex gap-2"><span class="shrink-0" style="color:var(--c-faint)">—</span>Recorded in your weekly summary for reference.</li>
          <li class="flex gap-2"><span class="shrink-0" style="color:var(--c-faint)">—</span>Does not affect your plan, load calculations, or scheduled runs.</li>
        </ul>
      </div>
    </div>

    <div class="border-t px-4 py-4 flex gap-3" style="background:var(--c-surface);border-color:var(--c-border);padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 1rem)">
      <button id="ar-cancel-intro"
              class="flex-1 py-3 rounded-xl font-medium transition-colors" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">
        Cancel
      </button>
      <button id="ar-continue"
              class="flex-1 py-3 rounded-xl font-medium transition-colors" style="background:var(--c-ok);color:#fff">
        Review activities
      </button>
    </div>
  `;

  overlay.querySelector('#ar-cancel-intro')?.addEventListener('click', () => {
    overlay.remove();
    onComplete();
  });

  overlay.querySelector('#ar-continue')?.addEventListener('click', () => {
    showReviewScreen(overlay, pending, onComplete);
  });
}

// ---------------------------------------------------------------------------
// Step 2: Review screen

function showReviewScreen(
  overlay: HTMLElement,
  pending: GarminPendingItem[],
  onComplete: () => void,
  savedChoices?: Record<string, 'integrate' | 'log'>,
  onCancel?: () => void,
): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  const allWorkouts = getWeekWorkoutsForReview();
  const unratedWorkouts = allWorkouts.filter(w => wk?.rated[w.id || w.n] === undefined);

  // Pre-compute matches for run, gym, and other (sport → recurring activity)
  const matchCache = new Map<string, MatchResult | null>();
  for (const item of pending) {
    matchCache.set(item.garminId, findMatchingWorkout(buildExternalActivity(item), unratedWorkouts));
  }

  const choices: Record<string, 'integrate' | 'log'> = {};
  for (const item of pending) {
    // Use saved choice if available (re-review), otherwise fall back to smart default
    choices[item.garminId] = savedChoices?.[item.garminId]
      ?? (defaultsToIntegrate(item, matchCache.get(item.garminId) ?? null) ? 'integrate' : 'log');
  }

  // Build week label for header
  let weekHeaderStr = `Week ${s.w}${s.tw ? ` of ${s.tw}` : ''}`;
  if (s.planStartDate) {
    const ws = new Date(s.planStartDate);
    ws.setDate(ws.getDate() + (s.w - 1) * 7);
    const we = new Date(ws);
    we.setDate(we.getDate() + 6);
    const fmtD = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    weekHeaderStr += ` · ${fmtD(ws)} – ${fmtD(we)}`;
  }

  overlay.innerHTML = `
    <div class="border-b" style="background:var(--c-surface);border-color:var(--c-border)">
      <div class="max-w-7xl mx-auto px-4 py-4">
        <h1 class="text-xl font-semibold" style="color:var(--c-black)">Activity Review</h1>
        <p class="text-sm mt-0.5" style="color:var(--c-muted)">${weekHeaderStr}</p>
        <p class="text-xs mt-0.5" style="color:var(--c-faint)">${pending.length} activit${pending.length === 1 ? 'y' : 'ies'} to review</p>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-4 py-4 space-y-5">
      ${renderByDay(pending, choices, matchCache)}
    </div>

    <div class="border-t px-4 py-4 flex gap-3" style="background:var(--c-surface);border-color:var(--c-border);padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 1rem)">
      <button id="ar-cancel"
              class="flex-1 py-3 rounded-xl font-medium transition-colors" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">
        Cancel
      </button>
      <button id="ar-apply"
              class="flex-1 py-3 rounded-xl font-medium transition-colors" style="background:var(--c-ok);color:#fff">
        Apply
      </button>
    </div>
  `;

  // Toggle buttons without re-rendering the whole screen (prevents page jump)
  overlay.querySelectorAll<HTMLButtonElement>('[data-garmin-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-garmin-id')!;
      const c  = btn.getAttribute('data-choice') as 'integrate' | 'log';
      if (choices[id] === c) return;
      choices[id] = c;
      patchCardButtons(overlay, id, c);
      // Persist immediately so a refresh doesn't lose choices
      const sT = getMutableState();
      const wkT = sT.wks?.[sT.w - 1];
      if (wkT) {
        if (!wkT.garminReviewChoices) wkT.garminReviewChoices = {};
        wkT.garminReviewChoices[id] = c;
        saveState();
      }
    });
  });

  overlay.querySelector('#ar-cancel')?.addEventListener('click', () => {
    overlay.remove();
    if (onCancel) onCancel();
    else onComplete();
  });

  overlay.querySelector('#ar-apply')?.addEventListener('click', () => {
    const integrateCount = Object.values(choices).filter(c => c === 'integrate').length;
    if (integrateCount >= 2) {
      // Batch — show the tap-to-assign Matching Screen
      const pairings  = proposeMatchings(pending, choices, matchCache, allWorkouts);
      const unrated   = allWorkouts.filter(w => wk?.rated[w.id || w.n] === undefined);
      const sWS = getMutableState();
      let weekStartDate: Date | undefined;
      let weekLabel: string | undefined;
      if (sWS.planStartDate) {
        weekStartDate = new Date(sWS.planStartDate);
        weekStartDate.setDate(weekStartDate.getDate() + (sWS.w - 1) * 7);
        const weekEndDate = new Date(weekStartDate);
        weekEndDate.setDate(weekEndDate.getDate() + 6);
        const fmtD = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        weekLabel = `Week ${sWS.w}${sWS.tw ? ` of ${sWS.tw}` : ''} · ${fmtD(weekStartDate)} – ${fmtD(weekEndDate)}`;
      }
      showMatchingScreen(
        overlay,
        pending,
        choices,
        pairings,
        unrated,
        (confirmedMatchings, reductionItems, logonlyItems) => {
          // Save ORIGINAL integrate/log choices to garminReviewChoices BEFORE modification.
          // This preserves the user's intent (e.g. 'integrate') for items that become excess
          // load — so re-review shows them as 'integrate', not 'log'.
          const sOrig = getMutableState();
          const wkOrig = sOrig.wks?.[sOrig.w - 1];
          if (wkOrig) {
            if (!wkOrig.garminReviewChoices) wkOrig.garminReviewChoices = {};
            for (const [id, choice] of Object.entries(choices)) {
              wkOrig.garminReviewChoices[id] = choice;
            }
          }

          // Build updated choices: reduction + logonly bucket items become 'log' for applyReview
          const updatedChoices = { ...choices };
          for (const item of reductionItems) updatedChoices[item.garminId] = 'log';
          for (const item of logonlyItems)   updatedChoices[item.garminId] = 'log';

          // Populate unspentLoadItems for items going to excess load (reduction bucket + tray leftovers)
          populateUnspentLoadItems(reductionItems);

          // Build toast lines before removing overlay
          const toastLines = buildAssignmentLines(pending, choices, updatedChoices, confirmedMatchings, allWorkouts);

          overlay.remove();
          saveState();

          showAssignmentToast(toastLines);
          applyReview(pending, updatedChoices, matchCache, onComplete, confirmedMatchings);
        },
        () => showReviewScreen(overlay, pending, onComplete, choices),
        weekStartDate,
        weekLabel,
      );
    } else {
      overlay.remove();
      applyReview(pending, choices, matchCache, onComplete);
    }
  });
}

/** Group activities by calendar date and render a date header before each group */
function renderByDay(
  pending: GarminPendingItem[],
  choices: Record<string, 'integrate' | 'log'>,
  matchCache: Map<string, MatchResult | null>,
): string {
  // Sort by startTime ascending so days appear in order
  const sorted = [...pending].sort((a, b) => a.startTime.localeCompare(b.startTime));

  // Group into ordered date buckets
  const buckets: { dateKey: string; label: string; items: GarminPendingItem[] }[] = [];
  for (const item of sorted) {
    const d = new Date(item.startTime);
    const dateKey = d.toISOString().slice(0, 10); // YYYY-MM-DD
    let bucket = buckets.find(b => b.dateKey === dateKey);
    if (!bucket) {
      const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      bucket = { dateKey, label, items: [] };
      buckets.push(bucket);
    }
    bucket.items.push(item);
  }

  return buckets.map(bucket => `
    <div>
      <p class="text-xs font-semibold uppercase tracking-wide mb-2" style="color:var(--c-faint)">${bucket.label}</p>
      <div class="space-y-2">
        ${bucket.items.map(item => renderCard(item, choices, matchCache)).join('')}
      </div>
    </div>
  `).join('');
}

function renderCard(
  item: GarminPendingItem,
  choices: Record<string, 'integrate' | 'log'>,
  matchCache: Map<string, MatchResult | null>,
): string {
  const label       = formatActivityType(item.activityType);
  const timeStr     = new Date(item.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const durationMin = Math.round(item.durationSec / 60);
  const distKm      = item.distanceM ? (item.distanceM / 1000).toFixed(1) : null;
  const choice      = choices[item.garminId];
  const match       = matchCache.get(item.garminId) ?? null;

  let matchHint = '';
  if (item.appType === 'run' || item.appType === 'gym' || item.appType === 'other') {
    if (match) {
      const color  = match.confidence === 'high' ? 'color:var(--c-ok)' : 'color:var(--c-caution)';
      const prefix = match.confidence === 'high' ? 'Matches' : 'Possible match';
      matchHint = `<p class="text-xs mt-1" style="${color}">${prefix}: ${match.workoutName}</p>`;
    } else if (item.appType !== 'other') {
      matchHint = `<p class="text-xs mt-1" style="color:var(--c-faint)">No planned session — will log as extra activity</p>`;
    }
  }

  return `
    <div class="rounded-lg border p-3" style="background:var(--c-surface);border-color:var(--c-border)">
      <div class="mb-2.5">
        <p class="font-medium text-sm" style="color:var(--c-black)">${label}</p>
        <p class="text-xs mt-0.5" style="color:var(--c-muted)">${distKm ? `${distKm} km &middot; ` : ''}${durationMin} min &middot; ${timeStr}</p>
        ${matchHint}
      </div>
      <div class="flex gap-2">
        <button data-garmin-id="${item.garminId}" data-choice="integrate"
                class="flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors" style="${
                  choice === 'integrate' ? 'background:var(--c-ok);color:#fff' : 'background:rgba(0,0,0,0.06);color:var(--c-muted)'
                }">${choice === 'integrate' ? '● Integrate' : 'Integrate'}</button>
        <button data-garmin-id="${item.garminId}" data-choice="log"
                class="flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors" style="${
                  choice === 'log' ? 'background:rgba(0,0,0,0.18);color:var(--c-black)' : 'background:rgba(0,0,0,0.06);color:var(--c-muted)'
                }">${choice === 'log' ? '● Log Only' : 'Log Only'}</button>
      </div>
    </div>
  `;
}

function patchCardButtons(overlay: HTMLElement, garminId: string, choice: 'integrate' | 'log'): void {
  const integBtn = overlay.querySelector<HTMLButtonElement>(`[data-garmin-id="${garminId}"][data-choice="integrate"]`);
  const logBtn   = overlay.querySelector<HTMLButtonElement>(`[data-garmin-id="${garminId}"][data-choice="log"]`);

  if (integBtn) {
    const on = choice === 'integrate';
    integBtn.className = `flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors`;
    integBtn.style.cssText = on ? 'background:var(--c-ok);color:#fff' : 'background:rgba(0,0,0,0.06);color:var(--c-muted)';
    integBtn.textContent = on ? '● Integrate' : 'Integrate';
  }
  if (logBtn) {
    const on = choice === 'log';
    logBtn.className = `flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors`;
    logBtn.style.cssText = on ? 'background:rgba(0,0,0,0.18);color:var(--c-black)' : 'background:rgba(0,0,0,0.06);color:var(--c-muted)';
    logBtn.textContent = on ? '● Log Only' : 'Log Only';
  }
}

// ---------------------------------------------------------------------------
// Helpers for matching screen integration

const DAY_SHORT_AR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Add reduction-bucket items to wk.unspentLoadItems for later plan adjustment. */
function populateUnspentLoadItems(items: GarminPendingItem[]): void {
  if (items.length === 0) return;
  const s  = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) return;
  if (!wk.unspentLoadItems) wk.unspentLoadItems = [];

  for (const item of items) {
    // Dedup: skip if this garminId is already in the excess load list
    if (wk.unspentLoadItems.some(u => u.garminId === item.garminId)) continue;
    const aerobic   = item.aerobicEffect   ?? 1.5;
    const anaerobic = item.anaerobicEffect ?? 0.5;
    const sport     = mapAppTypeToSport(item.appType);
    wk.unspentLoadItems.push({
      garminId:    item.garminId,
      displayName: formatActivityType(item.activityType),
      sport,
      durationMin: Math.round(item.durationSec / 60),
      aerobic,
      anaerobic,
      date:   item.startTime.slice(0, 10),
      reason: 'overflow',
    } as UnspentLoadItem);
  }
}

/** Build human-readable toast lines for each pending item. */
function buildAssignmentLines(
  pending: GarminPendingItem[],
  originalChoices: Record<string, 'integrate' | 'log'>,
  updatedChoices: Record<string, 'integrate' | 'log'>,
  confirmedMatchings: Map<string, string | null>,
  allWorkouts: ReturnType<typeof getWeekWorkoutsForReview>,
): string[] {
  const lines: string[] = [];
  for (const item of pending) {
    const name = formatActivityType(item.activityType);
    const updated = updatedChoices[item.garminId];
    const original = originalChoices[item.garminId];

    if (original === 'log' && updated === 'log') {
      // Was always log-only (from review screen choice) — skip, not interesting
      continue;
    }

    const workoutId = confirmedMatchings.get(item.garminId);
    if (workoutId) {
      const w = allWorkouts.find(w => (w.id || w.n) === workoutId);
      const day = w?.dayOfWeek !== undefined ? DAY_SHORT_AR[w.dayOfWeek] : '';
      lines.push(`${name} → ${w?.n ?? workoutId}${day ? ` ${day}` : ''}`);
    } else if (updated === 'log' && original === 'integrate') {
      // Was integrate, now log (could be reduction or logonly bucket)
      // Check if it was a reduction item (added to unspentLoadItems)
      const s  = getMutableState();
      const wk = s.wks?.[s.w - 1];
      const isReduction = wk?.unspentLoadItems?.some(u => u.garminId === item.garminId);
      lines.push(isReduction ? `${name} → Excess load` : `${name} → Logged (no plan impact)`);
    } else if (updated === 'log') {
      lines.push(`${name} → Logged (no plan impact)`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Apply

function applyReview(
  pending: GarminPendingItem[],
  choices: Record<string, 'integrate' | 'log'>,
  matchCache: Map<string, MatchResult | null>,
  onComplete: () => void,
  /** When provided (from Matching Confirmation screen), overrides matchCache for all items. */
  confirmedMatchings?: Map<string, string | null>,
): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) { onComplete(); return; }

  if (!wk.garminMatched) wk.garminMatched = {};
  const usedWorkoutIds = new Set<string>();

  // Persist the user's choices so re-review can pre-populate them.
  // Skip when confirmedMatchings is provided: the matching-screen callback already saved the
  // original (pre-reduction) choices, and we must not overwrite them with 'log' here.
  if (!confirmedMatchings) {
    if (!wk.garminReviewChoices) wk.garminReviewChoices = {};
    for (const [id, choice] of Object.entries(choices)) {
      wk.garminReviewChoices[id] = choice;
    }
  }

  const logItems       = pending.filter(i => choices[i.garminId] === 'log');
  const integrateItems = pending.filter(i => choices[i.garminId] === 'integrate');
  const integrateRuns  = integrateItems.filter(i => i.appType === 'run');
  const integrateGym   = integrateItems.filter(i => i.appType === 'gym');
  const integrateCross = integrateItems.filter(i => i.appType !== 'run' && i.appType !== 'gym');

  // ── 1. Log Only ────────────────────────────────────────────────────────────
  for (const item of logItems) {
    const adhocId = `garmin-${item.garminId}`;
    if (!wk.adhocWorkouts?.some(w => w.id === adhocId)) {
      addAdhocWorkoutFromPending(wk, item, adhocId, deriveItemRPE(item, s));
    }
    wk.garminMatched[item.garminId] = adhocId;
  }

  // ── 2. Runs → match planned runs ──────────────────────────────────────────
  for (const item of integrateRuns) {
    // Guard: if this run is already definitively matched (not __pending__), don't re-process.
    // This prevents double-processing when applyReview is called for activities that were
    // auto-matched by matchAndAutoComplete (and openActivityReReview didn't un-rate them).
    const existingMatch = wk.garminMatched[item.garminId];
    if (existingMatch && existingMatch !== '__pending__' && !existingMatch.startsWith('garmin-')) {
      // Already matched to a plan slot — mark it as used and skip
      usedWorkoutIds.add(existingMatch);
      continue;
    }

    const rpe = deriveItemRPE(item, s);
    // Confirmed matchings from the UI screen override the auto-match
    const confirmedId = confirmedMatchings?.get(item.garminId);
    const matchWorkoutId = confirmedMatchings
      ? (confirmedId ?? null) // explicit null = user chose "no slot"
      : (matchCache.get(item.garminId)?.workoutId ?? null);
    const matchObj = matchWorkoutId ? (matchCache.get(item.garminId) ?? null) : null;
    const allW = getWeekWorkoutsForReview();
    const resolvedName = matchWorkoutId
      ? (matchObj?.workoutName ?? allW.find(w => (w.id || w.n) === matchWorkoutId)?.n ?? matchWorkoutId)
      : null;

    if (matchWorkoutId && !usedWorkoutIds.has(matchWorkoutId) && wk.rated[matchWorkoutId] === undefined) {
      usedWorkoutIds.add(matchWorkoutId);
      wk.rated[matchWorkoutId] = rpe;
      wk.garminMatched[item.garminId] = matchWorkoutId;
      // Alias to reuse existing code below
      const match = { workoutId: matchWorkoutId, workoutName: resolvedName ?? matchWorkoutId, confidence: matchObj?.confidence ?? 'low' as const };

      if (!wk.garminActuals) wk.garminActuals = {};
      wk.garminActuals[match.workoutId] = {
        garminId: item.garminId,
        startTime: item.startTime,
        distanceKm: (item.distanceM ?? 0) / 1000,
        durationSec: item.durationSec,
        avgPaceSecKm: item.distanceM && item.distanceM > 0
          ? Math.round(item.durationSec / (item.distanceM / 1000))
          : null,
        avgHR: item.avgHR,
        maxHR: item.maxHR,
        calories: item.calories,
        aerobicEffect: item.aerobicEffect,
        anaerobicEffect: item.anaerobicEffect,
        workoutName: match.workoutName,
        hrZones: item.hrZones ?? null,
      } as GarminActual;

      log(`Garmin run: ${((item.distanceM ?? 0) / 1000).toFixed(1)} km RPE ${rpe} → "${match.workoutName}"`);
    } else {
      const adhocId = `garmin-${item.garminId}`;
      addAdhocWorkoutFromPending(wk, item, adhocId, rpe);
      wk.garminMatched[item.garminId] = adhocId;
    }
  }

  // ── 3. Gym (HIIT/strength) + Sports (other) → match planned sessions ─────────
  const allWorkouts  = getWeekWorkoutsForReview();
  const planCandidates = allWorkouts.filter(
    w => wk.rated[w.id || w.n] === undefined && !usedWorkoutIds.has(w.id || w.n),
  );
  const gymOverflow:   GarminPendingItem[] = [];
  const sportOverflow: GarminPendingItem[] = [];

  // Gym: match against planned gym sessions
  for (const item of integrateGym) {
    const rpe = deriveItemRPE(item, s);
    // If user confirmed a specific slot in the Matching Confirmation screen, use it
    const confirmedGymId = confirmedMatchings?.get(item.garminId) ?? undefined;
    const autoMatch = findMatchingWorkout(buildExternalActivity(item), planCandidates);
    const matchId   = confirmedMatchings ? (confirmedGymId ?? null) : (autoMatch?.workoutId ?? null);
    const matchName = matchId
      ? (allWorkouts.find(w => (w.id || w.n) === matchId)?.n ?? matchId)
      : null;

    if (matchId && !usedWorkoutIds.has(matchId)) {
      usedWorkoutIds.add(matchId);
      wk.rated[matchId] = rpe;
      wk.garminMatched[item.garminId] = matchId;

      // Store garminActuals so the slot card shows the activity name — no duplicate adhoc
      if (!wk.garminActuals) wk.garminActuals = {};
      wk.garminActuals[matchId] = {
        garminId: item.garminId,
        startTime: item.startTime,
        distanceKm: (item.distanceM ?? 0) / 1000,
        durationSec: item.durationSec,
        avgPaceSecKm: item.distanceM && item.distanceM > 0 ? Math.round(item.durationSec / (item.distanceM / 1000)) : null,
        avgHR: item.avgHR ?? null, maxHR: item.maxHR ?? null, calories: item.calories ?? null,
        aerobicEffect: item.aerobicEffect, anaerobicEffect: item.anaerobicEffect,
        displayName: formatActivityType(item.activityType),
        hrZones: item.hrZones ?? null,
      } as GarminActual;

      const idx = planCandidates.findIndex(w => (w.id || w.n) === matchId);
      if (idx >= 0) planCandidates.splice(idx, 1);

      log(`Garmin ${formatActivityType(item.activityType)}: ${Math.round(item.durationSec / 60)} min RPE ${rpe} → "${matchName}"`);
    } else {
      gymOverflow.push(item);
    }
  }

  // Sports (other): match against recurring cross-training activities by sport name
  for (const item of integrateCross) {
    const rpe = deriveItemRPE(item, s);
    // Honour the user's confirmed selection if present; otherwise use auto-match
    const confirmedCrossId = confirmedMatchings?.get(item.garminId) ?? undefined;
    const autoMatch = matchCache.get(item.garminId) ?? null;
    const matchId   = confirmedMatchings ? (confirmedCrossId ?? null) : (autoMatch?.workoutId ?? null);
    const matchName = matchId
      ? (autoMatch?.workoutName ?? allWorkouts.find(w => (w.id || w.n) === matchId)?.n ?? matchId)
      : null;

    if (matchId && !usedWorkoutIds.has(matchId)) {
      usedWorkoutIds.add(matchId);
      wk.rated[matchId] = rpe;
      wk.garminMatched[item.garminId] = matchId;

      // Store garminActuals so the slot card shows the activity name — no duplicate adhoc
      if (!wk.garminActuals) wk.garminActuals = {};
      wk.garminActuals[matchId] = {
        garminId: item.garminId,
        distanceKm: (item.distanceM ?? 0) / 1000,
        durationSec: item.durationSec,
        avgPaceSecKm: item.distanceM && item.distanceM > 0 ? Math.round(item.durationSec / (item.distanceM / 1000)) : null,
        avgHR: item.avgHR ?? null, maxHR: item.maxHR ?? null, calories: item.calories ?? null,
        aerobicEffect: item.aerobicEffect, anaerobicEffect: item.anaerobicEffect,
        displayName: formatActivityType(item.activityType),
      } as GarminActual;

      const idx = planCandidates.findIndex(w => (w.id || w.n) === matchId);
      if (idx >= 0) planCandidates.splice(idx, 1);

      log(`Garmin ${formatActivityType(item.activityType)}: ${Math.round(item.durationSec / 60)} min RPE ${rpe} → "${matchName}" (sport match)`);
    } else {
      sportOverflow.push(item);
    }
  }

  // ── Step 3b. Generic cross slot matching ──────────────────────────────────
  // Any remaining unmatched sport activities try to fill planned cross slots
  // by day proximity — no sport-name requirement. Only activities that can't
  // fill any slot proceed to the load calc modal.
  //
  // When confirmedMatchings is provided, the user already saw and approved all
  // pairings in the Matching Confirmation screen. Anything still unmatched is
  // genuine overflow — skip the day-proximity heuristic so we don't silently
  // re-assign slots the user explicitly left empty.
  const genericCrossSlots = confirmedMatchings
    ? []
    : planCandidates.filter(w => w.t === 'cross' && !usedWorkoutIds.has(w.id || w.n));
  const trueOverflow: GarminPendingItem[] = [];

  for (const item of sportOverflow) {
    const rpe    = deriveItemRPE(item, s);
    const jsDay  = new Date(item.startTime).getDay();
    const actDay = jsDay === 0 ? 6 : jsDay - 1;

    // Find closest available cross slot by day
    let bestSlot: typeof genericCrossSlots[0] | null = null;
    let bestDiff = Infinity;
    for (const slot of genericCrossSlots) {
      if (slot.dayOfWeek === undefined) continue;
      const diff = Math.min(
        Math.abs(slot.dayOfWeek - actDay),
        7 - Math.abs(slot.dayOfWeek - actDay),
      );
      if (diff < bestDiff) { bestDiff = diff; bestSlot = slot; }
    }

    if (bestSlot) {
      const slotId = bestSlot.id || bestSlot.n;
      usedWorkoutIds.add(slotId);
      wk.rated[slotId] = rpe;
      wk.garminMatched[item.garminId] = slotId;

      // Store garminActuals so the slot card shows the activity name — no duplicate adhoc
      if (!wk.garminActuals) wk.garminActuals = {};
      wk.garminActuals[slotId] = {
        garminId: item.garminId,
        startTime: item.startTime,
        distanceKm: (item.distanceM ?? 0) / 1000,
        durationSec: item.durationSec,
        avgPaceSecKm: item.distanceM && item.distanceM > 0 ? Math.round(item.durationSec / (item.distanceM / 1000)) : null,
        avgHR: item.avgHR ?? null, maxHR: item.maxHR ?? null, calories: item.calories ?? null,
        aerobicEffect: item.aerobicEffect, anaerobicEffect: item.anaerobicEffect,
        displayName: formatActivityType(item.activityType),
        hrZones: item.hrZones ?? null,
      } as GarminActual;

      const idx = genericCrossSlots.findIndex(w => (w.id || w.n) === slotId);
      if (idx >= 0) genericCrossSlots.splice(idx, 1);

      log(`Garmin ${formatActivityType(item.activityType)}: filled generic cross slot "${bestSlot.n}"`);
    } else {
      trueOverflow.push(item);
    }
  }

  // Gym overflow: log as extra adhoc — must NOT trigger run-reduction modal.
  // Gym/strength sessions have no run-equivalent load; reducing runs for them is wrong.
  for (const item of gymOverflow) {
    const adhocId = `garmin-${item.garminId}`;
    if (!wk.adhocWorkouts?.some(w => w.id === adhocId)) {
      addAdhocWorkoutFromPending(wk, item, adhocId, deriveItemRPE(item, s));
    }
    wk.garminMatched[item.garminId] = adhocId;
    log(`Garmin ${formatActivityType(item.activityType)}: no gym slot — logged as extra adhoc`);
  }

  const remainingCross = [...trueOverflow];

  if (remainingCross.length === 0) {
    saveState();
    render();
    onComplete();
    return;
  }

  // ── 4. Remaining cross-training → check load severity → modal only if needed ──
  saveState();

  const s2  = getMutableState();
  const wk2 = s2.wks?.[s2.w - 1];
  if (!wk2) { onComplete(); return; }

  const combinedActivity = buildCombinedActivity(remainingCross, s2);

  // Exclude already-rated workouts so matched runs/gym aren't offered for downgrade
  const freshWorkouts = getWeekWorkoutsForReview().filter(w => {
    const key = w.id || w.n;
    return wk2.rated[key] === undefined;
  });
  const weekRuns = workoutsToPlannedRuns(freshWorkouts, s2.pac);

  const ctx = {
    raceGoal: s2.rd,
    plannedRunsPerWeek: s2.rw,
    injuryMode: !!(s2 as any).injuryState,
    easyPaceSecPerKm: s2.pac?.e,
  };
  const popup = buildCrossTrainingPopup(ctx, weekRuns, combinedActivity);

  // ── Show reduce/replace/keep modal ────────────────────────────────────────
  const sportLabel = remainingCross.length === 1
    ? formatActivityType(remainingCross[0].activityType)
    : `${remainingCross.length} cross-training activities`;

  showSuggestionModal(popup, sportLabel, (decision) => {
    if (!decision) {
      // User dismissed — re-open review with still-pending items (no intro)
      const sD  = getMutableState();
      const wkD = sD.wks?.[sD.w - 1];
      const stillPending = (wkD?.garminPending || []).filter(
        i => wkD?.garminMatched?.[i.garminId] === '__pending__',
      );
      if (stillPending.length > 0) {
        showActivityReview(stillPending, onComplete, /* skipIntro */ true);
      } else {
        onComplete();
      }
      return;
    }

    const s3  = getMutableState();
    const wk3 = s3.wks?.[s3.w - 1];
    if (!wk3) { onComplete(); return; }

    const affectedNames: string[] = [];

    if (decision.choice !== 'keep' && decision.adjustments.length > 0) {
      const freshW   = getWeekWorkoutsForReview();
      const sport    = mapAppTypeToSport(
        remainingCross.find(i => i.appType !== 'other')?.appType ?? 'other',
      );
      const modified = applyAdjustments(freshW, decision.adjustments, normalizeSport(sport), s3.pac);

      if (!wk3.workoutMods) wk3.workoutMods = [];
      for (const adj of decision.adjustments) {
        const mw = modified.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
        if (!mw) continue;
        affectedNames.push(mw.n);
        wk3.workoutMods.push({
          name: mw.n,
          dayOfWeek: mw.dayOfWeek,
          status: mw.status || 'reduced',
          // Always use "Garmin: <activity>" so openActivityReReview() can find and remove it
          modReason: `Garmin: ${sportLabel}`,
          confidence: mw.confidence,
          originalDistance: mw.originalDistance,
          newDistance: mw.d,
          newType: mw.t,
          newRpe: mw.rpe || mw.r,
        } as WorkoutMod);
      }
    }

    for (const item of remainingCross) {
      const adhocId = `garmin-${item.garminId}`;
      if (!wk3.adhocWorkouts?.some(w => w.id === adhocId)) {
        addAdhocWorkoutFromPending(wk3, item, adhocId, deriveItemRPE(item, s3));
      }
      if (!wk3.garminMatched) wk3.garminMatched = {};
      wk3.garminMatched[item.garminId] = adhocId;
    }

    // Store cross-training TL and impact load
    {
      const sport = normalizeSport(combinedActivity.sport) as SportKey;
      const cfg = SPORTS_DB[sport];
      const runSpec = cfg?.runSpec ?? 0.35;
      const impactPerMin = cfg?.impactPerMin ?? 0.04;
      const crossTL = (combinedActivity.iTrimp != null && combinedActivity.iTrimp > 0)
        ? (combinedActivity.iTrimp * 100) / 15000
        : combinedActivity.duration_min * (TL_PER_MIN[combinedActivity.rpe] ?? 1.15) * runSpec;
      wk3.actualTSS = (wk3.actualTSS ?? 0) + Math.round(crossTL);
      wk3.actualImpactLoad = (wk3.actualImpactLoad ?? 0) + Math.round(combinedActivity.duration_min * impactPerMin);
    }

    const affectedStr = affectedNames.length > 0 ? ` — adjusted: ${affectedNames.join(', ')}` : '';
    log(`Garmin: ${sportLabel} applied (${decision.choice}${affectedStr})`);

    saveState();
    render();
    onComplete();
  });
}

// ---------------------------------------------------------------------------
// Matching Confirmation screen (Phase 3 — batch path only)
// ---------------------------------------------------------------------------

/** Short day names for the confirmation screen dropdowns. */
const DAY_SHORT_MC = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Activity type → simple emoji label. */
function activityEmoji(item: GarminPendingItem): string {
  switch (item.appType) {
    case 'run': return '🏃';
    case 'gym': return '💪';
    default: {
      const t = item.activityType.toLowerCase();
      if (t.includes('swim')) return '🏊';
      if (t.includes('cycl') || t.includes('bike') || t.includes('rid')) return '🚴';
      if (t.includes('yoga') || t.includes('pilat')) return '🧘';
      return '⚡';
    }
  }
}

/** Workout type → human-readable short label. */
function workoutTypeShort(t: string): string {
  const map: Record<string, string> = {
    run: 'Run', easy: 'Easy run', long: 'Long run', threshold: 'Threshold',
    vo2: 'VO₂', intervals: 'Intervals', gym: 'Gym', cross: 'Sport slot',
    marathon_pace: 'MP run', race_pace: 'Race pace', rest: 'Rest',
  };
  return map[t] ?? t;
}


/**
 * Dry-run of applyReview's matching steps — returns proposed pairings
 * WITHOUT mutating any state.
 */
function proposeMatchings(
  pending: GarminPendingItem[],
  choices: Record<string, 'integrate' | 'log'>,
  matchCache: Map<string, MatchResult | null>,
  allWorkouts: ReturnType<typeof getWeekWorkoutsForReview>,
): ProposedPairing[] {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) return [];

  const unrated = allWorkouts.filter(w => wk.rated[w.id || w.n] === undefined);
  const used = new Set<string>();
  const pairings: ProposedPairing[] = [];

  const integrate = pending.filter(i => choices[i.garminId] === 'integrate');
  const runs  = integrate.filter(i => i.appType === 'run');
  const gym   = integrate.filter(i => i.appType === 'gym');
  const cross = integrate.filter(i => i.appType !== 'run' && i.appType !== 'gym');

  // 1. Runs → matchCache
  for (const item of runs) {
    const match = matchCache.get(item.garminId) ?? null;
    if (match && !used.has(match.workoutId) && wk.rated[match.workoutId] === undefined) {
      used.add(match.workoutId);
      pairings.push({ item, proposedWorkoutId: match.workoutId, proposedWorkoutName: match.workoutName, confidence: match.confidence, matchType: 'run' });
    } else {
      pairings.push({ item, proposedWorkoutId: null, proposedWorkoutName: null, confidence: null, matchType: 'overflow' });
    }
  }

  // 2. Gym → findMatchingWorkout
  const gymCandidates = unrated.filter(w => !used.has(w.id || w.n));
  for (const item of gym) {
    const match = findMatchingWorkout(buildExternalActivity(item), gymCandidates);
    if (match && !used.has(match.workoutId)) {
      used.add(match.workoutId);
      const idx = gymCandidates.findIndex(w => (w.id || w.n) === match.workoutId);
      if (idx >= 0) gymCandidates.splice(idx, 1);
      pairings.push({ item, proposedWorkoutId: match.workoutId, proposedWorkoutName: match.workoutName, confidence: match.confidence, matchType: 'gym' });
    } else {
      pairings.push({ item, proposedWorkoutId: null, proposedWorkoutName: null, confidence: null, matchType: 'overflow' });
    }
  }

  // 3. Cross-training → named match → generic cross slot → overflow
  const crossCandidates = unrated.filter(w => !used.has(w.id || w.n));
  const crossSlots = [...crossCandidates.filter(w => w.t === 'cross')];
  for (const item of cross) {
    const namedMatch = matchCache.get(item.garminId) ?? null;
    if (namedMatch && !used.has(namedMatch.workoutId)) {
      used.add(namedMatch.workoutId);
      const idx = crossSlots.findIndex(w => (w.id || w.n) === namedMatch.workoutId);
      if (idx >= 0) crossSlots.splice(idx, 1);
      pairings.push({ item, proposedWorkoutId: namedMatch.workoutId, proposedWorkoutName: namedMatch.workoutName, confidence: namedMatch.confidence, matchType: 'sport' });
      continue;
    }
    // Try closest cross slot by day
    const jsDay  = new Date(item.startTime).getDay();
    const actDay = jsDay === 0 ? 6 : jsDay - 1;
    let best: typeof crossSlots[0] | null = null;
    let bestDiff = Infinity;
    for (const slot of crossSlots) {
      if (slot.dayOfWeek === undefined) continue;
      const diff = Math.min(Math.abs(slot.dayOfWeek - actDay), 7 - Math.abs(slot.dayOfWeek - actDay));
      if (diff < bestDiff) { bestDiff = diff; best = slot; }
    }
    if (best) {
      const slotId = best.id || best.n;
      used.add(slotId);
      const idx = crossSlots.findIndex(w => (w.id || w.n) === slotId);
      if (idx >= 0) crossSlots.splice(idx, 1);
      pairings.push({ item, proposedWorkoutId: slotId, proposedWorkoutName: best.n, confidence: 'low', matchType: 'cross-slot' });
    } else {
      pairings.push({ item, proposedWorkoutId: null, proposedWorkoutName: null, confidence: null, matchType: 'overflow' });
    }
  }

  return pairings;
}

/**
 * Show the Matching Confirmation screen in the existing overlay.
 *
 * Displays algorithm-proposed pairings with a dropdown for each item so the
 * user can reassign before committing. On "Confirm →", calls applyReview with
 * the confirmed pairings map; on "← Back", re-renders the review screen.
 */
function showMatchingConfirmation(
  overlay: HTMLElement,
  pending: GarminPendingItem[],
  choices: Record<string, 'integrate' | 'log'>,
  matchCache: Map<string, MatchResult | null>,
  allWorkouts: ReturnType<typeof getWeekWorkoutsForReview>,
  onComplete: () => void,
): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk) { applyReview(pending, choices, matchCache, onComplete); return; }

  const pairings = proposeMatchings(pending, choices, matchCache, allWorkouts);
  const unrated  = allWorkouts.filter(w => wk.rated[w.id || w.n] === undefined);

  // Build a dropdown for each pairing showing all available planned workouts
  const buildSelect = (p: ProposedPairing): string => {
    const selectedId = p.proposedWorkoutId ?? '';
    const options = unrated.map(w => {
      const id  = w.id || w.n;
      const day = w.dayOfWeek !== undefined ? DAY_SHORT_MC[w.dayOfWeek] : '';
      const sel = id === selectedId ? 'selected' : '';
      return `<option value="${id}" ${sel}>${w.n}${day ? ` (${day})` : ''} — ${workoutTypeShort(w.t)}</option>`;
    }).join('');
    const overflowSel = !p.proposedWorkoutId ? 'selected' : '';
    return `
      <select data-garmin-id="${p.item.garminId}"
              class="w-full border text-xs rounded-lg px-2 py-1.5 mt-1.5" style="background:var(--c-bg);border-color:var(--c-border);color:var(--c-black)">
        <option value="" ${overflowSel}>⚠ No slot — load adjustment modal</option>
        ${options}
      </select>`;
  };

  const rows = pairings.map(p => {
    const label   = formatActivityType(p.item.activityType);
    const dur     = Math.round(p.item.durationSec / 60);
    const distKm  = p.item.distanceM ? `${(p.item.distanceM / 1000).toFixed(1)} km · ` : '';
    const timeStr = new Date(p.item.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const emoji   = activityEmoji(p.item);
    const badge   = p.proposedWorkoutId
      ? (p.confidence === 'high'
          ? '<span class="text-xs ml-1.5" style="color:var(--c-ok)">✓ High match</span>'
          : '<span class="text-xs ml-1.5" style="color:var(--c-caution)">~ Possible</span>')
      : '<span class="text-xs ml-1.5" style="color:var(--c-faint)">No slot found</span>';

    return `
      <div class="rounded-lg border p-3" style="background:var(--c-surface);border-color:var(--c-border)">
        <div class="flex items-center justify-between gap-2 mb-0.5">
          <p class="text-sm font-medium" style="color:var(--c-black)">${emoji} ${label}</p>
          <span>${badge}</span>
        </div>
        <p class="text-xs" style="color:var(--c-muted)">${distKm}${dur} min · ${timeStr}</p>
        ${buildSelect(p)}
      </div>`;
  });

  const overflowCount = pairings.filter(p => !p.proposedWorkoutId).length;

  overlay.innerHTML = `
    <div class="border-b" style="background:var(--c-surface);border-color:var(--c-border)">
      <div class="max-w-7xl mx-auto px-4 py-4">
        <h1 class="text-xl font-semibold" style="color:var(--c-black)">Confirm Matching</h1>
        <p class="text-sm mt-0.5" style="color:var(--c-muted)">Review how each activity maps to your plan — adjust if needed.</p>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-4 py-4 space-y-2">
      ${rows.join('')}
      <div class="p-3 border rounded-lg text-xs" style="${overflowCount > 0
        ? 'background:rgba(245,158,11,0.08);border-color:rgba(245,158,11,0.3);color:var(--c-caution)'
        : 'background:rgba(34,197,94,0.08);border-color:rgba(34,197,94,0.3);color:var(--c-ok)'}">
        ${overflowCount > 0
          ? `${overflowCount} activit${overflowCount === 1 ? 'y has' : 'ies have'} no slot — a load adjustment modal will follow.`
          : 'All activities matched — no load adjustment needed.'}
      </div>
    </div>

    <div class="border-t px-4 py-4 flex gap-3" style="background:var(--c-surface);border-color:var(--c-border);padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 1rem)">
      <button id="mc-back"
              class="flex-1 py-3 rounded-xl font-medium transition-colors" style="background:rgba(0,0,0,0.06);color:var(--c-muted)">
        ← Back
      </button>
      <button id="mc-confirm"
              class="flex-1 py-3 rounded-xl font-medium transition-colors" style="background:var(--c-ok);color:#fff">
        Confirm →
      </button>
    </div>
  `;

  // Back → re-render the review screen in-place (preserving integrate/log choices)
  overlay.querySelector('#mc-back')?.addEventListener('click', () => {
    showReviewScreen(overlay, pending, onComplete, choices);
  });

  // Confirm → read each select, build confirmed map, run applyReview
  overlay.querySelector('#mc-confirm')?.addEventListener('click', () => {
    const confirmedMatchings = new Map<string, string | null>();
    overlay.querySelectorAll<HTMLSelectElement>('select[data-garmin-id]').forEach(sel => {
      const garminId = sel.getAttribute('data-garmin-id')!;
      confirmedMatchings.set(garminId, sel.value || null);
    });
    overlay.remove();
    applyReview(pending, choices, matchCache, onComplete, confirmedMatchings);
  });
}

// ---------------------------------------------------------------------------
// Auto-process path (flowing week — single or same-day activities)
// ---------------------------------------------------------------------------

/**
 * Silently slot-match all pending items (treating all as "integrate"),
 * then show the load modal only if there is overflow.
 * Called instead of showActivityReview when it's a single same-day activity
 * and no batch review is needed.
 */
export function autoProcessActivities(
  items: GarminPendingItem[],
  onComplete: () => void,
): void {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk || items.length === 0) { onComplete(); return; }

  if (!wk.garminMatched) wk.garminMatched = {};
  const usedWorkoutIds = new Set<string>();

  // Persist integrate choice for all items (so re-review pre-populates correctly)
  if (!wk.garminReviewChoices) wk.garminReviewChoices = {};
  for (const item of items) wk.garminReviewChoices[item.garminId] = 'integrate';

  const allWorkouts  = getWeekWorkoutsForReview();
  const planCandidates = allWorkouts.filter(
    w => wk.rated[w.id || w.n] === undefined && !usedWorkoutIds.has(w.id || w.n),
  );

  const gymItems   = items.filter(i => i.appType === 'gym');
  const crossItems = items.filter(i => i.appType !== 'run' && i.appType !== 'gym');
  const runItems   = items.filter(i => i.appType === 'run');
  const overflow:  GarminPendingItem[] = [];
  const autoAssignLines: string[] = [];

  // Runs → match closest planned run
  for (const item of runItems) {
    const rpe   = deriveItemRPE(item, s);
    const match = findMatchingWorkout(buildExternalActivity(item), planCandidates);
    if (match && !usedWorkoutIds.has(match.workoutId)) {
      usedWorkoutIds.add(match.workoutId);
      wk.rated[match.workoutId] = rpe;
      wk.garminMatched[item.garminId] = match.workoutId;
      if (!wk.garminActuals) wk.garminActuals = {};
      wk.garminActuals[match.workoutId] = {
        garminId: item.garminId,
        startTime: item.startTime,
        distanceKm: (item.distanceM ?? 0) / 1000,
        durationSec: item.durationSec,
        avgPaceSecKm: item.distanceM && item.distanceM > 0
          ? Math.round(item.durationSec / (item.distanceM / 1000)) : null,
        avgHR: item.avgHR, maxHR: item.maxHR, calories: item.calories,
        aerobicEffect: item.aerobicEffect, anaerobicEffect: item.anaerobicEffect,
        workoutName: match.workoutName,
        hrZones: item.hrZones ?? null,
      } as GarminActual;
      const idx = planCandidates.findIndex(w => (w.id || w.n) === match.workoutId);
      if (idx >= 0) planCandidates.splice(idx, 1);
      log(`Garmin run: ${((item.distanceM ?? 0) / 1000).toFixed(1)} km RPE ${rpe} → "${match.workoutName}"`);
      const runW = allWorkouts.find(w => (w.id || w.n) === match.workoutId);
      const runDay = runW?.dayOfWeek !== undefined ? ` ${DAY_SHORT_AR[runW.dayOfWeek]}` : '';
      autoAssignLines.push(`${formatActivityType(item.activityType)} → ${match.workoutName}${runDay}`);
    } else {
      overflow.push(item);
      autoAssignLines.push(`${formatActivityType(item.activityType)} → Excess load`);
    }
  }

  // Gym → match planned gym sessions
  const gymOverflowAuto: GarminPendingItem[] = [];
  for (const item of gymItems) {
    const rpe   = deriveItemRPE(item, s);
    const match = findMatchingWorkout(buildExternalActivity(item), planCandidates);
    if (match && !usedWorkoutIds.has(match.workoutId)) {
      usedWorkoutIds.add(match.workoutId);
      wk.rated[match.workoutId] = rpe;
      wk.garminMatched[item.garminId] = match.workoutId;
      // Store garminActuals so the slot card shows the activity name — no duplicate adhoc
      if (!wk.garminActuals) wk.garminActuals = {};
      wk.garminActuals[match.workoutId] = {
        garminId: item.garminId,
        startTime: item.startTime,
        distanceKm: (item.distanceM ?? 0) / 1000,
        durationSec: item.durationSec,
        avgPaceSecKm: item.distanceM && item.distanceM > 0 ? Math.round(item.durationSec / (item.distanceM / 1000)) : null,
        avgHR: item.avgHR ?? null, maxHR: item.maxHR ?? null, calories: item.calories ?? null,
        aerobicEffect: item.aerobicEffect, anaerobicEffect: item.anaerobicEffect,
        displayName: formatActivityType(item.activityType),
        hrZones: item.hrZones ?? null,
      } as GarminActual;
      const idx = planCandidates.findIndex(w => (w.id || w.n) === match.workoutId);
      if (idx >= 0) planCandidates.splice(idx, 1);
      log(`Garmin ${formatActivityType(item.activityType)}: ${Math.round(item.durationSec / 60)} min → "${match.workoutName}"`);
      const gymW = allWorkouts.find(w => (w.id || w.n) === match.workoutId);
      const gymDay = gymW?.dayOfWeek !== undefined ? ` ${DAY_SHORT_AR[gymW.dayOfWeek]}` : '';
      autoAssignLines.push(`${formatActivityType(item.activityType)} → ${match.workoutName}${gymDay}`);
    } else {
      gymOverflowAuto.push(item);
      autoAssignLines.push(`${formatActivityType(item.activityType)} → Logged (extra session)`);
    }
  }

  // Gym overflow: log as extra adhoc — must NOT trigger run-reduction modal
  for (const item of gymOverflowAuto) {
    const adhocId = `garmin-${item.garminId}`;
    if (!wk.adhocWorkouts?.some(w => w.id === adhocId)) {
      addAdhocWorkoutFromPending(wk, item, adhocId, deriveItemRPE(item, s));
    }
    wk.garminMatched[item.garminId] = adhocId;
  }

  // Sports → named recurring slot, then generic cross slot
  const genericCrossSlots = planCandidates.filter(
    w => w.t === 'cross' && !usedWorkoutIds.has(w.id || w.n),
  );

  for (const item of crossItems) {
    const rpe  = deriveItemRPE(item, s);
    // Named recurring match
    const namedMatch = findMatchingWorkout(buildExternalActivity(item), planCandidates);
    if (namedMatch && !usedWorkoutIds.has(namedMatch.workoutId)) {
      usedWorkoutIds.add(namedMatch.workoutId);
      wk.rated[namedMatch.workoutId] = rpe;
      wk.garminMatched[item.garminId] = namedMatch.workoutId;
      // Store garminActuals so the slot card shows the activity name — no duplicate adhoc
      if (!wk.garminActuals) wk.garminActuals = {};
      wk.garminActuals[namedMatch.workoutId] = {
        garminId: item.garminId,
        startTime: item.startTime,
        distanceKm: (item.distanceM ?? 0) / 1000,
        durationSec: item.durationSec,
        avgPaceSecKm: item.distanceM && item.distanceM > 0 ? Math.round(item.durationSec / (item.distanceM / 1000)) : null,
        avgHR: item.avgHR ?? null, maxHR: item.maxHR ?? null, calories: item.calories ?? null,
        aerobicEffect: item.aerobicEffect, anaerobicEffect: item.anaerobicEffect,
        displayName: formatActivityType(item.activityType),
        hrZones: item.hrZones ?? null,
      } as GarminActual;
      const idx = planCandidates.findIndex(w => (w.id || w.n) === namedMatch.workoutId);
      if (idx >= 0) planCandidates.splice(idx, 1);
      log(`Garmin ${formatActivityType(item.activityType)}: matched "${namedMatch.workoutName}"`);
      const nmW = allWorkouts.find(w => (w.id || w.n) === namedMatch.workoutId);
      const nmDay = nmW?.dayOfWeek !== undefined ? ` ${DAY_SHORT_AR[nmW.dayOfWeek]}` : '';
      autoAssignLines.push(`${formatActivityType(item.activityType)} → ${namedMatch.workoutName}${nmDay}`);
      continue;
    }
    // Generic cross slot — closest by day
    const jsDay  = new Date(item.startTime).getDay();
    const actDay = jsDay === 0 ? 6 : jsDay - 1;
    let bestSlot: typeof genericCrossSlots[0] | null = null;
    let bestDiff = Infinity;
    for (const slot of genericCrossSlots) {
      if (slot.dayOfWeek === undefined) continue;
      const diff = Math.min(
        Math.abs(slot.dayOfWeek - actDay),
        7 - Math.abs(slot.dayOfWeek - actDay),
      );
      if (diff < bestDiff) { bestDiff = diff; bestSlot = slot; }
    }
    if (bestSlot) {
      const slotId = bestSlot.id || bestSlot.n;
      usedWorkoutIds.add(slotId);
      wk.rated[slotId] = rpe;
      wk.garminMatched[item.garminId] = slotId;
      // Store garminActuals so the slot card shows the activity name — no duplicate adhoc
      if (!wk.garminActuals) wk.garminActuals = {};
      wk.garminActuals[slotId] = {
        garminId: item.garminId,
        startTime: item.startTime,
        distanceKm: (item.distanceM ?? 0) / 1000,
        durationSec: item.durationSec,
        avgPaceSecKm: item.distanceM && item.distanceM > 0 ? Math.round(item.durationSec / (item.distanceM / 1000)) : null,
        avgHR: item.avgHR ?? null, maxHR: item.maxHR ?? null, calories: item.calories ?? null,
        aerobicEffect: item.aerobicEffect, anaerobicEffect: item.anaerobicEffect,
        displayName: formatActivityType(item.activityType),
        hrZones: item.hrZones ?? null,
      } as GarminActual;
      const idx = genericCrossSlots.findIndex(w => (w.id || w.n) === slotId);
      if (idx >= 0) genericCrossSlots.splice(idx, 1);
      log(`Garmin ${formatActivityType(item.activityType)}: filled generic cross slot "${bestSlot.n}"`);
      const csDay = bestSlot.dayOfWeek !== undefined ? ` ${DAY_SHORT_AR[bestSlot.dayOfWeek]}` : '';
      autoAssignLines.push(`${formatActivityType(item.activityType)} → ${bestSlot.n}${csDay}`);
    } else {
      overflow.push(item);
      autoAssignLines.push(`${formatActivityType(item.activityType)} → Excess load`);
    }
  }

  if (overflow.length === 0) {
    saveState();
    showAssignmentToast(autoAssignLines);
    render();
    onComplete();
    return;
  }

  // Overflow → populate unspentLoadItems, then show suggestion modal
  populateUnspentLoadItems(overflow);
  saveState();
  const s2  = getMutableState();
  const wk2 = s2.wks?.[s2.w - 1];
  if (!wk2) { onComplete(); return; }

  const combinedActivity = buildCombinedActivity(overflow, s2);
  const freshWorkouts    = getWeekWorkoutsForReview().filter(w => wk2.rated[w.id || w.n] === undefined);
  const weekRuns         = workoutsToPlannedRuns(freshWorkouts, s2.pac);
  const ctx = { raceGoal: s2.rd, plannedRunsPerWeek: s2.rw, injuryMode: !!(s2 as any).injuryState, easyPaceSecPerKm: s2.pac?.e, runnerType: s2.typ as 'Speed' | 'Endurance' | 'Balanced' | undefined };
  const popup = buildCrossTrainingPopup(ctx, weekRuns, combinedActivity);

  const sportLabel = overflow.length === 1
    ? formatActivityType(overflow[0].activityType)
    : `${overflow.length} cross-training activities`;

  showSuggestionModal(popup, sportLabel, (decision) => {
    if (!decision) {
      // User dismissed modal — keep unspentLoadItems (excess load card shows on training tab)
      showAssignmentToast(autoAssignLines);
      render();
      onComplete();
      return;
    }

    const s3  = getMutableState();
    const wk3 = s3.wks?.[s3.w - 1];
    if (!wk3) { onComplete(); return; }

    if (decision.choice !== 'keep' && decision.adjustments.length > 0) {
      const freshW   = getWeekWorkoutsForReview();
      const sport    = mapAppTypeToSport(overflow.find(i => i.appType !== 'other')?.appType ?? 'other');
      const modified = applyAdjustments(freshW, decision.adjustments, normalizeSport(sport), s3.pac);
      if (!wk3.workoutMods) wk3.workoutMods = [];
      for (const adj of decision.adjustments) {
        const mw = modified.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
        if (!mw) continue;
        wk3.workoutMods.push({
          name: mw.n, dayOfWeek: mw.dayOfWeek, status: mw.status || 'reduced',
          modReason: `Garmin: ${sportLabel}`, confidence: mw.confidence,
          originalDistance: mw.originalDistance, newDistance: mw.d, newType: mw.t, newRpe: mw.rpe || mw.r,
        } as WorkoutMod);
      }
    }

    for (const item of overflow) {
      const adhocId = `garmin-${item.garminId}`;
      if (!wk3.adhocWorkouts?.some(w => w.id === adhocId)) {
        addAdhocWorkoutFromPending(wk3, item, adhocId, deriveItemRPE(item, s3));
      }
      if (!wk3.garminMatched) wk3.garminMatched = {};
      wk3.garminMatched[item.garminId] = adhocId;
    }

    // Plan adjusted — clear unspent items for these overflow activities
    if (wk3.unspentLoadItems) {
      const overflowIds = new Set(overflow.map(i => i.garminId));
      wk3.unspentLoadItems = wk3.unspentLoadItems.filter(u => !overflowIds.has(u.garminId));
    }

    // Store cross-training TL and impact load
    {
      const sport = normalizeSport(combinedActivity.sport) as SportKey;
      const cfg = SPORTS_DB[sport];
      const runSpec = cfg?.runSpec ?? 0.35;
      const impactPerMin = cfg?.impactPerMin ?? 0.04;
      const crossTL = (combinedActivity.iTrimp != null && combinedActivity.iTrimp > 0)
        ? (combinedActivity.iTrimp * 100) / 15000
        : combinedActivity.duration_min * (TL_PER_MIN[combinedActivity.rpe] ?? 1.15) * runSpec;
      wk3.actualTSS = (wk3.actualTSS ?? 0) + Math.round(crossTL);
      wk3.actualImpactLoad = (wk3.actualImpactLoad ?? 0) + Math.round(combinedActivity.duration_min * impactPerMin);
    }

    showAssignmentToast(autoAssignLines);
    saveState();
    render();
    onComplete();
  });
}

// ---------------------------------------------------------------------------

function buildCombinedActivity(
  items: GarminPendingItem[],
  s: ReturnType<typeof getMutableState>,
) {
  // Pick the dominant sport by total duration (most represented type wins)
  const durationByType: Record<string, number> = {};
  for (const item of items) {
    durationByType[item.appType] = (durationByType[item.appType] || 0) + item.durationSec;
  }
  const dominantAppType = Object.entries(durationByType)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
  const sport = mapAppTypeToSport(dominantAppType);

  const totalDurationMin = items.reduce((sum, i) => sum + i.durationSec / 60, 0);
  let weightedRpe = 0;
  for (const item of items) {
    weightedRpe += deriveItemRPE(item, s) * (item.durationSec / 60);
  }
  const avgRPE = Math.round(weightedRpe / totalDurationMin);

  const totalITrimp = items.reduce((sum, i) => sum + (i.iTrimp ?? 0), 0);
  const combinedITrimp = totalITrimp > 0 ? totalITrimp : undefined;
  const combined = createActivity(sport, Math.round(totalDurationMin), avgRPE, undefined, undefined, s.w, combinedITrimp);
  const mostRecent = items.reduce((a, b) => (a.startTime > b.startTime ? a : b));
  const jsDay = new Date(mostRecent.startTime).getDay();
  combined.dayOfWeek = jsDay === 0 ? 6 : jsDay - 1;
  // Aggregate HR zone times (seconds) from all items that have zone data
  const zoneItems = items.filter(i => i.hrZones != null);
  if (zoneItems.length > 0) {
    combined.hrZones = {
      z1: zoneItems.reduce((sum, i) => sum + (i.hrZones?.z1 ?? 0), 0),
      z2: zoneItems.reduce((sum, i) => sum + (i.hrZones?.z2 ?? 0), 0),
      z3: zoneItems.reduce((sum, i) => sum + (i.hrZones?.z3 ?? 0), 0),
      z4: zoneItems.reduce((sum, i) => sum + (i.hrZones?.z4 ?? 0), 0),
      z5: zoneItems.reduce((sum, i) => sum + (i.hrZones?.z5 ?? 0), 0),
    };
  }
  return combined;
}
