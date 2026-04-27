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
  closeInjuryModal();

  const injuryState = getInjuryState();

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 flex items-center justify-center z-50';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.innerHTML = getModalHTML(injuryState);

  document.body.appendChild(modal);
  wireModalHandlers();
}

/**
 * Close the injury modal
 */
export function closeInjuryModal(): void {
  document.getElementById(MODAL_ID)?.remove();
}

/** Cross-training activity display labels */
const CROSS_TRAINING_LABELS: Record<string, string> = {
  swimming: 'Swimming',
  cycling: 'Cycling',
  elliptical: 'Elliptical',
  rowing: 'Rowing',
  yoga: 'Yoga',
};

const INPUT_STYLE = `background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black);border-radius:8px;width:100%;padding:8px 12px;font-size:14px;outline:none`;

function getModalHTML(injuryState: InjuryState): string {
  const injuryTypes = Object.keys(INJURY_PROTOCOLS) as InjuryType[];
  const protocol = INJURY_PROTOCOLS[injuryState.type] || INJURY_PROTOCOLS.general;
  const crossTrainingOptions = (protocol.allowedActivities || [])
    .filter((a: string) => a in CROSS_TRAINING_LABELS);

  return `
    <div class="rounded-xl p-6 w-full max-w-md mx-4 shadow-xl overflow-y-auto" style="background:var(--c-surface);border:1px solid var(--c-border-strong);max-height:90vh">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold" style="color:var(--c-black)">${injuryState.active ? 'Weekly Injury Update' : 'Report Injury'}</h2>
        <button id="injury-modal-close" style="color:var(--c-faint);background:none;border:none;cursor:pointer;padding:0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <form id="injury-form" class="space-y-4">
        <!-- 1. Body Part Location -->
        <div>
          <label class="block text-sm font-medium mb-1" style="color:var(--c-muted)">Where does it hurt?</label>
          <select id="injury-location" style="${INPUT_STYLE}">
            ${(Object.keys(LOCATION_LABELS) as InjuryLocation[]).map(loc => `
              <option value="${loc}" ${injuryState.location === loc ? 'selected' : ''}>
                ${LOCATION_LABELS[loc]}
              </option>
            `).join('')}
          </select>
        </div>

        <!-- 2. Pain Level Slider -->
        <div>
          <label class="block text-sm font-medium mb-1" style="color:var(--c-muted)">
            Pain Level: <span id="pain-value" class="font-bold" style="color:var(--c-black)">${Math.max(1, injuryState.currentPain)}</span>/10
          </label>
          <input
            type="range"
            id="injury-pain"
            min="1"
            max="10"
            value="${Math.max(1, injuryState.currentPain)}"
            class="w-full h-2 rounded-lg appearance-none cursor-pointer"
            style="background:rgba(0,0,0,0.08)"
          />
          <div class="flex justify-between text-xs mt-1" style="color:var(--c-faint)">
            <span>Mild</span>
            <span>Severe</span>
          </div>
        </div>

        <!-- 3. Mobility Status -->
        <div>
          <label class="block text-sm font-medium mb-1" style="color:var(--c-muted)">Can you walk pain-free?</label>
          <select id="injury-mobility" style="${INPUT_STYLE}">
            <option value="yes">Yes - walking is fine</option>
            <option value="limited">Limited - some discomfort</option>
            <option value="no">No - walking is painful</option>
          </select>
        </div>

        <!-- 3.5. Can you run? -->
        <div>
          <label class="block text-sm font-medium mb-2" style="color:var(--c-muted)">Can you run?</label>
          <div class="flex gap-4">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="can-run" id="can-run-yes" value="yes" ${injuryState.canRun === 'yes' ? 'checked' : ''} class="w-4 h-4">
              <span class="text-sm" style="color:var(--c-black)">Yes</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="can-run" id="can-run-limited" value="limited" ${injuryState.canRun === 'limited' ? 'checked' : ''} class="w-4 h-4">
              <span class="text-sm" style="color:var(--c-black)">Limited / With pain</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="can-run" id="can-run-no" value="no" ${!injuryState.canRun || injuryState.canRun === 'no' ? 'checked' : ''} class="w-4 h-4">
              <span class="text-sm" style="color:var(--c-black)">No</span>
            </label>
          </div>
        </div>

        <!-- 3.6. Preferred Cross-Training -->
        <div>
          <label class="block text-sm font-medium mb-1" style="color:var(--c-muted)">Preferred rehab exercise</label>
          <select id="injury-cross-training" style="${INPUT_STYLE}">
            <option value="" ${!injuryState.preferredCrossTraining ? 'selected' : ''}>Auto (protocol default)</option>
            ${crossTrainingOptions.map((a: string) => `
              <option value="${a}" ${injuryState.preferredCrossTraining === a ? 'selected' : ''}>
                ${CROSS_TRAINING_LABELS[a] || a}
              </option>
            `).join('')}
          </select>
          <p class="text-xs mt-1" style="color:var(--c-faint)">Choose your preferred activity for rehab days.</p>
        </div>

        <!-- 4. Side/Detail (optional) -->
        <div>
          <label class="block text-sm font-medium mb-1" style="color:var(--c-muted)">Which side? (optional)</label>
          <input
            type="text"
            id="injury-location-detail"
            placeholder="e.g., Left, Right, Both"
            value="${injuryState.locationDetail || ''}"
            style="${INPUT_STYLE}"
          />
        </div>

        <!-- 5. Injury Type (collapsed) -->
        <details class="rounded-lg p-3" style="background:rgba(0,0,0,0.03);border:1px solid var(--c-border)">
          <summary class="text-sm font-medium cursor-pointer" style="color:var(--c-muted)">Advanced: Specific diagnosis (optional)</summary>
          <div class="mt-3">
            <select id="injury-type" style="${INPUT_STYLE}">
              ${injuryTypes.map(type => `
                <option value="${type}" ${injuryState.type === type ? 'selected' : ''}>
                  ${INJURY_PROTOCOLS[type].displayName}
                </option>
              `).join('')}
            </select>
            <p class="text-xs mt-1" style="color:var(--c-faint)">Leave as "General" if unsure — we'll adapt your plan based on pain level.</p>
          </div>
        </details>

        <!-- 6. Physio Notes (collapsed) -->
        <details class="rounded-lg p-3" style="background:rgba(0,0,0,0.03);border:1px solid var(--c-border)">
          <summary class="text-sm font-medium cursor-pointer" style="color:var(--c-muted)">Physio notes (optional)</summary>
          <div class="mt-3">
            <textarea
              id="injury-physio-notes"
              rows="3"
              placeholder="Enter notes from your physiotherapist..."
              class="resize-none"
              style="${INPUT_STYLE};height:auto"
            >${injuryState.physioNotes || ''}</textarea>
          </div>
        </details>

        <!-- Note -->
        <div class="rounded-lg p-3" style="border:1px solid var(--c-border)">
          <p class="text-xs" style="color:var(--c-muted)">
            Saving will automatically activate injury mode and adjust your training plan.
          </p>
        </div>

        <!-- Buttons -->
        <div class="flex gap-3 pt-2">
          <button type="button" id="injury-cancel" class="m-btn-glass m-btn-glass--inset">
            Cancel
          </button>
          ${injuryState.active ? `
            <button
              type="button"
              id="injury-resolve"
              class="px-4 py-2 rounded-lg text-sm font-medium"
              style="background:var(--c-ok-bg);border:1px solid rgba(34,197,94,0.4);color:var(--c-ok-text)"
            >
              Mark Resolved
            </button>
          ` : ''}
          <button
            type="submit"
            class="flex-1 px-4 py-2 rounded-lg text-sm font-medium"
            style="background:#EF4444;color:white"
          >
            ${injuryState.active ? 'Update Status' : 'Save & Activate'}
          </button>
        </div>
      </form>
    </div>
  `;
}

