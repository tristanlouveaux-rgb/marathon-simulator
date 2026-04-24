/**
 * Reusable discipline-aware workout card, matching the running workout-card
 * aesthetic: white background, subtle shadow, no coloured borders, discipline
 * shown as a small left-aligned badge rather than a stripe. Keeps visual
 * harmony with the running plan-view cards.
 */

import type { Workout } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL, DISCIPLINE_ICON } from './colours';

export function renderTriWorkoutCard(w: Workout, opts: { showDay?: boolean } = {}): string {
  const discipline: Discipline = w.discipline ?? 'run';
  const c = DISCIPLINE_COLOURS[discipline];
  const label = DISCIPLINE_LABEL[discipline];
  const rpe = w.rpe ?? w.r ?? 5;
  const tss = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
  const isBrick = w.t === 'brick' && w.brickSegments;

  const expandedDesc = humaniseDesc(w.d);

  const dayLine = opts.showDay && w.dayName
    ? `<div style="font-size:10px;font-weight:600;color:var(--c-faint);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px">${w.dayName}</div>`
    : '';

  const durLabel = computeDurationLabel(w, discipline);

  const brickFootnote = isBrick
    ? `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed rgba(0,0,0,0.08);font-size:11px;color:var(--c-faint)">Brick — bike ${fmtMinPretty(w.brickSegments![0].durationMin ?? 0)} + run ${fmtMinPretty(w.brickSegments![1].durationMin ?? 0)}</div>`
    : '';

  return `
    <div style="
      background:#fff;
      border-radius:14px;
      padding:14px 16px;
      margin-bottom:8px;
      box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05);
    ">
      ${dayLine}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="display:inline-flex;align-items:center;gap:5px;background:${c.badge};color:${c.badgeText};font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;padding:3px 8px;border-radius:100px">
          ${DISCIPLINE_ICON[discipline]}
          ${label}
        </span>
        ${durLabel ? `<span style="font-size:11px;color:var(--c-muted);font-variant-numeric:tabular-nums">${durLabel}</span>` : ''}
        <span style="flex:1"></span>
        <span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">RPE ${rpe}</span>
        ${tss > 0 ? `<span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">TSS ${Math.round(tss)}</span>` : ''}
      </div>
      <div style="font-size:15px;font-weight:600;color:#0F172A;margin-bottom:4px;letter-spacing:-0.01em">${escapeHtml(w.n)}</div>
      <div style="font-size:13px;color:var(--c-muted);line-height:1.5">${escapeHtml(expandedDesc)}</div>
      ${brickFootnote}
    </div>
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replace training shorthand with readable text, per user feedback:
 *   WU → Warm up
 *   CD → Cool down
 *   rec → recovery
 */
function humaniseDesc(desc: string): string {
  if (!desc) return '';
  let s = desc;
  s = s.replace(/\bWU\b/g, 'Warm up');
  s = s.replace(/\bCD\b/g, 'Cool down');
  s = s.replace(/\brec\b/g, 'recovery');
  return s;
}

/**
 * Primary duration label for the card chip. Swim in metres; bike in hours;
 * run in distance + hours; everything else falls back to time.
 */
function computeDurationLabel(w: Workout, discipline: Discipline): string {
  const mins = extractPrimaryMinutes(w);
  const distM = extractPrimaryMetres(w);

  if (w.brickSegments) {
    const total = (w.brickSegments[0].durationMin ?? 0) + (w.brickSegments[1].durationMin ?? 0);
    return fmtMinPretty(total);
  }

  if (discipline === 'swim') {
    // Prefer explicit metres
    if (distM > 0) return `${distM.toLocaleString()}m`;
    if (mins > 0) return fmtMinPretty(mins);
    return '';
  }

  if (discipline === 'bike') {
    if (mins > 0) return fmtMinPretty(mins);
    return '';
  }

  // run — show distance + time when we can estimate distance
  if (mins > 0) return fmtMinPretty(mins);
  return '';
}

function extractPrimaryMinutes(w: Workout): number {
  if (w.brickSegments) return 0;
  const matches = Array.from(String(w.d || '').matchAll(/(\d+)\s*min/g));
  if (!matches.length) return 0;
  // Pick the largest — usually the session total or main set
  return matches.reduce((acc, m) => Math.max(acc, parseInt(m[1], 10)), 0);
}

function extractPrimaryMetres(w: Workout): number {
  const m = String(w.d || '').match(/(\d[\d,]*)m total/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  const alt = String(w.d || '').match(/^\s*(\d[\d,]*)m\b/);
  if (alt) return parseInt(alt[1].replace(/,/g, ''), 10);
  return 0;
}

/**
 * Pretty-print minutes. Rounds to nearest 5 min for sessions ≥ 30 min so
 * we never show "147 min" — it becomes "2h 25min".
 */
function fmtMinPretty(mins: number): string {
  if (!Number.isFinite(mins) || mins <= 0) return '';
  const rounded = mins >= 30 ? Math.round(mins / 5) * 5 : Math.round(mins);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
