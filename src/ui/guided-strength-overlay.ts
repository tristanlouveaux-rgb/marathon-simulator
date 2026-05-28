/**
 * Guided strength-session overlay. Full-screen modal driven by
 * `StrengthGuideController`: shows the current exercise, an auto rest
 * countdown between sets, the elapsed clock, voice + haptic cues, and a
 * 1-tap RPE on finish. Mode-agnostic — any strength card (running / tri /
 * HYROX) can launch it.
 *
 * Reuses the existing guided primitives: `VoiceCoach` (voice cues),
 * `enableScreenAwake` / `disableScreenAwake`, and `completeStrengthSession`
 * for the completion write. Haptics use `navigator.vibrate` with a try/catch
 * (web; native iOS no-ops gracefully — voice covers it).
 *
 * UX: vertically centered per `docs/UX_PATTERNS.md → Overlays and Modals`.
 */

import type { Workout } from '@/types';
import { parseGuidedSession, type GuidedSet, type StrengthSession } from '@/guided/strength-model';
import { StrengthGuideController, type StrengthCueEvent } from '@/guided/strength-controller';
import { VoiceCoach } from '@/guided/voice';
import { enableScreenAwake, disableScreenAwake } from '@/guided/keep-awake';
import { completeStrengthSession } from '@/guided/strength-complete';

const OVERLAY_ID = 'guided-strength-overlay';

interface OverlayState {
  workout: Workout;
  session: StrengthSession;
  controller: StrengthGuideController;
  voice: VoiceCoach;
  cuesOn: boolean;
  finished: boolean;
  finishRpe: number | null;
  onClose?: () => void;
}

let active: OverlayState | null = null;

/** Open the guided strength overlay for a workout. */
export function openGuidedStrength(workout: Workout, opts: { onClose?: () => void } = {}): void {
  // Single active overlay at a time.
  if (active) closeOverlay();

  const session = parseGuidedSession(workout);
  if (!session || session.sets.length === 0) {
    // Nothing to guide; just no-op (caller can fall back to mark-done).
    return;
  }

  const voice = new VoiceCoach();
  const controller = new StrengthGuideController(session, {
    onCue: (e) => handleCue(e),
    manualAdvance: session.manualAdvance === true,
  });

  active = {
    workout,
    session,
    controller,
    voice,
    cuesOn: true,
    finished: false,
    finishRpe: null,
    onClose: opts.onClose,
  };

  mount();
  void enableScreenAwake().catch(() => {});
  controller.start();
}

// ─── Cue handler (DOM updates + voice + haptics) ─────────────────────────────

function handleCue(e: StrengthCueEvent): void {
  if (!active) return;

  if (e.type === 'setStart' && e.set) {
    speak(`Next: ${e.set.exerciseName}`);
    renderActive();
    return;
  }
  if (e.type === 'restStart' && e.set) {
    speak(`Rest ${e.restRemainingSec ?? 0} seconds`);
    renderResting();
    return;
  }
  if (e.type === 'pauseStart') {
    pulse([80, 60, 80]);
    speak(`Station logged. Start when you're ready.`);
    renderPaused();
    return;
  }
  if (e.type === 'countdownStart') {
    speak('Get ready');
    renderCountdown();
    return;
  }
  if (e.type === 'restEnd') {
    pulse([80, 60, 80]);
    return;
  }
  if (e.type === 'tick') {
    patchClocks();
    return;
  }
  if (e.type === 'complete') {
    speak('Session complete');
    pulse([120, 60, 120]);
    active.finished = true;
    renderFinish();
    return;
  }
}

// ─── Mount / unmount ─────────────────────────────────────────────────────────

function mount(): void {
  removeNode();
  const node = document.createElement('div');
  node.id = OVERLAY_ID;
  node.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  node.style.background = 'rgba(0,0,0,0.55)';
  document.body.appendChild(node);
  renderActive();
}

