/**
 * HYROX Critical Pace detail page.
 *
 * Opened by tapping the Critical Pace card on the HYROX Stats view. Replaces
 * the old modal explainer: leads with critical pace over time (a real curve
 * derived from VDOT history), follows with the derivation chain that produced
 * today's number, then explains what critical pace is and why it matters.
 *
 * The over-time curve is not stored. It is re-derived from `s.vdotHistory` by
 * mapping each VDOT sample through the same canonical formula the card uses
 * (`gp(vdot, lt).t × cpRatioForVdot(vdot)`), so the latest chart point equals
 * the card's headline by construction. No synthetic data.
 *
 * Back button returns to the HYROX Stats view. Mirrors the chip-detail page
 * scaffold (atmosphere + ring background + sun glint + centred title + body).
 */

import { getState } from '@/state/store';
import type { SimulatorState } from '@/types/state';
import { renderTabBar, wireTabBarHandlers, type TabId } from '@/ui/tab-bar';
import { atmosphereGradient, buildSunGlint, buildRingBackground } from '@/ui/page-flair';
import { deriveHyroxRunPace } from '@/calculations/hyrox-run-pace';
import { cpRatioForVdot } from '@/calculations/hyrox-run-pace';
import { gp } from '@/calculations/paces';
import { buildCpTrendChart, type BenchmarkSample, animateChartDrawOn } from '@/ui/triathlon/benchmark-charts';

// ── Design tokens (mirror forecast-chip-detail-view.ts) ──────────────────────

const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const CARD = 'background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px 20px';

