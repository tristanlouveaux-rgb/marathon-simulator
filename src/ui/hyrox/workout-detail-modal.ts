/**
 * HYROX workout detail modal.
 *
 * Tapped from plan-view or home hero card. Shows the full session breakdown:
 * components list for station/brick, run info for run sessions, MTL + RPE chips.
 */

import type { Workout } from '@/types/state';
import type { HyroxComponent, HyroxStation } from '@/types/triathlon';
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { getSubstitutionsFor, findSubstitution } from '@/constants/hyrox-substitutions';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';

type HyroxDisc = 'run' | 'station' | 'brick';

/** Render a single station row, with optional swap button + active substitution overlay. */
function renderStationRow(
  c: HyroxComponent,
  workout: Workout,
  options: { context: 'technique' | 'density' | 'breakdown'; accent: string }
): string {
  const station = c.type as HyroxStation;
  const display = STATION_DISPLAY[station];
  if (!display) return '';
  const subId = workout.hyroxStationSubs?.[station];
  const sub = subId ? findSubstitution(station, subId) : undefined;
  const distStr = c.reps ? `${c.reps} reps` : display.distance;
  const targetStr = c.durationSec ? fmtSec(c.durationSec) : '—';
  const targetLabel = options.context === 'technique' ? 'per round'
                     : options.context === 'density' ? 'target' : '';
  const showTargetCol = options.context !== 'breakdown';
  // Equipment-swap demoted to a small icon button on the right of the row.
  // When a swap is active, an inline "Swapped" badge sits beside the title and
  // the icon flips to a revert tooltip — no more triple-stacked grey buttons.
  const swapIcon = sub
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M3 12a9 9 0 0 1 15.5-6.3M21 4v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3M3 20v-5h5"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M7 7h10M17 7l-3-3M17 7l-3 3"/><path d="M17 17H7M7 17l3 3M7 17l3-3"/></svg>`;
  const swapTitle = sub ? 'Use original station' : "I don't have this equipment";
  const swapBtn = `<button class="hx-station-swap" data-station="${station}" title="${swapTitle}" aria-label="${swapTitle}" style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;background:transparent;border:1px solid rgba(0,0,0,0.08);border-radius:8px;color:var(--c-muted);cursor:pointer;-webkit-tap-highlight-color:transparent">${swapIcon}</button>`;
  const swappedBadge = `<span style="display:inline-block;font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#3d4f80;background:rgba(91,110,160,0.10);border-radius:4px;padding:2px 6px;margin-left:6px;vertical-align:1px">Swapped</span>`;
  const titleBlock = sub
    ? `<div style="font-size:13px;font-weight:600;color:var(--c-black)">${esc(sub.name)}${swappedBadge}</div>
       <div style="font-size:11px;color:var(--c-muted);margin-top:1px">replacing <span style="text-decoration:line-through;opacity:0.7">${display.name}</span></div>
       <div style="font-size:11px;color:var(--c-muted);line-height:1.4;margin-top:4px">${esc(sub.description)}</div>`
    : `<div style="font-size:13px;font-weight:600;color:#0F172A">${display.name}</div>
       <div style="font-size:11px;color:var(--c-muted)">${distStr}</div>`;

  if (options.context === 'breakdown') {
    return `
      <div style="display:flex;gap:14px;margin-bottom:14px;align-items:flex-start">
        <div style="width:3px;flex-shrink:0;background:${options.accent};border-radius:2px;margin-top:2px"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${options.accent};margin-bottom:3px">${sub ? 'Substitute' : display.name}</div>
          ${titleBlock}
        </div>
        <div style="flex-shrink:0">${swapBtn}</div>
      </div>`;
  }

  return `
    <div style="display:grid;grid-template-columns:1fr ${showTargetCol ? 'auto' : ''} auto;gap:12px;align-items:center;padding:11px 0;border-top:1px solid rgba(0,0,0,0.05)">
      <div style="min-width:0">${titleBlock}</div>
      ${showTargetCol ? `
        <div style="text-align:right">
          <div style="font-size:13px;font-variant-numeric:tabular-nums;color:#0F172A">${sub ? '—' : targetStr}</div>
          ${targetLabel ? `<div style="font-size:10px;color:var(--c-faint)">${targetLabel}</div>` : ''}
        </div>` : ''}
      ${swapBtn}
    </div>`;
}

