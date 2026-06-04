/**
 * Post-session summary card for a completed strength / gym session.
 *
 * Shown after the user finishes a guided session or taps "Mark as done". Gives
 * the recap: the working weights just logged (with estimated-1RM and a quiet
 * "New best" note), which muscle groups the session worked (text chips), the
 * duration and RPE, and the heart-rate data if a synced activity matched. When
 * no HR is attached yet, a "Match heart rate" action lets the user pick the
 * synced activity that belongs to this session (the manual fallback to the
 * completion-time auto-match).
 *
 * Modal follows the canonical centered-overlay pattern (UX_PATTERNS → Overlays
 * and Modals). Neutral palette; the green "New best" note is the only accent.
 * No emoji, no accent on the navigation/action links.
 */

import type { Workout } from '@/types';
import type { GarminPendingItem, Week } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { render } from '@/ui/renderer';
import { parseStrengthSession } from '@/guided/strength-model';
import { STRENGTH_PR_THRESHOLD_KG } from '@/constants/strength-constants';
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

/** "Mon 2 Jun" from an ISO string — disambiguates same-type recordings across days. */
function dateLabel(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
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
    // Exclude whatever is already attached to this session — "Change recording"
    // should only offer the alternatives.
    const attachedGid = currentActual()?.garminId;
    const fromPending = (wk!.garminPending ?? []).filter(p => p.avgHR != null && p.avgHR > 0);
    const seenGids = new Set(fromPending.map(p => p.garminId));
    // Standalone synced activities (their own `garmin-<gid>` card, not bound to a
    // plan slot) are offerable too. After a sync cleans up garminPending they are
    // the only remaining copy of the recording, and they're exactly the "floating
    // HIIT next to a done gym session" the user wants to merge in. Slot-bound
    // actuals (key = a plan-slot id) are deliberately not offered — they already
    // belong to another session.
    const fromActuals: GarminPendingItem[] = Object.entries(wk!.garminActuals ?? {})
      .filter(([key, a]) =>
        key.startsWith('garmin-') && key !== result.workoutId
        && a.avgHR != null && a.avgHR > 0 && !!a.garminId && !seenGids.has(a.garminId))
      .map(([, a]) => ({
        garminId: a.garminId,
        activityType: a.activityType ?? a.displayName ?? 'Activity',
        appType: 'gym',
        startTime: a.startTime ?? '',
        durationSec: a.durationSec ?? 0,
        distanceM: null,
        avgHR: a.avgHR ?? null,
        maxHR: a.maxHR ?? null,
        aerobicEffect: a.aerobicEffect ?? null,
        anaerobicEffect: a.anaerobicEffect ?? null,
        garminRpe: null,
        calories: a.calories ?? null,
        iTrimp: a.iTrimp ?? null,
        hrZones: a.hrZones ?? null,
      }));
    return [...fromPending, ...fromActuals].filter(p => p.garminId !== attachedGid);
  }

  function attachHR(p: GarminPendingItem): void {
    const a = currentActual();
    if (!a) return;
    const prevGid = a.garminId;
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
    // Merge: the picked recording may already exist as its own standalone card (a
    // `garmin-<gid>` actual + adhoc created when it was reviewed before this match).
    // Remove those copies so the session shows once, not as a planned card plus a
    // floating "HIIT".
    const dupKey = `garmin-${p.garminId}`;
    if (dupKey !== result.workoutId) {
      if (wk!.garminActuals?.[dupKey]) delete wk!.garminActuals[dupKey];
      if (wk!.adhocWorkouts?.length) wk!.adhocWorkouts = wk!.adhocWorkouts.filter(w => w.id !== dupKey);
      if (wk!.rated?.[dupKey] !== undefined) delete wk!.rated[dupKey];
    }
    // Re-match: release the recording that was attached before (if it was a real
    // synced one, not the guided- stub) back to review, so it can be bound to the
    // session it actually belongs to.
    if (prevGid && prevGid !== p.garminId && !prevGid.startsWith('guided-') && wk!.garminMatched[prevGid] === result.workoutId) {
      wk!.garminMatched[prevGid] = '__pending__';
    }
    saveState();
    pickingHR = false;
    build();
  }

  function fmtKg(kg: number): string {
    const n = Math.round(kg * 100) / 100;
    return `${n}kg`;
  }

  /**
   * Recap of the working weights just logged for this session, read from the
   * per-lift memory (persistStrengthLifts wrote them before this card opened).
   * The "New best" note compares the two most recent est1RM history samples
   * (today vs the previous training day), so it's independent of the launch
   * toast's notifiedPr snapshot — no double-surfacing.
   */
  function weightsRecap(): string {
    const session = parseStrengthSession(workout);
    if (!session) return '';
    const lifts = state.strengthLog?.lifts ?? {};
    const today = new Date().toISOString().slice(0, 10);

    const seen = new Set<string>();
    const rows: string[] = [];
    const prs: string[] = [];
    for (const set of session.sets) {
      if (!set.liftKey || seen.has(set.liftKey)) continue;
      seen.add(set.liftKey);
      const e = lifts[set.liftKey];
      if (!e || e.lastDate !== today) continue;
      const est = e.est1rmKg != null ? `<span style="color:var(--c-faint);margin-left:8px">est 1RM ${fmtKg(e.est1rmKg)}</span>` : '';
      rows.push(`
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--c-border)">
          <span style="font-size:13px;color:var(--c-black)">${esc(e.displayName)}</span>
          <span style="font-size:13px;color:var(--c-muted);font-variant-numeric:tabular-nums;flex-shrink:0">${e.lastWeightKg != null ? `${fmtKg(e.lastWeightKg)}${e.lastReps ? ` × ${esc(e.lastReps)}` : ''}` : ''}${est}</span>
        </div>`);
      const hist = e.est1rmHistory ?? [];
      if (hist.length >= 2) {
        const last = hist[hist.length - 1];
        const prev = hist[hist.length - 2].value;
        // History is now a PB-staircase (only advancing samples appended), so the
        // last delta can be from a PRIOR session. Only call it a "New best" when
        // the advancing sample was set TODAY — i.e. this session actually beat it.
        if (last.date === today && last.value - prev >= STRENGTH_PR_THRESHOLD_KG) prs.push(e.displayName);
      }
    }
    if (!rows.length) return '';
    const prNote = prs.length
      ? `<div style="font-size:12px;color:#15803d;margin-top:8px">New best: ${prs.map(esc).join(', ')}. Estimated 1RM beat your last.</div>`
      : '';
    return `
      <div style="margin-top:14px">
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:6px">Weights logged</div>
        ${rows.join('')}
        ${prNote}
      </div>`;
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
      // Name the attached recording's date and time. A mis-matched recording (the
      // wrong day's session bound to this slot) is then visible at a glance, and
      // "Change recording" is the recovery path.
      const attachedMeta = [dateLabel(a.startTime), timeLabel(a.startTime)].filter(Boolean).join(', ');
      const note = attachedMeta
        ? `From the recording on ${attachedMeta}.`
        : (result.hrAutoMatched ? 'Matched from a synced activity.' : '');
      const canRematch = hrCandidates().length > 0;
      return `
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--c-border)">
          <div style="font-size:14px;color:var(--c-black);font-variant-numeric:tabular-nums">Avg HR ${Math.round(a.avgHR)} bpm${max}</div>
          ${note ? `<div style="font-size:12px;color:var(--c-faint);margin-top:3px">${esc(note)}</div>` : ''}
          ${canRematch ? `<button id="ss-rematch-hr" style="margin-top:8px;padding:0;background:none;border:none;color:var(--c-muted);font-size:12px;font-weight:500;cursor:pointer;font-family:var(--f);text-decoration:underline;text-underline-offset:2px">Change recording</button>` : ''}
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
          <span style="display:block;font-size:12px;color:var(--c-muted)">${[dateLabel(p.startTime), timeLabel(p.startTime)].filter(Boolean).map(esc).join(', ')}${durLabel(p.durationSec) ? ` · ${durLabel(p.durationSec)}` : ''}</span>
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
        ${weightsRecap()}
        ${muscleChips()}
        ${hrSection()}
      </div>

      <div style="padding:18px 22px 10px">
        <button id="ss-done" style="width:100%;padding:14px;background:#0F172A;color:#FAF9F6;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;font-family:var(--f)">Done</button>
      </div>
      <div style="padding:0 22px 18px">
        <button id="ss-delete" style="width:100%;padding:11px;background:transparent;color:#EF4444;border:none;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">Delete this session</button>
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
    overlay.querySelector('#ss-rematch-hr')?.addEventListener('click', () => { pickingHR = true; build(); });
    overlay.querySelector('#ss-delete')?.addEventListener('click', () => {
      showDeleteConfirm(() => {
        const st = getMutableState();
        const wk2 = st.wks?.[result.weekIdx];
        if (wk2) {
          const id = result.workoutId;
          if (wk2.rated) delete wk2.rated[id];
          if (wk2.garminActuals) delete wk2.garminActuals[id];
          // A user-added session (session generator / accepted suggestion) is a real
          // slot in triWorkouts/adhocWorkouts — remove it entirely. A plan slot is
          // only un-completed (rating + actual cleared); the planned session stays.
          if (id.startsWith('adhoc-') || id.startsWith('holiday-')) {
            if (wk2.triWorkouts) wk2.triWorkouts = wk2.triWorkouts.filter(w => (w.id ?? w.n) !== id);
            if (wk2.adhocWorkouts) wk2.adhocWorkouts = wk2.adhocWorkouts.filter(w => (w.id ?? w.n) !== id);
          }
        }
        saveState();
        overlay.remove();
        render();
      });
    });
  }

  /**
   * In-app delete confirmation. Replaces the native `confirm()` dialog, which
   * renders as a "localhost says…" system box in the browser and behaves poorly
   * in the iOS WKWebView. A small centered card layered over the summary card.
   */
  function showDeleteConfirm(onConfirm: () => void): void {
    if (overlay.querySelector('#ss-confirm')) return;
    const el = document.createElement('div');
    el.id = 'ss-confirm';
    el.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);z-index:10;padding:20px';
    el.innerHTML = `
      <div style="background:#FAF9F6;border-radius:16px;max-width:340px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3)">
        <div style="font-size:16px;font-weight:600;color:#0F172A;margin-bottom:6px">Delete this session?</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:18px">It is removed from your week.</div>
        <div style="display:flex;gap:10px">
          <button id="ss-confirm-cancel" style="flex:1;padding:12px;background:transparent;color:#0F172A;border:1px solid var(--c-border);border-radius:10px;font-size:14px;font-weight:500;cursor:pointer;font-family:var(--f)">Cancel</button>
          <button id="ss-confirm-yes" style="flex:1;padding:12px;background:#EF4444;color:#FAF9F6;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--f)">Delete</button>
        </div>
      </div>`;
    overlay.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) el.remove(); });
    el.querySelector('#ss-confirm-cancel')?.addEventListener('click', () => el.remove());
    el.querySelector('#ss-confirm-yes')?.addEventListener('click', () => { el.remove(); onConfirm(); });
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAndRefresh(); });
  build();
  document.body.appendChild(overlay);
}
