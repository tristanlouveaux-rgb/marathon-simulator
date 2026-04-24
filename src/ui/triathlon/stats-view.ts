/**
 * Triathlon stats view.
 *
 * MVP: per-discipline CTL/ATL/TSB panel + weekly volume breakdown +
 * full race forecast. Per-discipline fitness chart (time-series) is
 * stubbed with a simple progress bar per discipline; a proper SVG chart
 * will follow once we have activity-backed history data.
 */

import { getState } from '@/state/store';
import { renderTriTabBar } from './tab-bar';
import { renderRaceForecastCard } from './race-forecast-card';
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL } from './colours';
import { readTriFitness, perDisciplineACWR } from '@/calculations/fitness-model.triathlon';

export function renderTriathlonStatsView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const tri = s.triConfig;
  const fitness = readTriFitness(s);

  // Weekly volume summary — planned this week
  const week = s.wks?.[s.w - 1];
  const workouts = week?.triWorkouts ?? [];
  const minutesByDiscipline = { swim: 0, bike: 0, run: 0 };
  for (const w of workouts) {
    const d = w.discipline ?? 'run';
    const mins = w.brickSegments
      ? (w.brickSegments[0].durationMin ?? 0) + (w.brickSegments[1].durationMin ?? 0)
      : parseMinutesFromDesc(w.d);
    if (d === 'swim' || d === 'bike' || d === 'run') minutesByDiscipline[d] += mins;
  }
  const totalMin = minutesByDiscipline.swim + minutesByDiscipline.bike + minutesByDiscipline.run;

  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);padding:20px 16px 100px">
      <div style="max-width:560px;margin:0 auto">
        <h1 style="font-size:1.3rem;font-weight:400;color:var(--c-black);margin:0 0 4px">Stats</h1>
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:18px">${tri?.distance === 'ironman' ? 'Ironman' : '70.3'} — week ${s.w} of ${s.tw}</div>

        <!-- Fitness breakdown -->
        <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px;margin-bottom:18px">
          <div style="font-size:12px;color:var(--c-muted);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:14px">Per-discipline fitness</div>
          ${(['swim', 'bike', 'run'] as const).map((d) => {
            const f = fitness[d];
            const c = DISCIPLINE_COLOURS[d];
            const acwr = perDisciplineACWR(f);
            const acwrLabel = acwr !== undefined ? `ACWR ${acwr.toFixed(2)}` : 'ACWR —';
            const acwrStatus = acwr === undefined ? 'muted' : acwr > 1.3 ? 'high' : acwr < 0.8 ? 'low' : 'safe';
            const acwrColour = acwrStatus === 'high' ? '#c06a50' : acwrStatus === 'low' ? '#a89060' : acwrStatus === 'safe' ? '#7a845c' : 'var(--c-faint)';
            return `
              <div style="margin-bottom:18px;padding:12px;border-radius:10px;background:${c.bg};border:1px solid ${c.border}">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
                  <span style="font-size:14px;font-weight:500;color:var(--c-black)">${DISCIPLINE_LABEL[d]}</span>
                  <span style="font-size:11px;color:${acwrColour};font-variant-numeric:tabular-nums">${acwrLabel}</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                  <div>
                    <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">CTL</div>
                    <div style="font-size:18px;font-weight:400;color:var(--c-black);font-variant-numeric:tabular-nums">${f.ctl.toFixed(1)}</div>
                  </div>
                  <div>
                    <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">ATL</div>
                    <div style="font-size:18px;font-weight:400;color:var(--c-black);font-variant-numeric:tabular-nums">${f.atl.toFixed(1)}</div>
                  </div>
                  <div>
                    <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">TSB</div>
                    <div style="font-size:18px;font-weight:400;color:${f.tsb >= 0 ? 'var(--c-black)' : '#c06a50'};font-variant-numeric:tabular-nums">${f.tsb >= 0 ? '+' : ''}${f.tsb.toFixed(1)}</div>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Weekly volume -->
        <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px;margin-bottom:18px">
          <div style="font-size:12px;color:var(--c-muted);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:14px">This week's volume</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
            ${(['swim', 'bike', 'run'] as const).map((d) => {
              const c = DISCIPLINE_COLOURS[d];
              const mins = minutesByDiscipline[d];
              const pct = totalMin > 0 ? Math.round((mins / totalMin) * 100) : 0;
              return `
                <div style="text-align:center;padding:10px 8px;background:${c.bg};border:1px solid ${c.border};border-radius:10px">
                  <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${DISCIPLINE_LABEL[d]}</div>
                  <div style="font-size:18px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${(mins / 60).toFixed(1)}h</div>
                  <div style="font-size:11px;color:var(--c-muted)">${pct}%</div>
                </div>
              `;
            }).join('')}
          </div>
          <div style="text-align:center;font-size:12px;color:var(--c-muted)">Total ${(totalMin / 60).toFixed(1)}h</div>
        </div>

        <!-- Race forecast -->
        ${renderRaceForecastCard(s)}

        <!-- Targets -->
        ${renderTargets(s)}
      </div>
    </div>
    ${renderTriTabBar('stats')}
  `;
}

function renderTargets(s: ReturnType<typeof getState>): string {
  const tri = s.triConfig;
  if (!tri) return '';
  return `
    <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px;margin-bottom:18px">
      <div style="font-size:12px;color:var(--c-muted);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:12px">Your targets</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
        <div>
          <div style="color:var(--c-faint);font-size:11px;text-transform:uppercase;letter-spacing:0.08em">CSS</div>
          <div style="color:var(--c-black);font-variant-numeric:tabular-nums">${tri.swim?.cssSecPer100m ? fmtCss(tri.swim.cssSecPer100m) : '—'}</div>
        </div>
        <div>
          <div style="color:var(--c-faint);font-size:11px;text-transform:uppercase;letter-spacing:0.08em">FTP</div>
          <div style="color:var(--c-black);font-variant-numeric:tabular-nums">${tri.bike?.ftp ? `${tri.bike.ftp}W` : '—'}</div>
        </div>
        <div>
          <div style="color:var(--c-faint);font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Time available</div>
          <div style="color:var(--c-black);font-variant-numeric:tabular-nums">${tri.timeAvailableHoursPerWeek ?? '—'}h/week</div>
        </div>
        <div>
          <div style="color:var(--c-faint);font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Split</div>
          <div style="color:var(--c-black);font-size:12px">S ${pct(tri.volumeSplit?.swim)} / B ${pct(tri.volumeSplit?.bike)} / R ${pct(tri.volumeSplit?.run)}</div>
        </div>
      </div>
      <div style="margin-top:12px;font-size:11px;color:var(--c-faint)">Edit targets from onboarding (relaunch wizard → triathlon-setup).</div>
    </div>
  `;
}

function pct(n: number | undefined): string {
  if (n === undefined) return '—';
  return `${Math.round(n * 100)}%`;
}

function fmtCss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}/100m`;
}

function parseMinutesFromDesc(desc: string): number {
  const m = desc.match(/(\d+)\s*min/);
  if (m) return Math.min(300, Math.max(10, parseInt(m[1], 10)));
  return 60;
}
