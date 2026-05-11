/**
 * Triathlon Forecast tab — standalone full-page destination for the race
 * prediction. Shows the race forecast card and (if applicable) the last-race
 * retro card. Content was previously embedded inline in stats-view.ts.
 */

import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { renderRaceForecastCard, renderCyclingFinishCard } from './race-forecast-card';
import { renderRaceReadinessCard } from './race-readiness-card';
import { getCyclingEventLabel, isCyclingOnlyMode } from '@/calculations/cycling-mode';
import { buildRingBackground, atmosphereGradient, buildSunGlint } from '../page-flair';
import { getCyclingEventById } from '@/data/cycling-events';
import { getTriathlonById } from '@/data/triathlons';

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'plan') {
    import('../main-view').then(({ renderMainView }) => renderMainView());
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
  } else if (tab === 'account') {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

function renderCalibrationCaption(tri: NonNullable<ReturnType<typeof getState>['triConfig']>): string {
  const tier = tri.calibration?.tier ?? 0;
  if (tier < 1) return '';
  const n = tri.calibration!.basedOnRaceCount;
  return `<div style="font-size:11px;color:var(--c-muted);text-align:center;margin-top:-8px;margin-bottom:4px;padding:0 20px">
    Predictions calibrated from your last ${n} race${n === 1 ? '' : 's'}.
  </div>`;
}

function renderRaceOutcomeRetroCard(s: ReturnType<typeof getState>): string {
  const log = s.triConfig?.raceLog;
  if (!log || log.length === 0) return '';
  const latest = log[log.length - 1];
  const gap = latest.predictedTotalSec - latest.actualTotalSec;
  if (gap < 60) return '';

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

export function renderTriathlonForecastView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const tri = s.triConfig;
  if (!tri) return;

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');
  const eventLabel = getCyclingEventLabel(s) ?? (tri.distance === 'ironman' ? 'Ironman' : '70.3');
  const raceCity = getTriathlonById(s.onboarding?.selectedTriathlonId ?? '')?.city ?? null;
  const eventWithCity = raceCity ? `${raceCity} ${eventLabel}` : eventLabel;
  const raceName = s.onboarding?.name ? `${s.onboarding.name}'s ${eventWithCity}` : `Your ${eventWithCity}`;

  container.innerHTML = `
    <style>
      @keyframes floatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .hf { opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>
    <div class="mosaic-page" style="background:${atmosphereGradient('sky')};position:relative;min-height:100vh">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('tf', { variant: 'sweep', palette: 'sky', pulse: true })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end;gap:8px" class="hf" data-delay="0.02">
          <button id="tri-fc-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <div class="hf" data-delay="0.06" style="text-align:center;padding:20px 20px 12px">
          <div style="font-size:32px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1">Forecast</div>
          <div style="font-size:13px;font-weight:500;color:#64748B;margin-top:6px">${escapeHtml(raceName)} — Week ${s.w} of ${s.tw}</div>
        </div>
        ${renderCalibrationCaption(tri)}

        <div style="padding:0 20px">
          ${renderRaceOutcomeRetroCard(s)}
          <div class="hf" data-delay="0.08">
            ${isCyclingOnlyMode(s) ? '' : renderRaceReadinessCard(s)}
          </div>
          <div class="hf" data-delay="0.10">
            ${isCyclingOnlyMode(s) ? renderCyclingFinishCard(s) : renderRaceForecastCard(s)}
          </div>
        </div>
      </div>

      ${renderTabBar('forecast')}
    </div>
  `;

  wireTabBarHandlers(navigateTab);
  document.getElementById('tri-fc-account-btn')?.addEventListener('click', () => navigateTab('account'));
  document.getElementById('race-readiness-detail-trigger')?.addEventListener('click', () => {
    import('./race-readiness-detail').then(({ renderRaceReadinessDetailView }) => {
      renderRaceReadinessDetailView();
    });
  });
  document.getElementById('tri-bike-setup-btn')?.addEventListener('click', () => {
    import('./bike-setup-view').then(({ openBikeSetupOverlay }) => openBikeSetupOverlay());
  });
  document.getElementById('tri-fc-transitions-btn')?.addEventListener('click', async () => {
    const [{ openTransitionsOverlay }, { predictTriathlonRace }] = await Promise.all([
      import('./transitions-overlay'),
      import('@/calculations/race-prediction.triathlon'),
    ]);
    const sv = getState();
    const live = sv.triConfig?.prediction ?? predictTriathlonRace(sv);
    openTransitionsOverlay(live, () => renderTriathlonForecastView());
  });

  // Cycling course inputs (cycling-only mode). Each writes through to onboarding,
  // saves, and re-renders so the predictor recomputes immediately.
  const cycEvent = document.getElementById('cyc-event') as HTMLSelectElement | null;
  cycEvent?.addEventListener('change', () => {
    const ms = getMutableState();
    if (!ms.onboarding) return;
    const id = cycEvent.value || undefined;
    ms.onboarding.cyclingEventId = id;
    // When picking a known event, clear manual climate/altitude so event values flow through.
    if (id) {
      const ev = getCyclingEventById(id);
      if (ev) {
        ms.onboarding.cyclingClimate = undefined;
        ms.onboarding.cyclingAltitudeM = undefined;
      }
    }
    saveState();
    renderTriathlonForecastView();
  });

  const cycClimate = document.getElementById('cyc-climate') as HTMLSelectElement | null;
  cycClimate?.addEventListener('change', () => {
    const ms = getMutableState();
    if (!ms.onboarding) return;
    const v = cycClimate.value;
    ms.onboarding.cyclingClimate = v ? (v as 'cool' | 'temperate' | 'warm' | 'hot' | 'hot-humid') : undefined;
    saveState();
    renderTriathlonForecastView();
  });

  const cycAltitude = document.getElementById('cyc-altitude') as HTMLInputElement | null;
  cycAltitude?.addEventListener('change', () => {
    const ms = getMutableState();
    if (!ms.onboarding) return;
    const n = Number(cycAltitude.value);
    ms.onboarding.cyclingAltitudeM = Number.isFinite(n) && n > 0 ? n : undefined;
    saveState();
    renderTriathlonForecastView();
  });

}
