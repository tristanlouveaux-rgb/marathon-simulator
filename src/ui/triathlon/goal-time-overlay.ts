/**
 * Triathlon goal-time overlay. Sets triConfig.targetFinishTimeSec.
 *
 * Triggered from the cone card on the Forecast tab (the "Edit goal time"
 * link, the "Set a goal time" CTA, or by tapping one of the Optimistic /
 * Median / Conservative outcome tiles). Mirrors the structure of the
 * HYROX goal modal (`hyrox/goal-modal.ts`).
 *
 * Per CLAUDE.md UI rules:
 *   - Vertically centered overlay
 *   - No emoji, no em-dashes
 *   - Bordered pill CTAs, no var(--c-accent)
 *   - Closes back to the forecast view (not Home)
 */

import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';

function fmtHhMmSs(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function parseHhMmSs(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':').map(p => p.trim());
  if (parts.some(p => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  let total = 0;
  if (nums.length === 3) {
    const [h, m, s] = nums;
    if (m >= 60 || s >= 60) return null;
    total = h * 3600 + m * 60 + s;
  } else if (nums.length === 2) {
    const [m, s] = nums;
    if (s >= 60) return null;
    total = m * 60 + s;
  } else {
    return null;
  }
  if (total <= 0 || total > 24 * 3600) return null;
  return total;
}

export function openTriGoalOverlay(preSec?: number): void {
  const existing = document.getElementById('tri-goal-overlay');
  if (existing) existing.remove();

  const ms = getMutableState();
  const tri = ms.triConfig;
  if (!tri) return;

  // Initial value priority: explicit preSec (from outcome-tile tap) >
  // existing targetFinishTimeSec > current prediction's totalSec.
  const initialTarget = preSec && preSec > 0
    ? preSec
    : (tri.targetFinishTimeSec && tri.targetFinishTimeSec > 0
        ? tri.targetFinishTimeSec
        : (tri.prediction?.totalSec ?? 0));

  const overlay = document.createElement('div');
  overlay.id = 'tri-goal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:24px;max-width:420px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,0.18)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div style="font-size:17px;font-weight:700;color:#0F172A">Set a goal time</div>
        <button id="tri-goal-close" style="background:none;border:none;cursor:pointer;color:var(--c-faint);font-size:20px;line-height:1;padding:0">×</button>
      </div>
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">Saved goals appear on the cone as a line and drive the chance-of-beating callout. Clear it any time to remove the goal line.</div>
      <label style="display:block;font-size:12px;font-weight:600;color:#0F172A;margin-bottom:6px">Target time (h:mm:ss)</label>
      <input
        id="tri-goal-input"
        type="text"
        value="${fmtHhMmSs(initialTarget)}"
        style="width:100%;box-sizing:border-box;border:1.5px solid rgba(0,0,0,0.15);border-radius:10px;padding:10px 12px;font-size:16px;font-family:var(--f);color:#0F172A;outline:none;margin-bottom:8px"
      />
      <div id="tri-goal-validation" style="font-size:12px;color:#ef4444;min-height:18px;margin-bottom:8px"></div>
      <div style="display:flex;gap:10px;margin-top:6px">
        <button id="tri-goal-clear" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer">Clear goal</button>
        <button id="tri-goal-save" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:13px;font-weight:600;color:var(--c-black);cursor:pointer">Save goal</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const validate = () => {
    const inputEl = document.getElementById('tri-goal-input') as HTMLInputElement | null;
    const noteEl = document.getElementById('tri-goal-validation');
    if (!inputEl || !noteEl) return null;
    const sec = parseHhMmSs(inputEl.value);
    if (sec == null) {
      noteEl.textContent = 'Enter as h:mm:ss (e.g. 4:47:36) or mm:ss for short events.';
      return null;
    }
    noteEl.textContent = '';
    return sec;
  };
  validate();
  document.getElementById('tri-goal-input')?.addEventListener('input', validate);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('tri-goal-close')?.addEventListener('click', close);

  const refreshForecast = () => {
    void import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  };

  document.getElementById('tri-goal-save')?.addEventListener('click', () => {
    const sec = validate();
    if (sec == null) return;
    const ms2 = getMutableState();
    if (!ms2.triConfig) return;
    ms2.triConfig.targetFinishTimeSec = sec;
    saveState();
    close();
    refreshForecast();
  });

  document.getElementById('tri-goal-clear')?.addEventListener('click', () => {
    const ms2 = getMutableState();
    if (!ms2.triConfig) return;
    ms2.triConfig.targetFinishTimeSec = undefined;
    saveState();
    close();
    refreshForecast();
  });
}