/**
 * Wire up modal event handlers
 */
function wireModalHandlers(): void {
  document.getElementById('injury-modal-close')?.addEventListener('click', closeInjuryModal);

  document.getElementById(MODAL_ID)?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeInjuryModal();
  });

  const painSlider = document.getElementById('injury-pain') as HTMLInputElement;
  const painValue = document.getElementById('pain-value');
  if (painSlider && painValue) {
    painSlider.addEventListener('input', () => {
      painValue.textContent = painSlider.value;
    });
  }

  document.getElementById('injury-cancel')?.addEventListener('click', () => closeInjuryModal());

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

  document.getElementById('injury-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSaveInjury();
  });
}

/**
 * Handle saving injury data
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

  let injuryState = getInjuryState();
  const wasAlreadyActive = injuryState.active;

  const isNewInjury = !injuryState.active || injuryState.injuryPhase === 'resolved';
  let initialPhase = injuryState.injuryPhase;
  if (isNewInjury) {
    if (painLevel >= 7) {
      initialPhase = 'acute';
    } else if (painLevel >= 4) {
      initialPhase = 'rehab';
    } else {
      initialPhase = 'test_capacity';
    }
  }

  injuryState = {
    ...injuryState,
    active: true,
    type: injuryType,
    location,
    locationDetail,
    physioNotes,
    canRun,
    preferredCrossTraining: preferredCrossTraining || null,
    startDate: isNewInjury ? new Date().toISOString() : injuryState.startDate,
    injuryPhase: initialPhase,
    acutePhaseStartDate: initialPhase === 'acute' ? new Date().toISOString() : injuryState.acutePhaseStartDate,
    ...(isNewInjury ? {
      capacityTestsPassed: [],
      capacityTestHistory: [],
      returnToRunLevel: 1,
      zeroPainWeeks: 0,
      graduatedReturnWeeksLeft: 2,
      holdCount: 0,
      morningPainResponses: [],
      history: [],
      phaseTransitions: [],
      lastTestRunDate: null,
      testRunPainResult: null,
    } : {}),
  };

  injuryState = recordPainLevel(injuryState, painLevel);
  injuryState = evaluatePhaseTransition(injuryState);

  const s = getMutableState();

  if (wasAlreadyActive && s.w >= 1 && s.w <= s.wks.length) {
    s.wks[s.w - 1].injuryCheckedIn = true;
  }

  setInjuryState(injuryState);
  saveState();

  if (wasAlreadyActive) {
    closeInjuryModal();
    const { next } = await import('@/ui/events');
    next();
  } else {
    window.location.reload();
  }
}

/**
 * Check if injury is currently active
 */
