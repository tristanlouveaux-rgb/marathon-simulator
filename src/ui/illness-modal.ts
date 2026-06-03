/**
 * Illness modal. Opened from the check-in overlay.
 *
 * Captures the symptom picture (above-neck vs below-neck, plus a fever/body-aches
 * flag and a severity) and builds the v2 illness schedule via the pure engine in
 * `calculations/illness-rules.ts`. The schedule + classification are written to
 * `s.illnessState`; the render-time plan mutation (`applyIllnessMods`) reads them
 * and, crucially, REST the strength work for below-neck illness (viral
 * myocarditis risk, Schwellnus 2016) — the legacy path silently left strength at
 * full load. Plain `severity` is still derived for back-compat banners.
 */

import { getMutableState } from '@/state/store';
import { saveState } from '@/state';
import {
  classifyIllness, buildSchedule, deriveLegacySeverity, summariseSchedule,
  type Symptom, type IllnessType, type Classification, type ScheduleEntry,
} from '@/calculations/illness-rules';

const MODAL_ID = 'illness-modal';

type SymptomChoice = 'above' | 'below' | 'systemic';
type SeverityChoice = 'mild' | 'moderate' | 'severe';

const SEVERITY_1TO10: Record<SeverityChoice, number> = { mild: 2, moderate: 5, severe: 8 };

const SYMPTOM_CARDS: Array<{ key: SymptomChoice; title: string; body: string }> = [
  { key: 'above', title: 'Above the neck',
    body: 'Runny nose, sneezing, sore throat, mild headache. Easy training at reduced volume is usually fine.' },
  { key: 'below', title: 'Below the neck',
    body: 'Chest, cough, or gut symptoms. Rest first, then a graded return. Strength work pauses.' },
  { key: 'systemic', title: 'Fever or body aches',
    body: 'Systemic illness. Full rest. Training through a fever raises heart-muscle risk and blunts recovery.' },
];

/** Pure: map the modal's symptom + severity choice into the engine inputs and
 *  the resulting classification + schedule. Shared by the live preview and the
 *  commit so the user sees exactly what gets stored. */
function computeIllnessPlan(symptom: SymptomChoice, severity: SeverityChoice): {
  illnessType: IllnessType; symptoms: Symptom[]; severity1to10: number;
  classification: Classification; schedule: ScheduleEntry[];
} {
  const illnessType: IllnessType = symptom === 'above' ? 'head_cold' : 'flu_chest';
  const symptoms: Symptom[] =
    symptom === 'above' ? (severity === 'mild' ? ['runny_nose'] : ['runny_nose', 'sore_throat'])
    : symptom === 'systemic' ? ['fever', 'body_aches']
    : ['cough'];
  const severity1to10 = SEVERITY_1TO10[severity];
  // RHR-delta refinement deferred (no daily resting-HR history wired to the
  // modal); null keeps rhrFlag normal and does not affect below-neck suppression.
  const classification = classifyIllness({ illnessType, symptoms, severity1to10, rhrDeltaBpm: null });
  const schedule = buildSchedule(classification, '1-2');
  return { illnessType, symptoms, severity1to10, classification, schedule };
}

export function openIllnessModal(): void {
  document.getElementById(MODAL_ID)?.remove();

  let symptom: SymptomChoice | null = null;
  let severity: SeverityChoice = 'moderate';

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  modal.style.background = 'rgba(0,0,0,0.45)';

  const cardStyle = (selected: boolean) =>
    `width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;` +
    `border:1px solid ${selected ? 'var(--c-black)' : 'var(--c-border)'};background:transparent;cursor:pointer;` +
    `margin-bottom:8px;text-align:left`;
  const chipStyle = (selected: boolean) =>
    `flex:1;padding:9px 0;border-radius:10px;border:1px solid ${selected ? 'var(--c-black)' : 'var(--c-border)'};` +
    `background:transparent;font-size:13px;font-weight:500;color:var(--c-black);cursor:pointer`;

  const render = () => {
    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
        <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">Illness</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px;line-height:1.5">Tell us your symptoms. We'll adjust this week and protect your recovery. Skipped workouts won't count against adherence.</div>

        <div style="font-size:11px;font-weight:600;color:var(--c-muted);margin-bottom:8px">SYMPTOMS</div>
        ${SYMPTOM_CARDS.map(c => `
          <button data-symptom="${c.key}" style="${cardStyle(symptom === c.key)}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:4px">${c.title}</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.5">${c.body}</div>
          </button>
        `).join('')}

        <div style="font-size:11px;font-weight:600;color:var(--c-muted);margin:14px 0 8px">HOW BAD IS IT?</div>
        <div style="display:flex;gap:8px;margin-bottom:${symptom ? '14' : '18'}px">
          ${(['mild', 'moderate', 'severe'] as SeverityChoice[]).map(sv => `
            <button data-severity="${sv}" style="${chipStyle(severity === sv)}">${sv[0].toUpperCase() + sv.slice(1)}</button>
          `).join('')}
        </div>

        ${symptom ? (() => {
          const { classification, schedule } = computeIllnessPlan(symptom, severity);
          const lines = summariseSchedule(classification, schedule);
          return `
          <div style="border:1px solid var(--c-border);border-radius:12px;padding:12px 14px;margin-bottom:18px">
            <div style="font-size:11px;font-weight:600;color:var(--c-muted);margin-bottom:6px">WHAT WE'LL DO</div>
            ${lines.map(l => `<div style="font-size:12px;color:var(--c-black);line-height:1.5;margin-bottom:4px">${l}</div>`).join('')}
          </div>`;
        })() : ''}

        <button id="illness-confirm"
          style="width:100%;padding:12px;border-radius:12px;border:none;background:${symptom ? 'var(--c-black)' : 'var(--c-border)'};
                 color:#fff;font-size:14px;font-weight:600;cursor:${symptom ? 'pointer' : 'default'};margin-bottom:8px"
          ${symptom ? '' : 'disabled'}>Set this</button>
        <button id="illness-cancel"
          style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
                 background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer">Cancel</button>
      </div>
    `;
    wire();
  };

  const wire = () => {
    modal.querySelectorAll<HTMLElement>('[data-symptom]').forEach(btn => {
      btn.addEventListener('click', () => { symptom = btn.dataset.symptom as SymptomChoice; render(); });
    });
    modal.querySelectorAll<HTMLElement>('[data-severity]').forEach(btn => {
      btn.addEventListener('click', () => { severity = btn.dataset.severity as SeverityChoice; render(); });
    });
    modal.querySelector('#illness-cancel')?.addEventListener('click', () => modal.remove());
    modal.querySelector('#illness-confirm')?.addEventListener('click', () => { if (symptom) confirm(symptom, severity); });
  };

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  render();
}

function confirm(symptom: SymptomChoice, severity: SeverityChoice): void {
  document.getElementById(MODAL_ID)?.remove();

  // Same computation the live preview showed, so the stored schedule matches.
  const { illnessType, symptoms, severity1to10, classification, schedule } = computeIllnessPlan(symptom, severity);

  const today = new Date().toISOString().split('T')[0];
  const s = getMutableState();
  s.illnessState = {
    startDate: today,
    onsetDate: today,
    active: true,
    severity: deriveLegacySeverity(schedule),
    classification,
    schedule,
    symptoms,
    illnessType,
    severity1to10,
    dayOfSymptoms: '1-2',
  };
  saveState();
  window.location.reload();
}

/** Clear illness state (mark recovered). */
export function clearIllness(): void {
  const s = getMutableState();
  if (s.illnessState) {
    s.illnessState.active = false;
  }
  saveState();
  window.location.reload();
}
