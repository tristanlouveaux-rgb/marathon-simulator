/**
 * Transitions override overlay — opened from the race-forecast card's
 * transitions row. Shows the empirical default for the user's race × level
 * bin (the same number the predictor uses), with an inline override.
 *
 * Override priority chain at runtime:
 *   1. user override (triConfig.transitionOverride) — what this overlay sets
 *   2. race-specific empirical bin
 *   3. global level-bin fallback
 *   4. skill-slider default
 * See `src/calculations/empirical-transitions.ts` and
 * `src/calculations/race-prediction.triathlon.ts` for the runtime resolution.
 *
 * Modal pattern follows `docs/UX_PATTERNS.md → Overlays and Modals`:
 * vertically centered, max-width card, dismiss-on-backdrop, never bottom
 * sheet.
 */

import { getMutableState, getState, saveState } from '@/state';
import type { SimulatorState } from '@/types/state';
import type { TriRacePrediction, TriSkillSlider } from '@/types/triathlon';
import {
  T1_SEC_BY_SLIDER,
  T2_SEC_BY_SLIDER,
  SOCK_ON_COST_SEC,
} from '@/constants/triathlon-constants';
import {
  lookupEmpiricalTransitions,
  splitCombinedTransition,
  applySockSavings,
  type TransitionSocks,
} from '@/calculations/empirical-transitions';
import { getTriathlonById } from '@/data/triathlons';

const OVERLAY_ID = 'tri-transitions-overlay';

function fmtMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseMmSs(text: string): number | null {
  const m = text.trim().match(/^(\d+):(\d{1,2})$/);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const sec = parseInt(m[2], 10);
  if (sec >= 60) return null;
  const total = min * 60 + sec;
  if (total < 0 || total > 30 * 60) return null;
  return total;
}

interface ResolvedTransitions {
  t1: number;
  t2: number;
  source: 'override' | 'race-empirical' | 'global-empirical' | 'slider';
  raceName?: string;
  binCenterSec?: number;
  n?: number;
  /** True when both T1 and T2 are hardcoded — sockless modifier is suppressed
   *  in this case because the user's number already reflects their sock
   *  decision (matches predictor behaviour in race-prediction.triathlon.ts). */
  fullyOverridden: boolean;
}

function resolve(state: SimulatorState, p: TriRacePrediction | null): ResolvedTransitions {
  const tri = state.triConfig!;
  const distance = tri.distance ?? '70.3';
  const override = tri.transitionOverride;
  const sliderKey = (tri.skillRating?.bike ?? 3) as TriSkillSlider;
  const sliderT1 = T1_SEC_BY_SLIDER[sliderKey];
  const sliderT2 = T2_SEC_BY_SLIDER[sliderKey];

  if (override?.t1Sec != null && override?.t2Sec != null) {
    return { t1: override.t1Sec, t2: override.t2Sec, source: 'override', fullyOverridden: true };
  }

  const raceId = state.onboarding?.selectedTriathlonId;
  const race = raceId ? getTriathlonById(raceId) : null;
  const raceName = race?.name;
  const movingSec = p ? p.swimSec + p.bikeSec + p.runSec : null;

  const empirical = raceName && movingSec != null
    ? lookupEmpiricalTransitions(raceName, distance, movingSec)
    : null;

  if (empirical && empirical.source !== 'none') {
    let t1: number;
    let t2: number;
    if (empirical.t1Sec != null && empirical.t2Sec != null) {
      t1 = override?.t1Sec ?? Math.round(empirical.t1Sec);
      t2 = override?.t2Sec ?? Math.round(empirical.t2Sec);
    } else {
      const split = splitCombinedTransition(empirical.transitionSec ?? sliderT1 + sliderT2);
      t1 = override?.t1Sec ?? split.t1;
      t2 = override?.t2Sec ?? split.t2;
    }
    return {
      t1, t2,
      source: empirical.source,
      raceName,
      binCenterSec: empirical.binCenterSec,
      n: empirical.n,
      fullyOverridden: false,
    };
  }

  return {
    t1: override?.t1Sec ?? sliderT1,
    t2: override?.t2Sec ?? sliderT2,
    source: 'slider',
    fullyOverridden: false,
  };
}

/** Apply the sockless modifier to a resolved pair. Mirrors the predictor's
 *  logic: 20s saved per skipped leg, floored at 60s per side. Applied even
 *  when both legs are hardcoded — the override is treated as the raw time
 *  with full socks, and the selector adjusts from there. */
function applySockless(r: ResolvedTransitions, choice: TransitionSocks): { t1: number; t2: number } {
  if (choice === 't1') return { t1: r.t1, t2: r.t2 };
  return applySockSavings(r.t1, r.t2, choice);
}

