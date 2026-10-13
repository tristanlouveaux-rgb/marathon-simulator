/**
 * HYROX stats view.
 *
 * Sections:
 *   1. Band + format header
 *   2. Plan timeline. Week / phase / race countdown
 *   3. Population comparison card. Predicted finish time vs global field
 *   4. MTL load card. WeeklyMTL vs cap, MTL ACWR indicator
 *   5. Station benchmarks. Calibrated vs pending
 */

import { getState } from '@/state/store';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { buildRingBackground, atmosphereGradient, buildSunGlint, shouldPlayEntrance } from '../page-flair';
import { HYROX_MTL_CAP } from '@/constants/hyrox-constants';
import { computeWeekActualMTL, computeWeekMTL, hyroxMtlAcwr } from '@/calculations/mtl';
import { STATION_DISPLAY, STATION_SEED_TIMES_SEC, HYROX_STATION_ORDER, SEED_RUN_PACE_SEC_KM } from '@/constants/hyrox-benchmarks';
import type { HyroxStation } from '@/types/triathlon';
import { getFinishTimePercentile, percentileLabel, percentileHeadline, hyroxPopulationCaption, hyroxFormatLabel } from '@/calculations/hyrox-population';
import { predictHyroxRace, type HyroxPrediction } from '@/calculations/race-prediction.hyrox';
import { latestTestAgeMonths, hyroxCalibrationCoverage } from '@/calculations/hyrox-station-history';
import { isHyroxDoublesFormat } from '@/calculations/hyrox-division';
import { deriveHyroxRunPace } from '@/calculations/hyrox-run-pace';
import { renderPlanShapeCard } from '../plan-shape-chart';
import type { SimulatorState } from '@/types/state';
import { ftRounded, fmtModelPaceKm } from '@/utils/format';

function navigateTab(tab: TabId): void {
  if (tab === 'home')     import('../home-view').then(({ renderHomeView }) => renderHomeView());
  else if (tab === 'plan') import('./plan-view').then(({ renderHyroxPlanView }) => renderHyroxPlanView());
  else if (tab === 'forecast') import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
  else if (tab === 'account') import('../account-view').then(({ renderAccountView }) => renderAccountView());
}

