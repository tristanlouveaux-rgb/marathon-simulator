/**
 * Per-lift detail drill-down. Opened from a loaded-lift row in the strength
 * workout detail modal. Shows the estimated-1RM trend (reusing the canonical
 * benchmark sparkline), the last working set, and the phase-aware suggestion
 * for next session.
 *
 * Centered overlay per docs/UX_PATTERNS.md → Overlays and Modals. Neutral
 * palette with a single data-hue accent (amber) for the chart, distinct from
 * the tri benchmark hues (FTP red / CSS blue / LT teal / VDOT green / CP violet).
 * No emoji, no accent on navigation.
 */

import type { TrainingPhase } from '@/types/training';
import { getState } from '@/state/store';
import { suggestNextWeight } from '@/calculations/strength-progression';
import { buildBenchmarkTrendChart, animateChartDrawOn } from '@/ui/triathlon/benchmark-charts';

const OVERLAY_ID = 'strength-lift-detail-overlay';
const ACCENT = '#F59E0B';
const FILL = 'rgba(245,158,11,0.10)';

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function trimNum(n: number): string { return (Math.round(n * 100) / 100).toString(); }
function fmtKg(kg: number): string { return `${trimNum(kg)}kg`; }
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Open the per-lift detail for a canonical lift key. */
export function openStrengthLiftDetail(liftKey: string, displayName: string): void {
  document.getElementById(OVERLAY_ID)?.remove();

  const s = getState();
  const entry = s.strengthLog?.lifts?.[liftKey];
  const name = displayName || entry?.displayName || liftKey;

  const wk = s.wks?.[(s.w ?? 1) - 1];
  const phase = (wk?.ph as TrainingPhase) ?? 'base';
  const isDeload = phase === 'taper' || !!(wk as any)?.forceDeload;

  let body: string;
  if (!entry) {
    body = `<div style="padding:24px 22px;font-size:13px;color:var(--c-muted);line-height:1.5">No weight logged yet. Complete this lift in a guided session, or log it with "Mark as done", and the trend builds here.</div>`;
  } else {
    const est = entry.est1rmKg;
    const history = entry.est1rmHistory ?? [];
    const sug = suggestNextWeight({
      lastWeightKg: entry.lastWeightKg,
      lastRir: entry.lastRir,
      phase,
      isDeload,
      injuryKind: 'normal',
    });

    const hasWorkingSet = entry.lastWeightKg != null && entry.lastWeightKg > 0;
    let suggestion: string;
    if (!hasWorkingSet) {
      suggestion = `1RM set manually. Log a working set in a guided session and the per-session weight suggestion builds here.`;
    } else if (sug.changed) {
      suggestion = `Next session: try ${fmtKg(sug.weightKg)}, up from ${fmtKg(entry.lastWeightKg!)}. The last set left reps in reserve.`;
    } else if (phase === 'peak') {
      suggestion = `Hold ${fmtKg(entry.lastWeightKg!)} through peak. Strength maintains while race sharpness builds.`;
    } else if (isDeload) {
      suggestion = `Hold ${fmtKg(entry.lastWeightKg!)} through the taper. No new load before race day.`;
    } else {
      suggestion = `Hold ${fmtKg(entry.lastWeightKg!)}. It rises when a session leaves 2 or more reps in reserve.`;
    }

    const lastLine = hasWorkingSet
      ? `${fmtKg(entry.lastWeightKg!)}${entry.lastReps ? ` × ${esc(entry.lastReps)}` : ''}${entry.lastDate ? ` · ${fmtDate(entry.lastDate)}` : ''}`
      : '';

    body = `
      <div style="padding:6px 22px 4px">
        ${est != null ? `
          <div style="font-size:11px;color:var(--c-faint);margin-bottom:8px">Estimated 1RM</div>
          ${buildBenchmarkTrendChart(history, ACCENT, FILL, 'kg', /*inverted*/ false)}
        ` : ''}
        ${hasWorkingSet ? `
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--c-border)">
          <div style="font-size:11px;color:var(--c-faint);margin-bottom:3px">Last working set</div>
          <div style="font-size:15px;color:var(--c-black);font-variant-numeric:tabular-nums">${lastLine}</div>
        </div>` : ''}
        <div style="margin-top:14px;padding:12px 14px;border:1px solid var(--c-border);border-radius:10px;font-size:13px;color:var(--c-black);line-height:1.5">${suggestion}</div>
      </div>`;
  }

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:220;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);width:100%;max-width:420px;max-height:90vh;overflow-y:auto;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3);position:relative">
      <div style="padding:20px 22px 8px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="font-size:20px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;line-height:1.2">${esc(name)}</div>
        <button id="lift-detail-close" style="width:30px;height:30px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted);flex-shrink:0" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      ${body}
      <div style="padding:16px 22px 18px">
        <button id="lift-detail-done" style="width:100%;padding:12px;background:transparent;color:var(--c-black);border:1px solid var(--c-border);border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;font-family:var(--f)">Close</button>
      </div>
    </div>`;

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#lift-detail-close')?.addEventListener('click', close);
  overlay.querySelector('#lift-detail-done')?.addEventListener('click', close);
  document.body.appendChild(overlay);
  animateChartDrawOn();
}
