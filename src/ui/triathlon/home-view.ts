/**
 * Triathlon home view.
 *
 * Shows today's workouts (stacked discipline cards), a per-discipline CTL
 * summary, and a compact race forecast card.
 */

import { getState } from '@/state/store';
import { renderTriWorkoutCard } from './workout-card';
import { renderTriTabBar } from './tab-bar';
import { renderRaceForecastCard } from './race-forecast-card';
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL } from './colours';
import { readTriFitness } from '@/calculations/fitness-model.triathlon';

export function renderTriathlonHomeView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();

  const week = s.wks?.[s.w - 1];
  const workouts = week?.triWorkouts ?? [];

  // Figure out today's day-of-week 0=Mon..6=Sun
  const jsDay = new Date().getDay();      // 0=Sun..6=Sat
  const today = (jsDay + 6) % 7;          // shift to Mon=0

  const todayList = workouts.filter((w) => w.dayOfWeek === today);
  const nextList = workouts.filter((w) => (w.dayOfWeek ?? -1) > today).slice(0, 3);

  const fitness = readTriFitness(s);

  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);padding:20px 16px 100px">
      <div style="max-width:560px;margin:0 auto">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:20px">
          <div>
            <div style="font-size:12px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${formatToday()}</div>
            <h1 style="font-size:1.5rem;font-weight:400;color:var(--c-black);margin:2px 0 0">Hi ${escapeHtml(s.onboarding?.name || 'there')}</h1>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">Week</div>
            <div style="font-size:20px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${s.w} / ${s.tw}</div>
          </div>
        </div>

        <!-- Today -->
        <div style="margin-bottom:20px">
          <h2 style="font-size:13px;font-weight:500;color:var(--c-muted);letter-spacing:0.08em;text-transform:uppercase;margin:0 0 10px">Today</h2>
          ${todayList.length === 0
            ? `<div style="background:rgba(255,255,255,0.85);border:1px solid rgba(0,0,0,0.05);border-radius:12px;padding:18px;text-align:center;font-size:13px;color:var(--c-muted)">Rest day. Recovery is where adaptation happens.</div>`
            : todayList.map((w) => renderTriWorkoutCard(w)).join('')}
        </div>

        <!-- Fitness -->
        <div style="margin-bottom:20px">
          <h2 style="font-size:13px;font-weight:500;color:var(--c-muted);letter-spacing:0.08em;text-transform:uppercase;margin:0 0 10px">Fitness</h2>
          <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:16px">
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px">
              <div>
                <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">Combined CTL</div>
                <div style="font-size:28px;font-weight:300;color:var(--c-black);font-variant-numeric:tabular-nums">${fitness.combinedCtl.toFixed(1)}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">Fresh</div>
                <div style="font-size:16px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${formatTSB(fitness)}</div>
              </div>
            </div>
            ${(['swim', 'bike', 'run'] as const).map((d) => {
              const f = fitness[d];
              const c = DISCIPLINE_COLOURS[d];
              const maxCtl = Math.max(fitness.swim.ctl, fitness.bike.ctl, fitness.run.ctl, 10);
              const pct = Math.min(100, (f.ctl / maxCtl) * 100);
              return `
                <div style="margin-bottom:8px">
                  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
                    <span style="color:var(--c-black)">${DISCIPLINE_LABEL[d]}</span>
                    <span style="font-variant-numeric:tabular-nums;color:var(--c-muted)">CTL ${f.ctl.toFixed(1)} · ATL ${f.atl.toFixed(1)}</span>
                  </div>
                  <div style="height:4px;background:rgba(0,0,0,0.05);border-radius:2px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:${c.accent};transition:width 0.3s"></div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Race forecast -->
        ${renderRaceForecastCard(s)}

        <!-- Coming up -->
        ${nextList.length > 0 ? `
          <div style="margin-bottom:16px">
            <h2 style="font-size:13px;font-weight:500;color:var(--c-muted);letter-spacing:0.08em;text-transform:uppercase;margin:0 0 10px">Coming up</h2>
            ${nextList.map((w) => renderTriWorkoutCard(w, { showDay: true })).join('')}
          </div>
        ` : ''}

      </div>
    </div>
    ${renderTriTabBar('home')}
  `;
}

function formatToday(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatTSB(fit: ReturnType<typeof readTriFitness>): string {
  const tsb = fit.run.tsb + fit.bike.tsb + fit.swim.tsb;
  const sign = tsb >= 0 ? '+' : '';
  return `${sign}${tsb.toFixed(1)}`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