export function renderHyroxStatsView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const hx = s.hyroxConfig;
  if (!hx) return;

  // Defensive ?? : athleteBand is typed required, but corrupted/partial state would
  // crash bandLabel's .replace(). Display-only midpoint fallback (ISSUE-282).
  const band = hx.athleteBand ?? 'intermediate';
  const format = hx.format ?? 'open_singles';
  const bandLabel = band.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const mtlCap = hx.mtlCap ?? HYROX_MTL_CAP[band];
  // Derived at render time from the week's completed sessions
  // (computeWeekActualMTL). Same scope as the chronic/acute computation so all
  // four numbers share one source. The stored `hyroxConfig.weeklyActualMTL` is
  // no longer written. See ISSUE-184.
  const currentWk = (s.wks ?? [])[(s.w ?? 1) - 1];
  const weeklyActualMTL = currentWk ? computeWeekActualMTL(currentWk) : 0;
  const weeklyPlannedMTL = currentWk ? computeWeekMTL(currentWk) : (hx.weeklyMTL ?? 0);
  const mtlPct = mtlCap > 0 ? Math.min(1, weeklyActualMTL / mtlCap) : 0;
  // Load ratio and the chronic / acute tiles under it come from one canonical
  // computation (mtl.ts hyroxMtlAcwr), the value Home and Readiness feed the
  // readiness MTL floor. It withholds the ratio until 14 days of plan weeks
  // are complete and values the weeks before the plan at the athlete's own
  // baseline, so a plan-compliant week 2 no longer reads as a spike.
  const mtlLoad = hyroxMtlAcwr(s);
  const mtlCTL = mtlLoad?.chronic ?? 0;
  const mtlATL = mtlLoad?.acute ?? 0;
  const mtlAcwr = mtlLoad?.ratio ?? null;

  const raceDate = hx.raceDate ?? s.onboarding?.customRaceDate;
  const raceDays = raceDate ? daysUntil(raceDate) : null;
  const phase = (s.wks?.[s.w - 1] as any)?.ph as string | undefined;

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  // Population comparison
  const prediction = predictHyroxRace(s);

  // Benchmarks ledger: the forecast's per-station benchmarks and its
  // calibrated count (hyroxBenchmarkLedger), so Stats, Account, the benchmark
  // card and the forecast agree.
  const ledger = hyroxBenchmarkLedger(hx, prediction);
  const predTimeSec = prediction?.totalSec ?? hx.previousHyroxTimeSec;
  const fasterThanPct = predTimeSec != null
    ? getFinishTimePercentile(predTimeSec, hx.format ?? 'open_singles')
    : null;

  // Run-pace derivation chain (for the Critical Pace card). Surfaces the
  // VDOT → threshold → CP → HYROX pace wiring so the user can see how their
  // 1km run pace was computed and what's anchoring it.
  const runPaceResult = deriveHyroxRunPace(s);
  const cpComponents = runPaceResult.components ?? null;

  // Entrance plays on the first Stats visit per session only; revisits render settled.
  const animate = shouldPlayEntrance('hyrox-stats');

  container.innerHTML = `
    <style>
      @keyframes hxStatsFloat {
        from { opacity:0; }
        to   { opacity:1; }
      }
      .hxsf { ${animate ? 'opacity:0; animation:hxStatsFloat 0.55s cubic-bezier(0.2,0.8,0.2,1) forwards;' : 'opacity:1;'} }
    </style>
    <div class="mosaic-page" style="background:${atmosphereGradient('sky')};position:relative;min-height:100vh">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxs', { variant: 'centered', palette: 'sky', pulse: animate, entrance: animate ? 'small' : 'none' })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <!-- Account button -->
        <div class="hxsf" style="padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end">
          <button id="hx-stats-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <!-- Hero -->
        <div class="hxsf" style="text-align:center;padding:20px 20px 20px;animation-delay:0.04s">
          <div style="font-size:32px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1">Stats</div>
          <div style="font-size:13px;font-weight:500;color:#64748B;margin-top:6px">${bandLabel} · ${(format === 'pro_singles' || format === 'pro_doubles') ? 'Pro' : 'Open'} ${(format === 'open_doubles' || format === 'pro_doubles') ? 'Doubles' : 'Singles'}</div>
        </div>

        <!-- Plan timeline -->
        <div class="hxsf" style="padding:20px 20px 0;animation-delay:0.04s">
          <div style="background:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:4px">Plan progress</div>
                <div style="font-size:22px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${(s.w != null && s.tw != null && s.w > s.tw) ? 'Plan complete' : `Week ${s.w ?? '—'}<span style="font-size:14px;color:var(--c-muted);font-weight:400"> of ${s.tw ?? '—'}</span>`}</div>
                ${phase ? `<div style="font-size:12px;color:var(--c-muted);margin-top:2px;text-transform:capitalize">${phase} phase</div>` : ''}
              </div>
              ${raceDays != null ? `
                <div style="text-align:right">
                  <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:4px">Race</div>
                  <div style="font-size:22px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${raceDays > 14 ? Math.floor(raceDays / 7) : raceDays}<span style="font-size:12px;color:var(--c-muted);font-weight:400"> ${raceDays > 14 ? 'wks' : 'days'}</span></div>
                </div>
              ` : ''}
            </div>
            ${s.w && s.tw ? `
              <div style="margin-top:12px;height:4px;background:rgba(0,0,0,0.06);border-radius:2px;overflow:hidden">
                <div style="height:100%;width:${Math.round(((s.w - 1) / s.tw) * 100)}%;background:#0F172A;border-radius:2px;transition:width 0.4s"></div>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Population comparison card -->
        ${fasterThanPct != null ? `
        <div class="hxsf" style="padding:12px 20px 0;animation-delay:0.06s">
          <div style="background:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:12px">Global rank</div>
            <div style="display:flex;align-items:center;gap:16px">
              <div style="flex-shrink:0;width:56px;height:56px;border-radius:50%;background:#f8f7f4;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:700;color:#0F172A;font-variant-numeric:tabular-nums">
                ${fasterThanPct}%
              </div>
              <div>
                <div style="font-size:16px;font-weight:600;color:#0F172A">${percentileHeadline(fasterThanPct)}</div>
                <div style="font-size:12px;color:var(--c-muted);margin-top:2px">${percentileLabel(fasterThanPct)} · ${hyroxFormatLabel(hx.format ?? 'open_singles')}</div>
              </div>
            </div>
            <div style="margin-top:14px;position:relative;height:8px;background:linear-gradient(to right, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.12) 50%, rgba(0,0,0,0.20) 100%);border-radius:4px">
              <div style="position:absolute;top:-3px;left:${fasterThanPct}%;transform:translateX(-50%);width:14px;height:14px;background:#0F172A;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.25)"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px">
              <div style="font-size:10px;color:var(--c-faint)">Slowest</div>
              <div style="font-size:10px;color:var(--c-faint)">Fastest</div>
            </div>
            <div style="font-size:11px;color:var(--c-faint);margin-top:8px">Based on ${prediction != null ? 'predicted finish time' : 'previous time'}. ${hyroxPopulationCaption(hx.format ?? 'open_singles')}</div>
          </div>
        </div>
        ` : ''}

        <!-- MTL load card -->
        <div class="hxsf" style="padding:12px 20px 0;animation-delay:0.14s">
          <div id="hx-stats-mtl-card" style="background:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);cursor:pointer">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:12px">MusculoTendon load this week</div>
            ${weeklyActualMTL === 0 ? `
              <div style="font-size:13px;color:var(--c-faint);padding:4px 0 10px">No station work completed this week.</div>
              <div style="font-size:11px;color:var(--c-faint)">${weeklyPlannedMTL > 0 ? `${Math.round(weeklyPlannedMTL)} planned` : ''}</div>
            ` : `
              <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px">
                <div>
                  <span style="font-size:28px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${Math.round(weeklyActualMTL)}</span>
                  <span style="font-size:13px;color:var(--c-muted);margin-left:4px">/ ${Math.round(mtlCap)} cap</span>
                </div>
                ${weeklyPlannedMTL > 0 ? `<span style="font-size:11px;color:var(--c-faint)">${Math.round(weeklyPlannedMTL)} planned</span>` : ''}
              </div>
              <div style="height:6px;background:rgba(0,0,0,0.06);border-radius:3px;overflow:hidden;margin-bottom:12px">
                <div style="height:100%;width:${Math.round(mtlPct * 100)}%;background:${mtlPct > 0.9 ? '#ef4444' : mtlPct > 0.7 ? '#f59e0b' : '#b8742c'};border-radius:3px;transition:width 0.4s"></div>
              </div>
            `}
            ${mtlAcwr != null ? renderAcwrRow(mtlAcwr) : ''}
            ${mtlCTL > 0 ? `
              <div style="display:flex;gap:16px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,0.05)">
                <div style="flex:1;text-align:center">
                  <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-faint);margin-bottom:2px">Chronic MTL</div>
                  <div style="font-size:16px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${mtlCTL.toFixed(1)}</div>
                </div>
                <div style="flex:1;text-align:center">
                  <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-faint);margin-bottom:2px">Acute MTL</div>
                  <div style="font-size:16px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${mtlATL.toFixed(1)}</div>
                </div>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Training load across the plan (run vs stations ramp + you-are-here) -->
        ${(() => { const h = renderPlanShapeCard(s); return h ? `<div class="hxsf" style="padding:12px 20px 0;animation-delay:0.15s">${h}</div>` : ''; })()}

        <!-- Critical Pace derivation card -->
        ${cpComponents ? (() => {
          // Whole second with the minute carried (fmtModelPaceKm), as the
          // forecast and Critical pace detail show the same paces.
          const fmtPaceLocal = (secKm: number) =>
            (!Number.isFinite(secKm) || secKm <= 0) ? '—' : fmtModelPaceKm(secKm);
          const v = s.v;
          const cpSec = Math.round(cpComponents.criticalPaceSecKm);
          const thresholdSec = Math.round(cpComponents.thresholdSecKm);
          const finalPaceSec = runPaceResult.paceSecKm;
          const cpRatio = cpComponents.cpRatio;
          const formatFactor = cpComponents.formatFactor;
          const personalOffset = cpComponents.personalOffsetSec;
          const isDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
          const offsetLabel = personalOffset === 0
            ? 'no race history yet'
            : `${personalOffset > 0 ? '+' : ''}${personalOffset} s/km from your race history`;
          return `
            <div class="hxsf" style="padding:12px 20px 0;animation-delay:0.16s">
              <div id="hx-stats-cp-card" style="background:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);cursor:pointer">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
                  <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Critical pace</div>
                  <div style="font-size:11px;color:var(--c-muted)">VDOT ${v?.toFixed(0) ?? '—'}</div>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:12px">
                  <div>
                    <span style="font-size:24px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${fmtPaceLocal(cpSec)}</span>
                    <span style="font-size:13px;color:var(--c-muted);margin-left:4px">/km</span>
                  </div>
                  <div style="text-align:right">
                    <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.06em">HYROX pace</div>
                    <div style="font-size:16px;font-weight:500;color:#0F172A;font-variant-numeric:tabular-nums">${fmtPaceLocal(finalPaceSec)}/km</div>
                  </div>
                </div>
                <div style="font-size:12px;color:var(--c-muted);line-height:1.5">
                  Threshold ${fmtPaceLocal(thresholdSec)}/km × <span style="font-weight:600;color:#0F172A">${cpRatio.toFixed(2)}</span> (CP-ratio at your VDOT) = ${fmtPaceLocal(cpSec)}/km critical pace.${isDoubles ? ` Doubles run ratio ${formatFactor.toFixed(2)} → ${fmtPaceLocal(Math.round(cpSec * formatFactor))}.` : ''} ${personalOffset !== 0 ? `Personal offset ${personalOffset > 0 ? '+' : ''}${personalOffset}s/km → final.` : ''}
                </div>
                <div style="font-size:10px;color:var(--c-faint);padding-top:10px;border-top:1px solid rgba(0,0,0,0.05);margin-top:10px">${offsetLabel} · tap for the trend and science</div>
              </div>
            </div>
          `;
        })() : ''}

        <!-- Benchmarks card: run pace + stations -->
        <div class="hxsf" style="padding:12px 20px 0;animation-delay:0.18s">
          <div style="background:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Benchmarks</div>
              <div style="font-size:11px;color:var(--c-muted)">${ledger.calibratedCount} / ${ledger.rows.length} stations calibrated</div>
            </div>
            ${ledger.rows.map(row => renderBenchmarkRow(row, hx.athleteBand, s)).join('')}
            ${renderRunPaceRow(hx.hyroxRunPaceSecKm, hx.athleteBand, hx.hyroxRunPaceSource)}
            ${(format === 'pro_singles' || format === 'pro_doubles') ? `
              <div style="border-top:1px solid rgba(0,0,0,0.05);margin-top:6px;padding:10px 0 0;display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div>
                  <div style="font-size:13px;color:var(--c-black)">Calibrated at Pro weights</div>
                  <div style="font-size:11px;color:var(--c-muted);margin-top:1px;line-height:1.4">Toggle on if your station tests were done at Pro-division weights. Off adds the heavier-weight slowdown on top of your test times. Splits from a logged race follow that race's weights.</div>
                </div>
                <button id="hx-pro-weights-toggle" data-on="${hx.benchmarksAtProWeights ? 'true' : 'false'}" style="flex-shrink:0;padding:7px 12px;border-radius:100px;border:1px solid ${hx.benchmarksAtProWeights ? 'var(--c-black)' : 'rgba(0,0,0,0.18)'};background:${hx.benchmarksAtProWeights ? 'var(--c-black)' : '#fff'};color:${hx.benchmarksAtProWeights ? '#FDFCF7' : 'var(--c-black)'};font-size:12px;cursor:pointer">${hx.benchmarksAtProWeights ? 'On' : 'Off'}</button>
              </div>
            ` : ''}
          </div>
        </div>

      </div>

      ${renderTabBar('stats')}
    </div>
  `;

  wireTabBarHandlers(navigateTab);
  document.getElementById('hx-stats-account-btn')?.addEventListener('click', () => navigateTab('account'));

  document.getElementById('hx-stats-mtl-card')?.addEventListener('click', () => {
    import('../mtl-load-view').then(({ renderMtlLoadView }) => renderMtlLoadView(() => renderHyroxStatsView()));
  });

  // CP card tap → full drill-down page (critical pace over time + the science).
  document.getElementById('hx-stats-cp-card')?.addEventListener('click', () => {
    import('./critical-pace-detail-view').then(({ renderHyroxCriticalPaceDetail }) => renderHyroxCriticalPaceDetail());
  });

  // Pro weights toggle. Flips hyroxConfig.benchmarksAtProWeights. The flag is
  // only consumed by the prediction engine (forecast tab) and this button's own
  // appearance — nothing else on the Stats page reads it — so we restyle the
  // button in place rather than re-rendering the whole page.
  document.getElementById('hx-pro-weights-toggle')?.addEventListener('click', async (e) => {
    const { getMutableState } = await import('@/state/store');
    const { saveState } = await import('@/state/persistence');
    const ms = getMutableState();
    if (!ms.hyroxConfig) return;
    const on = !ms.hyroxConfig.benchmarksAtProWeights;
    ms.hyroxConfig.benchmarksAtProWeights = on;
    saveState();
    const btn = e.currentTarget as HTMLButtonElement;
    btn.setAttribute('data-on', on ? 'true' : 'false');
    btn.style.borderColor = on ? 'var(--c-black)' : 'rgba(0,0,0,0.18)';
    btn.style.background = on ? 'var(--c-black)' : '#fff';
    btn.style.color = on ? '#FDFCF7' : 'var(--c-black)';
    btn.textContent = on ? 'On' : 'Off';
  });
}

