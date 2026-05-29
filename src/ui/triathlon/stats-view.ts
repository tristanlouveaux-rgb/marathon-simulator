/**
 * Triathlon Stats. Two compact tap-cards that drill into the full Fitness
 * and Progress detail pages. The Fitness detail (`renderTriFitnessDetailView`)
 * owns Your Numbers + Trend sparklines + Race estimates. The Progress detail
 * (`renderTriProgressDetailView`) owns Recent weeks, the stat list, Phase
 * timeline, CTL chart, and Weekly load TSS charts. Putting all of that on
 * the main page made it too busy.
 */

import { getState } from '@/state/store';
import type { SimulatorState, GarminActual } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { getCyclingEventLabel } from '@/calculations/cycling-mode';
import { getTriathlonById } from '@/data/triathlons';
import { buildRingBackground, atmosphereGradient, buildSunGlint } from '../page-flair';
import { iTrimpToTSS } from './progress-detail-view';

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('../home-view').then(({ renderHomeView }) => renderHomeView());
  else if (tab === 'plan') import('../main-view').then(({ renderMainView }) => renderMainView());
  else if (tab === 'forecast') import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  else if (tab === 'account') import('../account-view').then(({ renderAccountView }) => renderAccountView());
}

// ── Compact summary cards ────────────────────────────────────────────────────

function fmtCssCompact(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${String(s).padStart(2, '0')}/100m`;
}

function fmtLtCompact(secPerKm: number, pref: 'km' | 'mi'): string {
  const sec = pref === 'mi' ? secPerKm * 1.609344 : secPerKm;
  const unit = pref === 'mi' ? '/mi' : '/km';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}${unit}`;
}

