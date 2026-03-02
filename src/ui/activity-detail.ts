/**
 * activity-detail.ts
 * Full-page view for a single activity: stats grid, HR zones, km splits, route map.
 * Navigated to from plan-view and home-view; back button returns to source view.
 */

import type { GarminActual } from '@/types';
import { drawPolylineOnCanvas } from './strava-detail';

export type ActivityDetailSource = 'plan' | 'home';

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
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

function buildDetailHTML(actual: GarminActual, planWorkoutName: string): string {
  const source = actual.garminId?.startsWith('strava-') ? 'Strava' : 'Garmin';
  const actName = actual.workoutName || actual.displayName || planWorkoutName || 'Activity';
  const dateStr = actual.startTime
    ? new Date(actual.startTime).toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      })
    : '';

  // ─── Stats grid ─────────────────────────────────────────────────────────────
  const stats = [
    actual.distanceKm > 0.1 ? { val: `${actual.distanceKm.toFixed(2)} km`, lbl: 'Distance' } : null,
    actual.durationSec > 0 ? { val: fmtDuration(actual.durationSec), lbl: 'Time' } : null,
    actual.avgPaceSecKm ? { val: fmtPace(actual.avgPaceSecKm), lbl: 'Avg Pace' } : null,
    actual.avgHR ? { val: `${actual.avgHR} bpm`, lbl: 'Avg HR' } : null,
    actual.maxHR ? { val: `${actual.maxHR} bpm`, lbl: 'Max HR' } : null,
    actual.calories ? { val: `${actual.calories} kcal`, lbl: 'Calories' } : null,
  ].filter(Boolean) as { val: string; lbl: string }[];

  const statsHtml = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">
      ${stats.map(item => `
        <div style="flex:1;min-width:calc(50% - 4px);padding:12px 14px;background:var(--c-surface);border-radius:var(--r-card);border:1px solid var(--c-border)">
          <div style="font-size:20px;font-weight:300;letter-spacing:-0.03em;line-height:1.1">${esc(item.val)}</div>
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-top:4px">${item.lbl}</div>
        </div>
      `).join('')}
    </div>
  `;

  // ─── Route map ───────────────────────────────────────────────────────────────
  let mapHtml = '';
  if (actual.polyline) {
    const kmSplitsAttr = actual.kmSplits?.length
      ? ` data-km-splits="${esc(JSON.stringify(actual.kmSplits))}"`
      : '';
    mapHtml = `
      <div style="margin-bottom:20px">
        <div class="m-sec-label">Route</div>
        <div class="m-card" style="overflow:hidden;padding:0">
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
        <div style="margin-bottom:20px">
          <div class="m-sec-label">HR Zones</div>
          <div class="m-card" style="padding:14px 16px">
            <div style="height:8px;border-radius:4px;display:flex;overflow:hidden;gap:2px;margin-bottom:12px">
              ${zones.filter(([v]) => v > 0).map(([v, col]) => `<div style="flex:${pct(v)};background:${col}"></div>`).join('')}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px 14px">
              ${zones.filter(([v]) => v > 0).map(([v, col, lbl]) => `
                <span style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--c-muted)">
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
  let splitsHtml = '';
  if (actual.kmSplits && actual.kmSplits.length > 0) {
    const splits = actual.kmSplits;
    const minP = Math.min(...splits);
    const maxP = Math.max(...splits);
    const range = maxP - minP || 1;
    const rows = splits.map((pace, i) => {
      const norm = (pace - minP) / range;
      const barColor = norm < 0.33 ? '#22C55E' : norm < 0.67 ? '#EAB308' : '#EF4444';
      const barWidth = Math.round(30 + norm * 70);
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0${i < splits.length - 1 ? ';border-bottom:1px solid var(--c-border)' : ''}">
          <span style="font-size:10px;font-weight:600;color:var(--c-faint);width:24px;text-align:right;flex-shrink:0">${i + 1}</span>
          <div style="flex:1;height:5px;background:rgba(0,0,0,0.05);border-radius:3px;overflow:hidden">
            <div style="width:${barWidth}%;height:100%;background:${barColor};border-radius:3px"></div>
          </div>
          <span style="font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;width:56px;text-align:right;flex-shrink:0">${fmtPace(pace)}</span>
        </div>
      `;
    }).join('');
    splitsHtml = `
      <div style="margin-bottom:20px">
        <div class="m-sec-label">km Splits</div>
        <div class="m-card" style="padding:6px 14px">${rows}</div>
      </div>
    `;
  }

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      <!-- Header with back button -->
      <div style="padding:14px 18px 12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--c-border);background:var(--c-surface)">
        <button id="act-detail-back"
          style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <div style="flex:1;min-width:0">
          <div style="font-size:17px;font-weight:500;letter-spacing:-0.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(actName)}</div>
          <div style="font-size:11px;color:var(--c-muted)">${dateStr ? dateStr + ' · ' : ''}${source}</div>
        </div>
      </div>

      <!-- Scrollable content -->
      <div style="padding:16px 18px 40px">
        ${statsHtml}
        ${mapHtml}
        ${hrHtml}
        ${splitsHtml}
      </div>

    </div>
  `;
}

export function renderActivityDetail(
  actual: GarminActual,
  planWorkoutName: string,
  returnView: ActivityDetailSource,
): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  container.innerHTML = buildDetailHTML(actual, planWorkoutName);

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

  // Back button
  document.getElementById('act-detail-back')?.addEventListener('click', () => {
    if (returnView === 'home') {
      import('./home-view').then(({ renderHomeView }) => renderHomeView());
    } else {
      import('./plan-view').then(({ renderPlanView }) => renderPlanView());
    }
  });
}
