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
import { looksLikeCssTest, looksLikeFtpTest } from '@/calculations/tri-benchmarks-from-history';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { generateWeekWorkouts } from '@/workouts';
import { getTrailingEffortScore } from '@/calculations/fitness-model';
import { SPORT_LABELS } from '@/constants';
import { showSportPicker, reclassifyActivity, getEffectiveSport } from './sport-picker-modal';
import { buildScrollAtmosphereBackground, floweyHaloAnimationCSS, buildSunGlint } from './page-flair';
import {
  scoreRepAdherence, repCommentary, parseRepPrescription,
} from '@/calculations/rep-adherence';
import { openSafetyRatingModal } from './safety-slider';
import { trimRouteEnds, decodePolylineToLatLng } from '@/gps/anonymize-route';
import { submitRouteSafetyRating } from '@/data/safetyRatingSync';

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

function fmtSwimPace(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${String(s).padStart(2, '0')}/100m`;
}

// ── Section label (replaces m-sec-label ALL-CAPS) ───────────────────────────

function secLabel(text: string): string {
  return `<div style="font-size:12px;font-weight:600;color:${TEXT_S};margin-bottom:8px;padding-left:2px">${text}</div>`;
}

// ── Build detail HTML ───────────────────────────────────────────────────────

function buildDetailHTML(actual: GarminActual, planWorkoutName: string, plannedTSS?: number, unitPref: 'km' | 'mi' = 'km', workoutId?: string): string {
  const s = getState();
  // Source attribution — three possible IDs prefix activity rows:
  //   strava-… → Strava (richest signal: HR streams, polyline, best_efforts)
  //   apple-…  → Apple Health (HealthKit + HealthExtras plugin)
  //   else     → Garmin webhook
  const source = actual.garminId?.startsWith('strava-')
    ? 'Strava'
    : actual.garminId?.startsWith('apple-')
    ? 'Apple Health'
    : 'Garmin';
  const stravaActivityId = actual.garminId?.startsWith('strava-') ? actual.garminId.slice(7) : null;
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
  // Power (cycling). Strava's `device_watts` flag is unreliable for activities
  // transferred via Garmin Connect → Strava (often returns false even on real
  // power-meter data), so we don't surface "estimated" tags from it.
  if (actual.averageWatts != null && actual.averageWatts > 0) {
    gridStats.push({ val: `${Math.round(actual.averageWatts)} W`, lbl: 'Avg Power' });
  }
  if (actual.normalizedPowerW != null && actual.normalizedPowerW > 0
      && (actual.averageWatts == null || Math.abs(actual.normalizedPowerW - actual.averageWatts) >= 5)) {
    gridStats.push({ val: `${Math.round(actual.normalizedPowerW)} W`, lbl: 'Normalised Power' });
  }
  if (actual.maxWatts != null && actual.maxWatts > 0) {
    gridStats.push({ val: `${Math.round(actual.maxWatts)} W`, lbl: 'Max Power' });
  }
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
        getTrailingEffortScore(s.wks ?? [], s.w ?? 1), wk.scheduledAcwrStatus, undefined,
        s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
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

  // ─── Rep table + fade ────────────────────────────────────────────────────────
  // Only renders when reps were detected. Shows source ("Strava laps" / "Auto"),
  // per-rep table, fade chart, and a one-line commentary when the prescribed
  // workout has a parseable target.
  let repsHtml = '';
  if (actual.repData && actual.repData.reps.length > 0) {
    const reps = actual.repData.reps;
    const isBikeAct = (actual.activityType ?? '').includes('CYCL') || (actual.activityType ?? '').includes('BIKE');
    const discipline: 'run' | 'bike' = isBikeAct ? 'bike' : 'run';

    // Find the matched workout to derive a target. plannedType is the plan
    // workout type ('vo2', 'threshold', 'bike_threshold', etc.). Running-mode
    // workouts aren't persisted on the week (regenerated by the engine), so
    // we look in triWorkouts + adhocWorkouts and fall back to a typed stub
    // when nothing is found — the scorer only needs the type to resolve a
    // target.
    let matchedWorkout: import('@/types').Workout | undefined;
    if (actual.plannedType) {
      for (const wk of (s.wks || [])) {
        if (!wk.garminMatched) continue;
        const wid = wk.garminMatched[actual.garminId];
        if (!wid) continue;
        const w = (wk.triWorkouts || []).find(x => x.id === wid)
          ?? (wk.adhocWorkouts || []).find((x: any) => x.id === wid);
        if (w) { matchedWorkout = w as import('@/types').Workout; break; }
      }
      if (!matchedWorkout) {
        matchedWorkout = { n: '', d: '', t: actual.plannedType, r: 0 } as import('@/types').Workout;
      }
    }

    const ftp = (s as any).onboarding?.triBike?.ftp;
    const scored = scoreRepAdherence({
      workout: matchedWorkout,
      actual,
      discipline,
      vdot: s.v,
      ltPaceSecKm: s.ltPace ?? null,
      ftp,
    });

    // Parse "8×400m" out of the description for the header chip when we have
    // a matched workout but the scorer didn't run (e.g. no VDOT yet).
    const prescriptionStr = scored?.score?.parsedFrom
      ?? parseRepPrescription(matchedWorkout?.d)?.parsedFrom
      ?? null;

    const sourceLabel = actual.repData.source === 'strava-laps' ? 'Strava laps' : 'Auto-detected';

    // Range for the bar chart (faster = longer green bar; for bike: stronger = longer).
    const repValues = discipline === 'run'
      ? reps.map(r => r.paceSecKm).filter((v): v is number => v != null && v > 0)
      : reps.map(r => r.avgWatts).filter((v): v is number => v != null && v > 0);
    const minV = repValues.length ? Math.min(...repValues) : 0;
    const maxV = repValues.length ? Math.max(...repValues) : 0;
    const range = Math.max(maxV - minV, discipline === 'run' ? 10 : 5);

    const rowsHtml = reps.map((r, i) => {
      const value = discipline === 'run' ? r.paceSecKm : r.avgWatts;
      // For run: lower (faster) = greener. For bike: higher (stronger) = greener.
      const norm = value != null
        ? (discipline === 'run' ? (value - minV) / range : (maxV - value) / range)
        : 1;
      const barColor = norm < 0.33 ? '#22C55E' : norm < 0.67 ? '#EAB308' : '#EF4444';
      const barWidth = Math.round(30 + norm * 70);
      const valueText = discipline === 'run'
        ? (r.paceSecKm != null ? fmtPace(r.paceSecKm, unitPref) : '—')
        : (r.avgWatts != null ? `${r.avgWatts}W` : '—');
      const distText = r.distanceM > 0
        ? (r.distanceM >= 1000 ? `${(r.distanceM / 1000).toFixed(2)}km` : `${r.distanceM}m`)
        : fmtDuration(r.durationSec);
      const hrText = r.avgHR != null ? `${r.avgHR}bpm` : '';
      const inBand = scored?.perRep[i]?.inBand ? '●' : '';
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0${i < reps.length - 1 ? ';border-bottom:1px solid rgba(0,0,0,0.05)' : ''}">
          <span style="font-size:10px;font-weight:600;color:${TEXT_L};width:24px;text-align:right;flex-shrink:0">${r.index}</span>
          <span style="font-size:10px;color:${TEXT_L};width:48px;flex-shrink:0">${distText}</span>
          <div style="flex:1;height:5px;background:rgba(0,0,0,0.05);border-radius:3px;overflow:hidden">
            <div style="width:${barWidth}%;height:100%;background:${barColor};border-radius:3px"></div>
          </div>
          <span style="font-size:10px;color:#22C55E;width:8px;flex-shrink:0">${inBand}</span>
          <span style="font-size:11px;color:${TEXT_L};width:46px;text-align:right;flex-shrink:0">${hrText}</span>
          <span style="font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;width:64px;text-align:right;flex-shrink:0;color:${TEXT_M}">${valueText}</span>
        </div>
      `;
    }).join('');

    const commentary = scored ? repCommentary(scored, discipline) : '';
    const headerChip = prescriptionStr ? `Prescribed: ${prescriptionStr}` : `${reps.length} reps`;

    repsHtml = `
      <div class="ad-fade" style="animation-delay:0.34s;margin-bottom:16px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;padding:0 4px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:${TEXT_L};font-weight:600">Reps</div>
          <div style="font-size:11px;color:${TEXT_L}">${headerChip} · ${sourceLabel}</div>
        </div>
        <div style="${CARD};padding:12px 16px">
          ${rowsHtml}
          ${commentary ? `
            <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,0.05);font-size:12px;color:${TEXT_S};line-height:1.5">
              ${esc(commentary)}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ─── Coach insight ───────────────────────────────────────────────────────────
  const prev = findPreviousSession(actual.plannedType, actual.garminId, s.wks || []);
  const allActuals = (s.wks || []).flatMap(wk => Object.values(wk.garminActuals || {}));
  const onb = (s as any).onboarding;
  const ftpWatts = onb?.triBike?.ftp ?? undefined;
  const cssSecPer100m = onb?.triSwim?.cssSecPer100m ?? undefined;
  const insight = generateWorkoutInsight(actual, { hrProfile: s, prev, unitPref, allActuals, ftpWatts, cssSecPer100m });
  const insightHtml = insight ? `
    <div class="ad-fade" style="animation-delay:0.38s;margin-bottom:16px">
      ${secLabel('Coach')}
      <div style="${CARD};padding:16px 18px;font-size:13px;line-height:1.55;color:${TEXT_S}">${insight}</div>
    </div>
  ` : '';

  // ─── CSS benchmark prompt (triathlon mode, swim activities only) ────────────
  const isTriMode = s.eventType === 'triathlon';
  const cssSignal = looksLikeCssTest(actual);
  const cssPromptHtml = isTriMode && cssSignal.likely && cssSignal.estimatedCss != null ? `
    <div class="ad-fade" style="animation-delay:0.44s;margin-bottom:16px">
      <div style="${CARD};padding:14px 16px">
        <div style="font-size:13px;font-weight:600;color:${TEXT_M};margin-bottom:4px">This swim looks like a CSS test.</div>
        <div style="font-size:12px;color:${TEXT_S};line-height:1.5;margin-bottom:12px">Estimated CSS: ${fmtSwimPace(cssSignal.estimatedCss)} (conservative; whole-session pace plus 5s buffer). Apply as your swim benchmark?</div>
        <button id="ad-apply-css" style="background:transparent;border:1px solid var(--c-border);color:${TEXT_M};padding:8px 16px;border-radius:100px;font-size:13px;font-weight:500;cursor:pointer" data-css="${cssSignal.estimatedCss}">
          Apply CSS: ${fmtSwimPace(cssSignal.estimatedCss)}
        </button>
      </div>
    </div>
  ` : '';

  // ─── FTP benchmark prompt (triathlon mode, powered bike rides) ──────────────
  // Shown on any ride with a real power meter — not gated on auto-detection.
  // The toggle is always off by default; user opts in explicitly.
  const ftpSignal = looksLikeFtpTest(actual);
  const showFtpPrompt = isTriMode && actual.deviceWatts === true && (actual.averageWatts ?? 0) >= 80;
  const ftpPromptHtml = showFtpPrompt ? `
    <div class="ad-fade" style="animation-delay:0.46s;margin-bottom:16px">
      <div id="ad-ftp-prompt-card" style="${CARD};padding:14px 16px">
        <div style="font-size:13px;font-weight:600;color:${TEXT_M};margin-bottom:8px">Was this an FTP test?</div>
        ${ftpSignal.best20MinW ? `<div style="font-size:12px;color:${TEXT_S};line-height:1.5;margin-bottom:12px">Best 20-min power: ${Math.round(ftpSignal.best20MinW)}W. FTP estimate ${ftpSignal.estimatedFtp}W (×0.95, Coggan).</div>` : `<div style="font-size:12px;color:${TEXT_S};line-height:1.5;margin-bottom:12px">Average power: ${Math.round(actual.averageWatts ?? 0)}W — FTP estimate ${Math.round((actual.averageWatts ?? 0) * 0.95)}W (×0.95).</div>`}
        <button id="ad-ftp-toggle" data-active="false"
          data-ftp="${ftpSignal.estimatedFtp ?? Math.round((actual.averageWatts ?? 0) * 0.95)}"
          data-twenty-min="${ftpSignal.best20MinW ?? actual.averageWatts ?? 0}"
          style="padding:8px 18px;border-radius:100px;background:transparent;border:1px solid var(--c-border);color:#0F172A;font-size:13px;font-weight:500;cursor:pointer;transition:background 0.15s,color 0.15s,border-color 0.15s">
          Use as FTP test
        </button>
        <div id="ad-ftp-confirm" style="display:none;margin-top:10px;font-size:12px;color:${TEXT_S}"></div>
      </div>
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
      <!-- Scroll atmosphere — mint palette, halo upper-centre. Reads as "session reflection". -->
      ${buildScrollAtmosphereBackground('adv', 'mint', { haloCenter: { cx: 200, cy: 280 } })}
      ${buildSunGlint('low')}
      <div style="position:relative;z-index:10;max-width:480px;margin:0 auto;padding-bottom:48px">

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
            <div style="font-size:12px;color:${TEXT_S};margin-top:3px">${dateStr ? dateStr + ' · ' : ''}${source}${stravaActivityId ? ` · <a href="https://www.strava.com/activities/${stravaActivityId}" target="_blank" rel="noopener" style="color:#FC5200;text-decoration:none;font-weight:600">View on Strava</a>` : ''}</div>
          </div>
          <button id="act-detail-discard" title="Discard activity" style="
            width:36px;height:36px;border-radius:50%;border:1px solid rgba(0,0,0,0.09);
            background:transparent;display:flex;align-items:center;justify-content:center;
            cursor:pointer;flex-shrink:0;
          ">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="${TEXT_S}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M6 6l1 14a2 2 0 002 2h6a2 2 0 002-2l1-14"/></svg>
          </button>
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
          ${repsHtml}
          ${insightHtml}
          ${cssPromptHtml}
          ${ftpPromptHtml}
          ${actual.polyline ? `
            <div class="ad-fade" style="animation-delay:0.50s;margin-bottom:16px">
              <button id="ad-safety-cta" style="
                width:100%;text-align:left;padding:13px 16px;border-radius:12px;
                background:transparent;border:1px solid var(--c-border);
                color:var(--c-muted);font-size:13px;cursor:pointer;
                display:flex;align-items:center;justify-content:space-between
              ">
                <span>Rate this route's safety</span>
                <span style="font-size:11px">→</span>
              </button>
            </div>
          ` : ''}
        </div>

      </div>
    </div>
    ${renderTabBar('home')}
  `;
}