const COMPACT_CARD = 'display:block;width:100%;text-align:left;background:rgba(255,255,255,0.78);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.65);border-radius:18px;box-shadow:0 2px 8px rgba(15,23,42,0.05),0 10px 28px rgba(15,23,42,0.05);padding:18px 18px 16px;margin-bottom:12px;cursor:pointer;font-family:var(--f);position:relative;-webkit-tap-highlight-color:transparent';
const CHEVRON_TR = `<svg style="position:absolute;top:18px;right:16px;pointer-events:none" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--c-muted)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;

function buildCompactFitnessCard(s: SimulatorState): string {
  const tri = s.triConfig;
  const unitPref = (s.unitPref ?? 'km') as 'km' | 'mi';
  const css = tri?.swim?.cssSecPer100m;
  const ftp = tri?.bike?.ftp;
  const lt  = s.lt;
  const vo2 = (s.vo2Estimates?.headline?.value ?? s.vo2) ?? null;

  const row = (label: string, value: string | null) => `
    <div style="display:flex;align-items:baseline;justify-content:space-between;padding:6px 0;border-top:1px solid rgba(15,23,42,0.05)">
      <span style="font-size:13px;color:var(--c-muted);font-weight:500">${label}</span>
      <span style="font-size:14px;color:var(--c-black);font-weight:600;font-variant-numeric:tabular-nums">${value ?? '—'}</span>
    </div>`;

  return `
    <button id="tri-stats-fitness-card" style="${COMPACT_CARD}">
      ${CHEVRON_TR}
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:10px">Fitness</div>
      ${row('Swim CSS',  css != null && css > 0 ? fmtCssCompact(css) : null)}
      ${row('Bike FTP',  ftp != null && ftp > 0 ? `${Math.round(ftp)} W` : null)}
      ${row('Run LT',    lt  != null && lt  > 0 ? fmtLtCompact(lt, unitPref) : null)}
      ${row('VO2max',    vo2 != null && vo2 > 0 ? `${Math.round(vo2)}` : null)}
    </button>
  `;
}

function buildCompactProgressCard(s: SimulatorState): string {
  // Aggregates over the last 5 weeks of completed actuals. Cheap walk; same
  // semantics as the Recent weeks card on the Progress detail page.
  const wks = s.wks ?? [];
  const curWeek = Math.max(1, Math.min(wks.length, s.w ?? 1));
  const startIdx = Math.max(0, curWeek - 5);
  let totalSec = 0, sessionCount = 0, totalTSS = 0;
  for (let i = startIdx; i < curWeek; i++) {
    const wk = wks[i];
    if (!wk?.garminActuals) continue;
    const seen = new Set<string>();
    for (const a of Object.values(wk.garminActuals) as GarminActual[]) {
      if (!a) continue;
      if (a.garminId && seen.has(a.garminId)) continue;
      if (a.garminId) seen.add(a.garminId);
      if (typeof a.durationSec === 'number') totalSec += a.durationSec;
      totalTSS += iTrimpToTSS(a.iTrimp);
      sessionCount += 1;
    }
  }
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const timeLabel = totalSec > 0 ? `${hh}h ${String(mm).padStart(2, '0')}m` : '—';

  return `
    <button id="tri-stats-progress-card" style="${COMPACT_CARD}">
      ${CHEVRON_TR}
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:10px">Progress</div>
      <div style="display:flex;align-items:baseline;gap:18px;flex-wrap:wrap">
        <div>
          <div style="font-size:24px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${timeLabel}</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:3px">time active</div>
        </div>
        <div>
          <div style="font-size:24px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${sessionCount}</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:3px">sessions</div>
        </div>
        <div>
          <div style="font-size:24px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${Math.round(totalTSS)}</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:3px">total TSS</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--c-muted);margin-top:12px">Last 5 weeks · tap to see weekly breakdown</div>
    </button>
  `;
}

export function renderTriathlonStatsView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const tri = s.triConfig;
  if (!tri) return;

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  const cyclingLabel = getCyclingEventLabel(s);
  const baseEventLabel = cyclingLabel ?? (tri.distance === 'ironman' ? 'Ironman' : '70.3');
  const raceCity = cyclingLabel ? null : (getTriathlonById(s.onboarding?.selectedTriathlonId ?? '')?.city ?? null);
  const eventLabel = raceCity ? `${raceCity} ${baseEventLabel}` : baseEventLabel;
  const raceName = s.onboarding?.name ? `${s.onboarding.name}'s ${eventLabel}` : `Your ${eventLabel}`;
  const escapeHtml = (str: string) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  container.innerHTML = `
    <style>
      @keyframes floatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .hf { opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>
    <div class="mosaic-page" style="background:${atmosphereGradient('mint')};position:relative;min-height:100vh">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('ts', { variant: 'centered', palette: 'mint', pulse: true })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <!-- Account button -->
        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end;gap:8px" class="hf" data-delay="0.02">
          <button id="tri-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <!-- Hero -->
        <div class="hf" data-delay="0.06" style="text-align:center;padding:20px 20px 20px">
          <div style="font-size:32px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1">Stats</div>
          <div style="font-size:13px;font-weight:500;color:#64748B;margin-top:6px">${escapeHtml(raceName)}. Week ${s.w} of ${s.tw}</div>
        </div>

        <div style="padding:0 20px">

          <!-- Compact Fitness summary. Tap to drill into the full Your Numbers,
               Trend sparklines, and Race estimates page. -->
          <div class="hf" data-delay="0.10">
            ${buildCompactFitnessCard(s)}
          </div>

          <!-- Compact Progress summary. Tap to drill into Recent weeks, Stat
               list, Phase Timeline, CTL chart, and Weekly load TSS chart. -->
          <div class="hf" data-delay="0.14">
            ${buildCompactProgressCard(s)}
          </div>

        </div>
      </div>

      ${renderTabBar('stats')}
    </div>
  `;

  wireTabBarHandlers(navigateTab);
  document.getElementById('tri-account-btn')?.addEventListener('click', () => navigateTab('account'));

  // Drill into Fitness detail (Your Numbers + Trend sparklines + Race estimates).
  document.getElementById('tri-stats-fitness-card')?.addEventListener('click', () => {
    import('./fitness-detail-view').then(({ renderTriFitnessDetailView }) => renderTriFitnessDetailView());
  });

  // Drill into Progress detail (Recent weeks, stat list, Phase Timeline,
  // per-discipline CTL, Weekly load TSS).
  document.getElementById('tri-stats-progress-card')?.addEventListener('click', () => {
    import('./progress-detail-view').then(({ renderTriProgressDetailView }) => renderTriProgressDetailView());
  });
}
