/**
 * Triathlon plan view.
 *
 * Day-grouped card layout. Each day gets a header (Monday, Tuesday, …)
 * followed by stacked discipline cards for that day's sessions.
 *
 * Rendered when `state.eventType === 'triathlon'`. The existing running
 * plan view remains the default for running users.
 */

import { getState } from '@/state/store';
import { renderTriWorkoutCard } from './workout-card';
import { renderTriTabBar } from './tab-bar';
import { DAY_NAMES } from '@/workouts/scheduler.triathlon';

export function renderTriathlonPlanView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();

  const viewWeek = s.w;
  const week = s.wks?.[viewWeek - 1];
  const workouts = week?.triWorkouts ?? [];

  const totalSessions = workouts.length;
  const totalMin = workouts.reduce((acc, w) => acc + (w.brickSegments ? (w.brickSegments[0].durationMin ?? 0) + (w.brickSegments[1].durationMin ?? 0) : parseMinutesFromDesc(w.d)), 0);

  // Group by day (0..6)
  const byDay: Record<number, typeof workouts> = {};
  for (const w of workouts) {
    const d = w.dayOfWeek ?? 4;  // Friday as catch-all
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(w);
  }

  const weekNav = renderWeekNav(s.w, s.tw, week?.ph ?? 'base');

  const daysHtml = Array.from({ length: 7 }, (_, d) => {
    const list = byDay[d] ?? [];
    if (list.length === 0) {
      return `
        <div style="margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <span style="font-size:12px;font-weight:500;color:var(--c-muted);letter-spacing:0.08em;text-transform:uppercase">${DAY_NAMES[d]}</span>
            <span style="flex:1;height:1px;background:rgba(0,0,0,0.06)"></span>
            <span style="font-size:11px;color:var(--c-faint)">Rest</span>
          </div>
        </div>
      `;
    }
    return `
      <div style="margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span style="font-size:12px;font-weight:500;color:var(--c-black);letter-spacing:0.08em;text-transform:uppercase">${DAY_NAMES[d]}</span>
          <span style="flex:1;height:1px;background:rgba(0,0,0,0.06)"></span>
          ${list.length > 1 ? `<span style="font-size:11px;color:var(--c-faint)">${list.length} sessions</span>` : ''}
        </div>
        ${list.map((w) => renderTriWorkoutCard(w)).join('')}
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);padding:20px 16px 100px">
      <div style="max-width:560px;margin:0 auto">
        <h1 style="font-size:1.3rem;font-weight:400;color:var(--c-black);margin:0 0 4px">Plan</h1>
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:12px">Week ${viewWeek} of ${s.tw} — ${phaseLabel(week?.ph)} phase</div>

        ${weekNav}

        <div style="background:rgba(255,255,255,0.85);border-radius:14px;padding:12px 14px;margin-bottom:14px;display:flex;gap:18px">
          <div>
            <div style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;text-transform:uppercase">Sessions</div>
            <div style="font-size:18px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${totalSessions}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;text-transform:uppercase">Weekly hours</div>
            <div style="font-size:18px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${(totalMin / 60).toFixed(1)}h</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--c-faint);letter-spacing:0.08em;text-transform:uppercase">Target distance</div>
            <div style="font-size:18px;font-weight:500;color:var(--c-black)">${s.triConfig?.distance === 'ironman' ? 'Ironman' : '70.3'}</div>
          </div>
        </div>

        ${daysHtml}
      </div>
    </div>
    ${renderTriTabBar('plan')}
  `;
}

function phaseLabel(ph: string | undefined): string {
  if (!ph) return 'Base';
  return ph.charAt(0).toUpperCase() + ph.slice(1);
}

function parseMinutesFromDesc(desc: string): number {
  // Try to pull "Nmin" or "N min" out of the description; fallback to 60.
  const m = desc.match(/(\d+)\s*min/);
  if (m) return Math.min(300, Math.max(10, parseInt(m[1], 10)));
  return 60;
}

function renderWeekNav(currentWeek: number, totalWeeks: number, _phase: string): string {
  return `
    <div style="display:flex;gap:6px;margin-bottom:14px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch">
      ${Array.from({ length: totalWeeks }, (_, i) => {
        const wk = i + 1;
        const active = wk === currentWeek;
        return `
          <div style="
            flex-shrink:0;
            min-width:34px;height:34px;
            display:flex;align-items:center;justify-content:center;
            font-size:12px;font-variant-numeric:tabular-nums;
            border-radius:8px;
            background:${active ? 'var(--c-black)' : 'rgba(255,255,255,0.7)'};
            color:${active ? '#FDFCF7' : 'var(--c-muted)'};
            border:1px solid ${active ? 'var(--c-black)' : 'rgba(0,0,0,0.08)'};
            font-weight:${active ? '500' : '400'};
          ">${wk}</div>
        `;
      }).join('')}
    </div>
  `;
}