function fmtPace(secPerKm: number): string {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '—';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

function statRow(label: string, value: string, strong = false): string {
  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04)">
      <span style="color:${TEXT_S}">${label}</span>
      <span style="color:${TEXT_M};font-variant-numeric:tabular-nums;${strong ? 'font-weight:600' : ''}">${value}</span>
    </div>`;
}

/** Re-derive a critical-pace-over-time series from VDOT history, anchored on
 *  the current value so the latest point matches the card's headline. */
function buildCpSamples(s: SimulatorState, currentCpSecKm: number | null): BenchmarkSample[] {
  const lt = (s.lt ?? (s as { ltPace?: number | null }).ltPace) ?? null;
  const samples: BenchmarkSample[] = (s.vdotHistory ?? [])
    .filter(h => typeof h.vdot === 'number' && h.vdot >= 25 && h.vdot <= 85 && !!h.date)
    .map(h => ({ date: h.date as string, value: gp(h.vdot, lt).t * cpRatioForVdot(h.vdot) }));

  // Pin the trailing point to today's canonical CP so the chart's headline
  // agrees with the card. Replace a same-day entry rather than duplicate it.
  if (currentCpSecKm != null && Number.isFinite(currentCpSecKm)) {
    const today = new Date().toISOString().slice(0, 10);
    const last = samples[samples.length - 1];
    if (last && last.date === today) last.value = currentCpSecKm;
    else samples.push({ date: today, value: currentCpSecKm });
  }
  return samples;
}

export function renderHyroxCriticalPaceDetail(opts?: { onBack?: () => void }): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const hx = s.hyroxConfig;
  if (!hx) return;

  const result = deriveHyroxRunPace(s);
  const cp = result.components ?? null;

  const cpSecKm = cp ? cp.criticalPaceSecKm : null;
  const samples = buildCpSamples(s, cpSecKm);

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  // ── Body ─────────────────────────────────────────────────────────────────
  const chartCard = `
    <div class="hxcp-fade" style="${CARD};animation-delay:0.10s">
      <div style="font-size:13px;color:${TEXT_S};font-weight:500;margin-bottom:10px">Critical pace over time</div>
      ${buildCpTrendChart(samples)}
      <div style="font-size:11px;color:${TEXT_S};line-height:1.5;margin-top:12px">Derived from your VDOT history. Faster VDOT lowers critical pace, so the line falls as your aerobic fitness rises.</div>
    </div>`;

  const isDoubles = !!cp && cp.formatFactor < 1.0;
  const derivationCard = cp ? `
    <div class="hxcp-fade" style="${CARD};animation-delay:0.16s;margin-top:14px">
      <div style="font-size:13px;color:${TEXT_S};font-weight:500;margin-bottom:4px">How today's number is built</div>
      ${statRow('Threshold pace', `${fmtPace(cp.thresholdSecKm)}`)}
      ${statRow('CP-ratio at your VDOT', cp.cpRatio.toFixed(2))}
      ${statRow('Critical pace', fmtPace(cp.criticalPaceSecKm), true)}
      ${isDoubles ? statRow(`Doubles factor (${cp.formatFactor.toFixed(2)})`, fmtPace(cp.criticalPaceSecKm * cp.formatFactor)) : ''}
      ${cp.personalOffsetSec !== 0 ? statRow('Personal offset from race history', `${cp.personalOffsetSec > 0 ? '+' : ''}${cp.personalOffsetSec}s/km`) : ''}
      ${statRow('HYROX run pace', fmtPace(result.paceSecKm), true)}
    </div>` : '';

  const explainCard = `
    <div class="hxcp-fade" style="${CARD};animation-delay:0.22s;margin-top:14px">
      <div style="font-size:14px;font-weight:600;color:${TEXT_M};margin-bottom:8px">What critical pace is</div>
      <div style="font-size:13px;color:${TEXT_M};line-height:1.6;margin-bottom:14px">Critical pace is the run speed you can sustain across the eight 1km legs of a HYROX. It sits between your 5k pace and threshold pace. The stations between legs act as partial recovery, so trained athletes hold a pace at or slightly faster than continuous threshold.</div>

      <div style="font-size:14px;font-weight:600;color:${TEXT_M};margin-bottom:8px">Why it matters</div>
      <div style="font-size:13px;color:${TEXT_M};line-height:1.6;margin-bottom:14px">It is the single largest controllable factor in your finish time. Running covers 8km of the race. Pace it too hot early and station work falls apart late. The number here is the pace your current fitness supports, which sets every run-leg target in your plan and your projected finish.</div>

      <div style="font-size:12px;color:${TEXT_S};line-height:1.55;padding-top:14px;border-top:1px solid rgba(0,0,0,0.06)"><strong style="color:${TEXT_M}">The science.</strong> Critical pace is the asymptote of the velocity-time relationship (Hill 1923; Monod and Scherrer 1965; Jones et al. 2010). For trained runners it sits between 5k and threshold pace and aligns with maximum lactate steady state within 3 to 5 percent (Galbraith et al. 2014). The HYROX interval structure of 8 × 1km separated by 3 to 7 min of station work matches critical-pace physiology better than a continuous threshold effort.</div>

      <div style="font-size:12px;color:${TEXT_S};line-height:1.55;padding-top:12px"><strong style="color:${TEXT_M}">Why it sharpens over time.</strong> When you log a HYROX race the model compares your observed run pace to its prediction at that format, blends the residual into a personal offset, and biases future predictions toward it. The offset decays over 12 months without fresh evidence, so recent races count most.</div>
    </div>`;

  const headline = cpSecKm != null ? fmtPace(cpSecKm) : '—';

  container.innerHTML = `
    <style>
      @keyframes hxcpFloatUp { from { opacity:0; } to { opacity:1; } }
      .hxcp-fade { opacity:0; animation:hxcpFloatUp 0.55s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="hxcp-view" class="safe-top-bleed" style="
      position:relative;min-height:100vh;background:${atmosphereGradient('sky')};
      font-family:var(--f);overflow-x:hidden;
    ">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxcp', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div class="hxcp-fade" style="animation-delay:0.02s;padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <button id="hxcp-back-btn" style="background:transparent;border:none;font-size:14px;color:${TEXT_S};cursor:pointer;padding:0;font-family:var(--f)">← Back</button>
          <button id="hxcp-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <div class="hxcp-fade" style="animation-delay:0.06s;text-align:center;padding:20px 20px 16px">
          <div style="font-size:11px;color:${TEXT_S};font-weight:500">Critical pace</div>
          <div style="font-size:30px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.1;margin-top:6px">${headline}</div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">Your sustainable HYROX run pace${s.v != null ? ` at VDOT ${s.v.toFixed(0)}` : ''}</div>
        </div>

        <div style="padding:0 16px">
          ${chartCard}
          ${derivationCard}
          ${explainCard}
        </div>

      </div>

      ${renderTabBar('stats')}
    </div>
  `;

  document.getElementById('hxcp-back-btn')?.addEventListener('click', () => {
    if (opts?.onBack) { opts.onBack(); return; }
    import('./stats-view').then(({ renderHyroxStatsView }) => renderHyroxStatsView());
  });
  document.getElementById('hxcp-account-btn')?.addEventListener('click', () => {
    import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
  });

  wireTabBarHandlers(navigateTab);
  animateChartDrawOn();
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('@/ui/home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('@/ui/hyrox/plan-view').then(m => m.renderHyroxPlanView());
  else if (tab === 'stats') import('@/ui/hyrox/stats-view').then(m => m.renderHyroxStatsView());
  else if (tab === 'forecast') import('@/ui/hyrox/forecast-view').then(m => m.renderHyroxForecastView());
  else if (tab === 'account') import('@/ui/account-view').then(m => m.renderAccountView());
}
