/**
 * Matching Screen — tap-to-assign activity → workout slot UI.
 *
 * UX rules:
 *  - Slot cards ordered by day of week (Mon first); show actual date ("Mon 23 Feb")
 *  - Activity tray: runs → gym → cross/other; only UNASSIGNED integrate items shown
 *  - Log-only activities (from review screen) are hidden from tray entirely
 *  - Assigned activities disappear from tray; bucket contents shown as chips
 *  - Tapping a × chip returns that activity to the tray (unassigned)
 *  - Tapping an occupied slot bumps its activity back to the tray (swap)
 */

import type { GarminPendingItem } from '@/types/state';
import type { Workout } from '@/types/state';
import { formatActivityType } from '@/calculations/activity-matcher';

// ─── Day labels ───────────────────────────────────────────────────────────────

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProposedPairing {
  item: GarminPendingItem;
  proposedWorkoutId: string | null;
  proposedWorkoutName: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  matchType: 'run' | 'gym' | 'sport' | 'cross-slot' | 'overflow';
}

interface MatchingState {
  /** garminId → workoutId | 'reduction' | 'logonly' | null (unassigned) */
  assignments: Map<string, string | 'reduction' | 'logonly' | null>;
  selectedGarminId: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function activityEmoji(item: GarminPendingItem): string {
  const t = item.activityType.toLowerCase();
  if (t.includes('run')) return '🏃';
  if (t.includes('gym') || t.includes('strength') || t.includes('hiit') || t.includes('weight')) return '🏋️';
  if (t.includes('swim')) return '🏊';
  if (t.includes('cycl') || t.includes('bike') || t.includes('rid')) return '🚴';
  if (t.includes('yoga') || t.includes('pilat')) return '🧘';
  if (t.includes('walk')) return '🚶';
  if (t.includes('tennis') || t.includes('padel')) return '🎾';
  if (t.includes('soccer') || t.includes('football')) return '⚽';
  if (t.includes('basketball')) return '🏀';
  return '⚡';
}

function workoutTypeShort(t: string): string {
  const map: Record<string, string> = {
    run: 'Run', easy: 'Easy run', long: 'Long run', threshold: 'Threshold',
    vo2: 'VO₂', intervals: 'Intervals', gym: 'Gym', cross: 'Sport slot',
    marathon_pace: 'MP run', race_pace: 'Race pace', rest: 'Rest',
  };
  return map[t] ?? t;
}

function isCompatible(item: GarminPendingItem, workout: Workout): boolean {
  const type = item.appType;
  const wt   = workout.t;
  if (type === 'run') return wt === 'run' || wt === 'easy' || wt === 'long' || wt === 'threshold' || wt === 'steady' || wt === 'vo2' || wt === 'marathon_pace' || wt === 'race_pace' || wt === 'intervals';
  if (type === 'gym') return wt === 'gym';
  return wt === 'cross' || wt === 'other';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Type priority for tray sort: runs first, gym second, cross/other last */
const TYPE_PRI: Record<string, number> = { run: 0, gym: 1 };

// ─── Render ───────────────────────────────────────────────────────────────────

function renderScreen(
  overlay: HTMLElement,
  state: MatchingState,
  pending: GarminPendingItem[],
  choices: Record<string, 'integrate' | 'log'>,
  allWorkouts: Workout[],
  onConfirm: (state: MatchingState) => void,
  onBack: () => void,
  weekStartDate?: Date,
  weekLabel?: string,
): void {
  // Items the user chose to integrate from the review screen
  const integrateItems = pending.filter(i => choices[i.garminId] === 'integrate');

  // Sort slot cards by day of week (Mon=0 first, undefined last)
  const sortedWorkouts = [...allWorkouts].sort((a, b) => (a.dayOfWeek ?? 99) - (b.dayOfWeek ?? 99));

  // Sort tray: runs → gym → cross/other, then chronologically
  const sortedIntegrate = [...integrateItems].sort((a, b) =>
    ((TYPE_PRI[a.appType] ?? 2) - (TYPE_PRI[b.appType] ?? 2)) ||
    a.startTime.localeCompare(b.startTime),
  );

  // Helper: compute full date label for a slot card
  function slotDateLabel(dayOfWeek: number | undefined): string {
    if (dayOfWeek === undefined) return '';
    if (weekStartDate) {
      const d = new Date(weekStartDate.getTime());
      d.setDate(d.getDate() + dayOfWeek);
      return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    }
    return DAY_SHORT[dayOfWeek] ?? '';
  }

  // ── Slot cards ──────────────────────────────────────────────────────────────
  const slotCards = sortedWorkouts.map(w => {
    const wid      = w.id || w.n;
    const dayLabel = slotDateLabel(w.dayOfWeek);
    const assigned = [...state.assignments.entries()].find(([, v]) => v === wid);
    const assignedItem = assigned ? integrateItems.find(i => i.garminId === assigned[0]) : null;

    let assignedBadge = '';
    if (assignedItem) {
      const dur = Math.round(assignedItem.durationSec / 60);
      assignedBadge = `
        <div class="mt-2">
          <span class="text-xs bg-emerald-900/50 border border-emerald-700/50 text-emerald-300 rounded px-1.5 py-0.5">
            ${escHtml(formatActivityType(assignedItem.activityType))} ${dur}min
          </span>
        </div>`;
    }

    const selectedItem = state.selectedGarminId
      ? integrateItems.find(i => i.garminId === state.selectedGarminId)
      : null;
    const canAssign    = selectedItem && !assignedItem && isCompatible(selectedItem, w);
    const canSwap      = selectedItem && !!assignedItem && isCompatible(selectedItem, w);
    const cannotAssign = selectedItem && !assignedItem && !isCompatible(selectedItem, w);

    let borderClass = assignedItem ? 'border-emerald-700/60' : 'border-gray-700';
    if (canAssign || canSwap) borderClass = 'border-blue-500 ring-1 ring-blue-500/50';
    else if (cannotAssign) borderClass = 'border-gray-700 opacity-40';

    let hint = '';
    if (canAssign) hint = '<p class="text-blue-400 text-xs mt-1.5">Tap to assign</p>';
    else if (canSwap) hint = '<p class="text-blue-400 text-xs mt-1.5">Tap to swap</p>';
    else if (cannotAssign) hint = '<p class="text-gray-500 text-xs mt-1.5">Incompatible</p>';
    else if (!state.selectedGarminId && assignedItem) hint = '<p class="text-gray-500 text-xs mt-1.5">Tap to return to tray</p>';

    return `
      <div class="slot-card bg-gray-900 border ${borderClass} rounded-lg p-3 shrink-0 w-44 cursor-pointer transition-all"
           data-workout-id="${escHtml(wid)}">
        <p class="text-white text-xs font-medium">${escHtml(w.n)}</p>
        <p class="text-gray-400 text-xs mt-0.5">${dayLabel ? `${dayLabel} · ` : ''}${workoutTypeShort(w.t)}</p>
        <p class="text-gray-500 text-xs mt-0.5 truncate">${escHtml(w.d.slice(0, 28))}${w.d.length > 28 ? '…' : ''}</p>
        ${assignedBadge}
        ${hint}
      </div>`;
  }).join('');

  // ── Tray: only unassigned integrate items (log-only hidden entirely) ────────
  const trayItems = sortedIntegrate.filter(item => {
    const a = state.assignments.get(item.garminId);
    // Show if unassigned OR currently selected (allow deselect tap)
    return (a === null || a === undefined) || item.garminId === state.selectedGarminId;
  });

  const trayCards = trayItems.map(item => {
    const isSelected = state.selectedGarminId === item.garminId;
    const dur        = Math.round(item.durationSec / 60);
    const dist       = item.distanceM ? `${(item.distanceM / 1000).toFixed(1)} km · ` : '';
    const actDateStr = new Date(item.startTime).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    return `
      <div class="activity-card bg-gray-900 border ${isSelected ? 'border-blue-500 ring-1 ring-blue-500/50' : 'border-gray-700'} rounded-lg p-3 shrink-0 w-44 cursor-pointer transition-all"
           data-garmin-id="${escHtml(item.garminId)}">
        <p class="text-white text-xs font-medium">${activityEmoji(item)} ${escHtml(formatActivityType(item.activityType))}</p>
        <p class="text-gray-400 text-xs mt-0.5">${actDateStr}</p>
        <p class="text-gray-400 text-xs mt-0.5">${dist}${dur} min</p>
        ${isSelected
          ? '<p class="text-blue-300 text-xs mt-1.5 font-medium">↑ Now tap a slot</p>'
          : '<p class="text-gray-500 text-xs mt-1.5">Tap to select</p>'}
      </div>`;
  }).join('');

  const assignedToSlotCount = sortedIntegrate.filter(i => {
    const a = state.assignments.get(i.garminId);
    return a && a !== 'reduction' && a !== 'logonly';
  }).length;

  // ── Bucket contents (chips with × to return to tray) ─────────────────────
  // Reduction bucket: all 'integrate' items, all removable
  const reductionBucketItems = [...state.assignments.entries()]
    .filter(([, v]) => v === 'reduction')
    .map(([gid]) => integrateItems.find(i => i.garminId === gid))
    .filter((i): i is GarminPendingItem => !!i);

  // Logonly bucket: 'integrate' items manually sent (removable) vs original 'log' (not removable)
  const logonlyBucketItems = [...state.assignments.entries()]
    .filter(([, v]) => v === 'logonly')
    .map(([gid]) => {
      const item = pending.find(i => i.garminId === gid);
      if (!item) return null;
      return { item, removable: choices[gid] === 'integrate' };
    })
    .filter((x): x is { item: GarminPendingItem; removable: boolean } => !!x);

  function bucketChips(items: GarminPendingItem[], chipClass: string): string {
    if (items.length === 0) return '';
    return `<div class="mt-2 flex flex-wrap gap-1.5">
      ${items.map(item => `
        <button class="bucket-chip text-xs ${chipClass} rounded-md px-2 py-0.5 flex items-center gap-1"
                data-garmin-id="${escHtml(item.garminId)}">
          ${activityEmoji(item)} ${escHtml(formatActivityType(item.activityType))} ×
        </button>
      `).join('')}
    </div>`;
  }

  function staticChips(items: GarminPendingItem[]): string {
    if (items.length === 0) return '';
    return `<div class="mt-2 flex flex-wrap gap-1.5">
      ${items.map(item => `
        <span class="text-xs text-gray-500 border border-gray-700 rounded-md px-2 py-0.5">
          ${activityEmoji(item)} ${escHtml(formatActivityType(item.activityType))}
        </span>
      `).join('')}
    </div>`;
  }

  const reductionChipsHtml = bucketChips(
    reductionBucketItems,
    'bg-amber-900/40 border border-amber-700/40 text-amber-200',
  );
  const logonlyRemovable = logonlyBucketItems.filter(x => x.removable).map(x => x.item);
  const logonlyFixed     = logonlyBucketItems.filter(x => !x.removable).map(x => x.item);
  const logonlyChipsHtml = bucketChips(logonlyRemovable, 'bg-gray-700/60 border border-gray-600/60 text-gray-300')
    + staticChips(logonlyFixed);

  // ── Counts ──
  const hasSelected     = state.selectedGarminId !== null;
  const reductionCount  = reductionBucketItems.length;
  const logonlyCount    = logonlyBucketItems.length;
  const unassignedCount = sortedIntegrate.filter(i => {
    const a = state.assignments.get(i.garminId);
    return a === null || a === undefined;
  }).length;

  const reductionBorderClass = hasSelected ? 'border-amber-600/60 ring-1 ring-amber-600/30' : 'border-gray-700';
  const logonlyBorderClass   = hasSelected ? 'border-gray-600 ring-1 ring-gray-600/30'      : 'border-gray-700';

  // ── Full render ─────────────────────────────────────────────────────────────
  overlay.innerHTML = `
    <div class="bg-gray-900 border-b border-gray-800">
      <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-2">
        <button id="ms-back" class="text-gray-400 text-sm shrink-0">← Back</button>
        <div class="text-center min-w-0">
          <p class="text-sm font-semibold text-white">Assign Activities</p>
          ${weekLabel ? `<p class="text-xs text-gray-400 truncate">${escHtml(weekLabel)}</p>` : ''}
          <p class="text-xs text-gray-500 mt-0.5">Suggested matches applied — move anything around if needed</p>
        </div>
        <button id="ms-confirm"
                class="text-sm font-medium px-3 py-1 rounded-lg transition-colors shrink-0 bg-emerald-600 text-white">
          Confirm →
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">

      <!-- 1. Week Slots -->
      <div class="px-4 pt-4 pb-2">
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Week Slots</p>
        ${sortedWorkouts.length === 0
          ? '<p class="text-gray-500 text-xs">No unrated planned workouts this week.</p>'
          : `<div class="flex gap-3 overflow-x-auto pb-2" style="-webkit-overflow-scrolling: touch; scrollbar-width: none;">
               ${slotCards}
             </div>`}
      </div>

      <!-- 2. Activity Tray (unassigned integrate items only) -->
      <div class="px-4 pt-2 pb-3 border-t border-gray-800">
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Select Activity
          ${assignedToSlotCount > 0 ? `<span class="text-emerald-400 normal-case font-normal ml-2">${assignedToSlotCount} in slots ✓</span>` : ''}
          ${hasSelected ? '<span class="text-blue-400 normal-case font-normal ml-2">Now tap a slot ↑</span>' : ''}
        </p>
        ${trayItems.length === 0
          ? `<p class="text-emerald-400 text-xs py-1">${sortedIntegrate.length > 0 ? 'All activities placed ✓' : 'No activities to assign.'}</p>`
          : `<div class="flex gap-3 overflow-x-auto pb-2" style="-webkit-overflow-scrolling: touch; scrollbar-width: none;">
               ${trayCards}
             </div>`}
      </div>

      <!-- 3. Excess Load bucket -->
      <div class="px-4 pt-2 pb-2 border-t border-gray-800">
        <div id="bucket-reduction"
             class="bg-amber-950/20 border ${reductionBorderClass} rounded-lg p-3 cursor-pointer transition-all">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-amber-300 text-sm font-medium">Excess Load</p>
              <p class="text-xs text-amber-400/70 mt-0.5">Load held — adjust plan after confirm</p>
            </div>
            ${reductionCount > 0 ? `<span class="text-xs bg-amber-900/50 border border-amber-700/50 text-amber-300 rounded-full px-2 py-0.5">${reductionCount}</span>` : ''}
          </div>
          ${hasSelected ? '<p class="text-amber-400 text-xs mt-1.5">Tap to send here</p>' : ''}
          ${reductionChipsHtml ? `<p class="text-amber-500/70 text-xs mt-2 mb-0.5">Tap × to return to tray:</p>${reductionChipsHtml}` : ''}
        </div>
      </div>

      <!-- 4. Log Only bucket -->
      <div class="px-4 pt-0 pb-4">
        <div id="bucket-logonly"
             class="bg-gray-800/30 border ${logonlyBorderClass} rounded-lg p-3 cursor-pointer transition-all">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-gray-300 text-sm font-medium">Log Only</p>
              <p class="text-xs text-gray-400 mt-0.5">Recorded, no plan impact</p>
            </div>
            ${logonlyCount > 0 ? `<span class="text-xs bg-gray-700 text-gray-300 rounded-full px-2 py-0.5">${logonlyCount}</span>` : ''}
          </div>
          ${hasSelected ? '<p class="text-gray-400 text-xs mt-1.5">Tap to send here</p>' : ''}
          ${logonlyChipsHtml ? `<p class="text-gray-500 text-xs mt-2 mb-0.5">Tap × to return to tray:</p>${logonlyChipsHtml}` : ''}
        </div>
      </div>

      ${unassignedCount > 0 ? `
      <div class="px-4 pb-4">
        <div class="bg-blue-950/20 border border-blue-800/50 rounded-lg p-3 text-xs text-blue-300">
          ${unassignedCount} activit${unassignedCount === 1 ? 'y' : 'ies'} in tray — tap to assign to a slot or Log Only, or confirm to send to Excess Load.
        </div>
      </div>` : ''}

    </div>
  `;

  // ─── Event handlers ──────────────────────────────────────────────────────────

  overlay.querySelector('#ms-back')?.addEventListener('click', onBack);
  overlay.querySelector('#ms-confirm')?.addEventListener('click', () => onConfirm(state));

  // Activity card: select / deselect
  overlay.querySelectorAll<HTMLElement>('.activity-card').forEach(card => {
    card.addEventListener('click', () => {
      const gid = card.getAttribute('data-garmin-id')!;
      state.selectedGarminId = state.selectedGarminId === gid ? null : gid;
      renderScreen(overlay, state, pending, choices, allWorkouts, onConfirm, onBack, weekStartDate, weekLabel);
    });
  });

  // Slot card: assign selected, swap if occupied, or return-to-tray if occupied with nothing selected
  overlay.querySelectorAll<HTMLElement>('.slot-card').forEach(card => {
    card.addEventListener('click', () => {
      const wid  = card.getAttribute('data-workout-id')!;
      if (!state.selectedGarminId) {
        // Nothing selected — if slot is occupied, deassign back to tray
        const already = [...state.assignments.entries()].find(([, v]) => v === wid);
        if (already) {
          state.assignments.set(already[0], null);
          renderScreen(overlay, state, pending, choices, allWorkouts, onConfirm, onBack, weekStartDate, weekLabel);
        }
        return;
      }
      const item = integrateItems.find(i => i.garminId === state.selectedGarminId)!;
      const w    = allWorkouts.find(w => (w.id || w.n) === wid);
      if (!w || !isCompatible(item, w)) {
        card.classList.add('animate-shake');
        setTimeout(() => card.classList.remove('animate-shake'), 400);
        return;
      }
      // If slot occupied, bump existing back to unassigned (returns to tray)
      const already = [...state.assignments.entries()].find(([, v]) => v === wid);
      if (already) state.assignments.set(already[0], null);

      state.assignments.set(state.selectedGarminId, wid);
      state.selectedGarminId = null;
      renderScreen(overlay, state, pending, choices, allWorkouts, onConfirm, onBack, weekStartDate, weekLabel);
    });
  });

  // Reduction bucket: send selected to excess load
  overlay.querySelector('#bucket-reduction')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('.bucket-chip')) return;
    if (!state.selectedGarminId) return;
    state.assignments.set(state.selectedGarminId, 'reduction');
    state.selectedGarminId = null;
    renderScreen(overlay, state, pending, choices, allWorkouts, onConfirm, onBack, weekStartDate, weekLabel);
  });

  // Log-only bucket: send selected to log only
  overlay.querySelector('#bucket-logonly')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('.bucket-chip')) return;
    if (!state.selectedGarminId) return;
    state.assignments.set(state.selectedGarminId, 'logonly');
    state.selectedGarminId = null;
    renderScreen(overlay, state, pending, choices, allWorkouts, onConfirm, onBack, weekStartDate, weekLabel);
  });

  // Bucket chips: tap × to return item to tray (unassigned)
  overlay.querySelectorAll<HTMLElement>('.bucket-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const gid = chip.getAttribute('data-garmin-id')!;
      state.assignments.set(gid, null);
      state.selectedGarminId = null;
      renderScreen(overlay, state, pending, choices, allWorkouts, onConfirm, onBack, weekStartDate, weekLabel);
    });
  });
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Show the tap-to-assign Matching Screen.
 *
 * @param overlay        Full-screen overlay element (reused from review screen)
 * @param pending        All pending Garmin items (integrate + log)
 * @param choices        integrate/log choices per garminId from review screen
 * @param pairings       Pre-computed pairings from proposeMatchings()
 * @param allWorkouts    Week workouts filtered to unrated
 * @param onConfirm      Called on confirm with final assignments + bucket items
 * @param onBack         Called on ← Back
 * @param weekStartDate  First day of the current plan week (for date display)
 * @param weekLabel      e.g. "Week 4 of 10 · Mon 17 – Sun 23 Feb" for header
 */
