/**
 * HYROX "Add session" modal.
 *
 * Lets the user generate one extra session in keeping with the current week's
 * phase + remaining MTL headroom. Mirrors the pattern of other modes' session
 * generators but constrained to HYROX session kinds.
 *
 * Session kinds offered: easy run / tempo run / interval run / station technique /
 *                        station density / brick / mini-brick /
 *                        half simulation / race simulation.
 *
 * Simulations are fixed-structure: their duration comes from the athlete's own
 * benchmarks and run pace, so the duration slider is hidden for them.
 *
 * On confirm: generate via hyrox-generators, append to current week's triWorkouts,
 * reschedule via scheduleHyroxWeek, persist, re-render plan view.
 */

import { getMutableState, getState } from '@/state/store';
import { saveState } from '@/state/persistence';
import {
  generateHyroxRun,
  generateHyroxStation,
  generateHyroxBrick,
  generateHyroxSimulation,
} from '@/workouts/hyrox-generators';
import { scheduleHyroxWeek } from '@/workouts/scheduler.hyrox';
import type { HyroxStation } from '@/types/triathlon';
import type { Workout } from '@/types/state';

type SessionKind =
  | 'run_easy'
  | 'run_tempo'
  | 'run_intervals'
  | 'station_technique'
  | 'station_density'
  | 'brick'
  | 'mini_brick'
  | 'half_simulation'
  | 'simulation';

interface SessionOption {
  kind: SessionKind;
  label: string;
  caption: string;
  defaultMin: number;
  /** Minimum sensible duration for the slider (5-min steps). */
  minMin: number;
  /** Maximum sensible duration for the slider. */
  maxMin: number;
}

const OPTIONS: SessionOption[] = [
  { kind: 'run_easy',         label: 'Easy run',          caption: 'Zone 2 aerobic. Recovery-friendly.',     defaultMin: 45, minMin: 25, maxMin: 90 },
  { kind: 'run_tempo',        label: 'Tempo run',         caption: 'Threshold work, sustained effort.',      defaultMin: 40, minMin: 30, maxMin: 70 },
  { kind: 'run_intervals',    label: 'Interval run',      caption: 'VO2 max efforts, hard repeats.',         defaultMin: 35, minMin: 25, maxMin: 60 },
  { kind: 'station_technique',label: 'Station technique', caption: 'Skill + form, lower intensity.',         defaultMin: 50, minMin: 35, maxMin: 75 },
  { kind: 'station_density',  label: 'Station density',   caption: 'AMRAP-style higher-volume work.',        defaultMin: 45, minMin: 30, maxMin: 65 },
  { kind: 'brick',            label: 'Brick',             caption: 'Run + station rounds, race-specific.',   defaultMin: 60, minMin: 45, maxMin: 100 },
  { kind: 'mini_brick',       label: 'Mini brick',        caption: 'Shorter brick — 500m + erg, beginner.',  defaultMin: 35, minMin: 25, maxMin: 50 },
  { kind: 'half_simulation',  label: 'Half simulation',   caption: 'All 8 stations in race order, half volume.', defaultMin: 0, minMin: 0, maxMin: 0 },
  { kind: 'simulation',       label: 'Race simulation',   caption: 'Full race distance, start to finish.',    defaultMin: 0, minMin: 0, maxMin: 0 },
];

/** Simulations have a fixed structure, so no duration is chosen for them. */
function isSimulation(kind: SessionKind): boolean {
  return kind === 'simulation' || kind === 'half_simulation';
}

/** Generate a draft workout for a session kind, to read its real MTL and
 *  duration. Used for cap-headroom warnings without hardcoded estimates, and
 *  for simulations, whose duration is derived rather than chosen.
 *  When `durationMin` is omitted, falls back to the option's default duration. */
