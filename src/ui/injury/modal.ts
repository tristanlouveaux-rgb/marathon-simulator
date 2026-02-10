/**
 * Injury Report Modal
 *
 * Simple HTML form for reporting injuries:
 * - Type: Select dropdown for injury type
 * - Pain: Slider 0-10
 * - Save: Button to update state and re-render
 */

import type { InjuryType, InjuryState, InjuryLocation, CapacityTestType } from '@/types/injury';
import { createDefaultInjuryState } from '@/types/injury';

/** Body part location labels */
const LOCATION_LABELS: Record<InjuryLocation, string> = {
  foot: 'Foot / Ankle',
  knee: 'Knee',
  calf: 'Calf / Shin',
  hamstring: 'Hamstring / Thigh',
  hip: 'Hip / Glute',
  back: 'Lower Back',
  other: 'Other',
};
import { INJURY_PROTOCOLS } from '@/constants/injury-protocols';
import { recordPainLevel, recordCapacityTest, applyPhaseProgression, hasPassedRequiredCapacityTests, evaluateReturnToRunGate, applyGateDecision, getReturnToRunLevelLabel, classifySeverity, evaluatePhaseTransition } from '@/injury/engine';
import { getState, getMutableState } from '@/state/store';
import { render } from '@/ui/renderer';
import { saveState } from '@/state';

/** Modal container ID */
const MODAL_ID = 'injury-modal';

/** Get or create injury state on simulator state */
function getInjuryState(): InjuryState {
  const state = getState() as any;
  if (!state.injuryState) {
    state.injuryState = createDefaultInjuryState();
  }
  return state.injuryState;
}

/** Set injury state on simulator state */
function setInjuryState(injuryState: InjuryState): void {
  const state = getMutableState() as any;
  state.injuryState = injuryState;
}

/**
 * Open the injury report modal
 */
export function openInjuryModal(): void {
  // Remove existing modal if any
  closeInjuryModal();

  const injuryState = getInjuryState();

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50';
  modal.innerHTML = getModalHTML(injuryState);

  document.body.appendChild(modal);

  // Wire up event handlers
  wireModalHandlers();
}

/**
 * Close the injury modal
 */
export function closeInjuryModal(): void {
  const modal = document.getElementById(MODAL_ID);
  if (modal) {
    modal.remove();
  }
}

/**
 * Generate modal HTML
 */
/** Cross-training activity display labels */
const CROSS_TRAINING_LABELS: Record<string, string> = {
  swimming: 'Swimming',
  cycling: 'Cycling',
  elliptical: 'Elliptical',
  rowing: 'Rowing',
  yoga: 'Yoga',
};

