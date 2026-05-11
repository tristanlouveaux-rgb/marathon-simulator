/**
 * Triathlon Stats — single scrollable page.
 *
 * Sections (top to bottom):
 *   1. Your Numbers — CSS / FTP / LT / VO2max zone bars
 *   2. Trends — benchmark sparklines (CSS, FTP, LT, VO2max)
 *   3. Progress — range toggle, stat list, phase timeline, CTL + volume charts
 *
 * Race estimates live on the Forecast tab.
 */

import { getState } from '@/state/store';
import { getMutableState, saveState } from '@/state';
import type { SimulatorState } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { getCyclingEventLabel } from '@/calculations/cycling-mode';
import { getTriathlonById } from '@/data/triathlons';
import { buildYourNumbersCard, buildTrendCards } from './fitness-detail-view';
import { buildProgressContent, type ProgressRange } from './progress-detail-view';
import { animateChartDrawOn } from './benchmark-charts';
import { buildRingBackground, atmosphereGradient, buildSunGlint } from '../page-flair';

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('../home-view').then(({ renderHomeView }) => renderHomeView());
  else if (tab === 'plan') import('../main-view').then(({ renderMainView }) => renderMainView());
  else if (tab === 'forecast') import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  else if (tab === 'account') import('../account-view').then(({ renderAccountView }) => renderAccountView());
}