function removeNode(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

export function closeOverlay(): void {
  if (!active) { removeNode(); return; }
  active.controller.destroy();
  active.voice.cancel();
  void disableScreenAwake().catch(() => {});
  const onClose = active.onClose;
  active = null;
  removeNode();
  onClose?.();
}

// ─── Renders ────────────────────────────────────────────────────────────────

function shellOpen(headerRight: string): string {
  return `
    <div style="
      background:#FAF9F6;
      width:100%;max-width:520px;
      max-height:92vh;overflow-y:auto;
      border-radius:20px;
      box-shadow:0 10px 40px rgba(0,0,0,0.3);
      position:relative;
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 6px">
        ${headerRight}
        <button id="gs-close" style="width:32px;height:32px;background:transparent;border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted)" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
}

function shellClose(): string { return `</div>`; }

function muteButton(cuesOn: boolean): string {
  const label = cuesOn ? 'Mute' : 'Unmute';
  const icon = cuesOn
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19 12a4 4 0 0 0-2.2-3.6"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
  return `
    <button id="gs-mute" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:6px 4px">
      ${icon}<span>${label}</span>
    </button>`;
}

function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Row of per-exercise progress rings. Fill = sets done / sets in that exercise;
 * the exercise currently active (or just rested from) carries a small indicator
 * dot. Visual-only: the fill is the indicator, no in-ring text. Re-renders on
 * setStart and restEnd via the existing render paths; mid-tick state never
 * changes which set is done, so no per-tick patching is needed.
 */
function renderProgressRings(): string {
  if (!active) return '';
  const totalDone = active.controller.completedSets;
  const curEx = active.controller.currentSet()?.exerciseIndex;

  // Group sets by exercise, in order.
  const counts: number[] = [];
  for (const s of active.session.sets) {
    counts[s.exerciseIndex] = (counts[s.exerciseIndex] ?? 0) + 1;
  }

  let consumed = 0;
  const rings: string[] = [];
  for (let i = 0; i < counts.length; i++) {
    const setCount = counts[i] ?? 0;
    const done = Math.max(0, Math.min(setCount, totalDone - consumed));
    consumed += setCount;
    rings.push(buildProgressRing(done, setCount, i === curEx, i + 1));
  }
  if (!rings.length) return '';
  return `<div role="list" aria-label="Exercise progress" style="display:flex;gap:10px;justify-content:center;align-items:flex-start;margin:4px 0 18px;flex-wrap:wrap">${rings.join('')}</div>`;
}

function buildProgressRing(done: number, total: number, isCurrent: boolean, label: number): string {
  const r = 13;
  const circumference = 2 * Math.PI * r;
  const fraction = total > 0 ? done / total : 0;
  const offset = circumference * (1 - fraction);
  const accent = '#0F172A';
  const aria = `Exercise ${label}: ${done} of ${total} sets done${isCurrent ? ', current' : ''}`;
  const indicatorDot = isCurrent
    ? `<circle cx="16" cy="34" r="2" fill="${accent}"/>`
    : '';
  return `
    <div role="listitem" aria-label="${aria}" style="display:flex;flex-direction:column;align-items:center;width:32px">
      <svg width="32" height="38" viewBox="0 0 32 38" aria-hidden="true">
        <circle cx="16" cy="16" r="${r}" stroke="rgba(0,0,0,0.12)" stroke-width="2.5" fill="none"/>
        <circle cx="16" cy="16" r="${r}" stroke="${accent}" stroke-width="2.5" fill="none"
          stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
          transform="rotate(-90 16 16)" stroke-linecap="round"/>
        ${indicatorDot}
      </svg>
    </div>`;
}

function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  if (s >= 60) {
    const m = Math.floor(s / 60); const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }
  return `${s}s`;
}

function renderActive(): void {
  if (!active) return;
  const cur = active.controller.currentSet();
  if (!cur) return;
  const idx = active.session.sets.indexOf(cur);
  const total = active.session.sets.length;
  const upcoming = active.session.sets
    .slice(idx + 1, Math.min(idx + 4, total))
    .filter((s, i, arr) => i === 0 || arr[i - 1].exerciseIndex !== s.exerciseIndex)
    .slice(0, 3);
  // When every step is a one-shot (HYROX), suppress the redundant "Set 1 of 1"
  // and use "Station" terminology for the overall position counter.
  const oneShot = active.session.sets.every(s => s.setCount === 1);
  const positionLabel = oneShot ? `Station ${idx + 1} of ${total}` : `Set ${idx + 1} of ${total}`;

  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  node.innerHTML = `
    ${shellOpen(muteButton(active.cuesOn))}
      <div style="padding:6px 22px 22px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px">
          <div>
            <div id="gs-elapsed" style="font-size:34px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${fmtElapsed(active.controller.elapsedSec)}</div>
            <div style="font-size:11px;color:var(--c-muted);margin-top:4px">${positionLabel}</div>
          </div>
          ${cur.setCount > 1 ? `<div style="font-size:11px;color:var(--c-muted);text-align:right">Set ${cur.setIndex + 1} of ${cur.setCount}</div>` : ''}
        </div>

        ${renderProgressRings()}

        <div style="font-size:24px;font-weight:700;color:#0F172A;line-height:1.2;letter-spacing:-0.01em;margin-bottom:6px">${escapeHtml(cur.exerciseName)}</div>
        ${cur.reps ? `<div style="font-size:14px;color:#0F172A;margin-bottom:8px">${escapeHtml(cur.reps)}</div>` : ''}
        ${cur.cue ? `<div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:18px">${escapeHtml(cur.cue)}</div>` : ''}

        ${upcoming.length ? `
          <div style="font-size:11px;color:var(--c-faint);margin-bottom:6px">Up next</div>
          <ul style="margin:0 0 22px;padding-left:18px;font-size:12px;color:var(--c-muted);line-height:1.6">
            ${upcoming.map(u => `<li>${escapeHtml(u.exerciseName)}</li>`).join('')}
          </ul>` : ''}

        <button id="gs-complete" style="width:100%;padding:14px;background:#0F172A;color:#FAF9F6;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--f);margin-bottom:8px">
          Complete set
        </button>
        <button id="gs-finish" style="width:100%;padding:11px;background:transparent;color:var(--c-muted);border:1px solid var(--c-border);border-radius:10px;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">
          Finish session
        </button>
      </div>
    ${shellClose()}
  `;
  wireCommonControls();
  document.getElementById('gs-complete')?.addEventListener('click', () => active?.controller.completeSet());
  document.getElementById('gs-finish')?.addEventListener('click', () => active?.controller.finish());
}

function renderResting(): void {
  if (!active) return;
  const next = active.controller.nextSet();
  const last = active.controller.lastRecord();
  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  node.innerHTML = `
    ${shellOpen(muteButton(active.cuesOn))}
      <div style="padding:6px 22px 22px;text-align:center">
        <div style="font-size:12px;letter-spacing:0.04em;color:var(--c-muted);margin-bottom:6px">Rest</div>
        <div id="gs-rest" style="font-size:72px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1;margin-bottom:10px">${fmtCountdown(active.controller.restRemainingSec)}</div>

        ${last ? `<div style="font-size:12px;color:var(--c-muted);margin-bottom:14px">Logged: ${escapeHtml(last.exerciseName)}${last.setCount > 1 ? ` set ${last.setIndex + 1}` : ''} <span style="color:#0F172A;font-weight:600;font-variant-numeric:tabular-nums">${fmtElapsed(last.durationSec)}</span></div>` : ''}

        ${renderProgressRings()}

        ${next ? `
          <div style="font-size:12px;color:var(--c-muted);margin-bottom:4px">Next</div>
          <div style="font-size:17px;font-weight:600;color:#0F172A;margin-bottom:4px">${escapeHtml(next.exerciseName)}</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:22px">${next.setCount > 1 ? `Set ${next.setIndex + 1} of ${next.setCount}` : ''}${next.setCount > 1 && next.reps ? ' · ' : ''}${escapeHtml(next.reps)}</div>
        ` : ''}

        <div style="display:flex;gap:10px">
          <button id="gs-extend" style="flex:1;padding:12px;background:transparent;color:#0F172A;border:1px solid var(--c-border);border-radius:10px;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">+30s</button>
          <button id="gs-skip" style="flex:1;padding:12px;background:#0F172A;color:#FAF9F6;border:none;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f)">Skip rest</button>
        </div>

        <div id="gs-elapsed-small" style="margin-top:14px;font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">Elapsed ${fmtElapsed(active.controller.elapsedSec)}</div>
      </div>
    ${shellClose()}
  `;
  wireCommonControls();
  document.getElementById('gs-extend')?.addEventListener('click', () => active?.controller.extendRest(30));
  document.getElementById('gs-skip')?.addEventListener('click', () => active?.controller.skipRest());
}

/** Pre-station countdown — visible 5..1 number after the user taps Start. */
const COUNTDOWN_SECONDS = 5;

/**
 * Unbounded-rest screen for manual-advance sessions (HYROX). The rest-elapsed
 * timer ticks up so you can see how long you've been recovering; the recent-
 * station log shows the times just captured; tapping "Start next station"
 * triggers the 5-second pre-station countdown.
 */
function renderPaused(): void {
  if (!active) return;
  const next = active.controller.nextSet();
  const last = active.controller.lastRecord();
  const recent = active.controller.setRecords.slice(-3).reverse(); // most-recent first
  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  node.innerHTML = `
    ${shellOpen(muteButton(active.cuesOn))}
      <div style="padding:6px 22px 22px">
        <div style="font-size:11px;letter-spacing:0.04em;color:var(--c-muted);text-align:center;margin-bottom:4px">Rest</div>
        <div id="gs-pause-elapsed" style="font-size:64px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1;text-align:center;margin-bottom:14px">${fmtElapsed(active.controller.pauseElapsedSec)}</div>

        ${last ? `<div style="text-align:center;font-size:12px;color:var(--c-muted);margin-bottom:18px">${escapeHtml(last.exerciseName)}${last.setCount > 1 ? ` set ${last.setIndex + 1}` : ''} logged <span style="color:#0F172A;font-weight:600;font-variant-numeric:tabular-nums">${fmtElapsed(last.durationSec)}</span></div>` : ''}

        ${renderProgressRings()}

        ${recent.length > 1 ? `
          <div style="font-size:11px;color:var(--c-faint);letter-spacing:0.04em;margin-bottom:6px">Recent</div>
          <ul style="margin:0 0 18px;padding:0;list-style:none;font-size:12px;color:var(--c-muted);line-height:1.7">
            ${recent.map(r => `<li style="display:flex;justify-content:space-between;border-bottom:1px solid var(--c-border);padding:4px 0"><span>${escapeHtml(r.exerciseName)}${r.setCount > 1 ? ` · set ${r.setIndex + 1}` : ''}</span><span style="font-variant-numeric:tabular-nums;color:#0F172A;font-weight:500">${fmtElapsed(r.durationSec)}</span></li>`).join('')}
          </ul>
        ` : ''}

        ${next ? `
          <div style="text-align:center;font-size:13px;color:var(--c-muted);margin-bottom:4px">Take your time. Start when you're ready.</div>
          <div style="text-align:center;font-size:18px;font-weight:600;color:#0F172A;margin-bottom:4px">Next: ${escapeHtml(next.exerciseName)}</div>
          <div style="text-align:center;font-size:13px;color:var(--c-muted);margin-bottom:20px">${escapeHtml(next.reps)}</div>
        ` : ''}

        <button id="gs-next" style="width:100%;padding:14px;background:#0F172A;color:#FAF9F6;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--f);margin-bottom:8px">Start next station</button>
        <button id="gs-finish" style="width:100%;padding:11px;background:transparent;color:var(--c-muted);border:1px solid var(--c-border);border-radius:10px;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">Finish session</button>

        <div id="gs-elapsed-small" style="margin-top:14px;text-align:center;font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">Total elapsed ${fmtElapsed(active.controller.elapsedSec)}</div>
      </div>
    ${shellClose()}
  `;
  wireCommonControls();
  document.getElementById('gs-next')?.addEventListener('click', () => active?.controller.startNextSet(COUNTDOWN_SECONDS));
  document.getElementById('gs-finish')?.addEventListener('click', () => active?.controller.finish());
}

/**
 * Big 5..4..3..2..1 countdown before the next station begins. Auto-advances
 * to `renderActive` when the controller transitions out of `countdown`.
 */
function renderCountdown(): void {
  if (!active) return;
  const next = active.controller.nextSet();
  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  node.innerHTML = `
    ${shellOpen('<div></div>')}
      <div style="padding:18px 22px 36px;text-align:center">
        <div style="font-size:12px;letter-spacing:0.04em;color:var(--c-muted);margin-bottom:8px">Get ready</div>
        <div id="gs-countdown" style="font-size:128px;font-weight:700;color:#0F172A;letter-spacing:-0.04em;font-variant-numeric:tabular-nums;line-height:1;margin-bottom:16px">${active.controller.countdownRemainingSec}</div>
        ${next ? `
          <div style="font-size:18px;font-weight:600;color:#0F172A;margin-bottom:4px">${escapeHtml(next.exerciseName)}</div>
          <div style="font-size:13px;color:var(--c-muted)">${escapeHtml(next.reps)}</div>
        ` : ''}
      </div>
    ${shellClose()}
  `;
  // Tap the X to abort the countdown back to paused isn't worth wiring. Let
  // the countdown finish (it's 5 seconds). The close button uses the normal
  // confirm-finish flow if the user really wants out.
  document.getElementById('gs-close')?.addEventListener('click', () => {
    if (!active) return;
    if (confirm('Finish the session?')) active.controller.finish();
  });
}

function renderFinish(): void {
  if (!active) return;
  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  const elapsed = active.controller.elapsedSec;
  const elapsedMin = Math.max(1, Math.round(elapsed / 60));
  const sets = active.session.sets.length;
  const ex = active.session.exerciseCount;
  const initial = active.workout.rpe ?? active.workout.r ?? 5;
  const records = active.controller.setRecords;
  const oneShot = active.session.sets.every(s => s.setCount === 1);
  active.finishRpe = initial;

  // Per-set or per-station breakdown of measured times.
  let breakdownHtml = '';
  if (records.length) {
    if (oneShot) {
      // HYROX / one-shot: numbered list with the station name + time.
      const rows = records.map((r, i) =>
        `<li style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--c-border);font-size:13px"><span><span style="color:var(--c-faint);font-variant-numeric:tabular-nums;margin-right:8px">${i + 1}.</span>${escapeHtml(r.exerciseName)}</span><span style="font-variant-numeric:tabular-nums;color:#0F172A;font-weight:600">${fmtElapsed(r.durationSec)}</span></li>`
      ).join('');
      breakdownHtml = `<ul style="margin:0 0 22px;padding:0;list-style:none">${rows}</ul>`;
    } else {
      // Strength: group by exercise, show "N sets · total". Keeps the summary
      // tight when a session has 20+ sets.
      const byEx = new Map<number, { name: string; total: number; setCount: number }>();
      for (const r of records) {
        const cur = byEx.get(r.exerciseIndex) ?? { name: r.exerciseName, total: 0, setCount: 0 };
        cur.total += r.durationSec;
        cur.setCount += 1;
        byEx.set(r.exerciseIndex, cur);
      }
      const rows = Array.from(byEx.values()).map(g =>
        `<li style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--c-border);font-size:13px"><span>${escapeHtml(g.name)}<span style="color:var(--c-muted);font-size:11px;margin-left:6px">${g.setCount} ${g.setCount === 1 ? 'set' : 'sets'}</span></span><span style="font-variant-numeric:tabular-nums;color:#0F172A;font-weight:600">${fmtElapsed(g.total)}</span></li>`
      ).join('');
      breakdownHtml = `<ul style="margin:0 0 22px;padding:0;list-style:none">${rows}</ul>`;
    }
  }

  node.innerHTML = `
    ${shellOpen('<div></div>')}
      <div style="padding:6px 22px 22px">
        <div style="font-size:11px;letter-spacing:0.04em;color:var(--c-muted);margin-bottom:4px">Session complete</div>
        <div style="font-size:36px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1;margin-bottom:6px;font-variant-numeric:tabular-nums">${elapsedMin} min</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px">${oneShot ? `${ex} ${ex === 1 ? 'station' : 'stations'}` : `${sets} sets across ${ex} exercise${ex === 1 ? '' : 's'}`}.</div>

        ${breakdownHtml}

        <div style="font-size:13px;color:#0F172A;font-weight:500;margin-bottom:10px">How did it feel?</div>
        <div id="gs-rpe-row" style="display:flex;gap:5px;margin-bottom:22px;flex-wrap:wrap">
          ${Array.from({ length: 10 }, (_, i) => i + 1).map(n => `
            <button data-rpe="${n}" class="gs-rpe" style="
              flex:1;min-width:36px;padding:10px 0;
              background:${n === initial ? '#0F172A' : 'transparent'};
              color:${n === initial ? '#FAF9F6' : '#0F172A'};
              border:1px solid ${n === initial ? '#0F172A' : 'var(--c-border)'};
              border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f);font-variant-numeric:tabular-nums">${n}</button>
          `).join('')}
        </div>

        <button id="gs-save" style="width:100%;padding:14px;background:#0F172A;color:#FAF9F6;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--f)">
          Save and close
        </button>
      </div>
    ${shellClose()}
  `;
  // Mute button hidden on finish (no further cues to mute).
  document.getElementById('gs-close')?.addEventListener('click', () => closeOverlay());

  document.querySelectorAll<HTMLButtonElement>('.gs-rpe').forEach(btn => {
    btn.addEventListener('click', () => {
      const rpe = parseInt(btn.dataset.rpe || '5', 10);
      if (!active) return;
      active.finishRpe = rpe;
      document.querySelectorAll<HTMLButtonElement>('.gs-rpe').forEach(b => {
        const isSel = parseInt(b.dataset.rpe || '0', 10) === rpe;
        b.style.background = isSel ? '#0F172A' : 'transparent';
        b.style.color = isSel ? '#FAF9F6' : '#0F172A';
        b.style.borderColor = isSel ? '#0F172A' : 'var(--c-border)';
      });
    });
  });

  document.getElementById('gs-save')?.addEventListener('click', () => {
    if (!active) return;
    const rpe = active.finishRpe ?? initial;
    completeStrengthSession(active.workout, { rpe, durationSec: elapsed, records });
    closeOverlay();
  });
}