function getModalHTML(injuryState: InjuryState): string {
  const injuryTypes = Object.keys(INJURY_PROTOCOLS) as InjuryType[];
  // Get allowed activities for current injury type, filtered to main cross-training options
  const protocol = INJURY_PROTOCOLS[injuryState.type] || INJURY_PROTOCOLS.general;
  const crossTrainingOptions = (protocol.allowedActivities || [])
    .filter((a: string) => a in CROSS_TRAINING_LABELS);

  return `
    <div class="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-md mx-4 shadow-xl">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-white">${injuryState.active ? 'Weekly Injury Update' : 'Report Injury'}</h2>
        <button id="injury-modal-close" class="text-gray-400 hover:text-white transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <form id="injury-form" class="space-y-4">
        <!-- 1. Body Part Location (FIRST - most intuitive) -->
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">Where does it hurt?</label>
          <select id="injury-location" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500">
            ${(Object.keys(LOCATION_LABELS) as InjuryLocation[]).map(loc => `
              <option value="${loc}" ${injuryState.location === loc ? 'selected' : ''}>
                ${LOCATION_LABELS[loc]}
              </option>
            `).join('')}
          </select>
        </div>

        <!-- 2. Pain Level Slider -->
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">
            Pain Level: <span id="pain-value" class="text-emerald-400 font-bold">${Math.max(1, injuryState.currentPain)}</span>/10
          </label>
          <input
            type="range"
            id="injury-pain"
            min="1"
            max="10"
            value="${Math.max(1, injuryState.currentPain)}"
            class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
          <div class="flex justify-between text-xs text-gray-500 mt-1">
            <span>Mild</span>
            <span>Severe</span>
          </div>
        </div>

        <!-- 3. Mobility Status -->
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">Can you walk pain-free?</label>
          <select id="injury-mobility" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500">
            <option value="yes">Yes - walking is fine</option>
            <option value="limited">Limited - some discomfort</option>
            <option value="no">No - walking is painful</option>
          </select>
        </div>

        <!-- 3.5. Can you run? Radio buttons -->
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-2">Can you run?</label>
          <div class="flex gap-4">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="can-run" id="can-run-yes" value="yes" ${injuryState.canRun === 'yes' ? 'checked' : ''} class="w-4 h-4 text-emerald-500 bg-gray-800 border-gray-600 focus:ring-emerald-500">
              <span class="text-sm text-gray-300">Yes</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="can-run" id="can-run-limited" value="limited" ${injuryState.canRun === 'limited' ? 'checked' : ''} class="w-4 h-4 text-amber-500 bg-gray-800 border-gray-600 focus:ring-amber-500">
              <span class="text-sm text-gray-300">Limited / With pain</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="can-run" id="can-run-no" value="no" ${!injuryState.canRun || injuryState.canRun === 'no' ? 'checked' : ''} class="w-4 h-4 text-red-500 bg-gray-800 border-gray-600 focus:ring-red-500">
              <span class="text-sm text-gray-300">No</span>
            </label>
          </div>
        </div>

        <!-- 3.6. Preferred Cross-Training -->
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">Preferred rehab exercise</label>
          <select id="injury-cross-training" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500">
            <option value="" ${!injuryState.preferredCrossTraining ? 'selected' : ''}>Auto (protocol default)</option>
            ${crossTrainingOptions.map((a: string) => `
              <option value="${a}" ${injuryState.preferredCrossTraining === a ? 'selected' : ''}>
                ${CROSS_TRAINING_LABELS[a] || a}
              </option>
            `).join('')}
          </select>
          <p class="text-xs text-gray-500 mt-1">Choose your preferred activity for rehab days.</p>
        </div>

        <!-- 4. Side/Detail (optional) -->
        <div>
          <label class="block text-sm font-medium text-gray-300 mb-1">Which side? (optional)</label>
          <input
            type="text"
            id="injury-location-detail"
            placeholder="e.g., Left, Right, Both"
            value="${injuryState.locationDetail || ''}"
            class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <!-- 5. Injury Type (Secondary - auto-inferred based on location) -->
        <details class="bg-gray-800/50 rounded-lg p-3">
          <summary class="text-sm font-medium text-gray-400 cursor-pointer">Advanced: Specific diagnosis (optional)</summary>
          <div class="mt-3">
            <select id="injury-type" class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500">
              ${injuryTypes.map(type => `
                <option value="${type}" ${injuryState.type === type ? 'selected' : ''}>
                  ${INJURY_PROTOCOLS[type].displayName}
                </option>
              `).join('')}
            </select>
            <p class="text-xs text-gray-500 mt-1">Leave as "General" if unsure - we'll adapt your plan based on pain level.</p>
          </div>
        </details>

        <!-- 6. Physio Notes (optional, collapsed) -->
        <details class="bg-gray-800/50 rounded-lg p-3">
          <summary class="text-sm font-medium text-gray-400 cursor-pointer">Physio notes (optional)</summary>
          <div class="mt-3">
            <textarea
              id="injury-physio-notes"
              rows="3"
              placeholder="Enter notes from your physiotherapist..."
              class="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 resize-none"
            >${injuryState.physioNotes || ''}</textarea>
          </div>
        </details>

        <!-- Note: No checkbox - injury auto-activates on save -->
        <div class="bg-amber-950/30 border border-amber-800/50 rounded-lg p-3">
          <p class="text-xs text-amber-300">
            <strong>Note:</strong> Saving will automatically activate injury mode and adjust your training plan.
          </p>
        </div>

        <!-- Buttons -->
        <div class="flex gap-3 pt-2">
          <button
            type="button"
            id="injury-cancel"
            class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          ${injuryState.active ? `
            <button
              type="button"
              id="injury-resolve"
              class="px-4 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-600/50 text-emerald-400 rounded-lg text-sm font-medium transition-colors"
            >
              Mark Resolved
            </button>
          ` : ''}
          <button
            type="submit"
            class="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            ${injuryState.active ? 'Update Status' : 'Save & Activate'}
          </button>
        </div>
      </form>
    </div>
  `;
}

// Obsolete capacity test functions removed.