function provenanceCopy(r: ResolvedTransitions): string {
  switch (r.source) {
    case 'override':
      return 'Manually set by you.';
    case 'race-empirical': {
      const binMin = r.binCenterSec != null ? Math.round(r.binCenterSec / 60) : null;
      const tier = binMin != null
        ? ` for finishers around ${Math.floor(binMin / 60)}h${(binMin % 60).toString().padStart(2, '0')} swim+bike+run`
        : '';
      return `Average at ${r.raceName}${tier}. ${r.n?.toLocaleString() ?? ''} finishers.`;
    }
    case 'global-empirical':
      return `Average at your level across all races. ${r.n?.toLocaleString() ?? ''} finishers. Race-specific average not yet available.`;
    case 'slider':
      return 'Default for your skill rating. No race selected, or empirical data unavailable for this race.';
  }
}

const SOCK_OPTIONS: { value: TransitionSocks; label: string; sublabel: string }[] = [
  { value: 't1',   label: 'At T1',   sublabel: 'Typical' },
  { value: 't2',   label: 'At T2',   sublabel: `−${SOCK_ON_COST_SEC}s T1, +${SOCK_ON_COST_SEC}s T2` },
  { value: 'none', label: 'Sockless', sublabel: `−${SOCK_ON_COST_SEC}s overall` },
];

