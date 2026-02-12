/**
 * Cross-Training Suggestion Modal
 *
 * Shows a popup with 3 global choices for adjusting runs:
 * - REPLACE: Apply full recommendation (includes replacements)
 * - REDUCE: Apply only downgrades/reductions (no replacements)
 * - KEEP: No changes, warn about overtraining risk
 */

import type { SuggestionPopup, GlobalChoice, Adjustment } from '@/cross-training/suggester';

export interface SuggestionDecision {
  choice: GlobalChoice;
  adjustments: Adjustment[];
}

/**
 * Show the suggestion popup modal with 3 global choices
 */
export function showSuggestionModal(
  popup: SuggestionPopup,
  sportName: string,
  onComplete: (decision: SuggestionDecision | null) => void
): void {
  const severityColors = {
    light: { bg: 'bg-sky-900/30', border: 'border-sky-700', text: 'text-sky-300', icon: 'text-sky-400' },
    heavy: { bg: 'bg-amber-900/30', border: 'border-amber-700', text: 'text-amber-300', icon: 'text-amber-400' },
    extreme: { bg: 'bg-red-900/30', border: 'border-red-700', text: 'text-red-300', icon: 'text-red-400' },
  };
  const colors = severityColors[popup.severity];

  // Build adjustment details for expandable sections
  const buildAdjustmentList = (adjustments: Adjustment[]): string => {
    if (adjustments.length === 0) {
      return '<div class="text-gray-500 text-sm py-2">No changes to your running plan.</div>';
    }

    return adjustments.map(adj => {
      let actionLabel = '';
      let actionColor = '';
      let detail = '';

      // Round km values to 1 decimal place for clean display
      const origKm = Math.round(adj.originalDistanceKm * 10) / 10;
      const newKm = Math.round(adj.newDistanceKm * 10) / 10;

      if (adj.action === 'replace') {
        if (newKm > 0) {
          // Shakeout conversion - user still does a run
          actionLabel = 'Convert';
          actionColor = 'text-sky-400';
          detail = `${adj.originalType} → ${newKm}km easy shakeout`;
        } else {
          // Fully replaced - no run needed
          actionLabel = 'Replace';
          actionColor = 'text-red-400';
          detail = 'Replaced by cross-training';
        }
      } else if (adj.action === 'downgrade') {
        actionLabel = 'Downgrade';
        actionColor = 'text-amber-400';
        const paceLabel = (adj.originalType === 'threshold' && adj.newType === 'marathon_pace') ? 'steady pace'
                        : adj.newType === 'marathon_pace' ? 'marathon pace'
                        : adj.newType === 'threshold' ? 'threshold pace'
                        : 'easy effort';
        detail = origKm > 0
          ? `Keep ${origKm}km but at ${paceLabel}`
          : `Keep workout at ${paceLabel}`;
      } else {
        actionLabel = 'Reduce';
        actionColor = 'text-amber-400';
        // Handle 0km case for reduce as well
        detail = origKm > 0
          ? `${origKm}km → ${newKm}km`
          : `Reduce intensity`;
      }

      return `
        <div class="flex items-center justify-between py-2 border-b border-gray-700/50 last:border-0">
          <div>
            <span class="text-white font-medium">${adj.workoutId}</span>
            <span class="text-gray-500 text-sm ml-2">${adj.originalType}</span>
          </div>
          <div class="text-right">
            <span class="${actionColor} font-medium">${actionLabel}</span>
            <div class="text-gray-400 text-xs">${detail}</div>
          </div>
        </div>
      `;
    }).join('');
  };

  const hasReplacements = popup.replaceOutcome.adjustments.some(a => a.action === 'replace');
  const hasReductions = popup.reduceOutcome.adjustments.length > 0;

  // Warning text based on severity
  const keepWarning = popup.severity === 'extreme'
    ? 'Warning: Very high fatigue risk. Consider at least reducing.'
    : popup.severity === 'heavy'
    ? 'Note: Elevated fatigue risk this week.'
    : '';

  const overlay = document.createElement('div');
  overlay.id = 'suggestion-modal';
  overlay.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 overflow-y-auto';

  overlay.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
      <!-- Header -->
      <div class="p-5 border-b border-gray-700">
        <div class="flex items-start gap-4">
          <div class="w-12 h-12 rounded-full ${colors.bg} ${colors.border} border-2 flex items-center justify-center flex-shrink-0">
            <svg class="w-6 h-6 ${colors.icon}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
          </div>
          <div class="flex-1">
            <h3 class="text-white font-bold text-lg mb-1">${popup.headline}</h3>
            <p class="text-gray-400 text-sm leading-relaxed">${popup.summary}</p>
          </div>
        </div>

        <!-- Load badge -->
        <div class="mt-4 flex items-center gap-2 flex-wrap">
          <span class="inline-flex items-center px-3 py-1.5 rounded-full ${colors.bg} ${colors.border} border">
            <span class="${colors.text} font-medium text-sm">
              ${popup.durationMin} min ${popup.sportName} — ${popup.severity === 'extreme' ? 'Very high' : popup.severity === 'heavy' ? 'High' : 'Moderate'} training load
            </span>
          </span>
          ${popup.warnings.length > 0 ? `
            <span class="text-xs text-gray-500">${popup.warnings[0]}</span>
          ` : ''}
        </div>
      </div>

      <!-- 3 Global Choices -->
      <div class="p-5 space-y-3">

        <!-- REPLACE option (only show if there are replacements) -->
        ${hasReplacements ? `
        <button id="choice-replace" class="w-full text-left p-4 rounded-xl border-2 border-transparent bg-gray-800 hover:border-red-600 transition-all group">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-red-400 text-lg">Replace & Reduce</span>
            <span class="text-xs text-gray-500 group-hover:text-gray-400">Recommended for heavy loads</span>
          </div>
          <p class="text-gray-300 text-sm mb-3">Replace runs where possible, downgrade the rest. Best for heavy cross-training.</p>
          <details class="text-xs">
            <summary class="text-gray-500 cursor-pointer hover:text-gray-400">View changes (${popup.replaceOutcome.adjustments.length})</summary>
            <div class="mt-2 bg-gray-900/50 rounded-lg p-3">
              ${buildAdjustmentList(popup.replaceOutcome.adjustments)}
            </div>
          </details>
        </button>
        ` : ''}

        <!-- REDUCE option -->
        ${hasReductions ? `
        <button id="choice-reduce" class="w-full text-left p-4 rounded-xl border-2 ${!hasReplacements ? 'border-amber-600 bg-amber-900/20' : 'border-transparent bg-gray-800 hover:border-amber-600'} transition-all group">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-amber-400 text-lg">Reduce</span>
            ${!hasReplacements ? '<span class="text-xs bg-amber-800 text-amber-200 px-2 py-0.5 rounded">Recommended</span>' : ''}
          </div>
          <p class="text-gray-300 text-sm mb-3">Downgrade intensity and/or reduce distance. Keeps all runs in your plan.</p>
          <details class="text-xs" ${!hasReplacements ? 'open' : ''}>
            <summary class="text-gray-500 cursor-pointer hover:text-gray-400">View changes (${popup.reduceOutcome.adjustments.length})</summary>
            <div class="mt-2 bg-gray-900/50 rounded-lg p-3">
              ${buildAdjustmentList(popup.reduceOutcome.adjustments)}
            </div>
          </details>
        </button>
        ` : ''}

        <!-- KEEP option -->
        <button id="choice-keep" class="w-full text-left p-4 rounded-xl border-2 ${!hasReductions ? 'border-emerald-600 bg-emerald-900/20' : 'border-transparent bg-gray-800 hover:border-emerald-600'} transition-all">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-emerald-400 text-lg">Keep Plan</span>
            ${!hasReductions ? '<span class="text-xs bg-emerald-800 text-emerald-200 px-2 py-0.5 rounded">Recommended</span>' : ''}
          </div>
          <p class="text-gray-300 text-sm">Keep your running plan unchanged.</p>
          ${keepWarning ? `<p class="text-amber-400 text-xs mt-2">${keepWarning}</p>` : ''}
        </button>

      </div>

      <!-- Footer -->
      <div class="px-5 pb-5">
        <button id="close-modal" class="w-full py-2 text-gray-500 hover:text-gray-300 text-sm transition-colors">
          Dismiss
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = (choice: GlobalChoice | null, adjustments: Adjustment[]) => {
    overlay.remove();
    if (choice) {
      onComplete({ choice, adjustments });
    } else {
      onComplete(null);
    }
  };

  // Event handlers
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(null, []);
  });

  // CRITICAL: Prevent clicks on <details>/<summary> from bubbling to parent button.
  // Without this, clicking "View changes" would trigger the parent button's click handler.
  // See: docs/bugs/boxing-replacement-bug.md
  overlay.querySelectorAll('details').forEach(details => {
    details.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  });

  overlay.querySelector('#choice-replace')?.addEventListener('click', () => {
    close('replace', popup.replaceOutcome.adjustments);
  });

  overlay.querySelector('#choice-reduce')?.addEventListener('click', () => {
    close('reduce', popup.reduceOutcome.adjustments);
  });

  overlay.querySelector('#choice-keep')?.addEventListener('click', () => {
    close('keep', []);
  });

  overlay.querySelector('#close-modal')?.addEventListener('click', () => {
    close(null, []);
  });
}

// Legacy export for backwards compatibility
export type { SuggestionDecision as SuggestionDecisionLegacy };
