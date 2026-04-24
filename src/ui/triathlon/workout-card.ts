/**
 * Reusable discipline-aware workout card.
 *
 * Renders a single triathlon workout with discipline badge, colour stripe,
 * title + description, and a small RPE pill. Used by plan view, home view,
 * and any drill-down.
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

  const dayLine = opts.showDay && w.dayName
    ? `<div style="font-size:11px;color:var(--c-faint);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px">${w.dayName}</div>`
    : '';

  const brickFootnote = isBrick
    ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed ${c.border};font-size:11px;color:var(--c-faint)">Brick — bike ${w.brickSegments![0].durationMin}min + run ${w.brickSegments![1].durationMin}min</div>`
    : '';

  return `
    <div style="
      position:relative;
      background:rgba(255,255,255,0.92);
      border:1px solid ${c.border};
      border-left:3px solid ${c.accent};
      border-radius:12px;
      padding:12px 14px;
      margin-bottom:8px;
      box-shadow:0 1px 2px rgba(0,0,0,0.03), 0 2px 6px rgba(0,0,0,0.04);
    ">
      ${dayLine}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="
          display:inline-flex;align-items:center;gap:4px;
          background:${c.badge};color:${c.badgeText};
          font-size:10px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;
          padding:3px 7px;border-radius:100px">
          ${DISCIPLINE_ICON[discipline]}
          ${label}
        </span>
        <span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">RPE ${rpe}</span>
        ${tss > 0 ? `<span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">TSS ${Math.round(tss)}</span>` : ''}
      </div>
      <div style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:2px">${escapeHtml(w.n)}</div>
      <div style="font-size:13px;color:var(--c-muted);line-height:1.45">${escapeHtml(w.d)}</div>
      ${brickFootnote}
    </div>
  `;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