export function isInjuryActive(): boolean {
  return getInjuryState().active;
}

/**
 * Mark injury as recovered
 */
export function markAsRecovered(): void {
  let injuryState = getInjuryState();
  injuryState = { ...injuryState, active: false, currentPain: 0 };
  setInjuryState(injuryState);
  saveState();
  window.location.reload();
}

/**
 * Get current injury state for display
 */
export function getInjuryStateForDisplay(): InjuryState {
  return getInjuryState();
}

/** Phase display labels */
const PHASE_LABELS: Record<string, { label: string; style: string }> = {
  acute:            { label: 'Acute (Rest)',         style: `color:var(--c-warn)` },
  rehab:            { label: 'Rehabilitation',       style: `color:var(--c-caution)` },
  test_capacity:    { label: 'Capacity Testing',     style: `color:#A855F7` },
  return_to_run:    { label: 'Return to Run',        style: `color:var(--c-accent)` },
  graduated_return: { label: 'Graduated Return',     style: `color:#06B6D4` },
  resolved:         { label: 'Resolved',             style: `color:var(--c-ok)` },
};

/**
 * Render injury alert banner HTML
 */
export function renderInjuryBanner(): string {
  const injuryState = getInjuryState();
  if (!injuryState.active) return '';

  const protocol = INJURY_PROTOCOLS[injuryState.type];
  const displayName = protocol?.displayName || injuryState.type;
  const phaseInfo = PHASE_LABELS[injuryState.injuryPhase] || { label: 'Unknown', style: `color:var(--c-faint)` };

  return `
    <div class="rounded-lg p-3 mb-4" style="background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.25)">
      <div class="flex items-center gap-3">
        <svg class="w-5 h-5 flex-shrink-0" style="color:var(--c-warn)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
        <div class="flex-1">
          <p class="text-sm font-medium" style="color:var(--c-warn)">Injury Mode Active</p>
          <p class="text-xs" style="color:var(--c-muted)">
            ${displayName} — Pain: ${injuryState.currentPain}/10 —
            <span class="font-medium" style="${phaseInfo.style}">${phaseInfo.label}</span>
          </p>
        </div>
        <button id="btn-injury-details" class="text-xs px-2 py-1 rounded" style="background:rgba(239,68,68,0.1);color:var(--c-warn);border:1px solid rgba(239,68,68,0.25)">
          Details
        </button>
      </div>
    </div>
  `;
}

