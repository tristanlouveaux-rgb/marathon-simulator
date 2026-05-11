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
import { getState } from '@/state';
import { formatKm, fmtDesc } from '@/utils/format';
import { buildAtmosphereBase, buildSunGlint } from '@/ui/page-flair';

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
    marathon_pace: 'MP run', race_pace: 'Race pace', float: 'Float', rest: 'Rest',
  };
  return map[t] ?? t;
}

function isCompatible(item: GarminPendingItem, workout: Workout): boolean {
  const type = item.appType;
  const wt   = workout.t;
  // Runs match run-type slots, general sport (cross) slots, and the run leg of a brick
  if (type === 'run') return wt === 'run' || wt === 'easy' || wt === 'long' || wt === 'threshold' || wt === 'steady' || wt === 'vo2' || wt === 'marathon_pace' || wt === 'race_pace' || wt === 'intervals' || wt === 'float' || wt === 'cross' || wt === 'brick';
  // Gym/strength matches gym slots
  if (type === 'gym') return wt === 'gym';
  // Cycling matches any tri bike slot, brick (bike+run combo), or generic cross slot
  if (type === 'ride') return wt === 'cross' || wt === 'brick' || wt.startsWith('bike_');
  // Swimming matches any tri swim slot or generic cross slot
  if (type === 'swim') return wt === 'cross' || wt.startsWith('swim_');
  // Other cross-training (walks, sports, etc.) only match cross slots
  return wt === 'cross';
}

function escHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  const unitPref = getState().unitPref ?? 'km';
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

    const selectedItem = state.selectedGarminId
      ? integrateItems.find(i => i.garminId === state.selectedGarminId)
      : null;
    const canAssign    = selectedItem && !assignedItem && isCompatible(selectedItem, w);
    const canSwap      = selectedItem && !!assignedItem && isCompatible(selectedItem, w);
    const cannotAssign = selectedItem && !assignedItem && !isCompatible(selectedItem, w);

    const baseShadow = '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)';
    let boxShadow = baseShadow;
    let opacity = '1';
    if (canAssign || canSwap) boxShadow = `0 0 0 1.5px var(--c-accent), ${baseShadow}`;
    else if (cannotAssign) { opacity = '0.4'; }
    else if (assignedItem) boxShadow = `0 0 0 1px rgba(34,197,94,0.45), ${baseShadow}`;

    const assignedBadge = assignedItem ? `
      <div style="margin-top:6px;display:inline-flex;align-items:center;gap:5px;padding:3px 8px 3px 7px;border-radius:100px;background:rgba(0,0,0,0.04)">
        <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--c-ok)"></span>
        <span style="font-size:10px;font-weight:600;color:var(--c-black)">${escHtml(formatActivityType(assignedItem.activityType))}</span>
        <span style="font-size:10px;color:var(--c-muted)">${Math.round(assignedItem.durationSec / 60)} min</span>
      </div>` : '';

    const hint = canAssign ? `<div style="font-size:10px;color:var(--c-accent);margin-top:6px;font-weight:500">Tap to assign</div>`
      : canSwap ? `<div style="font-size:10px;color:var(--c-accent);margin-top:6px;font-weight:500">Tap to swap</div>`
      : (!state.selectedGarminId && assignedItem) ? `<div style="font-size:10px;color:var(--c-faint);margin-top:6px">Tap to unassign</div>`
      : '';

    const descSnippet = fmtDesc(w.d || '', unitPref).slice(0, 32);
    return `
      <div class="slot-card" data-workout-id="${escHtml(wid)}"
           style="background:var(--c-surface);border-radius:14px;padding:11px 13px;flex-shrink:0;width:164px;cursor:pointer;transition:box-shadow 0.18s, transform 0.18s;opacity:${opacity};box-shadow:${boxShadow}">
        <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-0.01em">${escHtml(w.n)}</div>
        <div style="font-size:10px;color:var(--c-muted)">${dayLabel ? dayLabel + ' · ' : ''}${workoutTypeShort(w.t)}</div>
        ${descSnippet ? `<div style="font-size:10px;color:var(--c-faint);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(descSnippet)}${w.d.length > 32 ? '…' : ''}</div>` : ''}
        ${assignedBadge}
        ${hint}
      </div>`;
  }).join('');

  // ── Tray: only unassigned integrate items ────────────────────────────────
  const trayItems = sortedIntegrate.filter(item => {
    const a = state.assignments.get(item.garminId);
    return (a === null || a === undefined) || item.garminId === state.selectedGarminId;
  });

  const trayCards = trayItems.map(item => {
    const isSelected = state.selectedGarminId === item.garminId;
    const dur        = Math.round(item.durationSec / 60);
    const dist       = item.distanceM ? `${formatKm(item.distanceM / 1000, unitPref)} · ` : '';
    const actDateStr = new Date(item.startTime).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    const baseShadow = '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)';
    const boxShadow = isSelected ? `0 0 0 1.5px var(--c-accent), ${baseShadow}` : baseShadow;

    return `
      <div class="activity-card" data-garmin-id="${escHtml(item.garminId)}"
           style="background:var(--c-surface);border-radius:14px;padding:11px 13px;flex-shrink:0;width:164px;cursor:pointer;transition:box-shadow 0.18s, transform 0.18s;box-shadow:${boxShadow}">
        <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px;letter-spacing:-0.01em">${escHtml(formatActivityType(item.activityType))}</div>
        <div style="font-size:10px;color:var(--c-muted)">${actDateStr}</div>
        <div style="font-size:10px;color:var(--c-muted);margin-top:1px">${dist}${dur} min</div>
        <div style="font-size:10px;margin-top:6px;font-weight:${isSelected ? '600' : '500'};color:${isSelected ? 'var(--c-accent)' : 'var(--c-faint)'}">
          ${isSelected ? '↑ Now tap a slot' : 'Tap to select'}
        </div>
      </div>`;
  }).join('');

  const assignedToSlotCount = sortedIntegrate.filter(i => {
    const a = state.assignments.get(i.garminId);
    return a && a !== 'reduction' && a !== 'logonly';
  }).length;

  // ── Bucket contents (chips with × to return to tray) ─────────────────────
  const reductionBucketItems = [...state.assignments.entries()]
    .filter(([, v]) => v === 'reduction')
    .map(([gid]) => integrateItems.find(i => i.garminId === gid))
    .filter((i): i is GarminPendingItem => !!i);

  const logonlyBucketItems = [...state.assignments.entries()]
    .filter(([, v]) => v === 'logonly')
    .map(([gid]) => {
      const item = pending.find(i => i.garminId === gid);
      if (!item) return null;
      return { item, removable: choices[gid] === 'integrate' };
    })
    .filter((x): x is { item: GarminPendingItem; removable: boolean } => !!x);

  function bucketChips(items: GarminPendingItem[], color: string, bg: string): string {
    if (items.length === 0) return '';
    return `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
      ${items.map(item => `
        <button class="bucket-chip" data-garmin-id="${escHtml(item.garminId)}"
                style="font-size:10px;color:${color};background:${bg};border:1px solid ${color}33;border-radius:4px;padding:2px 8px;cursor:pointer">
          ${escHtml(formatActivityType(item.activityType))} ×
        </button>
      `).join('')}
    </div>`;
  }

  function staticChips(items: GarminPendingItem[]): string {
    if (items.length === 0) return '';
    return `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
      ${items.map(item => `
        <span style="font-size:10px;color:var(--c-faint);background:rgba(0,0,0,0.04);border:1px solid var(--c-border);border-radius:4px;padding:2px 8px">
          ${escHtml(formatActivityType(item.activityType))}
        </span>
      `).join('')}
    </div>`;
  }

  const reductionChipsHtml = bucketChips(reductionBucketItems, '#d97706', 'rgba(245,158,11,0.08)');
  const logonlyRemovable   = logonlyBucketItems.filter(x => x.removable).map(x => x.item);
  const logonlyFixed       = logonlyBucketItems.filter(x => !x.removable).map(x => x.item);
  const logonlyChipsHtml   = bucketChips(logonlyRemovable, 'var(--c-muted)', 'rgba(0,0,0,0.04)') + staticChips(logonlyFixed);

  const hasSelected    = state.selectedGarminId !== null;
  const reductionCount = reductionBucketItems.length;
  const logonlyCount   = logonlyBucketItems.length;
  const unassignedCount = sortedIntegrate.filter(i => {
    const a = state.assignments.get(i.garminId);
    return a === null || a === undefined;
  }).length;

  const bucketBaseShadow = '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)';
  const reductionShadow = hasSelected
    ? `0 0 0 1.5px rgba(245,158,11,0.55), ${bucketBaseShadow}`
    : bucketBaseShadow;
  const logonlyShadow = hasSelected
    ? `0 0 0 1.5px rgba(0,0,0,0.18), ${bucketBaseShadow}`
    : bucketBaseShadow;

  // ── Full render ─────────────────────────────────────────────────────────────
  overlay.innerHTML = `
    ${buildAtmosphereBase('blue')}
    ${buildSunGlint('low')}

    <div style="position:relative;z-index:10;display:flex;flex-direction:column;flex:1;min-height:0;width:100%">

      <!-- Header -->
      <div style="background:rgba(255,255,255,0.72);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,0,0,0.05);padding:12px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-shrink:0">
        <button id="ms-back" style="font-size:13px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 0;flex-shrink:0">← Cancel</button>
        <div style="text-align:center;min-width:0">
          <div style="font-size:15px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black)">Match Activities</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:2px">Auto-matched below. Tap to reassign.</div>
        </div>
        <button id="ms-confirm" class="m-btn-glass m-btn-glass--inset" style="font-size:12px;font-weight:600;padding:6px 18px;flex-shrink:0;height:32px">Save</button>
      </div>

      <!-- Scroll body -->
      <div style="flex:1;overflow-y:auto">
        <div style="max-width:560px;margin:0 auto">

          <!-- Plan Slots -->
          <div style="padding:18px 18px 12px">
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Plan Slots</div>
              ${assignedToSlotCount > 0 ? `<div style="font-size:11px;color:var(--c-muted)">${assignedToSlotCount} matched</div>` : ''}
            </div>
            ${sortedWorkouts.length === 0
              ? `<p style="font-size:12px;color:var(--c-muted)">No unrated sessions this week.</p>`
              : `<div style="display:flex;gap:10px;overflow-x:auto;padding:2px 0 6px;-webkit-overflow-scrolling:touch;scrollbar-width:none">${slotCards}</div>`}
          </div>

          <!-- Activities (tray) -->
          <div style="padding:8px 18px 14px">
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Your Activities</div>
              ${hasSelected
                ? `<div style="font-size:11px;color:var(--c-accent);font-weight:500">Now tap a slot ↑</div>`
                : unassignedCount > 0
                  ? `<div style="font-size:11px;color:var(--c-muted)">${unassignedCount} unplaced</div>`
                  : ''}
            </div>
            ${trayItems.length === 0
              ? `<p style="font-size:12px;color:var(--c-muted)">${sortedIntegrate.length > 0 ? 'All placed.' : 'Nothing to assign.'}</p>`
              : `<div style="display:flex;gap:10px;overflow-x:auto;padding:2px 0 6px;-webkit-overflow-scrolling:touch;scrollbar-width:none">${trayCards}</div>`}
          </div>

          <!-- Excess Load bucket -->
          <div style="padding:6px 18px 10px">
            <div id="bucket-reduction" style="background:var(--c-surface);border-radius:14px;padding:13px 16px;cursor:pointer;transition:box-shadow 0.18s;box-shadow:${reductionShadow}">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <div style="min-width:0">
                  <div style="font-size:13px;font-weight:600;color:var(--c-caution);letter-spacing:-0.005em">Excess Load</div>
                  <div style="font-size:11px;color:var(--c-muted);margin-top:2px">Saved for later plan adjustment</div>
                </div>
                ${reductionCount > 0
                  ? `<span style="font-size:11px;font-weight:600;color:var(--c-caution);background:transparent;border:1px solid rgba(245,158,11,0.45);border-radius:100px;padding:2px 10px;flex-shrink:0">${reductionCount}</span>`
                  : ''}
              </div>
              ${hasSelected ? `<div style="font-size:11px;color:var(--c-caution);margin-top:6px;font-weight:500">Tap to send here</div>` : ''}
              ${reductionChipsHtml}
            </div>
          </div>

          <!-- Log Only bucket -->
          <div style="padding:0 18px 14px">
            <div id="bucket-logonly" style="background:var(--c-surface);border-radius:14px;padding:13px 16px;cursor:pointer;transition:box-shadow 0.18s;box-shadow:${logonlyShadow}">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <div style="min-width:0">
                  <div style="font-size:13px;font-weight:600;color:var(--c-black);letter-spacing:-0.005em">Log Only</div>
                  <div style="font-size:11px;color:var(--c-muted);margin-top:2px">Recorded, no plan impact</div>
                </div>
                ${logonlyCount > 0
                  ? `<span style="font-size:11px;font-weight:600;color:var(--c-muted);background:transparent;border:1px solid var(--c-border-strong, rgba(0,0,0,0.18));border-radius:100px;padding:2px 10px;flex-shrink:0">${logonlyCount}</span>`
                  : ''}
              </div>
              ${hasSelected ? `<div style="font-size:11px;color:var(--c-muted);margin-top:6px;font-weight:500">Tap to send here</div>` : ''}
              ${logonlyChipsHtml}
            </div>
          </div>

          ${unassignedCount > 0 ? `
          <div style="padding:0 20px 24px">
            <div style="font-size:11px;color:var(--c-faint);line-height:1.5">
              Unplaced activities go to Excess Load when you save.
            </div>
          </div>` : '<div style="height:24px"></div>'}

        </div>
      </div>
    </div>
  `;

  // ─── Event handlers ──────────────────────────────────────────────────────────

  overlay.querySelector('#ms-back')?.addEventListener('click', onBack);
  overlay.querySelector('#ms-confirm')?.addEventListener('click', () => {
    // Detect any slot-assigned activity that ran >10 min more than planned
    const overItems: { label: string; overMin: number }[] = [];
    for (const item of integrateItems) {
      const assignedWid = state.assignments.get(item.garminId);
      if (!assignedWid || assignedWid === 'reduction' || assignedWid === 'logonly') continue;
      const w = allWorkouts.find(w => (w.id || w.n) === assignedWid);
      const plannedMin = w?.estimatedDurationMin ?? 0;
      const actualMin = item.durationSec / 60;
      if (plannedMin > 0 && actualMin - plannedMin > 10) {
        overItems.push({ label: formatActivityType(item.activityType), overMin: Math.round(actualMin - plannedMin) });
      }
    }
    if (overItems.length === 0) { onConfirm(state); return; }

    const popup = document.createElement('div');
    popup.className = 'fixed inset-0 z-[300] flex items-center justify-center p-4';
    popup.style.background = 'rgba(0,0,0,0.45)';
    const bodyLines = overItems.map(o =>
      `<p style="font-size:13px;color:var(--c-muted);line-height:1.5;margin:0">${o.label} was ${o.overMin} min longer than planned. Full session load is recorded. Excess decays across future load targets.</p>`
    ).join('');
    popup.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
        <h3 style="font-size:17px;font-weight:500;color:var(--c-black);margin:0 0 8px;letter-spacing:-0.005em">Extra load counted</h3>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px">${bodyLines}</div>
        <button id="excess-popup-continue" class="m-btn-glass m-btn-glass--inset" style="width:100%">Continue</button>
      </div>`;
    document.body.appendChild(popup);
    const proceed = () => { popup.remove(); onConfirm(state); };
    popup.querySelector('#excess-popup-continue')?.addEventListener('click', proceed);
    popup.addEventListener('click', (e) => { if (e.target === popup) proceed(); });
  });

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
    if (p.proposedWorkoutId === '__reduction__') {
      // Saved from previous review: start in the Excess Load bucket
      assignments.set(p.item.garminId, 'reduction');
    } else if (p.matchType === 'overflow') {
      // Overflow items start in the tray (null) so the user can manually assign them.
      // They become Excess Load on confirm if still unassigned.
      assignments.set(p.item.garminId, null);
    } else {
      assignments.set(p.item.garminId, p.proposedWorkoutId);
    }
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