// ── Navigation ───────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./main-view').then(m => m.renderMainView());
  else if (tab === 'forecast') import('./triathlon/forecast-view').then(m => m.renderTriathlonForecastView());
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

  // Discard → permanent ignore + remove from week, then return
  document.getElementById('act-detail-discard')?.addEventListener('click', () => {
    showDiscardOverlay(actual, returnView);
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
      import('./main-view').then(({ renderMainView }) => renderMainView());
    }
  });

  // CSS benchmark apply button
  document.getElementById('ad-apply-css')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const estimatedCss = parseInt(btn.dataset.css ?? '0', 10);
    if (!estimatedCss) return;
    const ms = getMutableState();
    if (!ms.triConfig) return;
    if (!ms.triConfig.swim) ms.triConfig.swim = {};
    ms.triConfig.swim.cssSecPer100m = estimatedCss;
    ms.triConfig.swim.cssSource = 'user';
    ms.triConfig.swim.cssConfidence = 'high';
    if (ms.triConfig.prediction) ms.triConfig.prediction = undefined;
    regenerateTriPlan(ms);
    saveState();
    renderActivityDetail(actual, planWorkoutName, returnView, plannedTSS, workoutId);
  });

  // FTP benchmark toggle — pill button, off by default, user opts in
  document.getElementById('ad-ftp-toggle')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const isActive = btn.dataset.active === 'true';
    const estimatedFtp = parseInt(btn.dataset.ftp ?? '0', 10);
    const twentyMinW = parseInt(btn.dataset.twentyMin ?? '0', 10);
    const confirmEl = document.getElementById('ad-ftp-confirm');
    if (!estimatedFtp) return;

    if (!isActive) {
      // Activate
      btn.dataset.active = 'true';
      btn.style.background = '#0F172A';
      btn.style.color = '#FAF9F6';
      btn.style.borderColor = '#0F172A';
      btn.textContent = 'FTP test applied';
      const ms = getMutableState();
      if (!ms.triConfig) return;
      if (!ms.triConfig.bike) ms.triConfig.bike = {};
      ms.triConfig.bike.ftp = estimatedFtp;
      ms.triConfig.bike.ftpSource = 'user';
      ms.triConfig.bike.ftpConfidence = 'high';
      ms.triConfig.bike.twentyMinW = twentyMinW || undefined;
      ms.triConfig.bike.hasPowerMeter = true;
      if (ms.triConfig.prediction) ms.triConfig.prediction = undefined;
      regenerateTriPlan(ms);
      saveState();
      if (confirmEl) { confirmEl.textContent = `FTP set to ${estimatedFtp}W. Bike workout targets updated.`; confirmEl.style.display = 'block'; }
    } else {
      // Deactivate — clear back to unconfirmed state
      btn.dataset.active = 'false';
      btn.style.background = 'transparent';
      btn.style.color = '#0F172A';
      btn.style.borderColor = '';
      btn.textContent = 'Use as FTP test';
      if (confirmEl) confirmEl.style.display = 'none';
    }
  });

  // Safety CTA — opens rating modal, submits trimmed polyline on confirm
  document.getElementById('ad-safety-cta')?.addEventListener('click', async function handleSafetyCta() {
    const btn = document.getElementById('ad-safety-cta') as HTMLButtonElement | null;
    if (!btn) return;

    const result = await openSafetyRatingModal();
    if (!result.submitted) return;

    const encoded = actual.polyline;
    if (!encoded) return;

    const points = decodePolylineToLatLng(encoded);
    const trimResult = trimRouteEnds(points);
    if (!trimResult) return;

    const source = actual.garminId?.startsWith('strava-') ? 'strava' : 'garmin';
    await submitRouteSafetyRating({
      activityId: actual.garminId,
      source,
      polylineTrimmed: trimResult.encodedPolyline,
      pointCount: trimResult.pointCount,
      distanceKm: trimResult.distanceKm,
      safetyScore: result.score,
      centerLat: trimResult.centerLat,
      centerLng: trimResult.centerLng,
      boundsNorth: trimResult.boundsNorth,
      boundsSouth: trimResult.boundsSouth,
      boundsEast: trimResult.boundsEast,
      boundsWest: trimResult.boundsWest,
    });

    if (btn) {
      btn.querySelector('span')!.textContent = result.score != null
        ? `Route rated ${result.score}/10`
        : 'Route submitted';
      btn.style.color = 'var(--c-ok)';
      btn.style.borderColor = 'var(--c-ok)';
      btn.disabled = true;
    }
  });
}