/**
 * Wire up modal event handlers
 */
function wireModalHandlers(): void {
  // Close button
  document.getElementById('injury-modal-close')?.addEventListener('click', closeInjuryModal);

  // Click outside to close
  document.getElementById(MODAL_ID)?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closeInjuryModal();
    }
  });

  // Pain slider update
  const painSlider = document.getElementById('injury-pain') as HTMLInputElement;
  const painValue = document.getElementById('pain-value');
  if (painSlider && painValue) {
    painSlider.addEventListener('input', () => {
      painValue.textContent = painSlider.value;
    });
  }

  // Cancel button - just close modal
  document.getElementById('injury-cancel')?.addEventListener('click', () => {
    closeInjuryModal();
  });

  // Resolve button
  document.getElementById('injury-resolve')?.addEventListener('click', () => {
    showInjuryConfirm(
      'Resolve Injury?',
      'This will deactivate injury mode and return you to your normal training plan.',
      'Yes, I\'m recovered',
      'Cancel'
    ).then(resolve => {
      if (resolve) markAsRecovered();
    });
  });

  // Form submit
  document.getElementById('injury-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSaveInjury();
  });
}

/**
 * Handle saving injury data
 * AUTO-ACTIVATES injury and forces page reload for clean state
 */
async function handleSaveInjury(): Promise<void> {
  const typeSelect = document.getElementById('injury-type') as HTMLSelectElement;
  const painSlider = document.getElementById('injury-pain') as HTMLInputElement;
  const locationSelect = document.getElementById('injury-location') as HTMLSelectElement;
  const locationDetailInput = document.getElementById('injury-location-detail') as HTMLInputElement;
  const physioNotesTextarea = document.getElementById('injury-physio-notes') as HTMLTextAreaElement;

  if (!typeSelect || !painSlider || !locationSelect) {
    console.error('Injury form elements not found');
    return;
  }

  const injuryType = typeSelect.value as InjuryType;
  const painLevel = parseInt(painSlider.value, 10);
  const location = locationSelect.value as InjuryLocation;
  const locationDetail = locationDetailInput?.value || '';
  const physioNotes = physioNotesTextarea?.value || '';
  const canRunEl = document.querySelector('input[name="can-run"]:checked') as HTMLInputElement;
  const canRun = (canRunEl?.value || 'no') as 'yes' | 'limited' | 'no';
  const crossTrainingSelect = document.getElementById('injury-cross-training') as HTMLSelectElement;
  const preferredCrossTraining = crossTrainingSelect?.value || null;

  // Get current state and update
  let injuryState = getInjuryState();
  const wasAlreadyActive = injuryState.active;

  // Determine initial phase based on pain level
  let initialPhase = injuryState.injuryPhase;
  if (!injuryState.active || initialPhase === 'resolved') {
    if (painLevel >= 7) {
      initialPhase = 'acute';
    } else if (painLevel >= 4) {
      initialPhase = 'rehab';
    } else {
      initialPhase = 'test_capacity';
    }
  }

  // Update injury state - AUTO-ACTIVATE (no checkbox)
  injuryState = {
    ...injuryState,
    active: true,  // ALWAYS activate on save
    type: injuryType,
    location,
    locationDetail,
    physioNotes,
    canRun,
    preferredCrossTraining: preferredCrossTraining || null,
    startDate: injuryState.startDate || new Date().toISOString(),
    injuryPhase: initialPhase,
    acutePhaseStartDate: initialPhase === 'acute' ? new Date().toISOString() : injuryState.acutePhaseStartDate,
  };

  // Record pain level (adds to history)
  injuryState = recordPainLevel(injuryState, painLevel);

  // Evaluate phase transitions immediately so progression happens when criteria are met
  injuryState = evaluatePhaseTransition(injuryState);

  // Pain resolved handling removed here as it's now handled by the explicit "Resolve" button

  const s = getMutableState();

  // Mark check-in done for this week — but only if injury was already active
  // (initial report is not a check-in; the first check-in happens at week end)
  if (wasAlreadyActive && s.w >= 1 && s.w <= s.wks.length) {
    s.wks[s.w - 1].injuryCheckedIn = true;
  }

  // Save to state
  setInjuryState(injuryState);
  saveState();

  if (wasAlreadyActive) {
    // Weekly check-in: close modal and call next() to advance the week
    closeInjuryModal();
    const { next } = await import('@/ui/events');
    next();
  } else {
    // Initial injury report: full reload for clean state rebuild
    window.location.reload();
  }
}

