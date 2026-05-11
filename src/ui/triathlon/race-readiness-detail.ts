/**
 * Race-readiness detail view — per-discipline breakdown opened from the
 * summary card on the forecast page.
 *
 * Per discipline, shows:
 *   - Score + label + bar
 *   - Volume actual vs required ("5 hrs/wk recent vs 9 hrs/wk needed")
 *   - Longest session actual vs required
 *   - Actionable coaching line ("Add one long ride 3+ hours by week 8")
 *   - PB-recency note (run only, when applicable)
 *
 * Sourced from `state.triConfig.prediction.raceReadiness` — populated by
 * `predictTriathlonRace`.
 */

import { getState } from '@/state/store';
import type { DisciplineReadiness } from '@/calculations/specific-endurance-penalty';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { renderTriathlonForecastView } from './forecast-view';
import { buildScrollAtmosphereBackground, buildSunGlint } from '../page-flair';

const TEXT_M = '#374151';
const TEXT_S = '#6B7280';
const TEXT_XS = '#9CA3AF';

function readinessBarColor(tone: 'ok' | 'caution' | 'warn'): string {
  if (tone === 'ok') return 'var(--c-ok, #16A34A)';
  if (tone === 'caution') return 'var(--c-caution, #D97706)';
  return 'var(--c-warn, #DC2626)';
}

function fmtVolume(actual: number, required: number, unit: 'km' | 'hours'): string {
  if (unit === 'km') {
    return `${actual.toFixed(1)} km/wk recent · ${required.toFixed(0)} km/wk target`;
  }
  return `${actual.toFixed(1)} hrs/wk recent · ${required.toFixed(1)} hrs/wk target`;
}

function fmtLongestHours(actualH: number, requiredH: number): string {
  const fmtH = (h: number) => {
    if (h < 1) return `${Math.round(h * 60)} min`;
    const wholeH = Math.floor(h);
    const m = Math.round((h - wholeH) * 60);
    return m === 0 ? `${wholeH}h` : `${wholeH}h ${m}m`;
  };
  return `Longest single session: ${fmtH(actualH)} · target ${fmtH(requiredH)}`;
}

/**
 * Coaching line for the discipline. Plain consultant tone per CLAUDE.md UI
 * Copy rules — no motivational padding, no emoji, direct.
 */
function coachingLine(d: DisciplineReadiness): string {
  const volGap = d.weeklyVolumeRequired - d.weeklyVolumeActual;
  const longGap = d.longestSessionRequiredHours - d.longestSessionActualHours;

  if (d.score >= 90) {
    return 'Volume and peak sessions match the race demand. Maintain current pattern through taper.';
  }
  // Identify the binding constraint.
  const volRatio = d.weeklyVolumeRequired > 0 ? d.weeklyVolumeActual / d.weeklyVolumeRequired : 1;
  const longRatio = d.longestSessionRequiredHours > 0
    ? d.longestSessionActualHours / d.longestSessionRequiredHours
    : 1;

  if (volRatio < longRatio - 0.1) {
    // Weekly volume is the bottleneck
    const unit = d.weeklyVolumeUnit;
    const gap = volGap > 0 ? volGap.toFixed(unit === 'km' ? 0 : 1) : '0';
    return `Build weekly volume by about ${gap} ${unit}/wk to match the race target. Long sessions are closer to where they need to be.`;
  }
  if (longRatio < volRatio - 0.1) {
    // Longest session is the bottleneck
    const targetH = d.longestSessionRequiredHours;
    const targetLabel = targetH < 1 ? `${Math.round(targetH * 60)} min` :
      targetH === Math.floor(targetH) ? `${targetH}h` : `${Math.floor(targetH)}h ${Math.round((targetH - Math.floor(targetH)) * 60)}m`;
    return `Add a longer single session — work toward ${targetLabel}. Weekly volume is closer to target than peak sessions.`;
  }
  // Both low
  return 'Both weekly volume and peak single sessions are below race target. The plan ramps both — by race day this will be in the green.';
}

/**
 * One discipline panel with bar + diagnostic data + coaching line.
 */
