/**
 * activity-detail.ts
 * Full-page view for a single activity: stats grid, HR zones, km splits, route map.
 * Navigated to from plan-view and home-view; back button returns to source view.
 */

import type { GarminActual } from '@/types';
import { drawPolylineOnCanvas } from './strava-detail';
import { getState, getMutableState } from '@/state';
import { saveState } from '@/state/persistence';
import { formatKm } from '@/utils/format';
import { generateWorkoutInsight, findPreviousSession } from '@/calculations/workout-insight';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { generateWeekWorkouts } from '@/workouts';
import { getTrailingEffortScore } from '@/calculations/fitness-model';
import { SPORT_LABELS } from '@/constants';
import { showSportPicker, reclassifyActivity, getEffectiveSport } from './sport-picker-modal';

export type ActivityDetailSource = 'plan' | 'home' | 'strain';

// ── Design tokens ─────────────────────────────────────────────────────────────

const PAGE_BG  = '#FAF9F6';
const TEXT_M   = '#0F172A';
const TEXT_S   = '#64748B';
const TEXT_L   = '#94A3B8';

const CARD = `background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtPace(secPerKm: number, pref: 'km' | 'mi' = 'km'): string {
  const sec = pref === 'mi' ? secPerKm * 1.60934 : secPerKm;
  const unit = pref === 'mi' ? '/mi' : '/km';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}${unit}`;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}

function fmtZoneTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

// ── Section label (replaces m-sec-label ALL-CAPS) ───────────────────────────

function secLabel(text: string): string {
  return `<div style="font-size:12px;font-weight:600;color:${TEXT_S};margin-bottom:8px;padding-left:2px">${text}</div>`;
}

// ── Build detail HTML ───────────────────────────────────────────────────────