function discColour(disc: HyroxDisc) {
  switch (disc) {
    case 'run':     return { accent: '#7a845c', bg: 'rgba(122,132,92,0.08)', badge: 'rgba(122,132,92,0.14)', badgeText: '#4f5a3b', label: 'Run' };
    case 'station': return { accent: '#b8742c', bg: 'rgba(184,116,44,0.08)', badge: 'rgba(184,116,44,0.14)', badgeText: '#8a5820', label: 'Station' };
    case 'brick':   return { accent: '#5b6ea0', bg: 'rgba(91,110,160,0.08)', badge: 'rgba(91,110,160,0.14)', badgeText: '#3d4f80', label: 'Brick' };
  }
}

export function openHyroxWorkoutDetail(workout: Workout): void {
  const existing = document.getElementById('hx-workout-detail-overlay');
  if (existing) existing.remove();

  const rawDisc = workout.discipline as string;
  const disc: HyroxDisc = rawDisc === 'station' ? 'station' : rawDisc === 'brick' ? 'brick' : 'run';
  const c = discColour(disc);

  const rpe = workout.rpe ?? (workout as any).r ?? 5;
  const mtl = workout.musculoTendonLoad;
  const dur = workout.estimatedDurationMin;
  const durStr = dur ? (dur >= 60 ? `${Math.floor(dur / 60)}h ${dur % 60 > 0 ? `${dur % 60}m` : ''}`.trim() : `${dur}m`) : null;
  const components = (workout as any).hyroxComponents as HyroxComponent[] | undefined;

  const overlay = document.createElement('div');
  overlay.id = 'hx-workout-detail-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';

  // Header chips share an inline divider strip rather than separate gaps —
  // less visual noise than three free-floating spans.
  const chips: string[] = [];
  if (durStr) chips.push(durStr);
  chips.push(`RPE ${rpe}`);
  if (mtl != null && mtl > 0) chips.push(`MTL ${Math.round(mtl)}`);
  const chipsHtml = chips.map((t, i) =>
    `${i > 0 ? '<span style="color:var(--c-faint);margin:0 8px">·</span>' : ''}<span>${t}</span>`
  ).join('');

  overlay.innerHTML = `
    <div style="
      background:#FAF9F6;
      width:100%;max-width:520px;
      max-height:90vh;overflow-y:auto;
      border-radius:20px;
      box-shadow:0 10px 40px rgba(0,0,0,0.3);
      position:relative;
    ">
      <!-- Header -->
      <div style="background:linear-gradient(180deg,${c.bg},rgba(255,255,255,0));padding:18px 22px 16px;border-bottom:1px solid rgba(0,0,0,0.05)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px">
          <span style="display:inline-flex;align-items:center;background:${c.badge};color:${c.badgeText};font-size:10px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;padding:3px 10px;border-radius:100px">${c.label}</span>
          <button id="hx-detail-close" style="width:30px;height:30px;background:rgba(0,0,0,0.04);border:none;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted);flex-shrink:0" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style="font-size:22px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1.15;margin-bottom:6px">${esc(workout.n)}</div>
        <div style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums">${chipsHtml}</div>
      </div>

      <!-- Session body -->
      ${renderSessionBody(workout, components, c.accent, disc)}

      <div style="height:14px"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#hx-detail-close')?.addEventListener('click', close);

  // Per-station "I don't have this" / "Swap back" buttons
  overlay.querySelectorAll<HTMLButtonElement>('.hx-station-swap').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const station = btn.getAttribute('data-station') as HyroxStation;
      if (!station) return;
      const currentSubId = workout.hyroxStationSubs?.[station];
      if (currentSubId) {
        // Already swapped → revert to original
        applyStationSwap(workout, station, null);
        // Re-open modal to refresh
        close();
        openHyroxWorkoutDetail(workout);
      } else {
        openSubstitutionPicker(station, (chosenId) => {
          applyStationSwap(workout, station, chosenId);
          close();
          openHyroxWorkoutDetail(workout);
        });
      }
    });
  });
}

/** Persist a swap (or revert) on the workout, recomputing per-component MTL and total MTL. */
function applyStationSwap(workout: Workout, station: HyroxStation, subId: string | null): void {
  const ms = getMutableState();
  const live = workout;
  const components = live.hyroxComponents ?? [];

  // Lazily snapshot original component MTLs the first time we mutate this workout.
  live.hyroxOriginalMtls = live.hyroxOriginalMtls ?? {};
  for (const c of components) {
    if (c.type === 'run') continue;
    const key = c.type as string;
    if (live.hyroxOriginalMtls[key] == null) {
      live.hyroxOriginalMtls[key] = c.mtl;
    }
  }

  // Update the substitution map.
  live.hyroxStationSubs = live.hyroxStationSubs ?? {};
  if (subId == null) {
    delete live.hyroxStationSubs[station];
    if (Object.keys(live.hyroxStationSubs).length === 0) delete live.hyroxStationSubs;
  } else {
    live.hyroxStationSubs[station] = subId;
  }

  // Recompute the affected component's MTL from the original × current sub factor (or original if reverted).
  const idx = components.findIndex(c => c.type === station);
  if (idx >= 0) {
    const originalMtl = live.hyroxOriginalMtls[station] ?? components[idx].mtl;
    if (subId == null) {
      components[idx].mtl = originalMtl;
    } else {
      const sub = findSubstitution(station, subId);
      const factor = sub?.mtlFactor ?? 1.0;
      components[idx].mtl = Math.round(originalMtl * factor);
    }
  }

  // Recompute session total MTL from components.
  if (components.length > 0) {
    live.musculoTendonLoad = components.reduce((sum, c) => sum + (c.mtl ?? 0), 0);
  }
  void ms;
  saveState();
}

/** Show a small picker submodal listing substitution options for a station. */
function openSubstitutionPicker(station: HyroxStation, onPick: (subId: string) => void): void {
  const display = STATION_DISPLAY[station];
  const options = getSubstitutionsFor(station);
  const sub = document.createElement('div');
  sub.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(8px)';
  sub.innerHTML = `
    <div style="background:#fff;border-radius:18px;width:100%;max-width:420px;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.25)">
      <div style="padding:18px 22px 10px;border-bottom:1px solid rgba(0,0,0,0.06)">
        <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">No equipment substitute</div>
        <div style="font-size:17px;font-weight:600;color:var(--c-black)">${display?.name ?? station}</div>
        <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Pick a swap that matches your situation.</div>
      </div>
      <div style="padding:8px 12px 8px">
        ${options.map(o => `
          <button class="hx-sub-opt" data-id="${o.id}" style="display:block;width:100%;text-align:left;padding:12px 14px;margin:4px 0;border-radius:12px;border:1px solid rgba(0,0,0,0.08);background:#fff;cursor:pointer">
            <div style="font-size:14px;font-weight:500;color:var(--c-black)">${esc(o.name)}</div>
            <div style="font-size:12px;color:var(--c-muted);margin-top:2px;line-height:1.4">${esc(o.description)}</div>
          </button>
        `).join('')}
      </div>
      <div style="padding:8px 16px 16px;border-top:1px solid rgba(0,0,0,0.06)">
        <button id="hx-sub-cancel" style="width:100%;padding:11px;border-radius:12px;border:1px solid rgba(0,0,0,0.10);background:#fff;color:var(--c-black);font-size:14px;cursor:pointer">Cancel</button>
      </div>
    </div>
  `;
  sub.addEventListener('click', e => { if (e.target === sub) sub.remove(); });
  sub.querySelector('#hx-sub-cancel')?.addEventListener('click', () => sub.remove());
  sub.querySelectorAll<HTMLButtonElement>('.hx-sub-opt').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-id');
      if (id) {
        sub.remove();
        onPick(id);
      }
    });
  });
  document.body.appendChild(sub);
}

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderSessionBody(workout: Workout, components: HyroxComponent[] | undefined, accent: string, disc: HyroxDisc): string {
  const t = workout.t ?? '';
  const mtl = workout.musculoTendonLoad;

  // Station technique: structured rounds table + run finish
  if (t === 'hyrox_station_technique') {
    const stationComponents = (components ?? []).filter(c => c.type !== 'run');
    // Parse run finish from description ("Then X min easy run (~Y km)")
    const runMatch = workout.d?.match(/Then\s+(\d+)\s+min easy run.*?~([\d.]+)\s*km/);
    const runFinishMin = runMatch ? parseInt(runMatch[1]) : null;
    const runFinishKm = runMatch ? parseFloat(runMatch[2]) : null;

    const stationRows = stationComponents.map(c => renderStationRow(c, workout, { context: 'technique', accent })).join('');

    return `
      <div style="padding:18px 24px 0">
        <div style="padding:12px 14px;border-radius:10px;background:rgba(91,110,160,0.06);border:1px solid rgba(91,110,160,0.12);margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:#3d4f80">3 rounds</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:2px">60s between stations · 3 min between rounds · Technique pace</div>
        </div>
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--c-faint);margin-bottom:4px">Stations</div>
        ${stationRows}
        ${runFinishMin ? `
          <div style="padding:12px 14px;border-radius:10px;background:rgba(122,132,92,0.07);border:1px solid rgba(122,132,92,0.15);margin-top:14px">
            <div style="font-size:12px;font-weight:600;color:#4f5a3b">Easy run to finish</div>
            <div style="font-size:11px;color:var(--c-muted);margin-top:2px">${runFinishMin} min${runFinishKm ? ` · ~${runFinishKm} km` : ''} — practise the station-to-run transition at easy effort</div>
          </div>
        ` : ''}
      </div>
      ${mtl != null && mtl > 0 ? renderMtlNote(mtl, disc) : ''}`;
  }

  // Station density: structured rounds table, no run
  if (t === 'hyrox_station_density') {
    const stationComponents = (components ?? []).filter(c => c.type !== 'run');
    const stationRows = stationComponents.map(c => renderStationRow(c, workout, { context: 'density', accent })).join('');

    return `
      <div style="padding:18px 24px 0">
        <div style="padding:12px 14px;border-radius:10px;background:rgba(184,116,44,0.06);border:1px solid rgba(184,116,44,0.12);margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:#8a5820">2 rounds · Race pace</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:2px">30s between stations · 2 min between rounds · Stations only</div>
        </div>
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--c-faint);margin-bottom:4px">Stations</div>
        ${stationRows}
      </div>
      ${mtl != null && mtl > 0 ? renderMtlNote(mtl, disc) : ''}`;
  }

  // Default: description text + component breakdown
  return `
    <div style="padding:18px 24px 0">
      ${workout.d ? `<p style="font-size:14px;color:#0F172A;line-height:1.6;margin:0 0 16px">${esc(workout.d)}</p>` : ''}
    </div>
    ${components?.length ? renderComponentBreakdown(components, accent, workout) : ''}
    ${mtl != null && mtl > 0 ? renderMtlNote(mtl, disc) : ''}`;
}

function renderComponentBreakdown(components: HyroxComponent[], accent: string, workout: Workout): string {
  const rows = components.map(c => {
    if (c.type === 'run') {
      const km = c.distanceM ? (c.distanceM / 1000).toFixed(1) : null;
      const mtlStr = c.mtl > 0 ? `MTL ${Math.round(c.mtl)}` : '';
      return `
        <div style="display:flex;gap:14px;margin-bottom:14px">
          <div style="width:3px;flex-shrink:0;background:rgba(122,132,92,0.4);border-radius:2px;margin-top:2px"></div>
          <div style="flex:1">
            <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#7a845c;margin-bottom:3px">Run</div>
            <div style="font-size:14px;color:#0F172A">${km ? `${km} km` : 'Run segment'}${mtlStr ? `<span style="margin-left:10px;font-size:11px;color:var(--c-faint)">${mtlStr}</span>` : ''}</div>
          </div>
        </div>`;
    }
    return renderStationRow(c, workout, { context: 'breakdown', accent });
  }).join('');

  return `
    <div style="padding:4px 24px 8px">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--c-faint);margin-bottom:12px">Session breakdown</div>
      ${rows}
    </div>`;
}

function renderMtlNote(mtl: number, disc: HyroxDisc): string {
  const note = disc === 'brick'
    ? 'Brick sessions accumulate both aerobic and musculotendon load. Allow 48h before another high-MTL session.'
    : disc === 'station'
    ? 'Station work creates eccentric load that takes longer to recover from than aerobic load. Monitor soreness.'
    : '';
  if (!note) return '';
  return `
    <div style="margin:4px 24px 16px;padding:10px 14px;border-radius:10px;background:rgba(0,0,0,0.03);border:1px solid rgba(0,0,0,0.06)">
      <div style="font-size:11px;color:var(--c-muted);line-height:1.5">${note}</div>
    </div>`;
}

function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
