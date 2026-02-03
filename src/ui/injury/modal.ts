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
import { recordPainLevel, recordCapacityTest, applyPhaseProgression, hasPassedRequiredCapacityTests } from '@/injury/engine';
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
function getModalHTML(injuryState: InjuryState): string {
  const injuryTypes = Object.keys(INJURY_PROTOCOLS) as InjuryType[];

  return `
    <div class="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-md mx-4 shadow-xl">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-white">Report Injury</h2>
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
            Pain Level: <span id="pain-value" class="text-emerald-400 font-bold">${injuryState.currentPain}</span>/10
          </label>
          <input
            type="range"
            id="injury-pain"
            min="0"
            max="10"
            value="${injuryState.currentPain}"
            class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
          <div class="flex justify-between text-xs text-gray-500 mt-1">
            <span>No pain</span>
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
              <input type="radio" name="can-run" id="can-run-yes" value="yes" class="w-4 h-4 text-emerald-500 bg-gray-800 border-gray-600 focus:ring-emerald-500">
              <span class="text-sm text-gray-300">Yes</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="can-run" id="can-run-limited" value="limited" class="w-4 h-4 text-amber-500 bg-gray-800 border-gray-600 focus:ring-amber-500">
              <span class="text-sm text-gray-300">Limited / With pain</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="can-run" id="can-run-no" value="no" checked class="w-4 h-4 text-red-500 bg-gray-800 border-gray-600 focus:ring-red-500">
              <span class="text-sm text-gray-300">No</span>
            </label>
          </div>
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

        ${renderCapacityTestSection(injuryState)}

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
            class="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Save & Activate
          </button>
        </div>
      </form>
    </div>
  `;
}

/**
 * Render Capacity Test section (only shown in test_capacity phase)
 */
