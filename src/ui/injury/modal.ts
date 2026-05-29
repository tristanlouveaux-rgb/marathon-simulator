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
  shoulder: 'Shoulder',
  upper_arm: 'Upper Arm',
  elbow: 'Elbow',
  forearm: 'Forearm',
  wrist: 'Wrist / Hand',
  neck: 'Neck',
  chest_ribs: 'Chest / Ribs',
  other: 'Other',
};
import { INJURY_PROTOCOLS } from '@/constants/injury-protocols';
import { recordPainLevel, recordCapacityTest, applyPhaseProgression, hasPassedRequiredCapacityTests, evaluateReturnToRunGate, applyGateDecision, getReturnToRunLevelLabel, classifySeverity, evaluatePhaseTransition, getDisciplineCapacity, type DisciplineKey } from '@/injury/engine';
import type { SimulatorState, Workout } from '@/types/state';
import { injuryStrengthDecision } from '@/workouts/injury-strength';
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

const INPUT_STYLE = `background:var(--c-bg);border:1px solid var(--c-border);color:var(--c-black);border-radius:10px;width:100%;padding:10px 12px;font-size:14px;outline:none;font-family:var(--f)`;
const LABEL_STYLE = `display:block;font-size:12px;font-weight:600;color:var(--c-muted);margin-bottom:6px;letter-spacing:0.01em`;

/** A discipline shown in the capacity-capture block, with its copy. */
interface DiscConfig {
  disc: DisciplineKey;
  question: string;    // "Can you run?"
  resumeLabel: string; // "running" -> "Back to running in N weeks"
  verb0: string;       // caption shown when capacity is 0
}

/**
 * The disciplines to show capacity sliders for, by mode.
 * Running = run only; triathlon = run/bike/swim; HYROX = run/upper-load/lower-load.
 * Mirrors the per-mode list in buildInjuryCaption().
 */
function disciplinesForMode(eventType: string | undefined): DiscConfig[] {
  if (eventType === 'hyrox') {
    return [
      { disc: 'run',       question: 'Can you run?',      resumeLabel: 'running',         verb0: 'Cannot run' },
      { disc: 'upperLoad', question: 'Upper-body load?',  resumeLabel: 'upper-body work', verb0: 'No upper-body loading' },
      { disc: 'lowerLoad', question: 'Lower-body load?',  resumeLabel: 'lower-body work', verb0: 'No lower-body loading' },
    ];
  }
  if (eventType === 'triathlon') {
    return [
      { disc: 'run',  question: 'Can you run?',  resumeLabel: 'running',   verb0: 'Cannot run' },
      { disc: 'bike', question: 'Can you bike?', resumeLabel: 'cycling',   verb0: 'Cannot bike' },
      { disc: 'swim', question: 'Can you swim?', resumeLabel: 'swimming',  verb0: 'Cannot swim' },
    ];
  }
  // running (and any unset mode) = run only
  return [
    { disc: 'run', question: 'Can you run?', resumeLabel: 'running', verb0: 'Cannot run' },
  ];
}

/** Right-aligned value label for a capacity slider. */
const capValueLabel = (cap: number): string => (cap <= 0 ? 'None' : cap >= 100 ? 'Full' : `${cap}%`);
/** Caption beneath a capacity slider. verb0 used at 0%. */
const capCaptionText = (cap: number, verb0: string): string =>
  cap <= 0 ? verb0 : cap >= 100 ? 'Full capacity' : 'Reduced volume, sessions scaled down';

