/**
 * Triathlon workout detail modal — full session breakdown.
 *
 * Shown when a user taps a tri workout card on home or plan. Parses the
 * workout description into structured Warm up / Drills / Main set / Cool
 * down blocks and displays them as a clean vertical breakdown. Brick
 * workouts render both segments.
 */

import type { Workout } from '@/types/state';
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL, DISCIPLINE_ICON, type BadgeKind } from './colours';

export function openTriWorkoutDetail(workout: Workout): void {
  const existing = document.getElementById('tri-workout-detail-overlay');
  if (existing) existing.remove();

  const discipline: BadgeKind = workout.discipline
    ? workout.discipline
    : (workout.t === 'gym' || workout.t === 'strength' || /strength|gym/i.test(workout.n)) ? 'strength'
    : 'run';
  const c = DISCIPLINE_COLOURS[discipline];
  const label = DISCIPLINE_LABEL[discipline];
  const rpe = workout.rpe ?? workout.r ?? 5;
  const tss = (workout.aerobic ?? 0) + (workout.anaerobic ?? 0);
  const blocks = parseWorkoutBlocks(workout);

  const overlay = document.createElement('div');
  overlay.id = 'tri-workout-detail-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.style.cssText += ';overflow-y:auto';

  overlay.innerHTML = `
    <div style="
      background:#FAF9F6;
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
          <span>RPE ${rpe}</span>
          ${tss > 0 ? `<span>TSS ${Math.round(tss)}</span>` : ''}
          ${workout.dayName ? `<span>${workout.dayName}</span>` : ''}
        </div>
      </div>

      <!-- Structured breakdown -->
      <div style="padding:18px 24px 8px">
        ${isStructured(blocks)
          ? blocks.map((b) => renderBlock(b, c.accent)).join('')
          : `<div style="padding:4px 0 12px;font-size:14px;color:#0F172A;line-height:1.6">${escapeHtml(blocks[0]?.body || workout.d)}</div>`}
      </div>

      <div style="padding:8px 24px 24px;display:flex;justify-content:flex-end">
        <button id="tri-detail-done" style="
          padding:13px 22px;
          background:#0F172A;color:#FAF9F6;
          border:none;border-radius:10px;
          font-size:14px;font-weight:600;
          cursor:pointer;
        ">Done</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#tri-detail-close')?.addEventListener('click', close);
  overlay.querySelector('#tri-detail-done')?.addEventListener('click', close);
}

/**
 * A single "Session" block with no warm-up / main / cool-down split is just
 * the workout description repeated under a label — render it plainly instead.
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
  // Split on periods followed by space — simple heuristic for workout text
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
  // Fallback — put under "Session"
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
      <div style="flex-shrink:0;width:44px;padding-top:4px">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${isEndpoint ? 'var(--c-faint)' : accent}">${b.label.slice(0, 4).toUpperCase()}</div>
      </div>
      <div style="flex:1;border-left:2px solid ${isEndpoint ? 'rgba(0,0,0,0.08)' : accent};padding:4px 0 4px 14px">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${isEndpoint ? 'var(--c-muted)' : '#0F172A'};margin-bottom:4px">${b.label}</div>
        <div style="font-size:14px;color:#0F172A;line-height:1.55">${escapeHtml(b.body)}</div>
      </div>
    </div>
  `;
}

function formatTarget(t: import('@/types/triathlon').DisciplineTarget): string {
  if (t.targetWatts) return `${t.targetWatts}W`;
  if (t.targetPctFtp) return `${Math.round(t.targetPctFtp * 100)}% FTP`;
  if (t.targetPaceSecPerKm) return `${Math.floor(t.targetPaceSecPerKm / 60)}:${String(Math.round(t.targetPaceSecPerKm % 60)).padStart(2, '0')}/km`;
  if (t.targetPaceSecPer100m) return `${Math.floor(t.targetPaceSecPer100m / 60)}:${String(Math.round(t.targetPaceSecPer100m % 60)).padStart(2, '0')}/100m`;
  if (t.rpe) return `RPE ${t.rpe}`;
  return t.targetHrZone ? `HR Z${t.targetHrZone}` : 'steady';
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