function buildDetailHTML(actual: GarminActual, planWorkoutName: string, plannedTSS?: number, unitPref: 'km' | 'mi' = 'km', workoutId?: string): string {
  const s = getState();
  const source = actual.garminId?.startsWith('strava-') ? 'Strava' : 'Garmin';
  // Title: when the user has relabelled (manualSport set), prefer the sport label
  // over the raw Strava/Garmin workout name (which often reads "Cardio" for
  // non-running activities and no longer reflects the chosen sport).
  const titleSport = actual.manualSport ? (SPORT_LABELS as Record<string, string>)[actual.manualSport] : null;
  const actName = titleSport || actual.workoutName || actual.displayName || planWorkoutName || 'Activity';
  const dateStr = actual.startTime
    ? new Date(actual.startTime).toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    })
    : '';

  // ─── Hero distance ──────────────────────────────────────────────────────────
  const heroDistance = actual.distanceKm > 0.1 ? formatKm(actual.distanceKm, unitPref, 2) : null;
  const distUnit = unitPref === 'mi' ? 'mi' : 'km';

  const heroHtml = heroDistance ? `
    <div class="ad-fade" style="animation-delay:0.06s;text-align:center;margin-bottom:16px">
      <div style="display:flex;align-items:baseline;justify-content:center;gap:4px">
        <span style="font-size:44px;font-weight:300;letter-spacing:-0.03em;color:${TEXT_M}">${esc(heroDistance.replace(distUnit, ''))}</span>
        <span style="font-size:15px;font-weight:400;color:${TEXT_S}">${distUnit}</span>
      </div>
    </div>
  ` : '';

  // ─── Sport row (cross-training only — lets user correct a mis-classified activity) ─
  const isRunActual = !actual.activityType || actual.activityType.toUpperCase().includes('RUN');
  let sportRowHtml = '';
  if (!isRunActual) {
    const effSport = getEffectiveSport(actual);
    const sportLabel = (SPORT_LABELS as Record<string, string>)[effSport] ?? effSport;
    sportRowHtml = `
      <div class="ad-fade" style="animation-delay:0.08s;margin-bottom:16px">
        <button id="ad-sport-row" style="
          width:100%;${CARD};padding:14px 18px;border:none;cursor:pointer;
          display:flex;align-items:center;justify-content:space-between;gap:12px;
          font-family:var(--f);text-align:left;transition:transform 0.15s ease;
        " onmousedown="this.style.transform='scale(0.995)'" onmouseup="this.style.transform='scale(1)'" onmouseleave="this.style.transform='scale(1)'">
          <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
            <span style="font-size:11px;font-weight:500;color:${TEXT_L};letter-spacing:0.01em">Activity</span>
            <span style="font-size:16px;font-weight:500;color:${TEXT_M};letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sportLabel)}</span>
          </div>
          <span style="font-size:12px;font-weight:500;color:${TEXT_L};white-space:nowrap;flex-shrink:0">Tap to change →</span>
        </button>
      </div>
    `;
  }

  // ─── Stats grid (3x3) ────────────────────────────────────────────────────────
  const elapsedPace = actual.distanceKm > 0.1 && actual.durationSec > 0
    ? Math.round(actual.durationSec / actual.distanceKm)
    : null;
  const showElapsedPace = elapsedPace != null && actual.avgPaceSecKm != null && Math.abs(elapsedPace - actual.avgPaceSecKm) > 5;

  const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : 0;
  const actualTSS = actual.iTrimp != null && actual.iTrimp > 0
    ? Math.round((actual.iTrimp * 100) / 15000)
    : durMin > 0 ? Math.round(durMin * 0.92) : null;

  // Build grid: only include stats that have real values (no "—" filler cells)
  const gridStats: { val: string; lbl: string }[] = [];
  if (actual.durationSec > 0) gridStats.push({ val: fmtDuration(actual.durationSec), lbl: 'Time' });
  if (actual.avgPaceSecKm) gridStats.push({ val: fmtPace(actual.avgPaceSecKm, unitPref), lbl: 'Pace' });
  if (showElapsedPace) gridStats.push({ val: fmtPace(elapsedPace!, unitPref), lbl: 'Elapsed Pace' });
  if (actual.avgHR) gridStats.push({ val: `${actual.avgHR} bpm`, lbl: 'Avg HR' });
  if (actual.maxHR) gridStats.push({ val: `${actual.maxHR} bpm`, lbl: 'Max HR' });
  if (actual.elevationGainM != null && actual.elevationGainM > 0) gridStats.push({ val: `${Math.round(actual.elevationGainM)}m`, lbl: 'Elevation' });
  if (actualTSS != null) gridStats.push({ val: `${actualTSS}`, lbl: actual.iTrimp != null ? 'TSS (HR)' : 'TSS (est)' });
  if (actual.calories != null && actual.calories > 0) gridStats.push({ val: `${actual.calories}`, lbl: 'Calories' });

  // RPE as a grid cell (tappable)
  const RPE_COLOR = (v: number) => v <= 3 ? '#22C55E' : v <= 6 ? '#F59E0B' : '#EF4444';
  const RPE_LABEL: Record<number, string> = {
    1: 'Very easy', 2: 'Easy', 3: 'Easy', 4: 'Moderate',
    5: 'Moderate', 6: 'Hard', 7: 'Hard', 8: 'Very hard',
    9: 'Max effort', 10: 'Max effort',
  };
  // Look up expected RPE from the planned workout
  let expectedRpe: number | null = null;
  if (workoutId) {
    const wk = s.wks?.[(s.w ?? 1) - 1];
    if (wk) {
      const weekWos = generateWeekWorkouts(
        wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
        null, s.recurringActivities,
        (s as any).onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
        getTrailingEffortScore(s.wks ?? [], s.w ?? 1), wk.scheduledAcwrStatus,
      );
      const planned = weekWos.find((w: any) => (w.id || w.n) === workoutId);
      if (planned) expectedRpe = planned.rpe ?? planned.r ?? null;
    }
  }

  let rpeGridCell = '';
  if (workoutId) {
    const wk = getState().wks?.[(getState().w ?? 1) - 1];
    const currentRpe = wk?.rated?.[workoutId];
    const hasRpe = typeof currentRpe === 'number';
    const col = hasRpe ? RPE_COLOR(currentRpe) : TEXT_L;
    const display = hasRpe ? String(currentRpe) : '\u2014';
    const expectedStr = expectedRpe != null ? `/${expectedRpe}` : '';
    const label = hasRpe ? RPE_LABEL[currentRpe] ?? '' : 'Tap to rate';
    rpeGridCell = `
      <div id="rpe-card" data-wid="${workoutId}" data-expected="${expectedRpe ?? ''}" style="${CARD};padding:12px 14px;cursor:pointer">
        <div style="display:flex;align-items:baseline;gap:2px">
          <span style="font-size:20px;font-weight:300;letter-spacing:-0.03em;line-height:1.1;color:${TEXT_M}">${display}</span>
          <span style="font-size:13px;font-weight:300;color:${TEXT_L}">${expectedStr}</span>
        </div>
        <div style="font-size:10px;font-weight:600;color:${TEXT_L};margin-top:4px">RPE${hasRpe ? ' \u00b7 ' : ''}<span style="color:${col}">${hasRpe ? label : ''}</span></div>
      </div>`;
  }

  const statsHtml = `
    <div class="ad-fade" style="animation-delay:0.10s;margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
        ${gridStats.map(item => `
          <div style="${CARD};padding:12px 14px">
            <div style="font-size:20px;font-weight:300;letter-spacing:-0.03em;line-height:1.1;color:${item.val === '—' ? TEXT_L : TEXT_M}">${esc(item.val)}</div>
            <div style="font-size:10px;font-weight:600;color:${TEXT_L};margin-top:4px">${item.lbl}</div>
          </div>
        `).join('')}
        ${rpeGridCell}
      </div>
    </div>
  `;

  // ─── Planned vs actual comparison (only when planned TSS exists) ──────────
  let loadCompareHtml = '';
  if (actualTSS != null && plannedTSS && plannedTSS > 0) {
    const maxTSS = Math.max(plannedTSS, actualTSS, 1);
    const ratio = actualTSS / plannedTSS;
    const actualColor = ratio > 1.15 ? '#EF4444' : ratio < 0.80 ? '#EAB308' : '#22C55E';
    const diffPct = Math.round((ratio - 1) * 100);
    const diffStr = diffPct === 0 ? 'on target' : diffPct > 0 ? `+${diffPct}% vs planned` : `${diffPct}% vs planned`;
    loadCompareHtml = `
      <div class="ad-fade" style="animation-delay:0.14s;margin-bottom:16px">
        <div style="${CARD};padding:16px 18px">
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:12px">
            <span style="font-size:12px;font-weight:600;color:${TEXT_S}">Load vs plan</span>
            <span style="font-size:11px;font-weight:500;color:${actualColor};margin-left:auto">${diffStr}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:10px;color:${TEXT_S};width:50px;flex-shrink:0">Planned</span>
              <div style="flex:1;height:5px;background:rgba(0,0,0,0.05);border-radius:3px;overflow:hidden">
                <div style="width:${Math.round((plannedTSS / maxTSS) * 100)}%;height:100%;background:rgba(0,0,0,0.12);border-radius:3px"></div>
              </div>
              <span style="font-size:10px;color:${TEXT_L};width:44px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums">${plannedTSS}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:10px;color:${TEXT_S};width:50px;flex-shrink:0">Actual</span>
              <div style="flex:1;height:5px;background:rgba(0,0,0,0.05);border-radius:3px;overflow:hidden">
                <div style="width:${Math.round((actualTSS / maxTSS) * 100)}%;height:100%;background:${actualColor};border-radius:3px"></div>
              </div>
              <span style="font-size:10px;font-weight:600;color:${actualColor};width:44px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums">${actualTSS}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ─── Training effect chips ────────────────────────────────────────────────────
  let teHtml = '';
  if (actual.aerobicEffect != null || actual.anaerobicEffect != null) {
    const teLabel = (v: number) => v < 1.0 ? 'No effect' : v < 2.0 ? 'Minor' : v < 3.0 ? 'Maintaining' : v < 4.0 ? 'Improving' : v < 5.0 ? 'Highly improving' : 'Overreaching';
    const teColor = (v: number) => v < 2.0 ? TEXT_L : v < 3.5 ? '#22C55E' : v < 4.5 ? '#F97316' : '#EF4444';
    const chips = [
      actual.aerobicEffect != null ? `<span style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:8px;background:rgba(0,0,0,0.03);color:${teColor(actual.aerobicEffect)}">Aerobic ${actual.aerobicEffect.toFixed(1)} · ${teLabel(actual.aerobicEffect)}</span>` : '',
      actual.anaerobicEffect != null ? `<span style="font-size:10px;font-weight:600;padding:4px 10px;border-radius:8px;background:rgba(0,0,0,0.03);color:${teColor(actual.anaerobicEffect)}">Anaerobic ${actual.anaerobicEffect.toFixed(1)} · ${teLabel(actual.anaerobicEffect)}</span>` : '',
    ].filter(Boolean).join('');
    if (chips) {
      teHtml = `
        <div class="ad-fade" style="animation-delay:0.16s;margin-bottom:16px">
          <div style="display:flex;gap:6px;flex-wrap:wrap">${chips}</div>
        </div>
      `;
    }
  }

  // ─── Route map ───────────────────────────────────────────────────────────────
  let mapHtml = '';
  if (actual.polyline) {
    const kmSplitsAttr = actual.kmSplits?.length
      ? ` data-km-splits="${esc(JSON.stringify(actual.kmSplits))}"`
      : '';
    mapHtml = `
      <div class="ad-fade" style="animation-delay:0.20s;margin-bottom:16px">
        ${secLabel('Route')}
        <div style="${CARD};overflow:hidden;padding:0">
          <canvas id="act-detail-map"
            data-polyline="${esc(actual.polyline)}"${kmSplitsAttr}
            style="width:100%;display:block;height:200px">
          </canvas>
        </div>
      </div>
    `;
  }

  // ─── HR zones ────────────────────────────────────────────────────────────────
  let hrHtml = '';
  if (actual.hrZones) {
    const z = actual.hrZones;
    const total = z.z1 + z.z2 + z.z3 + z.z4 + z.z5;
    if (total > 0) {
      const pct = (v: number) => Math.max(1, Math.round((v / total) * 100));
      const zones: [number, string, string][] = [
        [z.z1, '#3B82F6', 'Z1 Easy'],
        [z.z2, '#22C55E', 'Z2 Aerobic'],
        [z.z3, '#EAB308', 'Z3 Tempo'],
        [z.z4, '#F97316', 'Z4 Threshold'],
        [z.z5, '#EF4444', 'Z5 VO2'],
      ];
      hrHtml = `
        <div class="ad-fade" style="animation-delay:0.26s;margin-bottom:16px">
          ${secLabel('HR Zones')}
          <div style="${CARD};padding:16px 18px">
            <div style="height:8px;border-radius:4px;display:flex;overflow:hidden;gap:2px;margin-bottom:12px">
              ${zones.filter(([v]) => v > 0).map(([v, col]) => `<div style="flex:${pct(v)};background:${col}"></div>`).join('')}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px 14px">
              ${zones.filter(([v]) => v > 0).map(([v, col, lbl]) => `
                <span style="display:flex;align-items:center;gap:5px;font-size:11px;color:${TEXT_S}">
                  <span style="width:8px;height:8px;border-radius:2px;background:${col};display:inline-block;flex-shrink:0"></span>
                  ${lbl} · ${fmtZoneTime(v)}
                </span>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    }
  }

  // ─── km splits ───────────────────────────────────────────────────────────────
  const isRunActivity = !actual.activityType || actual.activityType.includes('RUN');
  let splitsHtml = '';
  if (isRunActivity && actual.kmSplits && actual.kmSplits.length > 0) {
    const splits = actual.kmSplits.filter(p => p >= 60 && p <= 900);
    if (splits.length > 0) {
    const minP = Math.min(...splits);
    const maxP = Math.max(...splits);
    const range = Math.max(maxP - minP, 30);
    const rows = splits.map((pace, i) => {
      const norm = (pace - minP) / range;
      const barColor = norm < 0.33 ? '#22C55E' : norm < 0.67 ? '#EAB308' : '#EF4444';
      const barWidth = Math.round(30 + norm * 70);
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0${i < splits.length - 1 ? ';border-bottom:1px solid rgba(0,0,0,0.05)' : ''}">
          <span style="font-size:10px;font-weight:600;color:${TEXT_L};width:24px;text-align:right;flex-shrink:0">${i + 1}</span>
          <div style="flex:1;height:5px;background:rgba(0,0,0,0.05);border-radius:3px;overflow:hidden">
            <div style="width:${barWidth}%;height:100%;background:${barColor};border-radius:3px"></div>
          </div>
          <span style="font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;width:56px;text-align:right;flex-shrink:0;color:${TEXT_M}">${fmtPace(pace, unitPref)}</span>
        </div>
      `;
    }).join('');
    splitsHtml = `
      <div class="ad-fade" style="animation-delay:0.32s;margin-bottom:16px">
        ${secLabel(unitPref === 'mi' ? 'mi Splits' : 'km Splits')}
        <div style="${CARD};padding:8px 16px">${rows}</div>
      </div>
    `;
    }
  }

  // ─── Coach insight ───────────────────────────────────────────────────────────
  const prev = findPreviousSession(actual.plannedType, actual.garminId, s.wks || []);
  const allActuals = (s.wks || []).flatMap(wk => Object.values(wk.garminActuals || {}));
  const insight = generateWorkoutInsight(actual, { hrProfile: s, prev, unitPref, allActuals });
  const insightHtml = insight ? `
    <div class="ad-fade" style="animation-delay:0.38s;margin-bottom:16px">
      ${secLabel('Coach')}
      <div style="${CARD};padding:16px 18px;font-size:13px;line-height:1.55;color:${TEXT_S}">${insight}</div>
    </div>
  ` : '';

  return `
    <style>
      #ad-view { box-sizing:border-box; }
      #ad-view *, #ad-view *::before, #ad-view *::after { box-sizing:inherit; }
      @keyframes adFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .ad-fade { opacity:0; animation:adFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="ad-view" style="
      position:relative;min-height:100vh;background:${PAGE_BG};
      font-family:var(--f);overflow-x:hidden;
    ">
      <div style="max-width:480px;margin:0 auto;padding-bottom:48px">

        <!-- Header -->
        <div style="padding:56px 20px 12px;display:flex;align-items:center;justify-content:space-between">
          <button id="act-detail-back" style="
            width:36px;height:36px;border-radius:50%;border:1px solid rgba(0,0,0,0.09);
            background:transparent;display:flex;align-items:center;justify-content:center;
            cursor:pointer;flex-shrink:0;
          ">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${TEXT_M}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="text-align:center;min-width:0;flex:1">
            <div style="font-size:20px;font-weight:600;letter-spacing:-0.02em;color:${TEXT_M};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(actName)}</div>
            <div style="font-size:12px;color:${TEXT_S};margin-top:3px">${dateStr ? dateStr + ' · ' : ''}${source}</div>
          </div>
          <div style="width:36px"></div>
        </div>

        <!-- Content -->
        <div style="padding:0 16px">
          ${heroHtml}
          ${sportRowHtml}
          ${statsHtml}
          ${loadCompareHtml}
          ${teHtml}
          ${mapHtml}
          ${hrHtml}
          ${splitsHtml}
          ${insightHtml}
        </div>

      </div>
    </div>
    ${renderTabBar('home')}
  `;
}

// ── Navigation ───────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./plan-view').then(m => m.renderPlanView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
}

// ── Public entry point ──────────────────────────────────────────────────────

export function renderActivityDetail(
  actual: GarminActual,
  planWorkoutName: string,
  returnView: ActivityDetailSource,
  plannedTSS?: number,
  workoutId?: string,
): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const unitPref = getState().unitPref ?? 'km';
  container.innerHTML = buildDetailHTML(actual, planWorkoutName, plannedTSS, unitPref, workoutId);

  // Wire tab bar
  wireTabBarHandlers(navigateTab);

  // Draw route map canvas after layout
  const canvas = document.getElementById('act-detail-map') as HTMLCanvasElement | null;
  if (canvas) {
    const encoded = canvas.dataset.polyline;
    const kmSplitsRaw = canvas.dataset.kmSplits;
    const kmSplits = kmSplitsRaw ? JSON.parse(kmSplitsRaw) as number[] : undefined;
    if (encoded) {
      requestAnimationFrame(() => void drawPolylineOnCanvas(canvas, encoded, kmSplits));
    }
  }

  // RPE card → inline slider overlay
  document.getElementById('rpe-card')?.addEventListener('click', () => {
    const card = document.getElementById('rpe-card');
    const wid = card?.dataset.wid;
    if (!wid) return;
    const exp = card?.dataset.expected ? parseInt(card.dataset.expected, 10) : null;
    _showRpeOverlay(wid, actual, planWorkoutName, returnView, plannedTSS, exp || null);
  });

  // Sport row → picker → reclassify + re-render
  document.getElementById('ad-sport-row')?.addEventListener('click', async () => {
    const current = getEffectiveSport(actual);
    const chosen = await showSportPicker(current);
    if (!chosen || chosen === current) return;
    reclassifyActivity(actual, chosen);
    renderActivityDetail(actual, planWorkoutName, returnView, plannedTSS, workoutId);
  });

  // Back button
  document.getElementById('act-detail-back')?.addEventListener('click', () => {
    if (returnView === 'home') {
      import('./home-view').then(({ renderHomeView }) => renderHomeView());
    } else if (returnView === 'strain') {
      import('./strain-view').then(({ renderStrainView }) => renderStrainView());
    } else {
      import('./plan-view').then(({ renderPlanView }) => renderPlanView());
    }
  });
}

// ── RPE slider overlay (single-activity) ─────────────────────────────────────

function _showRpeOverlay(
  workoutId: string,
  actual: GarminActual,
  planWorkoutName: string,
  returnView: ActivityDetailSource,
  plannedTSS?: number,
  expectedRpe?: number | null,
): void {
  const s = getMutableState();
  const wk = s.wks?.[(s.w ?? 1) - 1];
  if (!wk) return;

  const currentRpe = typeof wk.rated?.[workoutId] === 'number' ? wk.rated[workoutId] as number : 5;
  const unitPref = s.unitPref ?? 'km';
  const dist = actual.distanceKm > 0.1 ? formatKm(actual.distanceKm, unitPref) : '';
  const mins = actual.durationSec > 0 ? Math.round(actual.durationSec / 60) : 0;
  const name = actual.workoutName || actual.displayName || planWorkoutName || 'Activity';

  const RPE_LABELS: Record<number, string> = {
    1: 'Very easy', 2: 'Easy', 3: 'Easy', 4: 'Moderate',
    5: 'Moderate', 6: 'Hard', 7: 'Hard', 8: 'Very hard',
    9: 'Max effort', 10: 'Max effort',
  };

  const expectedLine = expectedRpe != null
    ? `<div style="font-size:11px;color:${TEXT_S};margin-bottom:14px">Expected: ${expectedRpe}/10 \u00b7 ${RPE_LABELS[expectedRpe] ?? ''}</div>`
    : '';

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';

  overlay.innerHTML = `
    <style>
      #rpe-detail-slider {
        -webkit-appearance: none; appearance: none;
        width: 100%; height: 6px; border-radius: 3px;
        background: linear-gradient(to right, #22C55E, #EAB308 45%, #EF4444);
        outline: none;
      }
      #rpe-detail-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 24px; height: 24px; border-radius: 50%;
        background: #fff; border: 2px solid ${TEXT_M};
        box-shadow: 0 2px 6px rgba(0,0,0,0.15);
        cursor: pointer;
      }
    </style>
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:${PAGE_BG}">
      <div style="font-size:15px;font-weight:600;color:${TEXT_M};margin-bottom:2px">${esc(name)}</div>
      <div style="font-size:12px;color:${TEXT_S};margin-bottom:4px">${dist ? dist + ' \u00b7 ' : ''}${mins} min</div>
      ${expectedLine}
      <div style="display:flex;align-items:center;gap:12px">
        <input type="range" min="1" max="10" step="1" value="${currentRpe}"
               id="rpe-detail-slider">
        <span id="rpe-detail-val"
              style="font-size:22px;font-weight:700;color:${TEXT_M};min-width:24px;text-align:center">${currentRpe}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;padding:0 2px">
        <span style="font-size:9px;color:${TEXT_L}">Easy</span>
        <span id="rpe-detail-label" style="font-size:11px;font-weight:500;color:${TEXT_S}">${RPE_LABELS[currentRpe] ?? ''}</span>
        <span style="font-size:9px;color:${TEXT_L}">Max</span>
      </div>
      <div style="font-size:10px;color:${TEXT_L};margin-top:14px;line-height:1.5">This adjusts your next week. Felt harder than expected? Sessions get dialled back. Easier? They ramp up.</div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button id="rpe-detail-skip" style="flex:1;height:40px;border-radius:12px;border:1px solid rgba(0,0,0,0.09);
                background:transparent;font-size:13px;font-weight:600;color:${TEXT_S};cursor:pointer">Cancel</button>
        <button id="rpe-detail-save" style="flex:1;height:40px;border-radius:12px;border:none;
                background:${TEXT_M};font-size:13px;font-weight:600;color:#fff;cursor:pointer">Save</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const slider = document.getElementById('rpe-detail-slider') as HTMLInputElement;
  const valSpan = document.getElementById('rpe-detail-val')!;
  const labelSpan = document.getElementById('rpe-detail-label')!;

  slider.addEventListener('input', () => {
    const val = parseInt(slider.value, 10);
    valSpan.textContent = String(val);
    labelSpan.textContent = RPE_LABELS[val] ?? '';
  });

  const close = (save: boolean) => {
    if (save) {
      if (!wk.rated) wk.rated = {};
      wk.rated[workoutId] = parseInt(slider.value, 10);
      saveState();
    }
    overlay.remove();
    if (save) {
      // Re-render the detail page to update the RPE card
      renderActivityDetail(actual, planWorkoutName, returnView, plannedTSS, workoutId);
    }
  };

  document.getElementById('rpe-detail-save')!.addEventListener('click', () => close(true));
  document.getElementById('rpe-detail-skip')!.addEventListener('click', () => close(false));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
}