/** Styled toast for injury feedback */
function showInjuryToast(message: string, color: 'emerald' | 'amber'): void {
  const bg = color === 'emerald' ? 'var(--c-ok)' : 'var(--c-caution)';
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl shadow-lg text-sm font-medium z-[70] transition-opacity';
  toast.style.color = 'white';
  toast.style.background = bg;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 2500);
}

/**
 * Open the return-to-run gate modal for weekly check-in.
 */
export function openReturnToRunGateModal(): void {
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
  modal.className = 'fixed inset-0 flex items-center justify-center z-50';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.innerHTML = `
    <div class="rounded-xl p-6 w-full max-w-md mx-4 shadow-xl" style="background:var(--c-surface);border:1px solid var(--c-border-strong)">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold" style="color:var(--c-black)">Weekly Check-In</h2>
        <button id="injury-modal-close" style="color:var(--c-faint);background:none;border:none;cursor:pointer;padding:0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Current Level -->
      <div class="rounded-lg p-3 mb-4" style="background:rgba(78,159,229,0.08);border:1px solid rgba(78,159,229,0.3)">
        <div class="text-xs font-medium mb-1" style="color:var(--c-accent)">Current Protocol Level</div>
        <div class="text-sm font-semibold" style="color:var(--c-black)">${levelLabel}</div>
      </div>

      <!-- Morning Pain Summary -->
      ${mornings.length > 0 ? `
        <div class="rounded-lg p-3 mb-4" style="background:var(--c-bg);border:1px solid var(--c-border)">
          <div class="text-xs font-medium mb-2" style="color:var(--c-muted)">This Week's Morning Pain</div>
          <div class="flex gap-3 text-xs">
            <span style="color:var(--c-ok)">${betterCount} better</span>
            <span style="color:var(--c-accent)">${sameCount} same</span>
            <span style="color:var(--c-warn)">${worseCount} worse</span>
          </div>
        </div>
      ` : `
        <div class="rounded-lg p-3 mb-4" style="background:var(--c-bg);border:1px solid var(--c-border)">
          <div class="text-xs" style="color:var(--c-faint)">No morning pain data recorded this week</div>
        </div>
      `}

      <!-- Pain Slider -->
      <div class="mb-4">
        <label class="block text-sm font-medium mb-1" style="color:var(--c-muted)">
          How was your pain during the intervals?
          <span id="gate-pain-value" class="font-bold" style="color:var(--c-ok)">${injuryState.currentPain || 2}</span>/10
        </label>
        <input
          type="range"
          id="gate-pain-slider"
          min="0"
          max="10"
          value="${injuryState.currentPain || 2}"
          class="w-full h-2 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          style="background:rgba(0,0,0,0.08)"
        />
        <div class="flex justify-between text-xs mt-1" style="color:var(--c-faint)">
          <span>No pain</span>
          <span>Severe</span>
        </div>
      </div>

      <!-- Gate Decision Preview -->
      <div id="gate-decision-preview" class="rounded-lg p-3 mb-4" style="border:1px solid var(--c-border)"></div>

      <!-- Buttons -->
      <div class="flex gap-3">
        <button id="gate-cancel" class="m-btn-glass m-btn-glass--inset">Cancel</button>
        <button id="gate-confirm" class="flex-1 m-btn-primary px-4 py-2 rounded-lg text-sm font-medium">Confirm & Advance Week</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const updatePreview = () => {
    const painVal = parseInt((document.getElementById('gate-pain-slider') as HTMLInputElement)?.value || '2');
    const tempState: InjuryState = { ...injuryState, currentPain: painVal };
    const decision = evaluateReturnToRunGate(tempState);

    const previewEl = document.getElementById('gate-decision-preview');
    if (!previewEl) return;

    const colors = {
      progress: { bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.3)', textStyle: `color:var(--c-ok)`, label: 'Progressing' },
      hold:     { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)', textStyle: `color:var(--c-caution-text)`, label: 'Holding' },
      regress:  { bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.3)',  textStyle: `color:var(--c-warn)`, label: 'Stepping Back' },
    };
    const c = colors[decision.decision];
    const targetLabel = decision.newLevel > 8 ? 'Resolved!' : `Level ${decision.newLevel}`;

    previewEl.style.background = c.bg;
    previewEl.style.borderColor = c.border;
    previewEl.innerHTML = `
      <div class="text-sm font-semibold mb-1" style="${c.textStyle}">${c.label} → ${targetLabel}</div>
      <div class="text-xs" style="color:var(--c-muted)">${decision.reason}</div>
    `;
  };

  updatePreview();

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
    state = recordPainLevel(state, painVal);
    state = { ...state, severityClass: classifySeverity(state) };
    state = { ...state, zeroPainWeeks: painVal === 0 ? (state.zeroPainWeeks || 0) + 1 : 0 };
    const decision = evaluateReturnToRunGate(state);
    state = applyGateDecision(state, decision);

    const s = getMutableState();
    if (s.w >= 1 && s.w <= s.wks.length) {
      s.wks[s.w - 1].injuryCheckedIn = true;
    }

    setInjuryState(state);
    saveState();

    if (state.zeroPainWeeks >= 2 && state.injuryPhase === 'return_to_run') {
      closeInjuryModal();
      const choice = await showThreeOptionChoice(
        'Ready to return?',
        "You've had zero pain for 2 weeks. How would you like to proceed?",
        [
          { id: 'full',      label: 'Yes, full return',    description: 'Back to your normal training plan immediately' },
          { id: 'graduated', label: 'Yes, ease me back in', description: '2 weeks of reduced hard sessions with weekly check-ins' },
          { id: 'stay',      label: 'Not yet',              description: 'Continue recovery protocol' },
        ]
      );
      if (choice === 'full') { markAsRecovered(); return; }
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

    closeInjuryModal();
    const { next } = await import('@/ui/events');
    next();
  });
}

/** Styled confirm modal for injury decisions. */
function showInjuryConfirm(title: string, message: string, confirmLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 flex items-center justify-center z-[70] px-4';
    overlay.style.background = 'rgba(0,0,0,0.45)';
    overlay.innerHTML = `
      <div class="rounded-xl max-w-sm w-full p-6" style="background:var(--c-surface);border:1px solid var(--c-border-strong)">
        <h3 class="font-semibold text-lg mb-2" style="color:var(--c-black)">${title}</h3>
        <p class="text-sm mb-5" style="color:var(--c-muted)">${message}</p>
        <div class="flex flex-col gap-2">
          <button id="btn-injury-yes" class="w-full m-btn-primary py-2.5 font-medium rounded-lg text-sm">${confirmLabel}</button>
          <button id="btn-injury-no" class="w-full m-btn-glass m-btn-glass--inset">${cancelLabel}</button>
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
    overlay.className = 'fixed inset-0 flex items-center justify-center z-[70] px-4';
    overlay.style.background = 'rgba(0,0,0,0.45)';
    const buttonsHtml = options.map((opt, i) => {
      const btnStyle = i === 0
        ? `class="w-full m-btn-primary py-2.5 font-medium rounded-lg text-sm"`
        : i === 1
          ? `class="w-full py-2.5 font-medium rounded-lg text-sm" style="background:var(--c-accent);color:white"`
          : `class="w-full m-btn-glass m-btn-glass--inset"`;
      return `
        <button data-choice="${opt.id}" ${btnStyle}>
          ${opt.label}
          <span class="block text-xs opacity-75 font-normal mt-0.5">${opt.description}</span>
        </button>
      `;
    }).join('');
    overlay.innerHTML = `
      <div class="rounded-xl max-w-sm w-full p-6" style="background:var(--c-surface);border:1px solid var(--c-border-strong)">
        <h3 class="font-semibold text-lg mb-2" style="color:var(--c-black)">${title}</h3>
        <p class="text-sm mb-5" style="color:var(--c-muted)">${message}</p>
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
 */
export function openGraduatedReturnCheckIn(): void {
  closeInjuryModal();

  const injuryState = getInjuryState();
  const weeksLeft = injuryState.graduatedReturnWeeksLeft || 2;
  const weekNumber = 2 - weeksLeft + 1;

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 flex items-center justify-center z-50';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.innerHTML = `
    <div class="rounded-xl p-6 w-full max-w-md mx-4 shadow-xl" style="background:var(--c-surface);border:1px solid var(--c-border-strong)">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold" style="color:var(--c-black)">Graduated Return Check-In</h2>
        <button id="injury-modal-close" style="color:var(--c-faint);background:none;border:none;cursor:pointer;padding:0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Week indicator -->
      <div class="rounded-lg p-3 mb-4" style="background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.3)">
        <div class="text-xs font-medium mb-1" style="color:#06B6D4">Graduated Return</div>
        <div class="text-sm font-semibold" style="color:var(--c-black)">Week ${weekNumber} of 2</div>
        <p class="text-xs mt-1" style="color:var(--c-muted)">Hard sessions are reduced. Easy runs are normal.</p>
      </div>

      <!-- Pain Slider -->
      <div class="mb-4">
        <label class="block text-sm font-medium mb-1" style="color:var(--c-muted)">
          How was your pain this week?
          <span id="grad-pain-value" class="font-bold" style="color:var(--c-ok)">${injuryState.currentPain || 0}</span>/10
        </label>
        <input
          type="range"
          id="grad-pain-slider"
          min="0"
          max="10"
          value="${injuryState.currentPain || 0}"
          class="w-full h-2 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          style="background:rgba(0,0,0,0.08)"
        />
        <div class="flex justify-between text-xs mt-1" style="color:var(--c-faint)">
          <span>No pain</span>
          <span>Severe</span>
        </div>
      </div>

      <!-- Decision preview -->
      <div id="grad-decision-preview" class="rounded-lg p-3 mb-4" style="border:1px solid var(--c-border)"></div>

      <!-- Buttons -->
      <div class="flex gap-3">
        <button id="grad-cancel" class="m-btn-glass m-btn-glass--inset">Cancel</button>
        <button id="grad-confirm" class="flex-1 m-btn-primary px-4 py-2 rounded-lg text-sm font-medium">Confirm & Advance Week</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const updatePreview = () => {
    const painVal = parseInt((document.getElementById('grad-pain-slider') as HTMLInputElement)?.value || '0');
    const previewEl = document.getElementById('grad-decision-preview');
    if (!previewEl) return;

    if (painVal <= 1) {
      const remaining = weeksLeft - 1;
      previewEl.style.background = 'rgba(34,197,94,0.08)';
      previewEl.style.borderColor = 'rgba(34,197,94,0.3)';
      if (remaining <= 0) {
        previewEl.innerHTML = `
          <div class="text-sm font-semibold mb-1" style="color:var(--c-ok)">Fully Resolved!</div>
          <div class="text-xs" style="color:var(--c-muted)">2 clean weeks complete — returning to normal training</div>
        `;
      } else {
        previewEl.innerHTML = `
          <div class="text-sm font-semibold mb-1" style="color:var(--c-ok)">Progressing</div>
          <div class="text-xs" style="color:var(--c-muted)">${remaining} week${remaining > 1 ? 's' : ''} remaining in graduated return</div>
        `;
      }
    } else if (painVal <= 3) {
      previewEl.style.background = 'rgba(245,158,11,0.08)';
      previewEl.style.borderColor = 'rgba(245,158,11,0.3)';
      previewEl.innerHTML = `
        <div class="text-sm font-semibold mb-1" style="color:var(--c-caution-text)">Holding</div>
        <div class="text-xs" style="color:var(--c-muted)">Pain ${painVal}/10 — staying at current level, week does not count</div>
      `;
    } else {
      previewEl.style.background = 'rgba(239,68,68,0.08)';
      previewEl.style.borderColor = 'rgba(239,68,68,0.3)';
      previewEl.innerHTML = `
        <div class="text-sm font-semibold mb-1" style="color:var(--c-warn)">Stepping Back</div>
        <div class="text-xs" style="color:var(--c-muted)">Pain ${painVal}/10 — returning to return-to-run protocol</div>
      `;
    }
  };

  updatePreview();

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
      state = { ...state, injuryPhase: 'return_to_run' as const, graduatedReturnWeeksLeft: 2 };
      showInjuryToast('Pain spike — returning to return-to-run protocol', 'amber');
    } else if (painVal >= 2) {
      showInjuryToast('Holding at current level — week does not count', 'amber');
    } else {
      state.graduatedReturnWeeksLeft = Math.max(0, (state.graduatedReturnWeeksLeft || 2) - 1);
      if (state.graduatedReturnWeeksLeft <= 0) {
        state = applyPhaseProgression(state, 'Completed graduated return — 2 clean weeks');
        showInjuryToast('Graduated return complete — back to full training!', 'emerald');
      }
    }

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
