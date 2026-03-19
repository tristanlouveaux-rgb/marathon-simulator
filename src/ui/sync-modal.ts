/**
 * Smart Sync Modal
 *
 * Shows a match proposal when an external activity matches a planned workout.
 */

import type { MatchResult, ExternalActivity } from '@/calculations/matching';
import type { Workout } from '@/types';
import { getState } from '@/state/store';
import { formatKm } from '@/utils/format';

export type SyncDecision = 'match' | 'keep-both' | 'ignore';

/**
 * Show the match proposal modal and return the user's decision.
 */
export function showMatchProposal(
  activity: ExternalActivity,
  matchedWorkout: Workout,
  matchResult: MatchResult,
  onDecision: (decision: SyncDecision) => void,
): void {
  const actDist = formatKm(activity.distanceKm, getState().unitPref ?? 'km', 1);
  const confBadge = matchResult.confidence === 'high'
    ? '<span style="padding:2px 6px;background:rgba(22,163,74,0.1);color:#16a34a;border:1px solid rgba(22,163,74,0.3);border-radius:4px;font-size:11px">High confidence</span>'
    : '<span style="padding:2px 6px;background:rgba(245,158,11,0.1);color:var(--c-caution);border:1px solid rgba(245,158,11,0.3);border-radius:4px;font-size:11px">Medium confidence</span>';

  const overlay = document.createElement('div');
  overlay.id = 'sync-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:16px;max-width:384px;width:100%;padding:20px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <svg style="width:20px;height:20px;color:var(--c-ok)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
        <h3 style="font-size:17px;font-weight:600;color:var(--c-black)">Activity Detected</h3>
      </div>

      <p style="font-size:14px;color:var(--c-muted);margin-bottom:12px">
        We found a new activity <strong style="color:var(--c-black)">(${actDist})</strong> that looks like your scheduled
        <strong style="color:var(--c-black)">${matchedWorkout.n}</strong> (${matchedWorkout.d}).
      </p>

      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        ${confBadge}
        <span style="font-size:12px;color:var(--c-faint)">${matchResult.reason}</span>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="sync-match" style="width:100%;padding:10px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:10px;font-size:14px;font-weight:500;cursor:pointer">
          Mark Workout as Complete
        </button>
        <button id="sync-keep" style="width:100%;padding:10px;background:var(--c-bg);color:var(--c-black);border:1.5px solid var(--c-border-strong);border-radius:10px;font-size:14px;cursor:pointer">
          Log as Separate Activity
        </button>
        <button id="sync-ignore" style="width:100%;padding:8px;background:none;border:none;font-size:12px;color:var(--c-faint);cursor:pointer">
          Ignore
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = (decision: SyncDecision) => {
    overlay.remove();
    onDecision(decision);
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close('ignore');
  });
  overlay.querySelector('#sync-match')?.addEventListener('click', () => close('match'));
  overlay.querySelector('#sync-keep')?.addEventListener('click', () => close('keep-both'));
  overlay.querySelector('#sync-ignore')?.addEventListener('click', () => close('ignore'));
}
