/**
 * Post-session summary card for a completed strength / gym session.
 *
 * Shown after the user finishes a guided session or taps "Mark as done". Gives
 * the recap that was missing before: which muscle groups the session worked
 * (body-map silhouette + chips), the duration and RPE, and the heart-rate data
 * if a synced activity matched. When no HR is attached yet, a "Match heart rate"
 * action lets the user pick the synced activity that belongs to this session
 * (the manual fallback to the completion-time auto-match).
 *
 * Modal follows the canonical centered-overlay pattern (UX_PATTERNS → Overlays
 * and Modals). Body-map is the single accent colour (data hue); everything else
 * neutral. No emoji, no accent on the navigation/action links.
 */

import type { Workout } from '@/types';
import type { GarminPendingItem, Week } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { render } from '@/ui/renderer';
import { renderBodyMap } from '@/ui/body-map';
import type { StrengthCompletionResult } from '@/guided/strength-complete';

const OVERLAY_ID = 'strength-summary-overlay';

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "28m" / "1h 5m". */
function durLabel(sec: number): string | null {
  if (!sec || sec <= 0) return null;
  const min = Math.round(sec / 60);
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`;
}

/** "HH:MM" local time from an ISO string. */
function timeLabel(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Friendly label for a pending activity in the HR picker. */
function pendingLabel(p: GarminPendingItem): string {
  const t = (p.activityType || p.appType || 'Activity').replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Open the strength post-session summary. `result` comes from
 * completeStrengthSession. No-op for HYROX (which has its own recap) or when the
 * completion produced no log entry.
 */
export function openStrengthSummary(workout: Workout, result: StrengthCompletionResult): void {
  if (result.isHyrox) return;
  document.getElementById(OVERLAY_ID)?.remove();

  const state = getMutableState();
  const wk = state.wks?.[result.weekIdx];
  if (!wk) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:210;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';

  const closeAndRefresh = () => { overlay.remove(); render(); };

  // ── HR picker sub-view state ──
  let pickingHR = false;

  function currentActual() {
    return wk!.garminActuals?.[result.workoutId] ?? result.actual;
  }

  function hrCandidates(): GarminPendingItem[] {
    return (wk!.garminPending ?? []).filter(p => p.avgHR != null && p.avgHR > 0);
  }

  function attachHR(p: GarminPendingItem): void {
    const a = currentActual();
    if (!a) return;
    a.avgHR = p.avgHR;
    a.maxHR = p.maxHR;
    a.hrZones = p.hrZones ?? a.hrZones ?? null;
    a.iTrimp = p.iTrimp ?? a.iTrimp ?? null;
    a.garminId = p.garminId;          // adopt the synced identity (no longer a guided- stub)
    a.startTime = p.startTime;
    a.activityType = p.activityType || a.activityType;
    if (!wk!.garminMatched) wk!.garminMatched = {};
    wk!.garminMatched[p.garminId] = result.workoutId;
    wk!.garminPending = (wk!.garminPending ?? []).filter(x => x.garminId !== p.garminId);
    saveState();
    pickingHR = false;
    build();
  }

  function muscleChips(): string {
    if (!result.muscleGroups.length) return '';
    const pills = result.muscleGroups.map(g =>
      `<span style="display:inline-block;padding:5px 11px;border-radius:14px;border:1px solid var(--c-border);font-size:12px;color:var(--c-black);background:transparent">${esc(g.label)}</span>`,
    ).join('');
    return `
      <div style="margin-top:14px">
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:8px">Worked</div>
        <div style="display:flex;flex-wrap:wrap;gap:7px">${pills}</div>
      </div>`;
  }

  function hrSection(): string {
    const a = currentActual();
    if (a?.avgHR != null && a.avgHR > 0) {
      const max = a.maxHR != null && a.maxHR > 0 ? `<span style="color:var(--c-faint);margin:0 8px">·</span>Max ${Math.round(a.maxHR)}` : '';
      const note = result.hrAutoMatched ? 'Matched from a synced activity.' : '';
      return `
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--c-border)">
          <div style="font-size:14px;color:var(--c-black);font-variant-numeric:tabular-nums">Avg HR ${Math.round(a.avgHR)} bpm${max}</div>
          ${note ? `<div style="font-size:12px;color:var(--c-faint);margin-top:3px">${note}</div>` : ''}
        </div>`;
    }
    const candidates = hrCandidates();
    const caption = candidates.length
      ? 'Attach the watch or Strava recording from this session.'
      : 'No synced activity with heart rate yet. A later sync attaches automatically.';
    return `
      <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--c-border)">
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:${candidates.length ? '10px' : '0'}">${caption}</div>
        ${candidates.length ? `<button id="ss-match-hr" style="padding:9px 14px;background:transparent;color:var(--c-black);border:1px solid var(--c-border);border-radius:18px;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">Match heart rate</button>` : ''}
      </div>`;
  }

  function pickerView(): string {
    const rows = hrCandidates().map(p => `
      <button class="ss-pick" data-id="${esc(p.garminId)}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;padding:13px 14px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:12px;cursor:pointer;font-family:var(--f)">
        <span style="min-width:0">
          <span style="display:block;font-size:14px;font-weight:600;color:var(--c-black)">${esc(pendingLabel(p))}</span>
          <span style="display:block;font-size:12px;color:var(--c-muted)">${esc(timeLabel(p.startTime))}${durLabel(p.durationSec) ? ` · ${durLabel(p.durationSec)}` : ''}</span>
        </span>
        <span style="flex-shrink:0;font-size:13px;color:var(--c-muted);font-variant-numeric:tabular-nums">${Math.round(p.avgHR!)} bpm</span>
      </button>`).join('');
    return `
      <div style="padding:18px 22px 8px">
        <div style="font-size:16px;font-weight:700;color:var(--c-black);margin-bottom:4px">Match heart rate</div>
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:14px">Pick the recording from this session.</div>
        <div style="display:flex;flex-direction:column;gap:8px">${rows}</div>
      </div>
      <div style="padding:8px 22px 18px">
        <button id="ss-pick-cancel" style="width:100%;padding:11px;background:transparent;color:var(--c-muted);border:none;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">Cancel</button>
      </div>`;
  }

  function summaryView(): string {
    const chips: string[] = [];
    const dl = durLabel(result.durationSec);
    if (dl) chips.push(dl);
    chips.push(`RPE ${result.rpe}`);
    const chipsHtml = chips.map((t, i) =>
      `${i > 0 ? '<span style="color:var(--c-faint);margin:0 8px">·</span>' : ''}<span>${esc(t)}</span>`,
    ).join('');

    return `
      <div style="padding:20px 22px 6px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div>
            <div style="font-size:12px;color:var(--c-faint);margin-bottom:3px">Session complete</div>
            <div style="font-size:20px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;line-height:1.2">${esc(workout.n)}</div>
          </div>
          <button id="ss-close" style="width:30px;height:30px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted);flex-shrink:0" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums;margin-top:6px">${chipsHtml}</div>
      </div>

      <div style="padding:6px 22px 0">
        ${result.muscleGroups.length ? renderBodyMap(result.muscleGroups) : ''}
        ${muscleChips()}
        ${hrSection()}
      </div>

      <div style="padding:18px 22px">
        <button id="ss-done" style="width:100%;padding:14px;background:#0F172A;color:#FAF9F6;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--f)">Done</button>
      </div>`;
  }

  function build(): void {
    overlay.innerHTML = `
      <div style="background:var(--c-surface);width:100%;max-width:420px;max-height:92vh;overflow-y:auto;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3);position:relative">
        ${pickingHR ? pickerView() : summaryView()}
      </div>`;

    if (pickingHR) {
      overlay.querySelector('#ss-pick-cancel')?.addEventListener('click', () => { pickingHR = false; build(); });
      overlay.querySelectorAll<HTMLButtonElement>('.ss-pick').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          const p = hrCandidates().find(c => c.garminId === id);
          if (p) attachHR(p);
        });
      });
      return;
    }

    overlay.querySelector('#ss-close')?.addEventListener('click', closeAndRefresh);
    overlay.querySelector('#ss-done')?.addEventListener('click', closeAndRefresh);
    overlay.querySelector('#ss-match-hr')?.addEventListener('click', () => { pickingHR = true; build(); });
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAndRefresh(); });
  build();
  document.body.appendChild(overlay);
}