function renderShell(resolved: ResolvedTransitions, choice: TransitionSocks): string {
  const isOverride = resolved.source === 'override';
  const adjusted = applySockless(resolved, choice);
  const total = adjusted.t1 + adjusted.t2;

  return `
    <div class="w-full rounded-2xl" style="background:var(--c-surface);overflow:hidden;max-width:420px">

      <!-- Header -->
      <div style="padding:22px 20px 14px;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="font-size:11px;color:var(--c-faint)">Race forecast</div>
          <button id="tr-ovl-close" style="background:transparent;border:none;font-size:18px;color:var(--c-muted);cursor:pointer;padding:0 4px">×</button>
        </div>
        <div style="font-size:18px;font-weight:600;color:var(--c-black);line-height:1.3;margin-bottom:4px">Transitions</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5">${provenanceCopy(resolved)}</div>
      </div>

      <!-- Live readout strip -->
      <div style="padding:14px 20px;border-bottom:1px solid var(--c-border);display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div>
          <div style="font-size:11px;color:var(--c-faint);margin-bottom:2px">T1</div>
          <div style="font-size:20px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtMmSs(adjusted.t1)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--c-faint);margin-bottom:2px">T2</div>
          <div style="font-size:20px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtMmSs(adjusted.t2)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--c-faint);margin-bottom:2px">Total</div>
          <div style="font-size:20px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtMmSs(total)}</div>
        </div>
      </div>

      <!-- Sock-on event: socks go on once. Choose where (or skip). Applied
           on top of whichever T1/T2 value resolved (empirical, slider, or
           hardcoded override). -->
      <div style="padding:14px 20px;border-bottom:1px solid var(--c-border)">
        <div style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:2px">Putting socks on at</div>
        <div style="font-size:11px;color:var(--c-muted);line-height:1.4;margin-bottom:10px">Socks go on once. ~${SOCK_ON_COST_SEC}s per sock-on event.</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
          ${SOCK_OPTIONS.map(o => `
            <button id="tr-ovl-socks-${o.value}" type="button" style="padding:10px 12px;font-size:13px;font-weight:500;border:1px solid ${choice === o.value ? 'var(--c-black)' : 'var(--c-border)'};cursor:pointer;border-radius:10px;font-family:var(--f);background:${choice === o.value ? 'var(--c-black)' : 'transparent'};color:${choice === o.value ? '#fff' : 'var(--c-black)'};text-align:left;line-height:1.3">
              <div>${o.label}</div>
              <div style="font-size:10px;font-weight:400;color:${choice === o.value ? 'rgba(255,255,255,0.7)' : 'var(--c-muted)'};margin-top:2px">${o.sublabel}</div>
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Inputs -->
      <div style="padding:18px 20px 6px">
        <div style="font-size:11px;color:var(--c-muted);line-height:1.5;margin-bottom:14px">Override the predicted transition time if you have a tested number you trust more. Format: <span style="font-variant-numeric:tabular-nums">m:ss</span>.</div>
        <div style="display:flex;gap:12px;margin-bottom:6px">
          <div style="flex:1">
            <div style="font-size:11px;color:var(--c-muted);margin-bottom:6px">T1 (swim → bike)</div>
            <input type="text" id="tr-ovl-t1" value="${fmtMmSs(resolved.t1)}" inputmode="numeric" autocomplete="off" style="width:100%;height:44px;padding:0 12px;border:1px solid var(--c-border);border-radius:10px;background:transparent;font-family:var(--f);font-size:15px;color:var(--c-black);font-variant-numeric:tabular-nums">
          </div>
          <div style="flex:1">
            <div style="font-size:11px;color:var(--c-muted);margin-bottom:6px">T2 (bike → run)</div>
            <input type="text" id="tr-ovl-t2" value="${fmtMmSs(resolved.t2)}" inputmode="numeric" autocomplete="off" style="width:100%;height:44px;padding:0 12px;border:1px solid var(--c-border);border-radius:10px;background:transparent;font-family:var(--f);font-size:15px;color:var(--c-black);font-variant-numeric:tabular-nums">
          </div>
        </div>
        <div id="tr-ovl-error" style="display:none;font-size:11px;color:#B91C1C;margin-top:6px">Use m:ss format (e.g. 4:30). Each side must be under 30 minutes.</div>
      </div>

      <!-- Footer -->
      <div style="padding:14px 20px 20px;border-top:1px solid var(--c-border);display:flex;gap:10px;margin-top:12px">
        ${isOverride
          ? `<button id="tr-ovl-reset" style="flex:1;height:44px;border-radius:12px;border:1px solid var(--c-border);background:transparent;font-size:14px;font-weight:500;color:var(--c-muted);cursor:pointer">Reset to default</button>`
          : `<button id="tr-ovl-cancel" style="flex:1;height:44px;border-radius:12px;border:1px solid var(--c-border);background:transparent;font-size:14px;font-weight:500;color:var(--c-muted);cursor:pointer">Cancel</button>`}
        <button id="tr-ovl-save" style="flex:1;height:44px;border-radius:12px;border:none;background:#0F172A;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Save</button>
      </div>
    </div>`;
}

export function openTransitionsOverlay(prediction: TriRacePrediction | null, onSaved: () => void): void {
  document.getElementById(OVERLAY_ID)?.remove();
  const state = getState();
  if (!state.triConfig) return;
  const resolved = resolve(state, prediction);

  // Local sock-leg state: seeded from saved value, mutated optimistically
  // when the user toggles, persisted on Save (alongside any T1/T2 override).
  let sockChoice: TransitionSocks = state.triConfig.transitionSocks ?? 't1';

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  const rerender = () => {
    overlay.innerHTML = renderShell(resolved, sockChoice);
    wire();
  };

  const close = () => overlay.remove();

  function wire(): void {
    document.getElementById('tr-ovl-close')?.addEventListener('click', close);
    document.getElementById('tr-ovl-cancel')?.addEventListener('click', close);

    for (const opt of SOCK_OPTIONS) {
      document.getElementById(`tr-ovl-socks-${opt.value}`)?.addEventListener('click', () => {
        if (sockChoice === opt.value) return;
        sockChoice = opt.value;
        rerender();
      });
    }

    document.getElementById('tr-ovl-save')?.addEventListener('click', () => {
      const t1Input = document.getElementById('tr-ovl-t1') as HTMLInputElement | null;
      const t2Input = document.getElementById('tr-ovl-t2') as HTMLInputElement | null;
      const err = document.getElementById('tr-ovl-error');
      if (!t1Input || !t2Input) return;
      const t1 = parseMmSs(t1Input.value);
      const t2 = parseMmSs(t2Input.value);
      if (t1 == null || t2 == null) {
        if (err) err.style.display = 'block';
        return;
      }
      const m = getMutableState();
      if (!m.triConfig) return;
      // Only write a hardcoded override when the inputs actually differ from
      // the resolved seed. If the user only toggled sockless and didn't edit
      // T1 / T2, we leave any existing override alone — otherwise toggling
      // sockless would silently freeze whatever empirical value happened to
      // be displayed at open time.
      if (t1 !== resolved.t1 || t2 !== resolved.t2) {
        m.triConfig.transitionOverride = { t1Sec: t1, t2Sec: t2 };
      }
      m.triConfig.transitionSocks = sockChoice === 't1' ? undefined : sockChoice;
      if (m.triConfig.prediction) m.triConfig.prediction = undefined;
      saveState();
      overlay.remove();
      onSaved();
    });

    document.getElementById('tr-ovl-reset')?.addEventListener('click', () => {
      const m = getMutableState();
      if (!m.triConfig) return;
      m.triConfig.transitionOverride = undefined;
      m.triConfig.transitionSocks = undefined;
      if (m.triConfig.prediction) m.triConfig.prediction = undefined;
      saveState();
      overlay.remove();
      onSaved();
    });
  }

  rerender();
}