function renderAcwrRow(acwr: number): string {
  const zone = acwr > 1.5 ? 'high' : acwr > 1.3 ? 'caution' : 'safe';
  const colour = zone === 'high' ? '#ef4444' : zone === 'caution' ? '#f59e0b' : '#7a845c';
  const label = zone === 'high' ? 'Ease Back' : zone === 'caution' ? 'Manage Load' : 'Safe';
  const note = zone === 'high'
    ? 'Acute load spiked relative to your chronic base. Reduce this week.'
    : zone === 'caution'
    ? 'Mechanical load is elevated. Avoid adding extra eccentric work.'
    : 'Mechanical load is progressing safely.';
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,0.02)">
      <div>
        <div style="font-size:12px;font-weight:600;color:#0F172A">Load ratio</div>
        <div style="font-size:11px;color:var(--c-muted);margin-top:1px">${note}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;margin-left:12px">
        <div style="font-size:16px;font-weight:600;color:${colour};font-variant-numeric:tabular-nums">${acwr.toFixed(2)}</div>
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${colour}">${label}</div>
      </div>
    </div>
  `;
}

function renderRunPaceRow(
  userSecKm: number | undefined,
  band: string,
  source: 'user' | 'derived' | 'seed' | undefined,
): string {
  const seedSecKm = (SEED_RUN_PACE_SEC_KM as Record<string, number>)[band];
  // Run pace (can be fractional): whole second with the minute carried, the
  // forecast's formatter, never "4:60".
  const fmtPace = (s: number) => fmtModelPaceKm(s);

  const hasUser = userSecKm != null;
  const sourceCaption =
    source === 'derived' ? 'Updated from your runs. Beat your last test.' :
    source === 'user'    ? 'Set manually.' :
                           'From splits';
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.04)">
      <div>
        <div style="font-size:13px;font-weight:600;color:#0F172A">1km Run Pace</div>
        <div style="font-size:11px;color:var(--c-muted)">Average across all 8 legs</div>
      </div>
      <div style="text-align:right">
        ${hasUser ? `
          <div style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${fmtPace(userSecKm!)}/km</div>
          <div style="font-size:10px;color:var(--c-muted)">${sourceCaption}</div>
        ` : `
          <div style="font-size:12px;color:var(--c-faint);font-variant-numeric:tabular-nums">${seedSecKm ? `${fmtPace(seedSecKm)}/km` : '—'}</div>
          <div style="font-size:10px;color:var(--c-faint)">Population est.</div>
        `}
      </div>
    </div>
  `;
}