function draftFor(kind: SessionKind, hx: any, bodyWeightKg: number | undefined, slotIndex: number, phase: 'base' | 'build' | 'peak' | 'taper', durationMin?: number): Workout {
  const targetMin = durationMin ?? OPTIONS.find(o => o.kind === kind)?.defaultMin ?? 45;
  const isDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  const benchmarks = (isDoubles ? hx.stationBenchmarksDoubles : hx.stationBenchmarksSingles) ?? hx.stationBenchmarks;
  if (kind === 'run_easy' || kind === 'run_tempo' || kind === 'run_intervals') {
    return generateHyroxRun({
      kind, targetMinutes: targetMin, band: hx.athleteBand, phase, slotIndex,
      bodyWeightKg, runPaceSecKm: hx.hyroxRunPaceSecKm,
    });
  }
  if (kind === 'station_technique' || kind === 'station_density') {
    return generateHyroxStation({
      kind, targetMinutes: targetMin, band: hx.athleteBand, stationAccess: hx.stationAccess,
      phase, slotIndex, bodyWeightKg, stationBenchmarks: benchmarks,
    });
  }
  if (isSimulation(kind)) {
    return generateHyroxSimulation({
      kind: kind as 'simulation' | 'half_simulation', band: hx.athleteBand,
      bodyWeightKg, stationBenchmarks: benchmarks, runPaceSecKm: hx.hyroxRunPaceSecKm,
    });
  }
  return generateHyroxBrick({
    kind: kind as 'brick' | 'mini_brick', targetMinutes: targetMin, band: hx.athleteBand,
    stationAccess: hx.stationAccess, phase, slotIndex, bodyWeightKg, stationBenchmarks: benchmarks,
  });
}

/** Suggest the kind that fills the largest gap in the current week's plan. */
function suggestKind(weekWorkouts: Workout[]): SessionKind {
  const has = (predicate: (t?: string) => boolean) => weekWorkouts.some(w => predicate(w.t));
  const hasTempo    = has(t => t === 'run_tempo');
  const hasInterval = has(t => t === 'run_intervals');
  const hasDensity  = has(t => t === 'station_density');
  const hasBrick    = has(t => t === 'brick' || t === 'mini_brick');
  if (!hasTempo)    return 'run_tempo';
  if (!hasDensity)  return 'station_density';
  if (!hasInterval) return 'run_intervals';
  if (!hasBrick)    return 'brick';
  // Simulations are never auto-suggested: they are a deliberate test, and the
  // plan engine's phase logic decides when one belongs in the week.
  return 'run_easy';
}

