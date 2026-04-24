/**
 * Triathlon stats view — mirrors the running stats visual language.
 *
 * Hosts the race forecast card (moved here from home — §6), a per-
 * discipline fitness SVG chart (§7 — swim/bike/run CTL over the last
 * N weeks), and the per-discipline CTL/ATL/TSB + volume breakdown.
 */

import { getState } from '@/state/store';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { renderRaceForecastCard } from './race-forecast-card';
import { DISCIPLINE_COLOURS, DISCIPLINE_LABEL } from './colours';
import { readTriFitness, perDisciplineACWR } from '@/calculations/fitness-model.triathlon';

function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'plan') {
    import('../plan-view').then(({ renderPlanView }) => renderPlanView());
  } else if (tab === 'record') {
    import('../record-view').then(({ renderRecordView }) => renderRecordView());
  } else if (tab === 'account') {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

export function renderTriathlonStatsView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const tri = s.triConfig;
  if (!tri) return;

  const fitness = readTriFitness(s);
  const history = tri.fitnessHistory ?? [];

  const wk = s.wks?.[s.w - 1];
  const workouts = wk?.triWorkouts ?? [];
  const minByDisc = { swim: 0, bike: 0, run: 0 };
  for (const w of workouts) {
    const d = w.discipline ?? 'run';
    const mins = w.brickSegments
      ? (w.brickSegments[0].durationMin ?? 0) + (w.brickSegments[1].durationMin ?? 0)
      : parseMinutesFromDesc(w.d);
    if (d === 'swim' || d === 'bike' || d === 'run') minByDisc[d] += mins;
  }
  const totalMin = minByDisc.swim + minByDisc.bike + minByDisc.run;

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  container.innerHTML = `
    <style>
      @keyframes floatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .hf { opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .tri-stats-card { background:#fff;border-radius:14px;padding:16px;box-shadow:0 2px 4px rgba(0,0,0,0.04),0 8px 24px rgba(0,0,0,0.05);margin-bottom:14px }
      .tri-stats-label { font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#0F172A;margin-bottom:10px }
    </style>
    <div class="mosaic-page" style="background:#FAF9F6;position:relative;min-height:100vh">
      <div style="position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;pointer-events:none;z-index:0">
        <div style="position:absolute;inset:0;background:linear-gradient(180deg, #C5DFF8 0%, #E3F0FA 15%, #F0F7FC 35%, #F5F8FB 55%, #FAF9F6 80%)"></div>
        <svg style="position:absolute;top:0;left:0;width:100%;height:600px" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="tsBlur"><feGaussianBlur stdDeviation="20"/></filter>
            <filter id="tsSoft"><feGaussianBlur stdDeviation="6"/></filter>
          </defs>
          <ellipse cx="200" cy="100" rx="100" ry="70" fill="rgba(255,255,255,0.5)" filter="url(#tsSoft)" opacity="0.6"/>
          <path d="M-40,280 Q60,240 150,265 T320,245 T440,270 L440,600 L-40,600 Z" fill="rgba(255,255,255,0.25)" filter="url(#tsSoft)"/>
        </svg>
      </div>

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <!-- Header -->
        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end;gap:8px" class="hf" data-delay="0.02">
          <button id="tri-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <!-- Hero -->
        <div class="hf" data-delay="0.06" style="text-align:center;padding:20px 20px 20px">
          <div style="font-size:32px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1">Stats</div>
          <div style="font-size:13px;font-weight:500;color:#64748B;margin-top:6px">${tri.distance === 'ironman' ? 'Ironman' : '70.3'} — Week ${s.w} of ${s.tw}</div>
        </div>

        <div style="padding:0 20px">

          <!-- Race forecast (moved here from home — §6) -->
          <div class="hf" data-delay="0.10">
            ${renderRaceForecastCard(s)}
          </div>

          <!-- Per-discipline fitness chart -->
          <div class="tri-stats-card hf" data-delay="0.14">
            <div class="tri-stats-label">Fitness history</div>
            ${renderFitnessChart(history)}
            <div style="margin-top:10px;display:flex;justify-content:center;gap:18px;font-size:11px">
              ${(['swim', 'bike', 'run'] as const).map((d) => {
                const c = DISCIPLINE_COLOURS[d];
                return `<span style="display:inline-flex;align-items:center;gap:5px"><span style="display:inline-block;width:10px;height:2px;background:${c.accent}"></span>${DISCIPLINE_LABEL[d]}</span>`;
              }).join('')}
            </div>
          </div>

          <!-- Per-discipline CTL/ATL/TSB snapshot -->
          <div class="tri-stats-card hf" data-delay="0.18">
            <div class="tri-stats-label">Current fitness</div>
            ${(['swim', 'bike', 'run'] as const).map((d) => {
              const f = fitness[d];
              const c = DISCIPLINE_COLOURS[d];
              const acwr = perDisciplineACWR(f);
              const acwrLabel = acwr !== undefined ? `ACWR ${acwr.toFixed(2)}` : 'ACWR —';
              const acwrColour = acwr === undefined ? 'var(--c-faint)'
                : acwr > 1.3 ? '#c06a50'
                : acwr < 0.8 ? '#a89060'
                : '#7a845c';
              return `
                <div style="margin-bottom:14px;padding:12px;border-radius:10px;background:${c.bg};border:1px solid ${c.border}">
                  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
                    <span style="font-size:13px;font-weight:600;color:#0F172A">${DISCIPLINE_LABEL[d]}</span>
                    <span style="font-size:11px;color:${acwrColour};font-variant-numeric:tabular-nums">${acwrLabel}</span>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                    ${statCell('CTL', f.ctl.toFixed(1))}
                    ${statCell('ATL', f.atl.toFixed(1))}
                    ${statCell('TSB', `${f.tsb >= 0 ? '+' : ''}${f.tsb.toFixed(1)}`, f.tsb < 0 ? '#c06a50' : '#0F172A')}
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          <!-- This week volume -->
          <div class="tri-stats-card hf" data-delay="0.22">
            <div class="tri-stats-label">This week's volume</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:8px">
              ${(['swim', 'bike', 'run'] as const).map((d) => {
                const c = DISCIPLINE_COLOURS[d];
                const mins = minByDisc[d];
                const pct = totalMin > 0 ? Math.round((mins / totalMin) * 100) : 0;
                return `
                  <div style="text-align:center;padding:10px 8px;background:${c.bg};border:1px solid ${c.border};border-radius:10px">
                    <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${DISCIPLINE_LABEL[d]}</div>
                    <div style="font-size:18px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${fmtHours(mins)}</div>
                    <div style="font-size:11px;color:var(--c-muted)">${pct}%</div>
                  </div>
                `;
              }).join('')}
            </div>
            <div style="text-align:center;font-size:12px;color:var(--c-muted)">Total ${fmtHours(totalMin)}</div>
          </div>

          <!-- Targets -->
          <div class="tri-stats-card hf" data-delay="0.26">
            <div class="tri-stats-label">Your targets</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
              ${targetCell('CSS', tri.swim?.cssSecPer100m ? fmtCss(tri.swim.cssSecPer100m) : '—')}
              ${targetCell('FTP', tri.bike?.ftp ? `${tri.bike.ftp}W` : '—')}
              ${targetCell('Hours/week', tri.timeAvailableHoursPerWeek ? `${tri.timeAvailableHoursPerWeek}h` : '—')}
              ${targetCell('Split', `S ${pct(tri.volumeSplit?.swim)} · B ${pct(tri.volumeSplit?.bike)} · R ${pct(tri.volumeSplit?.run)}`)}
            </div>
          </div>

        </div>
      </div>

      ${renderTabBar('stats')}
    </div>
  `;

  wireTabBarHandlers(navigateTab);
  document.getElementById('tri-account-btn')?.addEventListener('click', () => navigateTab('account'));
}

// ─── Chart ──────────────────────────────────────────────────────────────────

function renderFitnessChart(history: Array<{ weekISO: string; swimCtl: number; bikeCtl: number; runCtl: number; combinedCtl: number }>): string {
  if (history.length < 2) {
    return `
      <div style="height:140px;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--c-muted);font-size:12px;background:rgba(0,0,0,0.02);border-radius:8px;padding:0 20px">
        Fills in once you have 2+ weeks of activity data.<br>Sync your Strava / Garmin to start building history.
      </div>
    `;
  }

  const W = 560;
  const H = 140;
  const pad = { top: 10, right: 8, bottom: 20, left: 32 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const n = history.length;
  const maxY = Math.max(
    10,
    ...history.map((h) => Math.max(h.swimCtl, h.bikeCtl, h.runCtl))
  );

  const x = (i: number) => pad.left + (plotW * i) / Math.max(1, n - 1);
  const y = (v: number) => pad.top + plotH - (v / maxY) * plotH;

  const lineFor = (key: 'swimCtl' | 'bikeCtl' | 'runCtl') =>
    history.map((h, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(h[key]).toFixed(1)}`).join(' ');

  const gridLines = [0.25, 0.5, 0.75].map((f) => {
    const gy = pad.top + plotH * (1 - f);
    return `<line x1="${pad.left}" y1="${gy}" x2="${W - pad.right}" y2="${gy}" stroke="rgba(0,0,0,0.06)" stroke-width="1"/>`;
  }).join('');

  const yLabels = [0, 0.5, 1].map((f) => {
    const v = Math.round(maxY * f);
    const gy = pad.top + plotH * (1 - f);
    return `<text x="${pad.left - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="var(--c-faint)" font-variant-numeric="tabular-nums">${v}</text>`;
  }).join('');

  const xLabels = history.map((h, i) => {
    if (i !== 0 && i !== n - 1 && i !== Math.floor(n / 2)) return '';
    const d = new Date(h.weekISO);
    const label = `${d.getDate()}/${d.getMonth() + 1}`;
    return `<text x="${x(i)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="var(--c-faint)">${label}</text>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" style="display:block">
      ${gridLines}
      ${yLabels}
      ${xLabels}
      <path d="${lineFor('swimCtl')}" fill="none" stroke="${DISCIPLINE_COLOURS.swim.accent}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <path d="${lineFor('bikeCtl')}" fill="none" stroke="${DISCIPLINE_COLOURS.bike.accent}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <path d="${lineFor('runCtl')}" fill="none" stroke="${DISCIPLINE_COLOURS.run.accent}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>
  `;
}

// ─── Cell helpers ───────────────────────────────────────────────────────────

function statCell(label: string, value: string, colour: string = '#0F172A'): string {
  return `
    <div>
      <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${label}</div>
      <div style="font-size:16px;font-weight:500;color:${colour};font-variant-numeric:tabular-nums">${value}</div>
    </div>
  `;
}

function targetCell(label: string, value: string): string {
  return `
    <div>
      <div style="color:var(--c-faint);font-size:11px;text-transform:uppercase;letter-spacing:0.08em">${label}</div>
      <div style="color:#0F172A;font-variant-numeric:tabular-nums">${value}</div>
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

function fmtHours(mins: number): string {
  if (mins <= 0) return '—';
  const rounded = mins >= 30 ? Math.round(mins / 5) * 5 : Math.round(mins);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function parseMinutesFromDesc(desc: string): number {
  const m = desc.match(/(\d+)\s*min/);
  if (m) return Math.min(300, Math.max(10, parseInt(m[1], 10)));
  return 60;
}