/** One Benchmarks-ledger row (hyroxBenchmarkLedger). */
export interface HyroxBenchmarkLedgerRow {
  station: HyroxStation;
  /** The athlete's benchmark for the station in the target's terms; absent
   *  when the station still uses the population seed. */
  sec?: number;
  /** True when `sec` is a doubles race split (the pair's time) converted to
   *  singles terms for a singles target. */
  convertedFromDoubles: boolean;
}

/**
 * The Stats Benchmarks ledger: one row per testable station and the
 * calibrated count, from hyroxCalibrationCoverage (the forecast's per-station
 * resolver). A station resolved from the other format's slot keeps the
 * forecast's reading of it:
 *  - Singles target, a doubles race split: the pair's time ÷ the forecast's
 *    crossFormatStationRatio, the conversion the forecast applies, so the
 *    pair's time never sits raw next to singles seeds. The forecast line's
 *    teamTimeSplit flag decides which values are race splits.
 *  - Anything else (a solo test from the doubles slot, a singles time for a
 *    doubles target) is already one athlete's time and shows as stored, like
 *    the doubles slot's own solo tests.
 * The ledger shows the benchmark itself, before the forecast's staleness
 * blend, Pro-weight adjustment and venue factors.
 */
export function hyroxBenchmarkLedger(
  hx: NonNullable<SimulatorState['hyroxConfig']>,
  prediction: Pick<HyroxPrediction, 'stations' | 'crossFormatStationRatio'> | null,
): { rows: HyroxBenchmarkLedgerRow[]; calibratedCount: number } {
  const coverage = hyroxCalibrationCoverage(hx);
  const ratio = prediction?.crossFormatStationRatio;
  const rows = coverage.testable.map((station): HyroxBenchmarkLedgerRow => {
    const raw = coverage.benchmarks[station];
    if (raw == null) return { station, convertedFromDoubles: false };
    const line = prediction?.stations.find(l => l.station === station);
    const convert = !isHyroxDoublesFormat(hx.format) && coverage.slotOf[station] === 'doubles'
      && line?.teamTimeSplit === true && ratio != null && ratio > 0;
    return convert
      ? { station, sec: raw / ratio!, convertedFromDoubles: true }
      : { station, sec: raw, convertedFromDoubles: false };
  });
  return { rows, calibratedCount: coverage.calibrated.length };
}