// ─── Patch the live clock + countdown without re-rendering the whole view ──

function patchClocks(): void {
  if (!active) return;
  const phase = active.controller.phase;
  const el = document.getElementById('gs-elapsed');
  if (el) el.textContent = fmtElapsed(active.controller.elapsedSec);
  const elSmall = document.getElementById('gs-elapsed-small');
  if (elSmall) {
    const label = phase === 'paused' ? 'Total elapsed' : 'Elapsed';
    elSmall.textContent = `${label} ${fmtElapsed(active.controller.elapsedSec)}`;
  }
  const rest = document.getElementById('gs-rest');
  if (rest && phase === 'resting') {
    rest.textContent = fmtCountdown(active.controller.restRemainingSec);
  }
  const pauseEl = document.getElementById('gs-pause-elapsed');
  if (pauseEl && phase === 'paused') {
    pauseEl.textContent = fmtElapsed(active.controller.pauseElapsedSec);
  }
  const cd = document.getElementById('gs-countdown');
  if (cd && phase === 'countdown') {
    const prev = parseInt(cd.textContent || '0', 10);
    const next = active.controller.countdownRemainingSec;
    if (next !== prev) {
      cd.textContent = String(next);
      pulse(40);  // soft tick each second
    }
  }
}

// ─── Common controls (mute, close) ──────────────────────────────────────────

function wireCommonControls(): void {
  document.getElementById('gs-mute')?.addEventListener('click', () => {
    if (!active) return;
    active.cuesOn = !active.cuesOn;
    if (!active.cuesOn) active.voice.cancel();
    // Re-render header to update the icon/label.
    if (active.controller.phase === 'resting') renderResting();
    else if (active.controller.phase === 'active') renderActive();
  });
  document.getElementById('gs-close')?.addEventListener('click', () => {
    if (!active) return;
    if (active.finished) { closeOverlay(); return; }
    // Confirm before discarding an in-progress session.
    const ok = confirm('Finish the session? Your time will be logged.');
    if (!ok) return;
    active.controller.finish();
  });
}

// ─── Cue side-effects ───────────────────────────────────────────────────────

function speak(text: string): void {
  if (!active?.cuesOn) return;
  try { active.voice.speak(text); } catch { /* no-op */ }
}

function pulse(pattern: number | number[]): void {
  if (!active?.cuesOn) return;
  try {
    if (typeof navigator !== 'undefined' && typeof (navigator as any).vibrate === 'function') {
      (navigator as any).vibrate(pattern);
    }
  } catch { /* no-op */ }
}

// ─── HTML escape ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