let _activeRange: ProgressRange = '12w';

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
    <div class="mosaic-page" style="background:${atmosphereGradient('sky')};position:relative;min-height:100vh">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('ts', { variant: 'centered', palette: 'sky', pulse: true })}
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
          <div style="font-size:13px;font-weight:500;color:#64748B;margin-top:6px">${escapeHtml(raceName)} — Week ${s.w} of ${s.tw}</div>
        </div>

        <div style="padding:0 20px">

          <!-- Your Numbers: CSS / FTP / LT / VO2max zone bars -->
          <div class="hf" data-delay="0.10">
            ${buildYourNumbersCard(s)}
          </div>

          <!-- Trends: sparklines per benchmark -->
          <div class="hf" data-delay="0.14">
            ${buildTrendCards(s)}
          </div>

          <!-- Progress section -->
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin:18px 0 10px" class="hf" data-delay="0.17">Progress</div>
          <div id="tri-progress-section" class="hf" data-delay="0.18">
            ${buildProgressContent(s, _activeRange)}
          </div>

        </div>
      </div>

      ${renderTabBar('stats')}
    </div>
  `;

  wireTabBarHandlers(navigateTab);
  animateChartDrawOn();
  document.getElementById('tri-account-btn')?.addEventListener('click', () => navigateTab('account'));

  document.getElementById('vo2-info-btn')?.addEventListener('click', () => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:18px;padding:24px;max-width:340px;width:100%;box-shadow:0 24px 48px rgba(0,0,0,0.18)">
        <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:14px">VO2max sources</div>

        <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:4px">Mosaic</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:14px">
          Computed from your training data. Running uses pace-vs-HR regression (Daniels VDOT). Cycling uses the ACSM power formula: <span style="font-variant-numeric:tabular-nums">10.8 × W/kg + 7</span>, derived from your FTP. Cardiac ceiling is your aerobic upper bound (peak HR ÷ resting HR, Uth-Sørensen) — a theoretical ceiling, not current fitness. Cross-training, when shown, is sustained-HR aerobic capacity from non-run, non-bike sport. The headline shows your highest measured value, falling back to cardiac ceiling only when no measured signal exists.
        </div>

        <div style="font-size:13px;font-weight:600;color:var(--c-black);margin-bottom:4px">Watch</div>
        <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:14px">
          Read directly from your device. Garmin and Apple Watch use their own proprietary algorithms — typically HR variability during GPS activities. Updates automatically when your device syncs. May differ from Mosaic; neither is ground truth.
        </div>

        <div style="font-size:12px;color:var(--c-faint);line-height:1.5;padding-top:12px;border-top:1px solid var(--c-border)">
          Running, cycling, and cardiac are shown separately because each measures a different aspect of aerobic fitness. A strong cyclist may score higher in cycling than running — both are real.
        </div>

        <button id="vo2-info-close" style="margin-top:16px;width:100%;padding:12px;border-radius:10px;border:1px solid var(--c-border);background:transparent;font-size:14px;font-weight:500;color:var(--c-black);cursor:pointer;font-family:var(--f)">Close</button>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('vo2-info-close')?.addEventListener('click', close);
  });

  document.getElementById('vo2-src-mosaic')?.addEventListener('click', () => {
    getMutableState().vo2Source = 'mosaic';
    saveState();
    renderTriathlonStatsView();
  });
  document.getElementById('vo2-src-device')?.addEventListener('click', () => {
    const sv = getState();
    if (!(sv.vo2 != null && sv.vo2 > 0)) return;
    getMutableState().vo2Source = 'device';
    saveState();
    renderTriathlonStatsView();
  });

  wireStatsProgressRangeButtons(s);

  // Drill-through from the "Your Numbers" bars. Each bar id (css/ftp/lt/vo2)
  // routes to its own detail page with a matching override card. LT reuses
  // the running-stats page (mode-agnostic); CSS/FTP/VO2max use the
  // tri-specific pages in `benchmark-detail-pages.ts`. The back button is
  // always rebound to return to *this* view, not the running fitness detail
  // page that running's flow uses.
  document.querySelectorAll<HTMLElement>('[data-tri-metric-detail]').forEach(el => {
    const handler = async () => {
      const id = el.dataset.triMetricDetail;
      const root = document.getElementById('app-root');
      if (!root) return;
      const sv = getState();

      if (id === 'lt') {
        const { buildLTMetricPage, wireLTOverrideHandlers, wireInfoButtons } =
          await import('../stats-view');
        root.innerHTML = buildLTMetricPage(sv);
        animateChartDrawOn();
        wireTabBarHandlers(navigateTab);
        wireLTOverrideHandlers(sv);
        wireInfoButtons();
      } else if (id === 'css') {
        const { buildCSSDetailPage, wireCSSDetailHandlers } =
          await import('./benchmark-detail-pages');
        const rerender = () => {
          root.innerHTML = buildCSSDetailPage(getState());
          animateChartDrawOn();
          wireTabBarHandlers(navigateTab);
          wireCSSDetailHandlers(rerender);
          rebindBack();
        };
        rerender();
        return;
      } else if (id === 'ftp') {
        const { buildFTPDetailPage, wireFTPDetailHandlers } =
          await import('./benchmark-detail-pages');
        const rerender = () => {
          root.innerHTML = buildFTPDetailPage(getState());
          animateChartDrawOn();
          wireTabBarHandlers(navigateTab);
          wireFTPDetailHandlers(rerender);
          rebindBack();
        };
        rerender();
        return;
      } else if (id === 'vo2') {
        const { buildVO2DetailPage, wireVO2DetailHandlers } =
          await import('./benchmark-detail-pages');
        const rerender = () => {
          root.innerHTML = buildVO2DetailPage(getState());
          animateChartDrawOn();
          wireTabBarHandlers(navigateTab);
          wireVO2DetailHandlers(rerender);
          rebindBack();
        };
        rerender();
        return;
      } else {
        return;
      }

      rebindBack();
    };

    const rebindBack = () => {
      const back = document.getElementById('stats-metric-back');
      back?.addEventListener('click', () => renderTriathlonStatsView());
    };

    el.addEventListener('click', handler);
    el.addEventListener('touchend', (e) => { e.preventDefault(); handler(); }, { passive: false });
  });
}

function wireStatsProgressRangeButtons(s: SimulatorState): void {
  document.querySelectorAll<HTMLButtonElement>('.tri-progress-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = btn.dataset.range as ProgressRange;
      if (!r || r === _activeRange) return;
      _activeRange = r;
      const section = document.getElementById('tri-progress-section');
      if (section) {
        section.innerHTML = buildProgressContent(s, _activeRange);
        animateChartDrawOn();
        wireStatsProgressRangeButtons(s);
      } else {
        renderTriathlonStatsView();
      }
    });
  });
}
