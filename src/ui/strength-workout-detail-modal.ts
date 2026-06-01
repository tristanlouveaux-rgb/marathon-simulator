/**
 * Shared strength/gym workout detail modal.
 *
 * Strength sessions used to render their full exercise list inline on the plan
 * card as a run-on paragraph ("3×12 Bodyweight Squat (...) (45s rest) 3×10 each
 * leg Reverse Lunge ..."), which read as gibberish. Instead the card now shows
 * the headline + "N exercises · tap to view"; tapping opens this modal, which
 * lays the session out as clean per-exercise rows.
 *
 * Mode-agnostic: running, triathlon, and (already) HYROX strength sessions all
 * share the same description format, so they share this modal. Rows are parsed
 * by the canonical `parseStrengthSession` (src/guided/strength-model.ts) — no
 * re-parsing here. Start/Done reuse the canonical cross-mode handlers.
 */

import type { Workout } from '@/types';
import { parseStrengthSession, type GuidedSet } from '@/guided/strength-model';

const OVERLAY_ID = 'strength-workout-detail-overlay';

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "45s rest" / "2 min rest". */
function restLabel(sec: number): string {
  if (sec <= 0) return '';
  return sec >= 60 ? `${Math.round(sec / 60)} min rest` : `${sec}s rest`;
}

/** "28m" / "1h 5m". */
function durLabel(min: number | undefined): string | null {
  if (!min) return null;
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`;
}

/** One clean row per exercise (first set carries the prescription). */
function renderRows(sets: GuidedSet[]): string {
  const byExercise = new Map<number, GuidedSet>();
  for (const set of sets) {
    if (!byExercise.has(set.exerciseIndex)) byExercise.set(set.exerciseIndex, set);
  }
  return [...byExercise.values()].map(ex => {
    const prescription = ex.reps
      ? `${ex.setCount} × ${esc(ex.reps)}`
      : `${ex.setCount} set${ex.setCount > 1 ? 's' : ''}`;
    const meta = [ex.cue ? esc(ex.cue) : '', restLabel(ex.restSec)].filter(Boolean).join(' · ');
    return `
      <div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--c-border)">
        <span style="flex-shrink:0;width:3px;border-radius:2px;background:var(--c-border-strong)"></span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">
            <span style="font-size:14px;font-weight:600;color:var(--c-black)">${esc(ex.exerciseName)}</span>
            <span style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums;flex-shrink:0">${prescription}</span>
          </div>
          ${meta ? `<div style="font-size:12px;color:var(--c-muted);line-height:1.45;margin-top:2px">${meta}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

/**
 * Open the strength detail modal for a gym/strength workout.
 * No-op if the workout has no parseable exercises.
 */
export function openStrengthWorkoutDetail(workout: Workout): void {
  document.getElementById(OVERLAY_ID)?.remove();

  const session = parseStrengthSession(workout);
  if (!session) return;

  const rpe = workout.rpe ?? (workout as any).r ?? null;
  const dur = durLabel(workout.estimatedDurationMin);
  const chips: string[] = [];
  if (dur) chips.push(dur);
  if (rpe != null) chips.push(`RPE ${rpe}`);
  chips.push(`${session.exerciseCount} exercise${session.exerciseCount === 1 ? '' : 's'}`);
  const chipsHtml = chips.map((t, i) =>
    `${i > 0 ? '<span style="color:var(--c-faint);margin:0 8px">·</span>' : ''}<span>${esc(t)}</span>`,
  ).join('');

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';

  overlay.innerHTML = `
    <div style="background:var(--c-surface);width:100%;max-width:520px;max-height:90vh;overflow-y:auto;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3);position:relative">
      <div style="padding:20px 22px 14px;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px">
          <div style="font-size:20px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;line-height:1.2">${esc(session.title)}</div>
          <button id="strength-detail-close" style="width:30px;height:30px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted);flex-shrink:0" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums">${chipsHtml}</div>
      </div>

      <div style="padding:4px 22px">
        ${renderRows(session.sets)}
        ${session.stretch ? `<div style="font-size:12px;color:var(--c-muted);line-height:1.45;padding:12px 0">${esc(session.stretch)}</div>` : ''}
      </div>

      <div style="padding:8px 22px 18px;display:flex;flex-direction:column;gap:10px">
        <button id="strength-detail-start" style="width:100%;padding:14px;background:#0F172A;color:#FAF9F6;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--f)">Start session</button>
        <button id="strength-detail-done" style="width:100%;padding:11px;background:transparent;color:var(--c-black);border:1px solid var(--c-border);border-radius:10px;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">Mark as done</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#strength-detail-close')?.addEventListener('click', close);
  overlay.querySelector('#strength-detail-start')?.addEventListener('click', () => {
    close();
    import('@/ui/guided-strength-overlay').then(({ openGuidedStrength }) => openGuidedStrength(workout));
  });
  overlay.querySelector('#strength-detail-done')?.addEventListener('click', () => {
    import('@/guided/strength-complete').then(({ completeStrengthSession }) => {
      const result = completeStrengthSession(workout);
      close();
      import('@/ui/strength-summary-card').then(({ openStrengthSummary }) => openStrengthSummary(workout, result));
    });
  });
}