/**
 * Check if injury is currently active
 */
export function isInjuryActive(): boolean {
  const injuryState = getInjuryState();
  return injuryState.active;
}

/**
 * Mark injury as recovered - deactivates injury mode
 */
export function markAsRecovered(): void {
  let injuryState = getInjuryState();

  injuryState = {
    ...injuryState,
    active: false,
    currentPain: 0,
  };

  setInjuryState(injuryState);
  saveState();


  // Force full page reload to rebuild normal training plan
  window.location.reload();
}

/**
 * Get current injury state for display
 */
export function getInjuryStateForDisplay(): InjuryState {
  return getInjuryState();
}

/** Phase display labels */
const PHASE_LABELS: Record<string, { label: string; color: string }> = {
  acute: { label: 'Acute (Rest)', color: 'text-red-400' },
  rehab: { label: 'Rehabilitation', color: 'text-amber-400' },
  test_capacity: { label: 'Capacity Testing', color: 'text-purple-400' },
  return_to_run: { label: 'Return to Run', color: 'text-blue-400' },
  graduated_return: { label: 'Graduated Return', color: 'text-cyan-400' },
  resolved: { label: 'Resolved', color: 'text-emerald-400' },
};

/**
 * Render injury alert banner HTML
 */
export function renderInjuryBanner(): string {
  const injuryState = getInjuryState();

  if (!injuryState.active) {
    return '';
  }

  const protocol = INJURY_PROTOCOLS[injuryState.type];
  const displayName = protocol?.displayName || injuryState.type;
  const phaseInfo = PHASE_LABELS[injuryState.injuryPhase] || { label: 'Unknown', color: 'text-gray-400' };

  return `
    <div class="bg-red-950/50 border border-red-800 rounded-lg p-3 mb-4">
      <div class="flex items-center gap-3">
        <svg class="w-5 h-5 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
        <div class="flex-1">
          <p class="text-sm font-medium text-red-300">Injury Mode Active</p>
          <p class="text-xs text-red-400/80">
            ${displayName} - Pain: ${injuryState.currentPain}/10 -
            <span class="${phaseInfo.color} font-medium">${phaseInfo.label}</span>
          </p>
        </div>
        <button id="btn-injury-details" class="text-xs px-2 py-1 bg-red-900/50 hover:bg-red-800/50 text-red-300 rounded transition-colors">
          Details
        </button>
      </div>
    </div>
  `;
}

/** Styled toast for injury feedback (no reload). */
function showInjuryToast(message: string, color: 'emerald' | 'amber'): void {
  const bg = color === 'emerald' ? 'bg-emerald-600' : 'bg-amber-600';
  const toast = document.createElement('div');
  toast.className = `fixed bottom-6 left-1/2 -translate-x-1/2 ${bg} text-white px-6 py-3 rounded-xl shadow-lg text-sm font-medium z-[70] transition-opacity`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 2500);
}

/**
 * Open the return-to-run gate modal for weekly check-in.
 * Shows current level, pain slider, morning pain summary, and gate decision.
 */
