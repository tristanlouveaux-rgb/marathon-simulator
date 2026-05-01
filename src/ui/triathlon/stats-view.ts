/**
 * Triathlon stats view — race forecast + adaptation + per-discipline CTL trend.
 *
 * Earlier iterations layered readiness, recovery, benchmarks and a Training
 * Load shortcut card here. Those were nav-only or duplicated content from
 * Home / Load / Account, so the page now keeps just the three things that
 * belong on Stats: race forecast, adaptation response, and progress trend.
 */

import { getState } from '@/state/store';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { renderRaceForecastCard } from './race-forecast-card';
import { renderTriAdaptationCard } from './adaptation-card';
import { DISCIPLINE_COLOURS } from './colours';

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

  const history = tri.fitnessHistory ?? [];

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

          ${renderRaceOutcomeRetroCard(s)}

          <!-- Race forecast -->
          <div class="hf" data-delay="0.10">
            ${renderRaceForecastCard(s)}
          </div>

          <!-- Adaptation: how the athlete is responding to training -->
          ${renderTriAdaptationCard(s)}

          <!-- Progress: per-discipline CTL trend; tap to drill down. Hidden until
               2+ weeks of history exist (UX_PATTERNS empty-state rule). -->
          ${history.length >= 2 ? `
            <div id="tri-progress-card" class="tri-stats-card hf" data-delay="0.13" style="cursor:pointer">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
                <div class="tri-stats-label" style="margin-bottom:0">Progress</div>
                <span style="font-size:11px;color:var(--c-muted)">Detail →</span>
              </div>
              ${renderFitnessChart(history)}
              <div style="display:flex;gap:14px;margin-top:8px;font-size:10px;color:var(--c-faint);font-variant-numeric:tabular-nums">
                <span><span style="display:inline-block;width:8px;height:2px;background:${DISCIPLINE_COLOURS.swim.accent};vertical-align:middle;margin-right:4px"></span>Swim</span>
                <span><span style="display:inline-block;width:8px;height:2px;background:${DISCIPLINE_COLOURS.bike.accent};vertical-align:middle;margin-right:4px"></span>Bike</span>
                <span><span style="display:inline-block;width:8px;height:2px;background:${DISCIPLINE_COLOURS.run.accent};vertical-align:middle;margin-right:4px"></span>Run</span>
              </div>
            </div>
          ` : ''}

        </div>
      </div>

      ${renderTabBar('stats')}
    </div>
  `;

  wireTabBarHandlers(navigateTab);
  document.getElementById('tri-account-btn')?.addEventListener('click', () => navigateTab('account'));
  document.getElementById('tri-progress-card')?.addEventListener('click', () => {
    import('./progress-detail-view').then(({ renderTriProgressDetailView }) => renderTriProgressDetailView());
  });
  document.getElementById('tri-bike-setup-btn')?.addEventListener('click', () => {
    import('./bike-setup-view').then(({ openBikeSetupOverlay }) => openBikeSetupOverlay());
  });
}

// ─── Chart ──────────────────────────────────────────────────────────────────

function renderFitnessChart(history: Array<{ weekISO: string; swimCtl: number; bikeCtl: number; runCtl: number; combinedCtl: number }>): string {
  const W = 560;
  const H = 140;
  const pad = { top: 10, right: 8, bottom: 20, left: 32 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const n = history.length;
  // Internal CTL is a weekly EMA of TSS. Display as TrainingPeaks-style
  // daily-equivalent (÷7) so the y-axis matches the "Current fitness" card.
  const norm = (v: number) => v / 7;
  const maxY = Math.max(
    10,
    ...history.map((h) => Math.max(norm(h.swimCtl), norm(h.bikeCtl), norm(h.runCtl)))
  );

  const x = (i: number) => pad.left + (plotW * i) / Math.max(1, n - 1);
  const y = (v: number) => pad.top + plotH - (v / maxY) * plotH;

  const lineFor = (key: 'swimCtl' | 'bikeCtl' | 'runCtl') =>
    history.map((h, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(norm(h[key])).toFixed(1)}`).join(' ');

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

// ─── Race-outcome retrospective ───────────────────────────────────────────

function renderRaceOutcomeRetroCard(state: ReturnType<typeof getState>): string {
  const log = state.triConfig?.raceLog;
  if (!log || log.length === 0) return '';
  const latest = log[log.length - 1];
  const gap = latest.predictedTotalSec - latest.actualTotalSec;
  if (gap < 60) return '';  // Below 1-minute threshold

  const fmt = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const ss = Math.round(sec % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
  };
  const gapMin = Math.floor(gap / 60);
  const gapTxt = gapMin === 1 ? '1 min' : `${gapMin} min`;

  return `
    <div class="hf" data-delay="0.08" style="margin-bottom:14px;background:#E8F2E5;border:1px solid #B8D6AE;border-radius:14px;padding:16px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#5a8050;margin-bottom:6px">Last race</div>
      <div style="font-size:15px;font-weight:600;color:#0F172A;margin-bottom:4px">You beat your prediction by ${gapTxt}</div>
      <div style="font-size:12px;color:#64748B;line-height:1.5">Predicted ${fmt(latest.predictedTotalSec)}, actual ${fmt(latest.actualTotalSec)}.</div>
    </div>
  `;
}
