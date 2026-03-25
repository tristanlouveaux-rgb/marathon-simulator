/**
 * Illness modal — opened from the check-in overlay.
 *
 * Asks the user how they are managing their illness, then sets illnessState
 * on the simulator state. The plan is not mutated; an illness banner appears
 * on the plan and home views reassuring the user that skips won't hurt adherence.
 */

import { getMutableState } from '@/state/store';
import { saveState } from '@/state';

const MODAL_ID = 'illness-modal';

export function openIllnessModal(): void {
  document.getElementById(MODAL_ID)?.remove();

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  modal.style.background = 'rgba(0,0,0,0.45)';

  modal.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
      <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">Illness</div>
      <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px;line-height:1.5">Your plan will adjust for this week. Skipped workouts won't count against adherence.</div>

      <button id="illness-opt-light"
        style="width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;
               border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:8px;text-align:left">
        <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:4px">Still running</div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5">Threshold, interval and tempo sessions converted to easy runs at 50% distance. Easy and long runs reduced to 60%.</div>
      </button>

      <button id="illness-opt-resting"
        style="width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;
               border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:18px;text-align:left">
        <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:4px">Full rest</div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.5">All running workouts replaced with rest. Resume training when you mark yourself recovered.</div>
      </button>

      <button id="illness-cancel"
        style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
               background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer">
        Cancel
      </button>
    </div>
  `;

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  document.getElementById('illness-cancel')?.addEventListener('click', () => modal.remove());

  const confirm = (severity: 'light' | 'resting') => {
    modal.remove();
    const s = getMutableState();
    s.illnessState = {
      startDate: new Date().toISOString().split('T')[0],
      severity,
      active: true,
    };
    saveState();
    window.location.reload();
  };

  document.getElementById('illness-opt-light')?.addEventListener('click', () => confirm('light'));
  document.getElementById('illness-opt-resting')?.addEventListener('click', () => confirm('resting'));
}

// ─── Workout modification (render-time, not persisted) ───────────────────────

const QUALITY_TYPES = ['threshold', 'interval', 'tempo', 'marathon_pace', 'race_pace', 'strides', 'fartlek'];
const NON_RUN_TYPES = ['cross', 'gym', 'strength', 'rest', 'yoga', 'swim', 'bike', 'cycl', 'row', 'hik', 'walk',
  'pilates', 'box', 'padel', 'tennis', 'football', 'soccer', 'basketball', 'rugby', 'elliptic', 'climb', 'ski'];

function parseKmFromDesc(d: string): number {
  const m = (d || '').match(/(\d+\.?\d*)km/);
  return m ? parseFloat(m[1]) : 0;
}

/**
 * Apply illness modifications to a workouts array IN MEMORY (render-time only — not saved to state).
 *
 * resting: mark all running workouts as rest.
 * light: downgrade quality sessions to easy at 50% km; reduce easy/long at 60% km.
 */
export function applyIllnessMods(workouts: any[], severity: 'light' | 'resting'): void {
  for (const w of workouts) {
    const type = (w.t || '').toLowerCase();
    const name = (w.n || '').toLowerCase();
    const isNonRun = NON_RUN_TYPES.some(t => type.includes(t) || name.includes(t));
    if (isNonRun) continue;

    const origKm = parseKmFromDesc(w.d);

    if (severity === 'resting') {
      w.illnessMod = true;
      w.illnessSeverity = 'resting';
      w.originalDistance = origKm > 0 ? `${origKm}km` : (w.d || w.n);
      w.d = 'Rest — illness';
    } else {
      // light: downgrade quality, reduce all distances
      const isQuality = QUALITY_TYPES.some(t => type.includes(t) || name.includes(t));
      if (origKm > 0) {
        const ratio = isQuality ? 0.5 : 0.6;
        const newKm = Math.max(2, Math.round(origKm * ratio * 2) / 2);
        w.illnessMod = true;
        w.illnessSeverity = 'light';
        w.originalDistance = `${origKm}km`;
        w.d = `${newKm}km easy pace`;
        if (isQuality) {
          w.t = 'easy';
          w.r = 4;
        } else {
          w.r = Math.min(w.r || 5, 4);
        }
      }
    }
  }
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
