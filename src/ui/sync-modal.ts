/**
 * Smart Sync Modal
 *
 * Shows a match proposal when an external activity matches a planned workout.
 */

import type { MatchResult, ExternalActivity } from '@/calculations/matching';
import type { Workout } from '@/types';

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
  const actDist = activity.distanceKm.toFixed(1);
  const confBadge = matchResult.confidence === 'high'
    ? '<span class="px-1.5 py-0.5 bg-emerald-900/50 text-emerald-300 rounded text-xs">High confidence</span>'
    : '<span class="px-1.5 py-0.5 bg-amber-900/50 text-amber-300 rounded text-xs">Medium confidence</span>';

  const overlay = document.createElement('div');
  overlay.id = 'sync-modal';
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
  overlay.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-5">
      <div class="flex items-center gap-2 mb-3">
        <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
        <h3 class="text-white font-semibold text-lg">Activity Detected</h3>
      </div>

      <p class="text-sm text-gray-300 mb-3">
        We found a new activity <strong class="text-white">(${actDist}km)</strong> that looks like your scheduled
        <strong class="text-white">${matchedWorkout.n}</strong> (${matchedWorkout.d}).
      </p>

      <div class="flex items-center gap-2 mb-4">
        ${confBadge}
        <span class="text-xs text-gray-500">${matchResult.reason}</span>
      </div>

      <div class="space-y-2">
        <button id="sync-match" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors">
          Mark Workout as Complete
        </button>
        <button id="sync-keep" class="w-full py-2.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-medium rounded-lg transition-colors">
          Log as Separate Activity
        </button>
        <button id="sync-ignore" class="w-full py-2 text-gray-500 hover:text-gray-300 text-xs transition-colors">
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