function renderCapacityTestSection(injuryState: InjuryState): string {
  if (injuryState.injuryPhase !== 'test_capacity') {
    return '';
  }

  const passedTests = injuryState.capacityTestsPassed || [];
  const hopTestPassed = passedTests.includes('single_leg_hop');
  const walkTestPassed = passedTests.includes('pain_free_walk');
  const allPassed = hopTestPassed && walkTestPassed;

  return `
    <div class="bg-purple-950/30 border border-purple-800/50 rounded-lg p-4">
      <h3 class="text-sm font-semibold text-purple-300 mb-3 flex items-center gap-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        Capacity Tests - Phase 3
      </h3>
      <p class="text-xs text-purple-400/80 mb-3">
        Complete these tests pain-free to unlock running. Both tests must pass.
      </p>

      <div class="space-y-2">
        <!-- Walk Test -->
        <div class="flex items-center justify-between p-2 bg-gray-800/50 rounded-lg">
          <div class="flex items-center gap-2">
            ${walkTestPassed
              ? '<span class="w-5 h-5 bg-emerald-500 rounded-full flex items-center justify-center"><svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span>'
              : '<span class="w-5 h-5 bg-gray-600 rounded-full"></span>'
            }
            <span class="text-sm text-gray-300">30-min Walk (Pain-Free)</span>
          </div>
          ${!walkTestPassed ? `
            <button type="button" id="btn-walk-test" class="px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded transition-colors">
              Perform Test
            </button>
          ` : '<span class="text-xs text-emerald-400">Passed</span>'}
        </div>

        <!-- Hop Test -->
        <div class="flex items-center justify-between p-2 bg-gray-800/50 rounded-lg">
          <div class="flex items-center gap-2">
            ${hopTestPassed
              ? '<span class="w-5 h-5 bg-emerald-500 rounded-full flex items-center justify-center"><svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg></span>'
              : '<span class="w-5 h-5 bg-gray-600 rounded-full"></span>'
            }
            <span class="text-sm text-gray-300">Single Leg Hop (10x Pain-Free)</span>
          </div>
          ${!hopTestPassed ? `
            <button type="button" id="btn-hop-test" class="px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded transition-colors">
              Perform Test
            </button>
          ` : '<span class="text-xs text-emerald-400">Passed</span>'}
        </div>
      </div>

      ${allPassed ? `
        <div class="mt-3 p-2 bg-emerald-950/50 border border-emerald-700 rounded-lg">
          <p class="text-xs text-emerald-300">
            <strong>All tests passed!</strong> Click "Save & Activate" to progress to Return-to-Run phase.
          </p>
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Show capacity test dialog (Pass/Fail)
 */
function showCapacityTestDialog(testType: CapacityTestType): void {
  const testNames: Record<CapacityTestType, string> = {
    single_leg_hop: 'Single Leg Hop Test',
    pain_free_walk: '30-Minute Walk Test',
    isometric_hold: 'Isometric Hold Test',
    stair_test: 'Stair Test',
    squat_test: 'Squat Test',
  };

  const testInstructions: Record<CapacityTestType, string> = {
    single_leg_hop: 'Perform 10 single-leg hops on the affected leg. Were all hops pain-free?',
    pain_free_walk: 'Walk for 30 minutes at a normal pace. Was the walk completely pain-free?',
    isometric_hold: 'Hold an isometric contraction for 30 seconds. Was it pain-free?',
    stair_test: 'Walk up and down 2 flights of stairs. Was it pain-free?',
    squat_test: 'Perform 10 bodyweight squats. Were all squats pain-free?',
  };

  // Create dialog overlay
  const dialog = document.createElement('div');
  dialog.id = 'capacity-test-dialog';
  dialog.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[60]';
  dialog.innerHTML = `
    <div class="bg-gray-900 border border-purple-700 rounded-lg p-6 w-full max-w-sm mx-4 shadow-xl">
      <h3 class="text-lg font-semibold text-purple-300 mb-2">${testNames[testType]}</h3>
      <p class="text-sm text-gray-400 mb-4">${testInstructions[testType]}</p>

      <div class="flex gap-3">
        <button id="test-fail" class="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-lg transition-colors">
          Had Pain
        </button>
        <button id="test-pass" class="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors">
          Pain-Free!
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  // Wire up buttons
  document.getElementById('test-pass')?.addEventListener('click', () => {
    handleCapacityTestResult(testType, true);
    dialog.remove();
  });

  document.getElementById('test-fail')?.addEventListener('click', () => {
    handleCapacityTestResult(testType, false);
    dialog.remove();
  });

  // Click outside to close
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.remove();
    }
  });
}

/**
 * Handle capacity test result
 */
function handleCapacityTestResult(testType: CapacityTestType, passed: boolean): void {
  let injuryState = getInjuryState();

  // Record the test (painDuring=0 and painAfter=0 for pass, or 5/5 for fail)
  const painLevel = passed ? 0 : 5;
  injuryState = recordCapacityTest(injuryState, testType, painLevel, painLevel, passed ? 'Passed' : 'Failed - had pain');

  // Check if all required tests are now passed
  if (passed && hasPassedRequiredCapacityTests(injuryState)) {
    injuryState = applyPhaseProgression(injuryState, 'All capacity tests passed');
    showInjuryToast('All tests passed — transitioning to Return-to-Run.', 'emerald');
  } else if (passed) {
    showInjuryToast('Test passed! Complete remaining tests to progress.', 'emerald');
  } else {
    showInjuryToast('Test failed — continue rehab exercises and retry when pain-free.', 'amber');
  }

  setInjuryState(injuryState);
  saveState();

  // Refresh modal to show updated state
  closeInjuryModal();
  openInjuryModal();
}

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

  // Form submit
  document.getElementById('injury-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSaveInjury();
  });

  // Capacity Test buttons
  document.getElementById('btn-walk-test')?.addEventListener('click', () => {
    showCapacityTestDialog('pain_free_walk');
  });

  document.getElementById('btn-hop-test')?.addEventListener('click', () => {
    showCapacityTestDialog('single_leg_hop');
  });
}

/**
 * Handle saving injury data
 * AUTO-ACTIVATES injury and forces page reload for clean state
 */
function handleSaveInjury(): void {
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

  // Get current state and update
  let injuryState = getInjuryState();

  // Determine initial phase based on pain level
  let initialPhase = injuryState.injuryPhase;
  if (!injuryState.active || initialPhase === 'resolved') {
    // New injury - set phase based on pain
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
    startDate: injuryState.startDate || new Date().toISOString(),
    injuryPhase: initialPhase,
    acutePhaseStartDate: initialPhase === 'acute' ? new Date().toISOString() : injuryState.acutePhaseStartDate,
  };

  // Record pain level (adds to history)
  injuryState = recordPainLevel(injuryState, painLevel);

  // Zero-pain auto-recovery: offer to switch to return-to-run
  if (painLevel === 0 && injuryState.injuryPhase !== 'return_to_run' && injuryState.injuryPhase !== 'resolved') {
    // Save current state first, then ask
    setInjuryState(injuryState);
    saveState();
    showInjuryConfirm(
      'Pain is 0 — Ready to Run?',
      'Your pain has resolved. Ready to switch to the Return-to-Run phase?',
      'Yes, let\'s go!',
      'Not yet',
    ).then(proceed => {
      if (proceed) {
        let s = getInjuryState();
        s = applyPhaseProgression(s, 'Auto-detected 0 pain');
        setInjuryState(s);
        saveState();
      }
      window.location.reload();
    });
    return;
  }

  // Save to state
  setInjuryState(injuryState);
  saveState();

  // Force full page reload to ensure clean state rebuild
  window.location.reload();
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
