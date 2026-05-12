/**
 * HYROX stats view.
 *
 * Sections:
 *   1. Band + format header
 *   2. Plan timeline — week / phase / race countdown
 *   3. Population comparison card — predicted finish time vs global field
 *   4. MTL load card — weeklyMTL vs cap, MTL ACWR indicator
 *   5. Station benchmarks — calibrated vs pending
 */

import { getState } from '@/state/store';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { buildRingBackground, atmosphereGradient, buildSunGlint } from '../page-flair';
import { HYROX_MTL_CAP } from '@/constants/hyrox-constants';
import { computeWeekActualMTL, computeWeekMTL } from '@/calculations/mtl';
import { STATION_DISPLAY, STATION_SEED_TIMES_SEC, HYROX_STATION_ORDER, SEED_RUN_PACE_SEC_KM } from '@/constants/hyrox-benchmarks';
import type { HyroxStation } from '@/types/triathlon';
import { getFinishTimePercentile, percentileLabel, percentileHeadline } from '@/calculations/hyrox-population';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { latestTestAgeMonths } from '@/calculations/hyrox-station-history';
import { deriveHyroxRunPace } from '@/calculations/hyrox-run-pace';
import type { SimulatorState } from '@/types/state';

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

  const band = hx.athleteBand;
  const format = hx.format ?? 'open_singles';
  const bandLabel = band.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const mtlCap = hx.mtlCap ?? HYROX_MTL_CAP[band];
  // Derived at render time — `hyroxConfig.weeklyActualMTL` is a dead field
  // (typed but never written). Same scope as the chronic/acute computation
  // so all four numbers share one source. See ISSUE-184.
  const currentWk = (s.wks ?? [])[(s.w ?? 1) - 1];
  const weeklyActualMTL = currentWk ? computeWeekActualMTL(currentWk) : 0;
  const weeklyPlannedMTL = currentWk ? computeWeekMTL(currentWk) : (hx.weeklyMTL ?? 0);
  const mtlPct = mtlCap > 0 ? Math.min(1, weeklyActualMTL / mtlCap) : 0;
  const mtlCTL = hx.mtlCTL ?? 0;
  const mtlATL = hx.mtlATL ?? 0;
  // Suppress ACWR until CTL has built up enough to be meaningful (≥1.0 daily-equivalent).
  // In Week 1 with no history CTL rounds to ~0 and any ATL produces a nonsensical ratio.
  // Only meaningful after enough actual station history has built up (>= 4 weeks of consistent work).
  // In Week 1–2 the ratio is a false alarm: tiny CTL vs first week's planned ATL.
  const mtlAcwr = mtlCTL >= 15 ? mtlATL / mtlCTL : null;

  const raceDate = hx.raceDate ?? s.onboarding?.customRaceDate;
  const raceDays = raceDate ? daysUntil(raceDate) : null;
  const phase = (s.wks?.[s.w - 1] as any)?.ph as string | undefined;

  // Read from format-specific benchmark slot, falling back to legacy pooled field.
  const isDoublesFormat = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  const benchmarks = (isDoublesFormat ? hx.stationBenchmarksDoubles : hx.stationBenchmarksSingles) ?? hx.stationBenchmarks ?? {};
  const access = hx.stationAccess;
  const calibratable = HYROX_STATION_ORDER.filter(st => {
    if (st === 'ski_erg' && !access.skiErg) return false;
    if (st === 'row_erg' && !access.rowErg) return false;
    if ((st === 'sled_push' || st === 'sled_pull') && access.sled === 'never') return false;
    return true;
  });
  const calibrated = calibratable.filter(st => benchmarks[st] != null);
  const pending = calibratable.filter(st => benchmarks[st] == null);

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  // Population comparison
  const prediction = predictHyroxRace(s);
  const predTimeSec = prediction?.totalSec ?? hx.previousHyroxTimeSec;
  const fasterThanPct = predTimeSec != null
    ? getFinishTimePercentile(predTimeSec, hx.format ?? 'open_singles')
    : null;

  // Run-pace derivation chain (for the Critical Pace card). Surfaces the
  // VDOT → threshold → CP → HYROX pace wiring so the user can see how their
  // 1km run pace was computed and what's anchoring it.
  const runPaceResult = deriveHyroxRunPace(s);
  const cpComponents = runPaceResult.components ?? null;

  container.innerHTML = `
    <style>
      @keyframes hxStatsFloat {
        from { opacity:0; transform:translateY(14px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .hxsf { opacity:0; animation:hxStatsFloat 0.55s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>
    <div class="mosaic-page" style="background:${atmosphereGradient('sky')};position:relative;min-height:100vh">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxs', { variant: 'centered', palette: 'sky', pulse: true })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <!-- Header -->
        <div class="hxsf" style="padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:28px;font-weight:700;color:#0F172A;letter-spacing:-0.02em">HYROX</div>
            <div style="font-size:13px;color:var(--c-muted);margin-top:2px">${bandLabel} · ${(format === 'pro_singles' || format === 'pro_doubles') ? 'Pro' : 'Open'} ${(format === 'open_doubles' || format === 'pro_doubles') ? 'Doubles' : 'Singles'}</div>
          </div>
          <button id="hx-stats-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
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
                <div style="font-size:12px;color:var(--c-muted);margin-top:2px">${percentileLabel(fasterThanPct)} · ${(hx.format === 'pro_singles' || hx.format === 'pro_doubles') ? 'Pro division' : 'Open division'}</div>
              </div>
            </div>
            <div style="margin-top:14px;position:relative;height:8px;background:linear-gradient(to right, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.12) 50%, rgba(0,0,0,0.20) 100%);border-radius:4px">
              <div style="position:absolute;top:-3px;left:${fasterThanPct}%;transform:translateX(-50%);width:14px;height:14px;background:#0F172A;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.25)"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px">
              <div style="font-size:10px;color:var(--c-faint)">Slowest</div>
              <div style="font-size:10px;color:var(--c-faint)">Fastest</div>
            </div>
            <div style="font-size:11px;color:var(--c-faint);margin-top:8px">Based on ${prediction != null ? 'predicted finish time' : 'previous time'}. Calibrated against 89,868 real HYROX finishers (Seasons 4–6) — all global ${(hx.format === 'pro_singles' || hx.format === 'pro_doubles') ? 'Pro' : 'Open'} division.</div>
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

        <!-- Critical Pace derivation card -->
        ${cpComponents ? (() => {
          const fmtPaceLocal = (secKm: number) => {
            if (!Number.isFinite(secKm) || secKm <= 0) return '—';
            const m = Math.floor(secKm / 60);
            const ss = String(Math.round(secKm % 60)).padStart(2, '0');
            return `${m}:${ss}`;
          };
          const v = s.v;
          const cpSec = Math.round(cpComponents.criticalPaceSecKm);
          const thresholdSec = Math.round(cpComponents.thresholdSecKm);
          const finalPaceSec = runPaceResult.paceSecKm;
          const cpRatio = cpComponents.cpRatio;
          const formatFactor = cpComponents.formatFactor;
          const personalOffset = cpComponents.personalOffsetSec;
          const isDoubles = formatFactor < 1.0;
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
                  Threshold ${fmtPaceLocal(thresholdSec)}/km × <span style="font-weight:600;color:#0F172A">${cpRatio.toFixed(2)}</span> (CP-ratio at your VDOT) = ${fmtPaceLocal(cpSec)}/km critical pace.${isDoubles ? ` Doubles factor ${formatFactor.toFixed(2)} → ${fmtPaceLocal(Math.round(cpSec * formatFactor))}.` : ''} ${personalOffset !== 0 ? `Personal offset ${personalOffset > 0 ? '+' : ''}${personalOffset}s/km → final.` : ''}
                </div>
                <div style="font-size:10px;color:var(--c-faint);padding-top:10px;border-top:1px solid rgba(0,0,0,0.05);margin-top:10px">${offsetLabel} · tap for the science</div>
              </div>
            </div>
          `;
        })() : ''}

        <!-- Benchmarks card: run pace + stations -->
        <div class="hxsf" style="padding:12px 20px 0;animation-delay:0.18s">
          <div style="background:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Benchmarks</div>
              <div style="font-size:11px;color:var(--c-muted)">${calibrated.length} / ${calibratable.length} stations calibrated</div>
            </div>
            ${calibratable.map(st => renderBenchmarkRow(st, benchmarks[st], hx.athleteBand, s)).join('')}
            ${renderRunPaceRow(hx.hyroxRunPaceSecKm, hx.athleteBand, hx.hyroxRunPaceSource)}
            ${(format === 'pro_singles' || format === 'pro_doubles') ? `
              <div style="border-top:1px solid rgba(0,0,0,0.05);margin-top:6px;padding:10px 0 0;display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div>
                  <div style="font-size:13px;color:var(--c-black)">Calibrated at Pro weights</div>
                  <div style="font-size:11px;color:var(--c-muted);margin-top:1px;line-height:1.4">Toggle on if your benchmarks were set at Pro-division weights. Default off — we'll add the heavier-weight slowdown on top of your times.</div>
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

  // CP card tap → modal explainer covering the derivation chain + science.
  document.getElementById('hx-stats-cp-card')?.addEventListener('click', () => {
    openCriticalPaceExplainer();
  });

  // Pro weights toggle — flips hyroxConfig.benchmarksAtProWeights and re-renders.
  document.getElementById('hx-pro-weights-toggle')?.addEventListener('click', async () => {
    const { getMutableState } = await import('@/state/store');
    const { saveState } = await import('@/state/persistence');
    const ms = getMutableState();
    if (!ms.hyroxConfig) return;
    ms.hyroxConfig.benchmarksAtProWeights = !ms.hyroxConfig.benchmarksAtProWeights;
    saveState();
    renderHyroxStatsView();
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
  const fmtPace = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = String(Math.round(s % 60)).padStart(2, '0');
    return `${m}:${sec}`;
  };

  const hasUser = userSecKm != null;
  const sourceCaption =
    source === 'derived' ? 'Updated from your runs — beat your last test.' :
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

function renderBenchmarkRow(
  station: HyroxStation,
  userSec: number | undefined,
  band: string,
  state: SimulatorState,
): string {
  const display = STATION_DISPLAY[station];
  const seedSec = (STATION_SEED_TIMES_SEC as any)[band]?.[station] as number | undefined;
  const hasUser = userSec != null;

  const fmtSec = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = String(Math.round(s % 60)).padStart(2, '0');
    return `${m}:${sec}`;
  };

  // Standalone benchmark times are max-effort with rest. Comparing them to the
  // 89k-finisher Kaggle dataset (which captures mid-race fatigued station
  // splits) is apples-to-oranges, so the BENCHMARKS card stays a personal
  // ledger — no population comparison. Race-day prediction percentile lives on
  // the headline finish-time card above, where the comparison is valid.
  let calibratedRightCol = '';
  if (hasUser) {
    const ageMo = latestTestAgeMonths(state, station);
    const ageCaption = (ageMo != null && ageMo >= 4)
      ? `Calibrated · ${Math.round(ageMo)} mo ago`
      : 'Calibrated';
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

/** Modal explainer for the Critical Pace card. Spells out the derivation
 *  chain (VDOT → threshold → CP → format → personalisation → HYROX pace)
 *  and the scientific anchor. Per UX_PATTERNS overlays must be vertically
 *  centered (`items-center justify-center`).
 */
function openCriticalPaceExplainer(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.45);' +
    'display:flex;align-items:center;justify-content:center;padding:20px;' +
    'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:18px;max-width:480px;width:100%;max-height:80vh;overflow-y:auto;padding:24px;box-shadow:0 24px 60px rgba(0,0,0,0.3);position:relative">
      <button id="hx-cp-modal-close" style="position:absolute;top:14px;right:14px;width:28px;height:28px;border-radius:14px;border:none;background:rgba(0,0,0,0.05);font-size:14px;cursor:pointer;line-height:1;color:var(--c-muted)">×</button>
      <div style="font-size:18px;font-weight:600;color:#0F172A;margin-bottom:14px;letter-spacing:-0.01em">How your HYROX pace is computed</div>
      <div style="font-size:13px;color:var(--c-black);line-height:1.6;margin-bottom:14px">
        Step by step, from physiology to prediction:
      </div>
      <ol style="font-size:13px;color:var(--c-black);line-height:1.6;padding-left:20px;margin:0 0 16px">
        <li style="margin-bottom:8px"><strong>Threshold pace</strong> from your VDOT and lactate threshold (LT pace). The pace you can hold for 60 min straight.</li>
        <li style="margin-bottom:8px"><strong>CP ratio</strong> at your VDOT. Continuously interpolated — no more discrete band buckets. Trained athletes can pace HYROX at or faster than threshold because stations are recovery between 1km legs.</li>
        <li style="margin-bottom:8px"><strong>Critical Pace</strong> = threshold × CP ratio. This is your sustainable HYROX run pace for the singles format.</li>
        <li style="margin-bottom:8px"><strong>Format factor</strong> adjusts for doubles (partner-rest reduces leg fatigue) or stays at 1.0 for singles.</li>
        <li style="margin-bottom:8px"><strong>Personal offset</strong> applies a residual from your logged HYROX races. Decays linearly to zero over 12 months without fresh evidence.</li>
      </ol>
      <div style="font-size:12px;color:var(--c-muted);line-height:1.5;padding-top:14px;border-top:1px solid rgba(0,0,0,0.06)">
        <strong>The science.</strong> Critical Pace is the asymptote of the velocity-time relationship (Hill 1923; Monod &amp; Scherrer 1965; Jones et al. 2010). For trained runners CP sits between 5k pace and threshold pace, and aligns with maximum lactate steady state within ~3–5% (Galbraith et al. 2014). HYROX's interval structure (8 × 1km separated by ~3–7 min of station work) matches CP-zone physiology better than continuous threshold.
      </div>
      <div style="font-size:12px;color:var(--c-muted);line-height:1.5;padding-top:10px">
        <strong>Why the prediction gets more accurate over time.</strong> When you log a HYROX race the model compares observed run pace to its prediction at that race's format, blends the residual into a personal offset, and uses that to bias all future predictions. The more races logged, the tighter the fit.
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#hx-cp-modal-close')?.addEventListener('click', close);
}
