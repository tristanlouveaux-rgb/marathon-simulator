/**
 * activity-detail.ts
 * Full-page view for a single activity: stats grid, HR zones, km splits, route map.
 * Navigated to from plan-view and home-view; back button returns to source view.
 */

import type { GarminActual } from '@/types';
import { drawPolylineOnCanvas } from './strava-detail';
import { getState } from '@/state';
import { formatKm } from '@/utils/format';

export type ActivityDetailSource = 'plan' | 'home';

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

function buildDetailHTML(actual: GarminActual, planWorkoutName: string, plannedTSS?: number, unitPref: 'km' | 'mi' = 'km'): string {
  const source = actual.garminId?.startsWith('strava-') ? 'Strava' : 'Garmin';
  const actName = actual.workoutName || actual.displayName || planWorkoutName || 'Activity';
  const dateStr = actual.startTime
    ? new Date(actual.startTime).toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    })
    : '';

  // ─── Stats grid — always 5 cells, — for missing fields ──────────────────────
  const stats: { val: string; lbl: string }[] = [
    { val: actual.distanceKm > 0.1 ? formatKm(actual.distanceKm, unitPref, 2) : '—', lbl: 'Distance' },
    { val: actual.durationSec > 0 ? fmtDuration(actual.durationSec) : '—', lbl: 'Time' },
    { val: actual.avgPaceSecKm ? fmtPace(actual.avgPaceSecKm, unitPref) : '—', lbl: 'Avg Pace' },
    { val: actual.avgHR ? `${actual.avgHR} bpm` : '—', lbl: 'Avg HR' },
    { val: actual.maxHR ? `${actual.maxHR} bpm` : '—', lbl: 'Max HR' },
  ];

  const statsHtml = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:20px">
      ${stats.map(item => `
        <div style="padding:12px 14px;background:var(--c-surface);border-radius:var(--r-card);border:1px solid var(--c-border)">
          <div style="font-size:20px;font-weight:300;letter-spacing:-0.03em;line-height:1.1;color:${item.val === '—' ? 'var(--c-faint)' : 'inherit'}">${esc(item.val)}</div>
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-top:4px">${item.lbl}</div>
        </div>
      `).join('')}
    </div>
  `;

  // ─── Training Load ───────────────────────────────────────────────────────────
  const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : 0;
  const actualTSS = actual.iTrimp != null && actual.iTrimp > 0
    ? Math.round((actual.iTrimp * 100) / 15000)
    : durMin > 0 ? Math.round(durMin * 0.92) : null;

  let loadHtml = '';
  if (actualTSS != null) {
    // Training effect chips
    const teLabel = (v: number) => v < 1.0 ? 'No effect' : v < 2.0 ? 'Minor' : v < 3.0 ? 'Maintaining' : v < 4.0 ? 'Improving' : v < 5.0 ? 'Highly improving' : 'Overreaching';
    const teColor = (v: number) => v < 2.0 ? 'var(--c-faint)' : v < 3.5 ? '#22C55E' : v < 4.5 ? '#F97316' : '#EF4444';
    const teChips = [
      actual.aerobicEffect != null ? `<span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;background:rgba(0,0,0,0.04);border:1px solid var(--c-border);color:${teColor(actual.aerobicEffect)}">Aerobic ${actual.aerobicEffect.toFixed(1)} · ${teLabel(actual.aerobicEffect)}</span>` : '',
      actual.anaerobicEffect != null ? `<span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:5px;background:rgba(0,0,0,0.04);border:1px solid var(--c-border);color:${teColor(actual.anaerobicEffect)}">Anaerobic ${actual.anaerobicEffect.toFixed(1)} · ${teLabel(actual.anaerobicEffect)}</span>` : '',
    ].filter(Boolean).join('');

    if (plannedTSS && plannedTSS > 0) {
      // Planned vs actual comparison
      const maxTSS = Math.max(plannedTSS, actualTSS, 1);
      const ratio = actualTSS / plannedTSS;
      const actualColor = ratio > 1.15 ? '#EF4444' : ratio < 0.80 ? '#EAB308' : '#22C55E';
      const diffPct = Math.round((ratio - 1) * 100);
      const diffStr = diffPct === 0 ? 'on target' : diffPct > 0 ? `+${diffPct}% vs planned` : `${diffPct}% vs planned`;
      loadHtml = `
        <div style="margin-bottom:20px">
          <div class="m-sec-label">Training Load</div>
          <div class="m-card" style="padding:14px 16px">
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:12px">
              <span style="font-size:28px;font-weight:300;letter-spacing:-0.03em;color:${actualColor}">${actualTSS}</span>
              <span style="font-size:11px;color:var(--c-muted)">TSS · ${actual.iTrimp != null ? 'HR-based' : 'estimated'}</span>
              <span style="font-size:11px;font-weight:500;color:${actualColor};margin-left:auto">${diffStr}</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:10px;color:var(--c-muted);width:50px;flex-shrink:0">Planned</span>
                <div style="flex:1;height:5px;background:rgba(0,0,0,0.05);border-radius:3px;overflow:hidden">
                  <div style="width:${Math.round((plannedTSS / maxTSS) * 100)}%;height:100%;background:var(--c-border);border-radius:3px"></div>
                </div>
                <span style="font-size:10px;color:var(--c-faint);width:44px;text-align:right;flex-shrink:0">${plannedTSS} TSS</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:10px;color:var(--c-muted);width:50px;flex-shrink:0">Actual</span>
                <div style="flex:1;height:5px;background:rgba(0,0,0,0.05);border-radius:3px;overflow:hidden">
                  <div style="width:${Math.round((actualTSS / maxTSS) * 100)}%;height:100%;background:${actualColor};border-radius:3px"></div>
                </div>
                <span style="font-size:10px;font-weight:600;color:${actualColor};width:44px;text-align:right;flex-shrink:0">${actualTSS} TSS</span>
              </div>
            </div>
            ${teChips ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">${teChips}</div>` : ''}
          </div>
        </div>
      `;
    } else {
      // No planned TSS — just show actual
      loadHtml = `
        <div style="margin-bottom:20px">
          <div class="m-sec-label">Training Load</div>
          <div class="m-card" style="padding:14px 16px">
            <div style="display:flex;align-items:baseline;gap:8px${teChips ? ';margin-bottom:12px' : ''}">
              <span style="font-size:28px;font-weight:300;letter-spacing:-0.03em">${actualTSS}</span>
              <span style="font-size:11px;color:var(--c-muted)">TSS · ${actual.iTrimp != null ? 'HR-based' : 'estimated'}</span>
            </div>
            ${teChips ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${teChips}</div>` : ''}
          </div>
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
  const isRunActivity = !actual.activityType || actual.activityType.includes('RUN');
  let splitsHtml = '';
  if (isRunActivity && actual.kmSplits && actual.kmSplits.length > 0) {
    // Filter GPS outliers (pauses produce >900s/km, jumps produce <60s/km)
    const splits = actual.kmSplits.filter(p => p >= 60 && p <= 900);
    if (splits.length === 0) { /* no valid splits — skip rendering */ }
    else {
    const minP = Math.min(...splits);
    const maxP = Math.max(...splits);
    const range = Math.max(maxP - minP, 30); // minimum 30s range so tight runs show variation
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
          <span style="font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;width:56px;text-align:right;flex-shrink:0">${fmtPace(pace, unitPref)}</span>
        </div>
      `;
    }).join('');
    splitsHtml = `
      <div style="margin-bottom:20px">
        <div class="m-sec-label">${unitPref === 'mi' ? 'mi' : 'km'} Splits</div>
        <div class="m-card" style="padding:6px 14px">${rows}</div>
      </div>
    `;
    } // end else (valid splits)
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
        ${loadHtml}
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
  plannedTSS?: number,
): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const unitPref = getState().unitPref ?? 'km';
  container.innerHTML = buildDetailHTML(actual, planWorkoutName, plannedTSS, unitPref);

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