export function openHyroxAddSessionModal(onUpdate: () => void): void {
  const s = getState();
  const hx = s.hyroxConfig;
  if (!hx) return;
  const wk = s.wks?.[(s.w ?? 1) - 1];
  if (!wk) return;
  const phase = (wk.ph ?? 'base') as 'base' | 'build' | 'peak' | 'taper';
  const weekWorkouts = wk.triWorkouts ?? [];
  let selected: SessionKind = suggestKind(weekWorkouts);

  // Cap-headroom: how much MTL is already on the books for this week vs the cap.
  // The "Over cap" warning only fires when adding the session would push the
  // weekly total >15% over the cap — not on every 1-MTL overshoot. The cap is a
  // soft governor in the plan engine, not a hard injury threshold.
  const plannedMtl = weekWorkouts.reduce((s, w) => s + (w.musculoTendonLoad ?? 0), 0);
  const cap = hx.mtlCap ?? 1000;
  const overCapThreshold = cap * 1.15;
  const headroom = Math.max(0, cap - plannedMtl);

  // Per-kind chosen duration (defaults to OPTIONS' defaultMin). Mutable so the
  // user can drag the slider on the selected card. MTL re-drafts live.
  const chosenMin: Record<SessionKind, number> = OPTIONS.reduce((acc, o) => {
    acc[o.kind] = o.defaultMin;
    return acc;
  }, {} as Record<SessionKind, number>);

  const slotIndex = (weekWorkouts.length ?? 0) + (s.w ?? 1);

  function draft(kind: SessionKind): Workout {
    return draftFor(kind, hx, s.bodyWeightKg, slotIndex, phase, chosenMin[kind]);
  }
  function mtlFor(kind: SessionKind): number {
    return draft(kind).musculoTendonLoad ?? 0;
  }
  /** Displayed duration: chosen on the slider, or derived for simulations. */
  function durationFor(kind: SessionKind): number {
    return isSimulation(kind) ? (draft(kind).estimatedDurationMin ?? 0) : chosenMin[kind];
  }

  const overlay = document.createElement('div');
  overlay.id = 'hx-add-session-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(8px)';

  function render(): void {
    const selectedMtl = mtlFor(selected);
    const overCap = (plannedMtl + selectedMtl) > overCapThreshold;
    const selectedOpt = OPTIONS.find(o => o.kind === selected)!;
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:18px;width:100%;max-width:440px;max-height:88vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.25)">
        <div style="padding:20px 22px 12px;border-bottom:1px solid rgba(0,0,0,0.06)">
          <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Add session · ${phase}</div>
          <div style="font-size:18px;font-weight:600;color:var(--c-black)">Pick a session type</div>
          <div style="font-size:12px;color:var(--c-muted);margin-top:4px">Suggested for what's missing this week.</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:8px;font-variant-numeric:tabular-nums">Week MTL: ${Math.round(plannedMtl)} of ${cap} cap · ${Math.round(headroom)} headroom</div>
        </div>
        <div style="padding:8px 12px 16px">
          ${OPTIONS.map(opt => {
            const isSel = opt.kind === selected;
            const isSuggested = opt.kind === suggestKind(weekWorkouts);
            const mtl = mtlFor(opt.kind);
            const exceedsCap = (plannedMtl + mtl) > overCapThreshold;
            const dur = durationFor(opt.kind);
            return `
              <button class="hx-add-opt" data-kind="${opt.kind}" style="display:block;width:100%;text-align:left;padding:12px 14px;margin:4px 0;border-radius:12px;border:1px solid ${isSel ? 'var(--c-black)' : 'rgba(0,0,0,0.08)'};background:${isSel ? 'var(--c-black)' : '#fff'};color:${isSel ? '#FDFCF7' : 'var(--c-black)'};cursor:pointer;transition:all 0.15s">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                  <div style="font-size:14px;font-weight:500">${opt.label}</div>
                  <div style="display:flex;gap:6px">
                    ${exceedsCap ? `<span style="font-size:10px;color:${isSel ? '#FDFCF7' : 'var(--c-black)'};opacity:0.75;border:1px solid ${isSel ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.18)'};border-radius:6px;padding:2px 7px">Over cap</span>` : ''}
                    ${isSuggested && !isSel ? `<span style="font-size:10px;color:var(--c-muted);border:1px solid rgba(0,0,0,0.12);border-radius:6px;padding:2px 7px">Suggested</span>` : ''}
                  </div>
                </div>
                <div style="font-size:11px;opacity:0.75;margin-top:2px">${opt.caption} · ${dur} min · ${Math.round(mtl)} MTL</div>
              </button>
            `;
          }).join('')}
        </div>

        <!-- Duration: slider for chosen-length sessions, derived read-out for simulations -->
        <div style="padding:0 22px 14px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <span style="font-size:12px;color:var(--c-muted)">${isSimulation(selected) ? 'Target time' : 'Duration'}</span>
            <span style="font-size:14px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums" id="hx-dur-display">${durationFor(selected)} min</span>
          </div>
          ${isSimulation(selected)
            ? `<div style="font-size:11px;color:var(--c-muted);line-height:1.5">Fixed structure. The target comes from your own station benchmarks and run pace, so it is the time to beat.</div>`
            : `<input type="range" id="hx-dur-slider" class="m-slider-glass" min="${selectedOpt.minMin}" max="${selectedOpt.maxMin}" step="5" value="${chosenMin[selected]}">`}
        </div>

        ${overCap ? `<div style="padding:0 16px 6px;font-size:11px;color:var(--c-muted)">This session would push you over your weekly MTL cap. Proceed only if you have headroom from prior recovery.</div>` : ''}
        <div style="display:flex;gap:8px;padding:12px 16px 18px;border-top:1px solid rgba(0,0,0,0.06)">
          <button id="hx-add-cancel" style="flex:1;padding:11px;border-radius:12px;border:1px solid rgba(0,0,0,0.10);background:#fff;color:var(--c-black);font-size:14px;cursor:pointer">Cancel</button>
          <button id="hx-add-confirm" style="flex:2;padding:11px;border-radius:12px;border:none;background:var(--c-black);color:#FDFCF7;font-size:14px;font-weight:500;cursor:pointer">Add session</button>
        </div>
      </div>
    `;
    overlay.querySelectorAll<HTMLButtonElement>('.hx-add-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        selected = btn.getAttribute('data-kind') as SessionKind;
        render();
      });
    });

    // Duration slider — update chosen duration, re-render to refresh MTL chip + caption.
    const slider = overlay.querySelector('#hx-dur-slider') as HTMLInputElement | null;
    const display = overlay.querySelector('#hx-dur-display') as HTMLElement | null;
    slider?.addEventListener('input', () => {
      const min = Number(slider.value);
      chosenMin[selected] = min;
      if (display) display.textContent = `${min} min`;
      // Light re-render: only the selected card MTL + over-cap warning need refresh.
      // Full re-render keeps logic simple at the cost of slider focus loss; trigger
      // only on `change` (release) to avoid that.
    });
    slider?.addEventListener('change', () => {
      render();
    });

    overlay.querySelector('#hx-add-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#hx-add-confirm')?.addEventListener('click', () => {
      addSession(selected, chosenMin[selected]);
      overlay.remove();
      onUpdate();
    });
  }

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  render();
  document.body.appendChild(overlay);
}

function addSession(kind: SessionKind, durationMin?: number): void {
  const ms = getMutableState();
  const hx = ms.hyroxConfig;
  if (!hx) return;
  const wkIdx = (ms.w ?? 1) - 1;
  const wk = ms.wks?.[wkIdx];
  if (!wk) return;

  const phase = (wk.ph ?? 'base') as 'base' | 'build' | 'peak' | 'taper';
  const slotIndex = (wk.triWorkouts?.length ?? 0) + (ms.w ?? 1);
  const targetMin = durationMin ?? OPTIONS.find(o => o.kind === kind)?.defaultMin ?? 45;
  const isDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  const benchmarks = (isDoubles ? hx.stationBenchmarksDoubles : hx.stationBenchmarksSingles) ?? hx.stationBenchmarks;

  let workout: Workout;
  if (kind === 'run_easy' || kind === 'run_tempo' || kind === 'run_intervals') {
    workout = generateHyroxRun({
      kind,
      targetMinutes: targetMin,
      band: hx.athleteBand,
      phase,
      slotIndex,
      bodyWeightKg: ms.bodyWeightKg,
      runPaceSecKm: hx.hyroxRunPaceSecKm,
    });
  } else if (kind === 'station_technique' || kind === 'station_density') {
    workout = generateHyroxStation({
      kind,
      targetMinutes: targetMin,
      band: hx.athleteBand,
      stationAccess: hx.stationAccess,
      phase,
      slotIndex,
      bodyWeightKg: ms.bodyWeightKg,
      stationBenchmarks: benchmarks as Partial<Record<HyroxStation, number>> | undefined,
    });
  } else if (kind === 'simulation' || kind === 'half_simulation') {
    // Simulations take no target duration: the race structure sets the length.
    workout = generateHyroxSimulation({
      kind,
      band: hx.athleteBand,
      bodyWeightKg: ms.bodyWeightKg,
      stationBenchmarks: benchmarks as Partial<Record<HyroxStation, number>> | undefined,
      runPaceSecKm: hx.hyroxRunPaceSecKm,
    });
  } else {
    workout = generateHyroxBrick({
      kind: kind as 'brick' | 'mini_brick',
      targetMinutes: targetMin,
      band: hx.athleteBand,
      stationAccess: hx.stationAccess,
      phase,
      slotIndex,
      bodyWeightKg: ms.bodyWeightKg,
      stationBenchmarks: benchmarks as Partial<Record<HyroxStation, number>> | undefined,
    });
  }

  // Tag as user-added so it can be filtered later if needed.
  (workout as any).addedManually = true;

  const updated = [...(wk.triWorkouts ?? []), workout];
  wk.triWorkouts = scheduleHyroxWeek(updated, hx.athleteBand);
  saveState();
  console.log(`[hyrox] added ${kind} session to week ${ms.w}: ${workout.estimatedDurationMin} min, MTL ${workout.musculoTendonLoad ?? 0}`);
}