function renderBenchmarkRow(
  row: HyroxBenchmarkLedgerRow,
  band: string,
  state: SimulatorState,
): string {
  const { station, sec: userSec } = row;
  const display = STATION_DISPLAY[station];
  const seedSec = (STATION_SEED_TIMES_SEC as any)[band]?.[station] as number | undefined;
  const hasUser = userSec != null;

  // Station times (doubles and Pro values are fractional): rounded before the
  // minute split, as the station detail page and forecast rows show them.
  const fmtSec = (s: number) => ftRounded(s);

  // Standalone benchmark times are max-effort with rest. Comparing them to the
  // 89k-finisher Kaggle dataset (which captures mid-race fatigued station
  // splits) is apples-to-oranges, so the BENCHMARKS card stays a personal
  // ledger. No population comparison. Race-day prediction percentile lives on
  // the headline finish-time card above, where the comparison is valid.
  let calibratedRightCol = '';
  if (hasUser) {
    const ageMo = latestTestAgeMonths(state, station);
    const label = row.convertedFromDoubles ? 'Converted from doubles race' : 'Calibrated';
    const ageCaption = (ageMo != null && ageMo >= 4)
      ? `${label} · ${Math.round(ageMo)} mo ago`
      : label;
    calibratedRightCol = `
      <div style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums;text-align:right">${fmtSec(userSec!)}</div>
      <div style="font-size:10px;color:var(--c-muted);text-align:right">${ageCaption}</div>
    `;
  }

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.04)">
      <div>
        <div style="font-size:13px;font-weight:600;color:#0F172A">${display.name}</div>
        <div style="font-size:11px;color:var(--c-muted)">${display.distance}</div>
      </div>
      <div style="text-align:right">
        ${hasUser
          ? calibratedRightCol
          : `<div style="font-size:12px;color:var(--c-faint);font-variant-numeric:tabular-nums">${seedSec ? fmtSec(seedSec) : '—'}</div>
             <div style="font-size:10px;color:var(--c-faint)">Population est.</div>`
        }
      </div>
    </div>
  `;
}

function daysUntil(isoDate: string): number {
  const target = new Date(isoDate).getTime();
  const now = new Date().setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((target - now) / 86400000));
}