function renderDisciplinePanel(d: DisciplineReadiness): string {
  const col = readinessBarColor(d.tone);
  const discTitle = d.discipline === 'swim' ? 'Swim' : d.discipline === 'bike' ? 'Bike' : 'Run';

  // PB/race-recency note (run: from race PBs; bike/swim: from completed triathlons)
  let pbLine = '';
  if (d.pbAgeDays != null) {
    if (d.pbRecencyApplied) {
      const months = Math.round(d.pbAgeDays / 30);
      const src = d.discipline === 'run' ? 'race PB' : 'completed triathlon';
      pbLine = `<div style="font-size:11px;color:${TEXT_S};margin-top:8px">Recent ${src} (${months} months ago) reduces the ${discTitle.toLowerCase()} penalty.</div>`;
    } else if (d.discipline === 'run') {
      const years = Math.round(d.pbAgeDays / 365);
      if (years >= 2) {
        pbLine = `<div style="font-size:11px;color:${TEXT_S};margin-top:8px">Marathon PB is ${years}+ years old — no recency boost. Recent race results would lighten the penalty.</div>`;
      }
    }
  }

  return `
    <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px 20px;margin-bottom:14px">

      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
        <div style="font-size:14px;font-weight:600;color:${TEXT_M}">${discTitle}</div>
        <div style="display:flex;align-items:baseline;gap:8px">
          <div style="font-size:20px;font-weight:600;color:${col}">${d.score}</div>
          <div style="font-size:12px;color:${TEXT_S}">${d.label}</div>
        </div>
      </div>

      <div style="position:relative;height:8px;border-radius:4px;background:rgba(0,0,0,0.07);overflow:hidden;margin-bottom:14px">
        <div style="position:absolute;left:0;top:0;height:100%;width:${d.score}%;background:${col};border-radius:4px"></div>
      </div>

      <div style="font-size:12px;color:${TEXT_M};line-height:1.6;margin-bottom:6px">
        ${fmtVolume(d.weeklyVolumeActual, d.weeklyVolumeRequired, d.weeklyVolumeUnit)}
      </div>
      <div style="font-size:12px;color:${TEXT_M};line-height:1.6">
        ${fmtLongestHours(d.longestSessionActualHours, d.longestSessionRequiredHours)}
      </div>

      <div style="font-size:13px;color:${TEXT_M};margin-top:14px;line-height:1.55">
        ${coachingLine(d)}
      </div>

      ${pbLine}
    </div>
  `;
}

/**
 * Top-level render. Replaces the app-root with the detail view. Back button
 * returns to the forecast page.
 */
export function renderRaceReadinessDetailView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const readiness = s.triConfig?.prediction?.raceReadiness;
  if (!readiness) {
    // No data — bounce back to forecast.
    renderTriathlonForecastView();
    return;
  }

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  container.innerHTML = `
    <style>
      @keyframes floatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .hf { opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>
    <div class="mosaic-page" style="background:#FAF9F6;position:relative;min-height:100vh">
      ${buildScrollAtmosphereBackground('rrd', 'slate', { haloCenter: { cx: 200, cy: 200 } })}
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between" class="hf" data-delay="0.02">
          <button id="rrd-back-btn" style="background:transparent;border:none;font-size:14px;color:var(--c-muted);cursor:pointer;padding:0">← Back</button>
          <button id="rrd-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <div class="hf" data-delay="0.06" style="text-align:center;padding:20px 20px 20px">
          <div style="font-size:28px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1">Race readiness</div>
          <div style="font-size:13px;font-weight:500;color:#64748B;margin-top:6px">Overall ${readiness.overallScore} · ${readiness.overallLabel}</div>
          <div style="font-size:12px;color:${TEXT_XS};margin-top:8px;max-width:440px;margin-left:auto;margin-right:auto;line-height:1.55">
            How well your recent training matches what the race distance demands. The plan ramps each discipline toward its target — by race day, scores climb to the green band.
          </div>
        </div>

        <div style="padding:0 20px" class="hf" data-delay="0.10">
          ${renderDisciplinePanel(readiness.swim)}
          ${renderDisciplinePanel(readiness.bike)}
          ${renderDisciplinePanel(readiness.run)}
        </div>

      </div>

      ${renderTabBar('forecast')}
    </div>
  `;

  document.getElementById('rrd-back-btn')?.addEventListener('click', () => {
    renderTriathlonForecastView();
  });
  document.getElementById('rrd-account-btn')?.addEventListener('click', () => {
    navigateTab('account');
  });

  wireTabBarHandlers(navigateTab);
}

// Lightweight tab nav delegation — same shape as forecast-view's navigateTab.
function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'plan') {
    import('../main-view').then(({ renderMainView }) => renderMainView());
  } else if (tab === 'forecast') {
    renderTriathlonForecastView();
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
  } else if (tab === 'account') {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  }
}
