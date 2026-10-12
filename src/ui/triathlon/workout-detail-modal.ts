/**
 * Triathlon workout detail modal. Full session breakdown.
 *
 * Shown when a user taps a tri workout card on home or plan. Parses the
 * workout description into structured Warm up / Drills / Main set / Cool
 * down blocks and displays them as a clean vertical breakdown. Brick
 * workouts render both segments.
 */

import type { Workout } from '@/types/state';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { intensityTargetLabel } from '@/ui/workout-adjust-overlay';
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL, DISCIPLINE_ICON, type BadgeKind } from './colours';
import { openGuidedStrength } from '@/ui/guided-strength-overlay';
import { completeStrengthSession } from '@/guided/strength-complete';
import { recordPlannedSessionDone, dropInAppActual, plannedSessionRecordSport } from '@/calculations/in-app-activity';
import { estimateWorkoutDurMin, planCardBaseMinPerKm } from '@/calculations/fitness-model';
import { estimateTriWorkoutMin, readTriWorkoutMin } from './week-resolve.triathlon';
import { fmtModelPaceKm } from '@/utils/format';

export function openTriWorkoutDetail(workout: Workout, weekIdx?: number): void {
  // HYROX sessions (station/brick) carry `hyroxComponents`; only the guided
  // player understands them (via parseHyroxSession). This only matches a
  // generated HYROX session in a non-HYROX mode — tri/cycling swim/bike/run/gym
  // never carry hyroxComponents — so it can't affect those. Tap → guided.
  const hyroxComponents = (workout as any).hyroxComponents;
  if (Array.isArray(hyroxComponents) && hyroxComponents.length > 0) {
    openGuidedStrength(workout);
    return;
  }
  // Strength/gym sessions. A session already DONE opens its recap (what was
  // logged — exercises, RPE, duration, and a Delete), not the "Start session"
  // breakdown. An undone one opens the editable breakdown. Mirrors the running
  // plan's openGymCardDetail so tapping a completed gym card never offers to
  // re-start the session.
  if (workout.t === 'gym' || workout.t === 'strength' || /strength|gym/i.test(workout.n || '')) {
    const sWkIdx = weekIdx ?? (getState().w - 1);
    const sWk = getState().wks?.[sWkIdx];
    const sId = String((workout as any).id ?? workout.n);
    const ratingVal = sWk?.rated?.[sId];
    const isDone = (typeof ratingVal === 'number' && ratingVal > 0) || !!(sWk?.garminActuals as Record<string, unknown> | undefined)?.[sId];
    if (isDone) {
      // A matched SYNCED activity (e.g. a HIIT logged onto this slot) opens the
      // rich activity detail — HR zones, stats, sport, and a Discard bin — the
      // same view Recent opens. A guided/manual strength session (no synced
      // actual) opens its exercise recap instead.
      const syncedActual: any = (sWk?.garminActuals as Record<string, unknown> | undefined)?.[sId];
      const gid = syncedActual?.garminId ? String(syncedActual.garminId) : '';
      const isSynced = gid.startsWith('strava-') || gid.startsWith('garmin-') || gid.startsWith('apple-');
      if (syncedActual && isSynced) {
        import('@/ui/activity-detail').then(({ renderActivityDetail }) => renderActivityDetail(syncedActual, workout.n, 'plan', undefined, sId));
        return;
      }
      import('@/guided/strength-complete').then(({ buildLoggedStrengthResult }) => {
        const result = buildLoggedStrengthResult(workout, sWkIdx);
        if (result && !result.isHyrox) {
          import('@/ui/strength-summary-card').then(({ openStrengthSummary }) => openStrengthSummary(workout, result));
        } else {
          import('@/ui/strength-workout-detail-modal').then(({ openStrengthWorkoutDetail }) => openStrengthWorkoutDetail(workout));
        }
      });
      return;
    }
    import('@/ui/strength-workout-detail-modal').then(({ openStrengthWorkoutDetail }) => openStrengthWorkoutDetail(workout));
    return;
  }

  // Week the session lives in (its triWorkouts object is mutated in place by the
  // Adjust control). The tap handlers resolve `workout` from the current week's
  // store, so default there.
  const wkIdx = weekIdx ?? (getState().w - 1);

  const existing = document.getElementById('tri-workout-detail-overlay');
  if (existing) existing.remove();

  // HYROX-only disciplines ('station', 'brick') fall back to 'run' in this
  // triathlon card. HYROX workouts render through their own modal.
  const triDisc = (workout.discipline === 'swim' || workout.discipline === 'bike' || workout.discipline === 'run')
    ? workout.discipline : undefined;
  const discipline: BadgeKind = triDisc
    ? triDisc
    : (workout.t === 'gym' || workout.t === 'strength' || /strength|gym/i.test(workout.n)) ? 'strength'
    : 'run';
  const c = DISCIPLINE_COLOURS[discipline];
  const label = DISCIPLINE_LABEL[discipline];
  const rpe = workout.rpe ?? workout.r ?? 5;
  const tss = (workout.aerobic ?? 0) + (workout.anaerobic ?? 0);
  const blocks = parseWorkoutBlocks(workout);
  const durMin = (typeof workout.estimatedDurationMin === 'number' && workout.estimatedDurationMin > 0)
    ? Math.round(workout.estimatedDurationMin) : 0;
  const isScaled = !!(workout as any).userScaledAt;
  const origMin = (typeof (workout as any).originalDurationMin === 'number' && (workout as any).originalDurationMin > 0)
    ? Math.round((workout as any).originalDurationMin) : 0;
  const triCfg = getState().triConfig;
  const intensityTarget = intensityTargetLabel(workout, triCfg?.bike?.ftp, triCfg?.swim?.cssSecPer100m);
  // Adjust applies to time-defined swim/bike/run sessions (cycling lives here as
  // the bike discipline). Strength sessions take the separate breakdown modal above.
  const canAdjust = durMin > 0 || /\d\s*(km|m|min)\b/i.test(workout.d || '');

  const overlay = document.createElement('div');
  overlay.id = 'tri-workout-detail-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.style.cssText += ';overflow-y:auto';

  overlay.innerHTML = `
    <div style="
      background:#fff;
      width:100%;max-width:520px;
      max-height:90vh;overflow-y:auto;
      border-radius:20px;
      box-shadow:0 10px 40px rgba(0,0,0,0.3);
      position:relative;
    ">
      <!-- Header with discipline band -->
      <div style="
        background:linear-gradient(180deg, ${c.bg}, rgba(255,255,255,0));
        padding:22px 24px 18px;
        border-bottom:1px solid rgba(0,0,0,0.05);
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span style="display:inline-flex;align-items:center;gap:6px;background:${c.badge};color:${c.badgeText};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:4px 11px;border-radius:100px">
            ${DISCIPLINE_ICON[discipline]}
            ${label}
          </span>
          <button id="tri-detail-close" style="
            width:32px;height:32px;
            background:rgba(0,0,0,0.05);border:none;border-radius:50%;
            display:flex;align-items:center;justify-content:center;
            cursor:pointer;color:var(--c-muted);
          " aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div style="font-size:26px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;margin-bottom:6px">${escapeHtml(workout.n)}</div>
        <div style="display:flex;gap:14px;font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums">
          ${durMin > 0 ? `<span>${durMin} min</span>` : ''}
          <span>RPE ${rpe}</span>
          ${tss > 0 ? `<span>TSS ${Math.round(tss)}</span>` : ''}
          ${workout.dayName ? `<span>${workout.dayName}</span>` : ''}
        </div>
        ${intensityTarget ? `<div style="font-size:12px;color:var(--c-muted);margin-top:6px;font-variant-numeric:tabular-nums">Target: ${intensityTarget}</div>` : ''}
        ${isScaled && origMin > 0 ? `<div style="font-size:11px;color:var(--c-faint);margin-top:5px">Adjusted for this session. Planned ${origMin} min.</div>` : ''}
      </div>

      <!-- Structured breakdown -->
      <div style="padding:18px 24px 8px">
        ${isStructured(blocks)
          ? blocks.map((b) => renderBlock(b, c.accent)).join('')
          : `<div style="padding:4px 0 12px;font-size:14px;color:#0F172A;line-height:1.6">${escapeHtml(blocks[0]?.body || workout.d)}</div>`}
      </div>

      ${discipline === 'strength' ? `
        <div style="padding:6px 24px 18px;display:flex;flex-direction:column;gap:10px">
          <button id="tri-detail-strength-start" class="m-btn-primary" style="width:100%;padding:14px;font-size:15px">Start session</button>
          <button id="tri-detail-strength-done" class="m-btn-ok" style="width:100%;padding:11px;font-size:13px">Mark as done</button>
        </div>
      ` : `
        <div style="padding:8px 24px 24px;display:flex;flex-direction:column;gap:14px">
          <!-- Mirrors the running plan card: primary Start CTA on top (run only),
               Mark as Done · Adjust · Skip text links below. No redundant Done. -->
          ${discipline === 'run'
            ? `<button id="tri-detail-start" class="m-btn-primary" style="width:100%;padding:13px;font-size:14px"><span style="width:9px;height:9px;background:#fff;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block"></span>Start session</button>`
            : ''}
          <div style="display:flex;gap:12px;justify-content:center;align-items:center;flex-wrap:wrap">
            <button id="tri-detail-mark-done" style="font-size:13px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 2px;font-family:var(--f)">Mark as Done</button>
            ${canAdjust ? `<span style="color:var(--c-border)">·</span><button id="tri-detail-adjust" style="font-size:13px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 2px;font-family:var(--f)">Adjust</button>` : ''}
            <span style="color:var(--c-border)">·</span>
            <button id="tri-detail-skip" style="font-size:13px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:4px 2px;font-family:var(--f)">Skip</button>
          </div>
        </div>
      `}
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#tri-detail-close')?.addEventListener('click', close);
  overlay.querySelector('#tri-detail-done')?.addEventListener('click', close);
  // On-demand run: launch the same guided/tracked-run flow plan mode uses
  // (window.trackWorkout). gym uses openGuidedStrength below; bike/swim keep
  // Mark-as-done (no suitable guided recorder for those yet).
  overlay.querySelector('#tri-detail-start')?.addEventListener('click', () => {
    close();
    (window as any).trackWorkout?.(workout.n || 'Session', workout.d || '');
  });
  overlay.querySelector('#tri-detail-adjust')?.addEventListener('click', () => {
    close();
    import('@/ui/workout-adjust-overlay').then(({ openWorkoutAdjust }) => {
      openWorkoutAdjust(workout, wkIdx, {
        persist: 'object',
        store: 'triWorkouts',
        workoutId: (workout as any).id,
        allowIntensity: false,
        rerender: () => import('./plan-view').then(m => m.renderTriathlonPlanView()).catch(() => {}),
      });
    });
  });
  overlay.querySelector('#tri-detail-mark-done')?.addEventListener('click', () => {
    setRated(wkIdx, workout, rpe);
    close();
    // Mode-aware refresh: renderTriathlonPlanView no-ops for on-demand users (no
    // triConfig), which would leave a just-completed generated session stuck in
    // the "Planned" list. renderMainView routes to the right plan view per mode.
    import('../main-view').then(m => m.renderMainView()).catch(() => {});
  });
  overlay.querySelector('#tri-detail-skip')?.addEventListener('click', () => {
    setRated(wkIdx, workout, 'skip');
    close();
    import('../main-view').then(m => m.renderMainView()).catch(() => {});
  });
  overlay.querySelector('#tri-detail-strength-start')?.addEventListener('click', () => {
    close();
    openGuidedStrength(workout);
  });
  overlay.querySelector('#tri-detail-strength-done')?.addEventListener('click', () => {
    const result = completeStrengthSession(workout);
    close();
    import('@/ui/strength-summary-card').then(({ openStrengthSummary }) => openStrengthSummary(workout, result));
  });
}

/**
 * Mark a tri session done (rpe number) or skipped ('skip') by writing the shared
 * `wk.rated` map — the same map the running plan card writes and the shared status
 * chip reads.
 *
 * Mark as Done with no watch also stores the session's planned load as its
 * activity record (decision 2026-10-06), mirroring the running plan card:
 * recordPlannedSessionDone writes the planned duration at the rated RPE,
 * stamped on the planned day, with a bike or swim tagged with its sport. The
 * session then counts in the Home strain ring, the week debrief and the holiday
 * return. A watch copy that syncs later supersedes the record in place
 * (matchAndAutoComplete), so it counts once. A session a synced activity
 * already completes (a fuzzy-matched link, a brick completed by detection) gets
 * the rating only: that activity carries the load
 * (isSessionCompletedByActivity). Skip drops the record. Shared by triathlon,
 * cycling and Just-Track generated sessions (this modal).
 */
function setRated(weekIdx: number, workout: Workout, value: number | 'skip'): void {
  const s = getMutableState();
  const wk = s.wks?.[weekIdx];
  if (!wk) return;
  if (!wk.rated) wk.rated = {};
  const key = (workout as any).id ?? workout.n;
  wk.rated[key] = value;
  if (value === 'skip') {
    dropInAppActual(wk, key); // a skipped session carries no load record
  } else {
    recordPlannedSessionDone(wk, key, workout, {
      rpe: value,
      durationMin: markDoneDurationMin(workout, s),
      planStartDate: s.planStartDate,
      weekNum: weekIdx + 1,
      currentWeek: s.w,
    });
  }
  saveState();
}

/**
 * Planned duration for a Mark as Done record: the dose the session's card and
 * the day target price. A session that states a duration (readTriWorkoutMin: a
 * stored duration, a brick's segments, a minutes token) uses it. A run that
 * states none (a Just-Track run generated as "8km @ 5:00/km") uses the running
 * plan card's estimate at the athlete's easy pace (planCardBaseMinPerKm), the
 * same dose markPlanCardDone records. Anything else takes
 * estimateTriWorkoutMin's fallback, as its card does.
 */
function markDoneDurationMin(workout: Workout, s: { pac?: { e?: number } }): number {
  const stated = readTriWorkoutMin(workout);
  if (stated != null) return stated;
  if (plannedSessionRecordSport(workout) === 'run') return estimateWorkoutDurMin(workout, planCardBaseMinPerKm(s));
  return estimateTriWorkoutMin(workout);
}

/**
 * A single "Session" block with no warm-up / main / cool-down split is just
 * the workout description repeated under a label. Render it plainly instead.
 */
function isStructured(blocks: WorkoutBlock[]): boolean {
  if (blocks.length === 0) return false;
  if (blocks.length === 1 && blocks[0].label === 'Session') return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse workout description into structured blocks
// ─────────────────────────────────────────────────────────────────────────────

interface WorkoutBlock {
  label: string;  // "Warm up", "Drills", "Main", "Cool down", "Bike", "Run"
  body: string;
}

function parseWorkoutBlocks(w: Workout): WorkoutBlock[] {
  // Brick workouts: render two segments explicitly.
  if (w.brickSegments) {
    const [bike, run] = w.brickSegments;
    const blocks: WorkoutBlock[] = [];
    blocks.push({ label: 'Bike', body: `${bike.durationMin ?? 0}min @ ${formatTarget(bike)}` });
    blocks.push({ label: 'Transition', body: 'Rack, shoes on, out the door. Practice keeping it under 2 min.' });
    blocks.push({ label: 'Run', body: `${run.durationMin ?? 0}min @ ${formatTarget(run)}` });
    return blocks;
  }

  const desc = humaniseDesc(w.d || '');
  if (!desc) return [];

  // Split by period followed by capital letter or keyword. Keep it simple.
  const parts = splitIntoSegments(desc);
  const blocks: WorkoutBlock[] = [];
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const block = classifySegment(trimmed);
    if (block) blocks.push(block);
  }
  return blocks;
}

function splitIntoSegments(desc: string): string[] {
  // Split on periods followed by space. Simple heuristic for workout text
  // Also split on obvious segment keywords.
  return desc.split(/\.\s+(?=(?:Warm up|Cool down|Drills|Main|Focus|Transition|Practice))/i);
}

function classifySegment(seg: string): WorkoutBlock | null {
  const text = seg.replace(/\.$/, '').trim();
  if (!text) return null;

  // Keyword-based classification
  if (/^warm\s*up/i.test(text)) {
    return { label: 'Warm up', body: stripPrefix(text, /^warm\s*up[:\s]*/i) };
  }
  if (/^cool\s*down/i.test(text)) {
    return { label: 'Cool down', body: stripPrefix(text, /^cool\s*down[:\s]*/i) };
  }
  if (/^drills?/i.test(text)) {
    return { label: 'Drills', body: stripPrefix(text, /^drills?[:\s]*/i) };
  }
  if (/^main/i.test(text)) {
    return { label: 'Main set', body: stripPrefix(text, /^main[:\s]*/i) };
  }
  if (/^focus/i.test(text)) {
    return { label: 'Focus', body: stripPrefix(text, /^focus[:\s]*/i) };
  }
  if (/^transition/i.test(text)) {
    return { label: 'Transition', body: text };
  }
  if (/^\d+m\s+total/i.test(text)) {
    return { label: 'Total volume', body: text };
  }
  // Fallback. Put under "Session"
  return { label: 'Session', body: text };
}

function stripPrefix(s: string, pattern: RegExp): string {
  return s.replace(pattern, '').trim();
}

function humaniseDesc(d: string): string {
  return String(d || '')
    .replace(/\bWU\b/g, 'Warm up')
    .replace(/\bCD\b/g, 'Cool down')
    .replace(/\brec\b/g, 'recovery');
}

// ─────────────────────────────────────────────────────────────────────────────
// Block rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderBlock(b: WorkoutBlock, accent: string): string {
  const isEndpoint = b.label === 'Warm up' || b.label === 'Cool down' || b.label === 'Transition';
  return `
    <div style="display:flex;gap:14px;margin-bottom:16px">
      <div style="width:3px;flex-shrink:0;background:${isEndpoint ? 'rgba(0,0,0,0.08)' : accent};border-radius:2px;margin-top:2px"></div>
      <div style="flex:1;padding:2px 0">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${isEndpoint ? 'var(--c-faint)' : accent};margin-bottom:4px">${b.label}</div>
        <div style="font-size:14px;color:#0F172A;line-height:1.55">${escapeHtml(b.body)}</div>
      </div>
    </div>
  `;
}

function formatTarget(t: import('@/types/triathlon').DisciplineTarget): string {
  if (t.targetWattsLow && t.targetWattsHigh) return `${t.targetWattsLow}–${t.targetWattsHigh}W`;
  if (t.targetWatts) return `${t.targetWatts}W`;
  if (t.targetPctFtp) return `${Math.round(t.targetPctFtp * 100)}% FTP`;
  if (t.targetPaceSecPerKm) return `${fmtModelPaceKm(t.targetPaceSecPerKm)}/km`; // whole second, minute carried
  if (t.targetPaceSecPer100m) return `${Math.floor(t.targetPaceSecPer100m / 60)}:${String(Math.round(t.targetPaceSecPer100m % 60)).padStart(2, '0')}/100m`;
  if (t.rpe) return `RPE ${t.rpe}`;
  return t.targetHrZone ? `HR Z${t.targetHrZone}` : 'steady';
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