function getModalHTML(injuryState: InjuryState): string {
  const injuryTypes = Object.keys(INJURY_PROTOCOLS) as InjuryType[];
  const protocol = INJURY_PROTOCOLS[injuryState.type] || INJURY_PROTOCOLS.general;
  const crossTrainingOptions = (protocol.allowedActivities || [])
    .filter((a: string) => a in CROSS_TRAINING_LABELS);
  const pain = Math.max(1, injuryState.currentPain);
  const eventType = (getState() as any).eventType as string | undefined;
  const disciplines = disciplinesForMode(eventType);

  // Seed a return-to-sport estimate from the protocol's typical recovery window
  // (injury-protocols.ts, clinical-judgement bands) so restricted disciplines
  // default to a sensible week count instead of blank. User-editable.
  const rw = protocol.typicalRecoveryWeeks;
  const recoveryMid = rw ? Math.round((rw.min + rw.max) / 2) : '';

  const capacityBlock = disciplines.map(({ disc, question, resumeLabel, verb0 }) => {
    const cap = Math.round(getDisciplineCapacity(injuryState, disc));
    const resume = injuryState.resumeWeeksByDiscipline?.[disc] ?? recoveryMid;
    return `
        <div class="injury-cap-block" data-disc="${disc}" data-verb0="${verb0}">
          <div class="flex items-center justify-between mb-2">
            <label style="${LABEL_STYLE};margin-bottom:0">${question}</label>
            <span id="injury-cap-${disc}-val" style="font-size:12px;font-weight:600;color:var(--c-black)">${capValueLabel(cap)}</span>
          </div>
          <input type="range" id="injury-cap-${disc}" class="m-slider-glass" min="0" max="100" step="5" value="${cap}" />
          <p id="injury-cap-${disc}-caption" style="font-size:12px;color:var(--c-muted);margin-top:6px;margin-bottom:0">${capCaptionText(cap, verb0)}</p>
          <div id="injury-resume-${disc}-row" class="flex items-center gap-2 mt-2" style="${cap >= 100 ? 'display:none' : ''}">
            <span style="font-size:13px;color:var(--c-muted)">Back to ${resumeLabel} in</span>
            <input type="number" id="injury-resume-${disc}" min="0" max="52" value="${resume === '' ? '' : resume}" placeholder="?" style="${INPUT_STYLE};width:64px;text-align:center;padding:8px" />
            <span style="font-size:13px;color:var(--c-muted)">weeks</span>
          </div>
        </div>`;
  }).join('');

  return `
    <style>
      #${MODAL_ID} #injury-form details > summary { list-style:none; cursor:pointer; display:flex; align-items:center; justify-content:space-between; font-size:13px; font-weight:500; color:var(--c-muted); padding:10px 0; }
      #${MODAL_ID} #injury-form details > summary::-webkit-details-marker { display:none; }
      #${MODAL_ID} #injury-form details > summary::after { content:''; width:8px; height:8px; border-right:1.5px solid var(--c-faint); border-bottom:1.5px solid var(--c-faint); transform:rotate(-45deg); transition:transform 0.2s; }
      #${MODAL_ID} #injury-form details[open] > summary::after { transform:rotate(45deg); }
      #${MODAL_ID} #injury-form select:focus, #${MODAL_ID} #injury-form input:focus, #${MODAL_ID} #injury-form textarea:focus { border-color:var(--c-border-strong); }
    </style>
    <div class="rounded-2xl p-5 w-full max-w-md mx-4 shadow-xl overflow-y-auto" style="background:var(--c-surface);border:1px solid var(--c-border);max-height:90vh">
      <div class="flex items-center justify-between mb-5">
        <h2 style="font-size:17px;font-weight:600;color:var(--c-black);letter-spacing:-0.01em">${injuryState.active ? 'Weekly injury update' : 'Report injury'}</h2>
        <button id="injury-modal-close" style="color:var(--c-faint);background:none;border:none;cursor:pointer;padding:4px;margin:-4px">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <form id="injury-form" class="space-y-4">
        <!-- 1. Location + Side -->
        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2">
            <label style="${LABEL_STYLE}">Where does it hurt?</label>
            <select id="injury-location" style="${INPUT_STYLE}">
              ${(Object.keys(LOCATION_LABELS) as InjuryLocation[]).map(loc => `
                <option value="${loc}" ${injuryState.location === loc ? 'selected' : ''}>
                  ${LOCATION_LABELS[loc]}
                </option>
              `).join('')}
            </select>
          </div>
          <div>
            <label style="${LABEL_STYLE}">Side</label>
            <input
              type="text"
              id="injury-location-detail"
              placeholder="L / R / Both"
              value="${injuryState.locationDetail || ''}"
              style="${INPUT_STYLE}"
            />
          </div>
        </div>

        <!-- 2. Pain Level Slider -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <label style="${LABEL_STYLE};margin-bottom:0">Pain level</label>
            <span style="font-size:12px;color:var(--c-muted)"><span id="pain-value" style="font-weight:600;color:var(--c-black)">${pain}</span> / 10</span>
          </div>
          <input
            type="range"
            id="injury-pain"
            class="m-slider-glass"
            min="1"
            max="10"
            value="${pain}"
          />
          <div class="flex justify-between mt-1.5" style="font-size:11px;color:var(--c-faint)">
            <span>Mild</span>
            <span>Severe</span>
          </div>
        </div>

        <!-- 3. Walking -->
        <div>
          <label style="${LABEL_STYLE}">Can you walk pain-free?</label>
          <select id="injury-mobility" style="${INPUT_STYLE}">
            <option value="yes">Yes, walking is fine</option>
            <option value="limited">Limited, some discomfort</option>
            <option value="no">No, walking is painful</option>
          </select>
        </div>

        <!-- 4. Per-discipline capacity + return-to-sport timeline (mode-aware) -->
        <div class="space-y-4">
          ${capacityBlock}
        </div>

        <!-- 5. Preferred Cross-Training -->
        <div>
          <label style="${LABEL_STYLE}">Preferred rehab activity</label>
          <select id="injury-cross-training" style="${INPUT_STYLE}">
            <option value="" ${!injuryState.preferredCrossTraining ? 'selected' : ''}>Auto (protocol default)</option>
            ${crossTrainingOptions.map((a: string) => `
              <option value="${a}" ${injuryState.preferredCrossTraining === a ? 'selected' : ''}>
                ${CROSS_TRAINING_LABELS[a] || a}
              </option>
            `).join('')}
          </select>
        </div>

        <!-- Advanced sections divider -->
        <div style="border-top:1px solid var(--c-border);margin-top:8px"></div>

        <!-- 6. Injury Type (collapsed) -->
        <details>
          <summary>Specific diagnosis (optional)</summary>
          <div style="padding-bottom:10px">
            <select id="injury-type" style="${INPUT_STYLE}">
              ${injuryTypes.map(type => `
                <option value="${type}" ${injuryState.type === type ? 'selected' : ''}>
                  ${INJURY_PROTOCOLS[type].displayName}
                </option>
              `).join('')}
            </select>
            <p style="font-size:11px;color:var(--c-faint);margin-top:6px">Leave as General if unsure. The plan adapts based on pain level.</p>
          </div>
        </details>

        <!-- 7. Physio Notes (collapsed) -->
        <details style="border-top:1px solid var(--c-border);margin-top:0">
          <summary>Physio notes (optional)</summary>
          <div style="padding-bottom:10px">
            <textarea
              id="injury-physio-notes"
              rows="3"
              placeholder="Notes from your physiotherapist..."
              class="resize-none"
              style="${INPUT_STYLE};height:auto"
            >${injuryState.physioNotes || ''}</textarea>
          </div>
        </details>

        <!-- Caption -->
        <p style="font-size:11px;color:var(--c-faint);text-align:center;margin-top:4px">
          Saving activates injury mode and adjusts your training plan.
        </p>

        <!-- Buttons -->
        <div class="flex flex-col gap-2 pt-1">
          <button
            type="submit"
            class="m-btn-primary"
            style="width:100%;justify-content:center;padding:11px 18px;font-size:14px"
          >
            ${injuryState.active ? 'Update status' : 'Save and activate'}
          </button>
          ${injuryState.active ? `
            <button type="button" id="injury-resolve" class="m-btn-glass m-btn-glass--inset" style="width:100%">
              Mark resolved
            </button>
          ` : ''}
          <button
            type="button"
            id="injury-cancel"
            style="background:none;border:none;color:var(--c-muted);padding:8px;font-size:13px;cursor:pointer;font-family:var(--f)"
          >
            Cancel
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

  // Per-discipline capacity sliders: live value label, caption, and resume-row visibility
  document.querySelectorAll<HTMLInputElement>('input[id^="injury-cap-"]').forEach(slider => {
    const disc = slider.id.slice('injury-cap-'.length);
    const block = slider.closest('.injury-cap-block') as HTMLElement | null;
    const verb0 = block?.dataset.verb0 || 'Cannot do this';
    const valEl = document.getElementById(`injury-cap-${disc}-val`);
    const capEl = document.getElementById(`injury-cap-${disc}-caption`);
    const resumeRow = document.getElementById(`injury-resume-${disc}-row`);
    slider.addEventListener('input', () => {
      const cap = parseInt(slider.value, 10);
      if (valEl) valEl.textContent = capValueLabel(cap);
      if (capEl) capEl.textContent = capCaptionText(cap, verb0);
      if (resumeRow) resumeRow.style.display = cap >= 100 ? 'none' : '';
    });
  });

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
  const crossTrainingSelect = document.getElementById('injury-cross-training') as HTMLSelectElement;
  const preferredCrossTraining = crossTrainingSelect?.value || null;

  let injuryState = getInjuryState();

  // Per-discipline capacity + return-to-sport timeline (mode-aware)
  const eventType = (getState() as any).eventType as string | undefined;
  const disciplines = disciplinesForMode(eventType);
  const capacityUpdates: Record<string, number> = {};
  const resumeWeeks: Partial<Record<DisciplineKey, number>> = { ...(injuryState.resumeWeeksByDiscipline || {}) };
  let runCap = getDisciplineCapacity(injuryState, 'run');
  for (const { disc } of disciplines) {
    const slider = document.getElementById(`injury-cap-${disc}`) as HTMLInputElement | null;
    let cap = getDisciplineCapacity(injuryState, disc);
    if (slider) {
      cap = Math.max(0, Math.min(100, parseInt(slider.value, 10) || 0));
      capacityUpdates[`${disc}Capacity`] = cap;
      if (disc === 'run') runCap = cap;
    }
    // A return-to-sport window only applies while the discipline is restricted.
    const resumeEl = document.getElementById(`injury-resume-${disc}`) as HTMLInputElement | null;
    if (cap < 100 && resumeEl && resumeEl.value.trim() !== '') {
      resumeWeeks[disc] = Math.max(0, parseInt(resumeEl.value, 10) || 0);
    } else {
      delete resumeWeeks[disc];
    }
  }
  // Keep the legacy canRun enum in sync so the return-to-run protocol and freeze gate still work.
  const canRun: 'yes' | 'limited' | 'no' = runCap <= 0 ? 'no' : runCap >= 100 ? 'yes' : 'limited';
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
    ...capacityUpdates,
    resumeWeeksByDiscipline: resumeWeeks,
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

  // HYROX plans are gated only at generation time, so an injury change must
  // trigger an explicit regen of the current + future weeks for the discipline
  // gates (drop runs when blocked, drop/scale stations by upper/lower capacity)
  // to take effect. Running and triathlon regenerate weeks on demand; HYROX
  // does not, so without this the plan keeps prescribing runs/stations the
  // athlete reported they cannot do. Past weeks are preserved (the gate skips
  // them, and regen carries over each week's actuals/rated/skip).
  if ((getState() as { eventType?: string }).eventType === 'hyrox' && s.wks?.length) {
    const { regenerateHyroxWeek } = await import('@/workouts/plan_engine.hyrox');
    for (let wi = s.w; wi <= s.wks.length; wi++) {
      const regen = regenerateHyroxWeek(s, wi);
      if (regen) s.wks[wi - 1] = regen;
    }
    saveState();
  }

  closeInjuryModal();

  if (wasAlreadyActive) {
    // Updating an existing injury must NOT advance the plan week. Re-render the
    // current view in place to reflect the new capacity, then offer the nudge.
    // Historic bug: this called next(), which ran the full week-completion flow
    // (s.w++ at events.ts), pushing the user forward one week on every injury edit.
    render();
    await maybeShowStrengthNudge();
  } else {
    await maybeShowStrengthNudge();
    window.location.reload();
  }
}

/**
 * After an injury update, offer ONE region-safe strength session to compensate
 * for the disciplines the injury limits (e.g. cannot run, so add leg/upper work).
 * Suggestion only: nothing is added unless the user accepts. Fires at most once
 * per week (strengthNudgeSeen guard). Reuses the existing injuryStrengthDecision
 * generator, which already picks injury-safe exercises and scales by region
 * capacity, so there are no invented load numbers here.
 */
async function maybeShowStrengthNudge(): Promise<void> {
  const s = getMutableState();
  const wk = s.wks?.[s.w - 1];
  if (!wk || wk.strengthNudgeSeen) return;

  const inj = getInjuryState();
  if (!inj.active) return;

  // Only when a discipline is actually limited this week.
  const caption = buildInjuryCaption(s);
  if (!caption) return;

  // Only when loaded strength is currently safe (region-adapted session exists).
  // Acute phase or all regions blocked returns 'none' and we stay quiet.
  const decision = injuryStrengthDecision(inj);
  if (decision.kind !== 'adapted') return;

  // Mark seen up front so a dismissed nudge never re-fires this week.
  wk.strengthNudgeSeen = true;
  saveState();

  const accepted = await showInjuryConfirm(
    'Add a strength session?',
    `${caption} A session that avoids the injured area holds your strength and durability while you recover.`,
    'Add session',
    'Not now',
  );
  if (!accepted) return;

  const workout: Workout = {
    ...decision.workout,
    id: `adhoc-strength-${Date.now()}`,
  };
  if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
  wk.adhocWorkouts.push(workout);
  saveState();
  render();
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

/**
 * Plain-text sentence describing the current injury's effect on training,
 * suitable to prepend to the readiness caption on Home and Readiness.
 * Returns '' when no injury is active or every discipline is at full capacity.
 *
 * Examples:
 *   "Running and swimming blocked by injury. Cycling capped at 40%."
 *   "Running blocked by injury."
 *   "Cycling capped at 60%."
 */
export function buildInjuryCaption(s: SimulatorState): string {
  if (!isInjuryActive()) return '';
  const inj = getInjuryState();

  const eventType = (s as any).eventType as 'running' | 'triathlon' | 'hyrox' | undefined;
  const isHyrox = eventType === 'hyrox';
  const fields: Array<{ disc: DisciplineKey; label: string }> = isHyrox
    ? [
        { disc: 'run',       label: 'running' },
        { disc: 'upperLoad', label: 'upper-body work' },
        { disc: 'lowerLoad', label: 'lower-body work' },
      ]
    : [
        { disc: 'run',  label: 'running' },
        { disc: 'bike', label: 'cycling' },
        { disc: 'swim', label: 'swimming' },
      ];

  const blocked: string[] = [];
  const reduced: Array<{ label: string; pct: number }> = [];
  for (const { disc, label } of fields) {
    const cap = getDisciplineCapacity(inj, disc);
    if (cap === 0) blocked.push(label);
    else if (cap < 100) reduced.push({ label, pct: cap });
  }
  if (blocked.length === 0 && reduced.length === 0) return '';

  const joinAnd = (items: string[]): string => {
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  };
  const sentenceCap = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);

  const parts: string[] = [];
  if (blocked.length) {
    parts.push(`${sentenceCap(joinAnd(blocked))} blocked by injury.`);
  }
  if (reduced.length === 1) {
    const r = reduced[0];
    parts.push(`${sentenceCap(r.label)} capped at ${r.pct}%.`);
  } else if (reduced.length > 1) {
    const phrase = reduced
      .map((r, i) => i === 0 ? `${sentenceCap(r.label)} capped at ${r.pct}%` : `${r.label} at ${r.pct}%`)
      .join(', ');
    parts.push(`${phrase}.`);
  }
  return parts.join(' ');
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
            ${displayName}. Pain: ${injuryState.currentPain}/10. <Span class="font-medium" style="${phaseInfo.style}">${phaseInfo.label}</span>
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
          class="m-slider-glass"
          min="0"
          max="10"
          value="${injuryState.currentPain || 2}"
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
          class="m-slider-glass"
          min="0"
          max="10"
          value="${injuryState.currentPain || 0}"
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
          <div class="text-xs" style="color:var(--c-muted)">2 clean weeks complete. Returning to normal training</div>
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
        <div class="text-xs" style="color:var(--c-muted)">Pain ${painVal}/10: staying at current level, week does not count</div>
      `;
    } else {
      previewEl.style.background = 'rgba(239,68,68,0.08)';
      previewEl.style.borderColor = 'rgba(239,68,68,0.3)';
      previewEl.innerHTML = `
        <div class="text-sm font-semibold mb-1" style="color:var(--c-warn)">Stepping Back</div>
        <div class="text-xs" style="color:var(--c-muted)">Pain ${painVal}/10. Returning to return-to-run protocol</div>
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
      showInjuryToast('Pain spike: returning to return-to-run protocol', 'amber');
    } else if (painVal >= 2) {
      showInjuryToast('Holding at current level: week does not count', 'amber');
    } else {
      state.graduatedReturnWeeksLeft = Math.max(0, (state.graduatedReturnWeeksLeft || 2) - 1);
      if (state.graduatedReturnWeeksLeft <= 0) {
        state = applyPhaseProgression(state, 'Completed graduated return. 2 Clean weeks');
        showInjuryToast('Graduated return complete: back to full training!', 'emerald');
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
