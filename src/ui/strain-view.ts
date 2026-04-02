/**
 * Strain detail page — new iPhone-native design language.
 * Opens when tapping the Strain ring on the Home view.
 * Shows strain %, 7-day rolling stats, coaching insight, and activity timeline.
 */

import { getState } from '@/state';
import type { SimulatorState, GarminActual, Week } from '@/types/state';
import {
  computeTodaySignalBTSS,
  computePlannedDaySignalBTSS,
  getTrailingEffortScore,
} from '@/calculations/fitness-model';
import { generateWeekWorkouts } from '@/workouts';
import { formatActivityType } from '@/calculations/activity-matcher';

// ── Design tokens ─────────────────────────────────────────────────────────────

const CREAM     = '#FDF7F2';
const GRAD_BG   = 'linear-gradient(180deg, #2d1810 0%, #4a2518 40%, #5d3020 100%)';
const ORANGE_A  = '#FF9A44';
const ORANGE_B  = '#FF512F';
const RING_R    = 57;
const RING_CIRC = +(2 * Math.PI * RING_R).toFixed(2); // ≈ 358.14

// ── Date helpers ──────────────────────────────────────────────────────────────

function weekIdxForDate(date: string, planStartDate: string): number {
  const ms = new Date(date + 'T12:00:00').getTime() - new Date(planStartDate + 'T12:00:00').getTime();
  return Math.max(0, Math.floor(ms / (7 * 24 * 3600 * 1000)));
}