/** Inline plan regeneration — called immediately after CSS or FTP is saved so
 *  workout descriptions reflect the new benchmark without waiting for a reload. */
function regenerateTriPlan(ms: ReturnType<typeof getMutableState>): void {
  if (ms.eventType !== 'triathlon' || !ms.triConfig || !ms.wks?.length) return;
  import('@/workouts/plan_engine.triathlon').then(({ generateTriathlonPlan, TRI_GENERATOR_VERSION }) => {
    const fresh = generateTriathlonPlan(ms);
    for (let i = 0; i < Math.min(ms.wks!.length, fresh.length); i++) {
      ms.wks![i].triWorkouts = fresh[i].triWorkouts;
      ms.wks![i].ph = fresh[i].ph;
    }
    if (ms.triConfig) ms.triConfig.generatorVersion = TRI_GENERATOR_VERSION;
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
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:${PAGE_BG}">
      <div style="font-size:15px;font-weight:600;color:${TEXT_M};margin-bottom:2px">${esc(name)}</div>
      <div style="font-size:12px;color:${TEXT_S};margin-bottom:4px">${dist ? dist + ' \u00b7 ' : ''}${mins} min</div>
      ${expectedLine}
      <div style="display:flex;align-items:center;gap:12px">
        <input type="range" min="1" max="10" step="1" value="${currentRpe}"
               id="rpe-detail-slider" class="m-slider-glass">
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

// ── Discard activity overlay ─────────────────────────────────────────────────

function showDiscardOverlay(actual: GarminActual, returnView: ActivityDetailSource): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.background = 'rgba(0,0,0,0.45)';

  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:${PAGE_BG}">
      <div style="font-size:16px;font-weight:600;color:${TEXT_M};margin-bottom:6px">Discard this activity?</div>
      <div style="font-size:13px;line-height:1.55;color:${TEXT_S};margin-bottom:18px">
        Removes it from your week and prevents future syncs from re-importing it. Use this for backfill duplicates you do not want.
      </div>
      <div style="display:flex;gap:8px">
        <button id="discard-cancel" style="flex:1;height:40px;border-radius:12px;border:1px solid rgba(0,0,0,0.09);
                background:transparent;font-size:13px;font-weight:600;color:${TEXT_S};cursor:pointer">Cancel</button>
        <button id="discard-confirm" style="flex:1;height:40px;border-radius:12px;border:none;
                background:#EF4444;font-size:13px;font-weight:600;color:#fff;cursor:pointer">Discard</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  document.getElementById('discard-cancel')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  document.getElementById('discard-confirm')!.addEventListener('click', async () => {
    overlay.remove();
    const { removeGarminActivity } = await import('./events');
    removeGarminActivity(actual.garminId, { permanent: true, skipConfirm: true });
    if (returnView === 'home') {
      const { renderHomeView } = await import('./home-view');
      renderHomeView();
    } else if (returnView === 'strain') {
      const { renderStrainView } = await import('./strain-view');
      renderStrainView();
    } else {
      const { renderMainView } = await import('./main-view');
      renderMainView();
    }
  });
}