export function openReturnToRunGateModal(): void {
  // Remove existing modal if any
  closeInjuryModal();

  const injuryState = getInjuryState();
  const currentLevel = injuryState.returnToRunLevel || 1;
  const levelLabel = getReturnToRunLevelLabel(currentLevel);
  const mornings = injuryState.morningPainResponses || [];
  const betterCount = mornings.filter(m => m.response === 'better').length;
  const sameCount = mornings.filter(m => m.response === 'same').length;
  const worseCount = mornings.filter(m => m.response === 'worse').length;

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-md mx-4 shadow-xl">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-white">Weekly Check-In</h2>
        <button id="injury-modal-close" class="text-gray-400 hover:text-white transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Current Level -->
      <div class="bg-blue-950/50 border border-blue-800 rounded-lg p-3 mb-4">
        <div class="text-xs text-blue-400 font-medium mb-1">Current Protocol Level</div>
        <div class="text-sm text-white font-semibold">${levelLabel}</div>
      </div>

      <!-- Morning Pain Summary -->
      ${mornings.length > 0 ? `
        <div class="bg-gray-800 rounded-lg p-3 mb-4">
          <div class="text-xs text-gray-400 font-medium mb-2">This Week's Morning Pain</div>
          <div class="flex gap-3 text-xs">
            <span class="text-emerald-400">${betterCount} better</span>
            <span class="text-blue-400">${sameCount} same</span>
            <span class="text-red-400">${worseCount} worse</span>
          </div>
        </div>
      ` : `
        <div class="bg-gray-800 rounded-lg p-3 mb-4">
          <div class="text-xs text-gray-500">No morning pain data recorded this week</div>
        </div>
      `}

      <!-- Pain Slider -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-300 mb-1">
          How was your pain during the intervals?
          <span id="gate-pain-value" class="text-emerald-400 font-bold">${injuryState.currentPain || 2}</span>/10
        </label>
        <input
          type="range"
          id="gate-pain-slider"
          min="0"
          max="10"
          value="${injuryState.currentPain || 2}"
          class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
        />
        <div class="flex justify-between text-xs text-gray-500 mt-1">
          <span>No pain</span>
          <span>Severe</span>
        </div>
      </div>

      <!-- Gate Decision Preview (updates live) -->
      <div id="gate-decision-preview" class="rounded-lg p-3 mb-4 border"></div>

      <!-- Buttons -->
      <div class="flex gap-3">
        <button id="gate-cancel" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-sm font-medium transition-colors">
          Cancel
        </button>
        <button id="gate-confirm" class="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors">
          Confirm & Advance Week
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Helper: compute and render gate decision preview
  const updatePreview = () => {
    const painVal = parseInt((document.getElementById('gate-pain-slider') as HTMLInputElement)?.value || '2');
    // Create a temporary state with the slider pain to preview the decision
    const tempState: InjuryState = { ...injuryState, currentPain: painVal };
    const decision = evaluateReturnToRunGate(tempState);

    const previewEl = document.getElementById('gate-decision-preview');
    if (!previewEl) return;

    const colors = {
      progress: { bg: 'bg-emerald-950/50', border: 'border-emerald-700', text: 'text-emerald-300', label: 'Progressing' },
      hold: { bg: 'bg-amber-950/50', border: 'border-amber-700', text: 'text-amber-300', label: 'Holding' },
      regress: { bg: 'bg-red-950/50', border: 'border-red-700', text: 'text-red-300', label: 'Stepping Back' },
    };
    const c = colors[decision.decision];
    const targetLabel = decision.newLevel > 8 ? 'Resolved!' : `Level ${decision.newLevel}`;

    previewEl.className = `rounded-lg p-3 mb-4 border ${c.bg} ${c.border}`;
    previewEl.innerHTML = `
      <div class="text-sm font-semibold ${c.text} mb-1">${c.label} → ${targetLabel}</div>
      <div class="text-xs text-gray-400">${decision.reason}</div>
    `;
  };

  // Initial preview
  updatePreview();

  // Wire handlers
  document.getElementById('injury-modal-close')?.addEventListener('click', closeInjuryModal);
  document.getElementById(MODAL_ID)?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeInjuryModal();
  });

  const painSlider = document.getElementById('gate-pain-slider') as HTMLInputElement;
  const painValueEl = document.getElementById('gate-pain-value');
  if (painSlider && painValueEl) {
    painSlider.addEventListener('input', () => {
      painValueEl.textContent = painSlider.value;
      updatePreview();
    });
  }

  document.getElementById('gate-cancel')?.addEventListener('click', closeInjuryModal);

  document.getElementById('gate-confirm')?.addEventListener('click', async () => {
    const painVal = parseInt((document.getElementById('gate-pain-slider') as HTMLInputElement)?.value || '2');

    let state = getInjuryState();
    // Record the check-in pain
    state = recordPainLevel(state, painVal);
    // Update severity classification
    state = { ...state, severityClass: classifySeverity(state) };
    // Track consecutive zero-pain weeks
    state = {
      ...state,
      zeroPainWeeks: painVal === 0 ? (state.zeroPainWeeks || 0) + 1 : 0,
    };
    // Evaluate gate
    const decision = evaluateReturnToRunGate(state);
    // Apply gate decision
    state = applyGateDecision(state, decision);

    // Mark check-in complete for this week
    const s = getMutableState();
    if (s.w >= 1 && s.w <= s.wks.length) {
      s.wks[s.w - 1].injuryCheckedIn = true;
    }

    setInjuryState(state);
    saveState();

    // After 2+ consecutive zero-pain weeks, offer early exit with graduated return option
    if (state.zeroPainWeeks >= 2 && state.injuryPhase === 'return_to_run') {
      closeInjuryModal();
      const choice = await showThreeOptionChoice(
        'Ready to return?',
        "You've had zero pain for 2 weeks. How would you like to proceed?",
        [
          { id: 'full', label: 'Yes, full return', description: 'Back to your normal training plan immediately' },
          { id: 'graduated', label: 'Yes, ease me back in', description: '2 weeks of reduced hard sessions with weekly check-ins' },
          { id: 'stay', label: 'Not yet', description: 'Continue recovery protocol' },
        ]
      );
      if (choice === 'full') {
        markAsRecovered();
        return;
      }
      if (choice === 'graduated') {
        state.injuryPhase = 'graduated_return';
        state.graduatedReturnWeeksLeft = 2;
        setInjuryState(state);
        saveState();
        const { next } = await import('@/ui/events');
        next();
        return;
      }
    }

    // Close modal and call next() to advance the week immediately
    closeInjuryModal();
    const { next } = await import('@/ui/events');
    next();
  });
}