export function showMatchingScreen(
  overlay: HTMLElement,
  pending: GarminPendingItem[],
  choices: Record<string, 'integrate' | 'log'>,
  pairings: ProposedPairing[],
  allWorkouts: Workout[],
  onConfirm: (confirmedMatchings: Map<string, string | null>, reductionItems: GarminPendingItem[], logonlyItems: GarminPendingItem[]) => void,
  onBack: () => void,
  weekStartDate?: Date,
  weekLabel?: string,
): void {
  const assignments = new Map<string, string | 'reduction' | 'logonly' | null>();
  for (const p of pairings) {
    // Overflow items start in the tray (null) so the user can manually assign them.
    // They become Excess Load on confirm if still unassigned.
    assignments.set(p.item.garminId, p.matchType === 'overflow' ? null : p.proposedWorkoutId);
  }
  // Original log-only items go to logonly bucket
  for (const item of pending.filter(i => choices[i.garminId] === 'log')) {
    assignments.set(item.garminId, 'logonly');
  }

  const state: MatchingState = { assignments, selectedGarminId: null };

  const handleConfirm = (s: MatchingState) => {
    const confirmed    = new Map<string, string | null>();
    const reductionIds: string[] = [];
    const logonlyIds: string[]   = [];

    for (const [gid, val] of s.assignments.entries()) {
      // null = still in tray (user didn't assign) → treat as excess load, same as 'reduction'
      if (val === 'reduction' || val === null) { reductionIds.push(gid); confirmed.set(gid, null); }
      else if (val === 'logonly') { logonlyIds.push(gid); confirmed.set(gid, null); }
      else { confirmed.set(gid, val); }
    }

    const integrateItems = pending.filter(i => choices[i.garminId] === 'integrate');
    const reductionItems = integrateItems.filter(i => reductionIds.includes(i.garminId));
    const logonlyItems   = pending.filter(i => logonlyIds.includes(i.garminId));

    onConfirm(confirmed, reductionItems, logonlyItems);
  };

  renderScreen(overlay, state, pending, choices, allWorkouts, handleConfirm, onBack, weekStartDate, weekLabel);
}