function fmtDateLong(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function fmtDateShort(date: string, today: string): string {
  if (date === today) return 'Today';
  const yest = new Date(today + 'T12:00:00');
  yest.setDate(yest.getDate() - 1);
  if (date === yest.toISOString().split('T')[0]) return 'Yesterday';
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function fmtTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtDurMin(durationSec: number): string {
  const m = Math.round(durationSec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function activitiesForDate(date: string, wks: Week[]): GarminActual[] {
  const out: GarminActual[] = [];
  for (const wk of wks) {
    for (const a of Object.values(wk.garminActuals ?? {})) {
      if (a.startTime?.startsWith(date)) out.push(a);
    }
  }
  return out;
}

interface DayData {
  date: string;
  durationMin: number;
  calories: number | null;
  signalBTSS: number;
  activities: GarminActual[];
}

function getDayData(date: string, s: SimulatorState): DayData {
  const wks = s.wks ?? [];
  const acts = activitiesForDate(date, wks);
  const durationMin = acts.reduce((sum, a) => sum + a.durationSec / 60, 0);
  const hasCalories = acts.some(a => a.calories != null);
  const calories = hasCalories ? acts.reduce((sum, a) => sum + (a.calories ?? 0), 0) : null;

  let signalBTSS = 0;
  if (s.planStartDate) {
    const wk = wks[weekIdxForDate(date, s.planStartDate)];
    if (wk) signalBTSS = computeTodaySignalBTSS(wk, date);
  } else {
    signalBTSS = acts.reduce((sum, a) => a.iTrimp != null ? sum + (a.iTrimp * 100) / 15000 : sum, 0);
  }

  return { date, durationMin, calories, signalBTSS, activities: acts };
}

function getLast7Days(today: string, s: SimulatorState): DayData[] {
  const days: DayData[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() - i);
    days.push(getDayData(d.toISOString().split('T')[0], s));
  }
  return days;
}

function getStrainForDate(
  date: string,
  s: SimulatorState,
): { strainPct: number; actualTSS: number; targetTSS: number } {
  const today = new Date().toISOString().split('T')[0];
  const isToday = date === today;
  const wks = s.wks ?? [];

  // Actual Signal B TSS
  let actualTSS = 0;
  if (s.planStartDate) {
    const wk = wks[weekIdxForDate(date, s.planStartDate)];
    if (wk) actualTSS = computeTodaySignalBTSS(wk, date);
  } else {
    const acts = activitiesForDate(date, wks);
    actualTSS = acts.reduce((sum, a) => a.iTrimp != null ? sum + (a.iTrimp * 100) / 15000 : sum, 0);
  }

  // Target TSS
  let targetTSS: number;
  if (isToday) {
    // Use today's planned workout TSS (same logic as home-view buildReadinessRing)
    const wk = wks[s.w - 1];
    if (wk) {
      const dayOfWeek = (new Date(date + 'T12:00:00').getDay() + 6) % 7;
      const plannedWorkouts = generateWeekWorkouts(
        wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
        null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e,
        s.w, s.tw, s.v, s.gs, getTrailingEffortScore(wks, s.w), wk.scheduledAcwrStatus,
      );
      const plannedDay = computePlannedDaySignalBTSS(plannedWorkouts, dayOfWeek);
      targetTSS = plannedDay > 0 ? plannedDay : Math.max((s.signalBBaseline ?? 0) / 7, 1);
    } else {
      targetTSS = Math.max((s.signalBBaseline ?? 0) / 7, 1);
    }
  } else {
    // Historical — compare against daily baseline
    targetTSS = Math.max((s.signalBBaseline ?? 0) / 7, 1);
  }

  return {
    strainPct: actualTSS > 0 ? (actualTSS / targetTSS) * 100 : 0,
    actualTSS,
    targetTSS,
  };
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function sparklinePath(values: number[]): string {
  const max = Math.max(...values, 0.001);
  if (max === 0.001) return '';
  const w = 100;
  const h = 30;
  const pts = values.map((v, i) => [
    (i / Math.max(values.length - 1, 1)) * w,
    h - (v / max) * h * 0.85 + h * 0.075,
  ] as [number, number]);
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    const mx = ((x1 + x2) / 2).toFixed(1);
    const my = ((y1 + y2) / 2).toFixed(1);
    d += ` Q${x1.toFixed(1)},${y1.toFixed(1)} ${mx},${my}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  d += ` T${lx.toFixed(1)},${ly.toFixed(1)}`;
  return d;
}

// ── Coaching copy (factual, consultant tone, no emoji) ────────────────────────

function coachingText(
  strainPct: number,
  actualTSS: number,
  targetTSS: number,
  isToday: boolean,
  weekKm: number,
): string {
  const actual = Math.round(actualTSS);
  const target = Math.round(targetTSS);
  const kmNote = weekKm > 0.5 ? ` ${weekKm.toFixed(1)} km logged this week.` : '';

  if (!isToday) {
    if (actual === 0) return target > 0 ? `No activities recorded. ${target} TSS daily baseline.` : 'Rest day.';
    if (strainPct >= 130) return `${actual} TSS — ${Math.round(strainPct - 100)}% above daily baseline.${kmNote}`;
    return `${actual} TSS logged against a ${target} TSS daily baseline.${kmNote}`;
  }

  if (strainPct >= 130) return `Daily load exceeded target. ${actual} TSS logged against ${target} TSS planned. Avoid additional training today.`;
  if (strainPct >= 100) return `Daily target reached. ${actual} TSS logged against ${target} TSS planned. Training complete for today.${kmNote}`;
  if (strainPct > 0)    return `${actual} TSS logged. ${Math.round(strainPct)}% of the ${target} TSS target reached.${kmNote}`;
  if (target > 0)       return `No load logged yet. ${target} TSS planned for today.${kmNote}`;
  return 'Rest day. No sessions scheduled today.';
}

// ── Activity icon (sport-specific SVG) ───────────────────────────────────────

function activityIcon(type: string): string {
  const t = (type ?? '').toUpperCase();
  const stroke = ORANGE_B;
  if (t.includes('RUN')) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M15 8H9l-2 8"/><path d="M9 8l-2 8h10l-1-4"/></svg>`;
  }
  if (t.includes('CYCL') || t.includes('BIKE') || t.includes('MOUNTAIN')) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><path d="M15 6h-1l-3 7H5.5"/><path d="M12 6l1 7h4.5"/></svg>`;
  }
  if (t.includes('SWIM')) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h2a2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1 2-2 2 2 0 0 1 2 2h2"/><path d="M2 17h2a2 2 0 0 1 2-2 2 2 0 0 1 2 2h2a2 2 0 0 1 2-2 2 2 0 0 1 2 2h2"/></svg>`;
  }
  if (t.includes('WALK') || t.includes('HIKE')) {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M9 8l-2 8m7-8l2 4-4 2-1 6"/></svg>`;
  }
  // Default — dumbbell / strength
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5h11M6.5 17.5h11M2 9.5h20M2 14.5h20"/></svg>`;
}

// ── Main HTML ─────────────────────────────────────────────────────────────────

function getStrainHTML(s: SimulatorState, displayDate: string): string {
  const today = new Date().toISOString().split('T')[0];
  const isToday = displayDate === today;

  const { strainPct, actualTSS, targetTSS } = getStrainForDate(displayDate, s);
  const displayData = getDayData(displayDate, s);
  const sevenDays = getLast7Days(today, s);

  // Ring
  const ringPct = Math.min(strainPct, 100);
  const targetOffset = +(RING_CIRC * (1 - ringPct / 100)).toFixed(2);
  const ringColor = strainPct >= 130 ? '#FF3B30' : strainPct >= 100 ? '#34C759' : `url(#strainGrad)`;

  // Stat cards — 7-day totals + sparklines
  const durationVals = sevenDays.map(d => Math.round(d.durationMin));
  const calVals      = sevenDays.map(d => d.calories ?? 0);
  const totalDurMin  = sevenDays.reduce((sum, d) => sum + d.durationMin, 0);
  const hasAnyCals   = sevenDays.some(d => d.calories != null);
  const totalCal     = hasAnyCals ? sevenDays.reduce((sum, d) => sum + (d.calories ?? 0), 0) : null;
  const durPath      = sparklinePath(durationVals);
  const calPath      = sparklinePath(calVals);

  // Week km for coaching note
  const currentWk = s.wks?.[s.w - 1];
  const weekKm = currentWk
    ? Object.values(currentWk.garminActuals ?? {}).reduce((sum, a) => sum + (a.distanceKm ?? 0), 0)
    : 0;

  // Coaching text
  const coaching = coachingText(strainPct, actualTSS, targetTSS, isToday, weekKm);
  const coachHeadline = strainPct >= 130 ? 'Exceeded target'
    : strainPct >= 100 ? 'Target reached'
    : strainPct > 0 ? 'Session in progress'
    : 'No load recorded';

  // Date picker pills (last 7 days, oldest → today)
  const datePills = sevenDays.map(d => {
    const active = d.date === displayDate;
    return `<button class="strain-date-pill" data-date="${d.date}" style="
      padding:6px 16px;border-radius:100px;border:none;cursor:pointer;
      font-size:13px;font-weight:${active ? '600' : '400'};font-family:var(--f);
      background:${active ? 'rgba(255,255,255,0.22)' : 'transparent'};
      color:${active ? 'white' : 'rgba(255,255,255,0.55)'};
      backdrop-filter:${active ? 'blur(8px)' : 'none'};
      white-space:nowrap;transition:background 0.15s,color 0.15s;
    ">${fmtDateShort(d.date, today)}</button>`;
  }).join('');

  // Timeline rows
  const acts = displayData.activities;
  const timelineHTML = acts.length === 0
    ? `<div style="padding:24px;text-align:center;font-size:13px;color:rgba(0,0,0,0.3)">No activities recorded</div>`
    : acts.map(a => {
        const name = a.displayName || a.workoutName || formatActivityType(a.activityType ?? '');
        const timeStr = a.startTime ? fmtTime(a.startTime) : '';
        const durStr  = fmtDurMin(a.durationSec);
        const tss     = a.iTrimp != null ? Math.round((a.iTrimp * 100) / 15000) : null;
        return `
          <div class="strain-act-row" data-garmin-id="${a.garminId}" style="
            display:flex;align-items:center;gap:12px;
            background:white;border-radius:20px;padding:12px 16px;
            box-shadow:0 4px 20px -2px rgba(0,0,0,0.05);
            cursor:pointer;margin-bottom:10px;
            transition:transform 0.1s;
          ">
            <div style="
              position:relative;width:48px;height:48px;flex-shrink:0;
              background:#FFF3ED;border-radius:16px;
              display:flex;align-items:center;justify-content:center;
            ">
              ${activityIcon(a.activityType ?? '')}
              ${tss != null ? `<div style="
                position:absolute;bottom:-5px;right:-5px;
                background:white;border:1px solid rgba(255,80,47,0.35);
                border-radius:6px;padding:1px 5px;
                font-size:10px;font-weight:700;color:${ORANGE_B};line-height:1.4;
              ">${tss}</div>` : ''}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:15px;font-weight:600;color:#111">${name}</div>
              <div style="font-size:13px;color:#999;margin-top:1px">${timeStr}${timeStr && durStr ? ' · ' : ''}${durStr}</div>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </div>`;
      }).join('');

  return `
    <style>
      #strain-view { box-sizing: border-box; }
      #strain-view *, #strain-view *::before, #strain-view *::after { box-sizing: inherit; }
      @keyframes strainFloatUp {
        from { opacity:0; transform:translateY(10px); }
        to   { opacity:1; transform:translateY(0); }
      }
      .s-fade { opacity:0; animation:strainFloatUp 0.55s ease-out forwards; }
      .strain-act-row:active { transform:scale(0.98); }
      .strain-date-pill:hover { background:rgba(255,255,255,0.15)!important; color:white!important; }
    </style>

    <div id="strain-view" style="
      position:relative;min-height:100vh;background:${CREAM};
      font-family:var(--f);overflow-x:hidden;
    ">

      <!-- ── Dark gradient top ───────────────────────────────────────── -->
      <div style="
        position:absolute;top:0;left:0;right:0;height:480px;
        background:${GRAD_BG};overflow:hidden;pointer-events:none;z-index:0;
      ">
        <div style="position:absolute;width:280px;height:280px;border-radius:50%;background:${ORANGE_A};filter:blur(80px);opacity:0.5;top:-50px;left:-80px"></div>
        <div style="position:absolute;width:240px;height:240px;border-radius:50%;background:${ORANGE_B};filter:blur(80px);opacity:0.45;top:150px;right:-60px"></div>
        <div style="position:absolute;width:150px;height:150px;border-radius:50%;background:#E5AA86;filter:blur(60px);opacity:0.4;bottom:60px;left:25%"></div>
        <div style="position:absolute;inset:0;background:linear-gradient(to bottom,transparent 55%,${CREAM})"></div>
      </div>

      <!-- ── Scrollable content ──────────────────────────────────────── -->
      <div style="position:relative;z-index:10;padding-bottom:48px">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
          position:sticky;top:0;z-index:50;
        ">
          <button id="strain-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.15);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:white;
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div style="text-align:center">
            <div style="font-size:20px;font-weight:600;color:white;text-shadow:0 1px 4px rgba(0,0,0,0.2)">Strain</div>
            <button id="strain-date-btn" style="
              display:flex;align-items:center;gap:4px;margin:3px auto 0;
              font-size:12px;color:rgba(255,255,255,0.78);font-weight:500;
              background:none;border:none;cursor:pointer;font-family:var(--f);
            ">
              ${fmtDateLong(displayDate)}
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>

          <button id="strain-info-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.2);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:white;
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </button>
        </div>

        <!-- Date picker (collapsed by default, scrollable row) -->
        <div id="strain-date-picker" style="
          display:none;overflow-x:auto;padding:0 16px 12px;
          scrollbar-width:none;-ms-overflow-style:none;
        ">
          <div style="display:flex;gap:6px;width:max-content;padding-bottom:2px">${datePills}</div>
        </div>

        <!-- Ring -->
        <div class="s-fade" style="animation-delay:0.08s;display:flex;justify-content:center;margin:12px 0 28px">
          <div style="
            position:relative;width:220px;height:220px;
            display:flex;align-items:center;justify-content:center;
            background:rgba(255,255,255,0.18);backdrop-filter:blur(20px);
            border-radius:50%;border:1px solid rgba(255,255,255,0.3);
            box-shadow:0 8px 60px -10px rgba(0,0,0,0.35);
          ">
            <svg width="180" height="180" viewBox="0 0 130 130" style="transform:rotate(-90deg)">
              <defs>
                <linearGradient id="strainGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${ORANGE_A}"/>
                  <stop offset="100%" stop-color="${ORANGE_B}"/>
                </linearGradient>
              </defs>
              <circle cx="65" cy="65" r="${RING_R}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="12"/>
              <circle id="strain-ring-circle" cx="65" cy="65" r="${RING_R}" fill="none"
                stroke="${ringColor}" stroke-width="12" stroke-linecap="round"
                stroke-dasharray="${RING_CIRC}"
                stroke-dashoffset="${RING_CIRC}"
                style="transition:stroke-dashoffset 1.4s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
              />
            </svg>
            <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-top:6px">
              <div style="display:flex;align-items:baseline;color:white;font-weight:700;text-shadow:0 1px 8px rgba(0,0,0,0.25)">
                <span style="font-size:52px;letter-spacing:-0.03em;line-height:1">${Math.round(strainPct)}</span>
                <span style="font-size:22px;margin-left:1px">%</span>
              </div>
              <span style="color:rgba(255,255,255,0.78);font-size:12px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;margin-top:-2px;text-shadow:0 1px 4px rgba(0,0,0,0.2)">strain</span>
            </div>
          </div>
        </div>

        <!-- Stat cards -->
        <div class="s-fade" style="animation-delay:0.18s;padding:0 16px;display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">

          <!-- Duration -->
          <div style="background:white;border-radius:20px;padding:16px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.05)">
            <div style="display:flex;align-items:center;gap:6px;color:#9CA3AF;margin-bottom:10px">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span style="font-size:12px;font-weight:500">7-day mins</span>
            </div>
            <div style="display:flex;align-items:baseline">
              <span style="font-size:28px;font-weight:600;color:#111;line-height:1">${Math.round(totalDurMin)}</span>
              <span style="font-size:14px;font-weight:500;color:#111;margin-left:2px">m</span>
            </div>
            <div style="margin-top:14px;height:32px">
              ${durPath ? `<svg viewBox="0 0 100 30" style="width:100%;height:100%;overflow:visible"><path d="${durPath}" fill="none" stroke="${ORANGE_B}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ''}
            </div>
          </div>

          <!-- Calories -->
          <div style="background:white;border-radius:20px;padding:16px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.05)">
            <div style="display:flex;align-items:center;gap:6px;color:#9CA3AF;margin-bottom:10px">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
              <span style="font-size:12px;font-weight:500">7-day kCal</span>
            </div>
            <div style="display:flex;align-items:baseline">
              <span style="font-size:28px;font-weight:600;color:#111;line-height:1">${totalCal != null ? Math.round(totalCal) : '—'}</span>
              ${totalCal != null ? `<span style="font-size:12px;font-weight:500;color:#888;margin-left:4px">kCal</span>` : ''}
            </div>
            <div style="margin-top:14px;height:32px">
              ${calPath && totalCal != null ? `<svg viewBox="0 0 100 30" style="width:100%;height:100%;overflow:visible"><path d="${calPath}" fill="none" stroke="${ORANGE_A}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ''}
            </div>
          </div>
        </div>

        <!-- Coaching card -->
        <div class="s-fade" style="animation-delay:0.28s;padding:0 16px;margin-bottom:20px">
          <div style="
            background:rgba(255,255,255,0.95);border-radius:20px;padding:18px 20px;
            box-shadow:0 4px 20px -2px rgba(0,0,0,0.05);border:1px solid rgba(255,255,255,0.8);
          ">
            <div style="font-size:15px;font-weight:600;color:#111;margin-bottom:6px">${coachHeadline}</div>
            <p style="font-size:14px;line-height:1.6;color:#555;margin:0">${coaching}</p>
          </div>
        </div>

        <!-- Timeline -->
        <div class="s-fade" style="animation-delay:0.38s;padding:0 16px">
          <h2 style="font-size:15px;font-weight:600;color:#111;margin:0 0 12px 4px">Timeline</h2>
          ${timelineHTML}
        </div>

      </div>
    </div>
  `;
}

// ── Info overlay ──────────────────────────────────────────────────────────────

function showStrainInfoOverlay(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:300;
    display:flex;align-items:center;justify-content:center;padding:20px;
    background:rgba(0,0,0,0.5);
  `;
  overlay.innerHTML = `
    <div style="background:white;border-radius:24px;padding:24px;max-width:380px;width:100%">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="font-size:17px;font-weight:700;margin:0;color:#111">What is Strain?</h2>
        <button id="strain-info-close" style="
          border:none;background:rgba(0,0,0,0.07);border-radius:50%;
          width:32px;height:32px;cursor:pointer;color:#555;
          display:flex;align-items:center;justify-content:center;font-size:16px;
        ">✕</button>
      </div>
      <p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 12px">
        Strain is today's completed physiological load as a percentage of the day's target. 100% means the planned session is done.
      </p>
      <p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 16px">
        It uses <strong>Signal B</strong> — raw physiological load with no sport discount. A 60-minute padel session and a 60-minute easy run at the same intensity contribute equally.
      </p>
      <div style="background:#FFF3ED;border-radius:14px;padding:14px">
        <div style="font-size:11px;font-weight:600;color:${ORANGE_B};margin-bottom:10px;letter-spacing:0.05em">THRESHOLDS</div>
        <div style="font-size:13px;color:#555;line-height:2">
          <div><strong style="color:#111">0–50%</strong> — No readiness effect. Session underway.</div>
          <div><strong style="color:#111">50–100%</strong> — Readiness floor applies progressively.</div>
          <div><strong style="color:#111">100%+</strong> — Target hit. No additional training recommended.</div>
          <div><strong style="color:#111">130%+</strong> — Load well exceeded. Injury risk elevated.</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('strain-info-close')?.addEventListener('click', () => overlay.remove());
}

// ── Activity detail overlay ───────────────────────────────────────────────────

function showActivityDetail(act: GarminActual): void {
  const name    = act.displayName || act.workoutName || formatActivityType(act.activityType ?? '');
  const timeStr = act.startTime ? fmtTime(act.startTime) : '—';
  const tss     = act.iTrimp != null ? Math.round((act.iTrimp * 100) / 15000) : null;

  const rows = [
    { label: 'Duration',      value: fmtDurMin(act.durationSec) },
    { label: 'Distance',      value: (act.distanceKm ?? 0) > 0.05 ? `${act.distanceKm!.toFixed(2)} km` : '—' },
    { label: 'Avg HR',        value: act.avgHR != null ? `${act.avgHR} bpm` : '—' },
    { label: 'Max HR',        value: act.maxHR != null ? `${act.maxHR} bpm` : '—' },
    { label: 'Signal B TSS',  value: tss != null ? String(tss) : '—' },
    { label: 'Calories',      value: act.calories != null ? `${act.calories} kCal` : '—' },
  ];

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:300;
    display:flex;align-items:center;justify-content:center;padding:20px;
    background:rgba(0,0,0,0.5);
  `;
  overlay.innerHTML = `
    <div style="background:white;border-radius:24px;padding:24px;max-width:380px;width:100%">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px">
        <div>
          <div style="font-size:18px;font-weight:700;color:#111">${name}</div>
          <div style="font-size:13px;color:#999;margin-top:3px">${timeStr}</div>
        </div>
        <button id="act-detail-close" style="
          border:none;background:rgba(0,0,0,0.07);border-radius:50%;
          width:32px;height:32px;cursor:pointer;color:#555;flex-shrink:0;
          display:flex;align-items:center;justify-content:center;font-size:16px;
        ">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${rows.map(r => `
          <div style="background:#F8F8F8;border-radius:14px;padding:14px">
            <div style="font-size:11px;color:#999;margin-bottom:5px;font-weight:500">${r.label}</div>
            <div style="font-size:20px;font-weight:600;color:#111">${r.value}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('act-detail-close')?.addEventListener('click', () => overlay.remove());
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function wireStrainHandlers(s: SimulatorState, displayDate: string): void {
  const { strainPct } = getStrainForDate(displayDate, s);
  const ringPct = Math.min(strainPct, 100);

  // Animate ring after first paint
  setTimeout(() => {
    const circle = document.getElementById('strain-ring-circle') as SVGCircleElement | null;
    if (circle) {
      circle.style.strokeDashoffset = String((RING_CIRC * (1 - ringPct / 100)).toFixed(2));
    }
  }, 50);

  // Back → home
  document.getElementById('strain-back-btn')?.addEventListener('click', () => {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  });

  // Date picker toggle
  const picker = document.getElementById('strain-date-picker');
  document.getElementById('strain-date-btn')?.addEventListener('click', () => {
    if (!picker) return;
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  });

  // Date pill selection
  document.querySelectorAll<HTMLElement>('.strain-date-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const date = btn.dataset.date;
      if (date) renderStrainView(date);
    });
  });

  // Info overlay
  document.getElementById('strain-info-btn')?.addEventListener('click', () => showStrainInfoOverlay());

  // Timeline activity detail
  document.querySelectorAll<HTMLElement>('.strain-act-row').forEach(row => {
    row.addEventListener('click', () => {
      const gid = row.dataset.garminId;
      if (!gid) return;
      const act = (s.wks ?? [])
        .flatMap(wk => Object.values(wk.garminActuals ?? {}))
        .find(a => a.garminId === gid);
      if (act) showActivityDetail(act);
    });
  });
}

// ── Public entry point ────────────────────────────────────────────────────────

export function renderStrainView(date?: string): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const today = new Date().toISOString().split('T')[0];
  const displayDate = date ?? today;
  container.innerHTML = getStrainHTML(s, displayDate);
  wireStrainHandlers(s, displayDate);
}