/** Styled confirm modal for injury decisions. */
function showInjuryConfirm(title: string, message: string, confirmLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-[70] px-4';
    overlay.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
        <h3 class="text-white font-semibold text-lg mb-2">${title}</h3>
        <p class="text-gray-400 text-sm mb-5">${message}</p>
        <div class="flex flex-col gap-2">
          <button id="btn-injury-yes" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors text-sm">${confirmLabel}</button>
          <button id="btn-injury-no" class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-lg transition-colors text-sm">${cancelLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#btn-injury-yes')?.addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.querySelector('#btn-injury-no')?.addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

/** Three-option choice modal for graduated return decisions. */
function showThreeOptionChoice(
  title: string,
  message: string,
  options: { id: string; label: string; description: string }[]
): Promise<string> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-[70] px-4';
    const buttonsHtml = options.map((opt, i) => {
      const style = i === 0
        ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
        : i === 1
          ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
          : 'bg-gray-800 hover:bg-gray-700 text-gray-300';
      return `
        <button data-choice="${opt.id}" class="w-full py-2.5 ${style} font-medium rounded-lg transition-colors text-sm">
          ${opt.label}
          <span class="block text-xs opacity-75 font-normal mt-0.5">${opt.description}</span>
        </button>
      `;
    }).join('');
    overlay.innerHTML = `
      <div class="bg-gray-900 border border-gray-700 rounded-xl max-w-sm w-full p-6">
        <h3 class="text-white font-semibold text-lg mb-2">${title}</h3>
        <p class="text-gray-400 text-sm mb-5">${message}</p>
        <div class="flex flex-col gap-2">${buttonsHtml}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    for (const opt of options) {
      overlay.querySelector(`[data-choice="${opt.id}"]`)?.addEventListener('click', () => {
        overlay.remove();
        resolve(opt.id);
      });
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(options[options.length - 1].id); }
    });
  });
}

/**
 * Open the graduated return weekly check-in modal.
 * Shows weeks remaining, pain slider, and handles progression/hold/regression.
 */
export function openGraduatedReturnCheckIn(): void {
  closeInjuryModal();

  const injuryState = getInjuryState();
  const weeksLeft = injuryState.graduatedReturnWeeksLeft || 2;
  const weekNumber = 2 - weeksLeft + 1; // 1 or 2

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50';
  modal.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-md mx-4 shadow-xl">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-white">Graduated Return Check-In</h2>
        <button id="injury-modal-close" class="text-gray-400 hover:text-white transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Week indicator -->
      <div class="bg-cyan-950/50 border border-cyan-800 rounded-lg p-3 mb-4">
        <div class="text-xs text-cyan-400 font-medium mb-1">Graduated Return</div>
        <div class="text-sm text-white font-semibold">Week ${weekNumber} of 2</div>
        <p class="text-xs text-gray-400 mt-1">Hard sessions are reduced. Easy runs are normal.</p>
      </div>

      <!-- Pain Slider -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-300 mb-1">
          How was your pain this week?
          <span id="grad-pain-value" class="text-emerald-400 font-bold">${injuryState.currentPain || 0}</span>/10
        </label>
        <input
          type="range"
          id="grad-pain-slider"
          min="0"
          max="10"
          value="${injuryState.currentPain || 0}"
          class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
        />
        <div class="flex justify-between text-xs text-gray-500 mt-1">
          <span>No pain</span>
          <span>Severe</span>
        </div>
      </div>

      <!-- Decision preview -->
      <div id="grad-decision-preview" class="rounded-lg p-3 mb-4 border"></div>

      <!-- Buttons -->
      <div class="flex gap-3">
        <button id="grad-cancel" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-sm font-medium transition-colors">
          Cancel
        </button>
        <button id="grad-confirm" class="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors">
          Confirm & Advance Week
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Preview logic
  const updatePreview = () => {
    const painVal = parseInt((document.getElementById('grad-pain-slider') as HTMLInputElement)?.value || '0');
    const previewEl = document.getElementById('grad-decision-preview');
    if (!previewEl) return;

    if (painVal <= 1) {
      const remaining = weeksLeft - 1;
      if (remaining <= 0) {
        previewEl.className = 'rounded-lg p-3 mb-4 border bg-emerald-950/50 border-emerald-700';
        previewEl.innerHTML = `
          <div class="text-sm font-semibold text-emerald-300 mb-1">Fully Resolved!</div>
          <div class="text-xs text-gray-400">2 clean weeks complete — returning to normal training</div>
        `;
      } else {
        previewEl.className = 'rounded-lg p-3 mb-4 border bg-emerald-950/50 border-emerald-700';
        previewEl.innerHTML = `
          <div class="text-sm font-semibold text-emerald-300 mb-1">Progressing</div>
          <div class="text-xs text-gray-400">${remaining} week${remaining > 1 ? 's' : ''} remaining in graduated return</div>
        `;
      }
    } else if (painVal <= 3) {
      previewEl.className = 'rounded-lg p-3 mb-4 border bg-amber-950/50 border-amber-700';
      previewEl.innerHTML = `
        <div class="text-sm font-semibold text-amber-300 mb-1">Holding</div>
        <div class="text-xs text-gray-400">Pain ${painVal}/10 — staying at current level, week does not count</div>
      `;
    } else {
      previewEl.className = 'rounded-lg p-3 mb-4 border bg-red-950/50 border-red-700';
      previewEl.innerHTML = `
        <div class="text-sm font-semibold text-red-300 mb-1">Stepping Back</div>
        <div class="text-xs text-gray-400">Pain ${painVal}/10 — returning to return-to-run protocol</div>
      `;
    }
  };

  updatePreview();

  // Wire handlers
  document.getElementById('injury-modal-close')?.addEventListener('click', closeInjuryModal);
  document.getElementById(MODAL_ID)?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeInjuryModal();
  });

  const painSlider = document.getElementById('grad-pain-slider') as HTMLInputElement;
  const painValueEl = document.getElementById('grad-pain-value');
  if (painSlider && painValueEl) {
    painSlider.addEventListener('input', () => {
      painValueEl.textContent = painSlider.value;
      updatePreview();
    });
  }

  document.getElementById('grad-cancel')?.addEventListener('click', closeInjuryModal);

  document.getElementById('grad-confirm')?.addEventListener('click', async () => {
    const painVal = parseInt((document.getElementById('grad-pain-slider') as HTMLInputElement)?.value || '0');

    let state = getInjuryState();
    state = recordPainLevel(state, painVal);

    if (painVal >= 4) {
      // Regress to return_to_run
      state = { ...state, injuryPhase: 'return_to_run' as const, graduatedReturnWeeksLeft: 2 };
      showInjuryToast('Pain spike — returning to return-to-run protocol', 'amber');
    } else if (painVal >= 2) {
      // Hold — don't decrement weeks
      showInjuryToast('Holding at current level — week does not count', 'amber');
    } else {
      // Pain <= 1: decrement weeks
      state.graduatedReturnWeeksLeft = Math.max(0, (state.graduatedReturnWeeksLeft || 2) - 1);
      if (state.graduatedReturnWeeksLeft <= 0) {
        // Auto-resolve
        state = applyPhaseProgression(state, 'Completed graduated return — 2 clean weeks');
        showInjuryToast('Graduated return complete — back to full training!', 'emerald');
      }
    }

    // Mark check-in complete
    const s = getMutableState();
    if (s.w >= 1 && s.w <= s.wks.length) {
      s.wks[s.w - 1].injuryCheckedIn = true;
    }

    setInjuryState(state);
    saveState();

    closeInjuryModal();
    const { next } = await import('@/ui/events');
    next();
  });
}
