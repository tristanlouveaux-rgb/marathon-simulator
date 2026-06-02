/**
 * Per-workout "Adjust" overlay (running).
 *
 * Lets the user scale a single running session for THIS session only:
 *  - a continuous duration slider (50%-115% of the prescribed TOTAL TIME), and
 *  - stepped Easier / Harder intensity notches along the pace ladder,
 *  - two one-tap presets ("Less time (easier)" and "Less time, same effort").
 *
 * The slider applies one scale factor to the whole session: every distance/time
 * token in the description scales proportionally (paces untouched) and the total
 * minutes scale with it. This works for structured tempo/interval sessions too,
 * not only simple distance runs. See workout-scaling.ts for the pure helpers and
 * the planning-vs-tracking rationale.
 *
 * The change is persisted as a `WorkoutMod` (userScaledAt-stamped) that plan-view
 * re-applies on render, exactly like the AI coach's reduce/adjust path
 * (coach-tools.ts). It never touches the plan, weekly targets, or the prediction.
 *
 * Modelled on openTriWorkoutDetail (triathlon/workout-detail-modal.ts): a
 * vertically-centered glass card. Neutral palette only.
 */

import type { Workout, WorkoutMod } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { formatKm } from '@/utils/format';
import {
  parseDistanceKm, isSimpleDistanceDesc, supportsDurationScale,
  scaleDescriptionProportional, scaleDurationMin,
  stepIntensity, canStepIntensity, RPE_BY_TYPE,
  DURATION_SCALE_MIN, DURATION_SCALE_MAX, LESS_TIME_FACTOR,
} from '@/workouts/workout-scaling';
import { BIKE_INTENSITY_LADDER, SWIM_INTENSITY_LADDER, BIKE_ADHERENCE_BAND } from '@/constants/triathlon-constants';
import { loadForBike, type BikeSessionKind } from '@/workouts/bike';
import { loadForSwim, type SwimSessionKind } from '@/workouts/swim';

/** Planned aerobic/anaerobic load for an intensity-rung key at a given duration,
 *  using the existing per-kind TSS/min helpers (loadForBike / loadForSwim, the
 *  same source the plan engine uses). Returns null for an unknown key. */
function loadForRung(key: string, minutes: number): { aerobic: number; anaerobic: number } | null {
  if (key.startsWith('bike_')) return loadForBike(key.slice(5) as BikeSessionKind, minutes);
  if (key.startsWith('swim_')) return loadForSwim(key.slice(5) as SwimSessionKind, minutes);
  return null;
}

const TYPE_LABEL: Record<string, string> = {
  easy: 'Easy', marathon: 'Marathon pace', threshold: 'Threshold',
  vo2: 'VO2 max', long: 'Long run', recovery: 'Recovery',
};
const typeLabel = (t: string) => TYPE_LABEL[t] ?? (t ? t[0].toUpperCase() + t.slice(1) : 'Run');

type IntensityMode = 'run' | 'bike' | 'swim' | 'none';

/** "M:SS/100m" swim pace. */
function fmtSwimPace(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const sec = Math.round(secPer100m % 60);
  return `${m}:${String(sec).padStart(2, '0')}/100m`;
}

/** Watt range for a bike rung at the given FTP, using the rung's adherence band.
 *  Mirrors pwLabel in bike.ts so the prescription reads identically. */
function bikeWattLabel(key: string, pct: number, ftp: number): string {
  const band = BIKE_ADHERENCE_BAND[key] ?? 0.07;
  const lo = Math.round(ftp * pct * (1 - band));
  const hi = Math.round(ftp * pct * (1 + band));
  return `${lo}–${hi}W`;
}

/** "Tempo · 180–210W" / "CSS intervals · 1:38/100m" for a ladder rung. The target
 *  is derived live from FTP/CSS, so it tracks benchmark improvements. Exported so
 *  the tri/HYROX detail modals can show the same string for a scaled session. */
export function intensityTargetLabel(workout: Workout, ftp?: number, css?: number): string | null {
  const key = workout.intensityLevel;
  if (!key) return null;
  const bike = BIKE_INTENSITY_LADDER.find(r => r.key === key);
  if (bike && ftp && ftp > 0) return `${bike.label} · ${bikeWattLabel(bike.key, bike.pct, ftp)}`;
  const swim = SWIM_INTENSITY_LADDER.find(r => r.key === key);
  if (swim && css && css > 0) return `${swim.label} · ${fmtSwimPace(css + swim.cssOffsetSec)}`;
  return null;
}

/**
 * How a scaled session is persisted. Running workouts are regenerated every
 * render, so the scale lives as a `WorkoutMod` re-applied on render ('mod').
 * Triathlon / cycling / HYROX sessions are persisted objects in `wk.triWorkouts`
 * (the drag-to-reorder handlers mutate them in place); for those the scale is
 * written straight onto the stored object ('object'), which is inherently
 * reload-safe and needs no match key.
 */
export interface AdjustOptions {
  persist?: 'mod' | 'object';
  /** Stable slot id. Keys the mod (running) or finds the object (tri/HYROX). */
  workoutId?: string;
  /** Show the Easier/Harder intensity ladder. Running only — the ladder is built
   *  on running pace types and has no defined mapping for swim/bike/stations.
   *  Defaults to true for 'mod', false for 'object'. */
  allowIntensity?: boolean;
  /** Which Week array holds the object for persist:'object'. Default 'triWorkouts'. */
  store?: 'triWorkouts' | 'adhocWorkouts';
  /** Re-render the calling view after apply/reset. Defaults to the running plan view. */
  rerender?: () => void;
}

/**
 * Open the adjust overlay for a workout.
 * @param workout  The workout as currently rendered (already reflects any prior mod).
 * @param weekIdx  Zero-based index into state.wks.
 * @param opts     Persistence + capability options. Omit for the running default.
 */
export function openWorkoutAdjust(workout: Workout, weekIdx: number, opts: AdjustOptions = {}): void {
  document.getElementById('workout-adjust-overlay')?.remove();

  const persist = opts.persist ?? 'mod';
  const store = opts.store ?? 'triWorkouts';
  const allowIntensity = opts.allowIntensity ?? (persist === 'mod');
  const workoutId = opts.workoutId ?? (workout as any).id;
  const rerender = opts.rerender ?? rerenderPlan;

  const s = getMutableState();
  const unit = s.unitPref ?? 'km';

  // Anchor everything to the ORIGINAL plan. After a prior scale these were stashed
  // on the workout (originalDistance = full plan description, originalDurationMin =
  // plan minutes); for an as-yet-unscaled session they are the current values.
  const origDesc = (workout.originalDistance && workout.originalDistance.trim())
    ? workout.originalDistance : (workout.d ?? '');
  const origMin = (workout.originalDurationMin && workout.originalDurationMin > 0)
    ? workout.originalDurationMin
    : (workout.estimatedDurationMin && workout.estimatedDurationMin > 0 ? workout.estimatedDurationMin : 0);
  const currentMin = (workout.estimatedDurationMin && workout.estimatedDurationMin > 0)
    ? workout.estimatedDurationMin : origMin;

  const canDuration = origMin > 0 || supportsDurationScale(origDesc);
  const isSimple = isSimpleDistanceDesc(origDesc);
  const origLeadKm = parseDistanceKm(origDesc);

  const baseType = workout.t;
  let selectedType = baseType;

  // ── Intensity mode ──────────────────────────────────────────────────────────
  // Running (mod path): the run pace ladder (easy→marathon→threshold→vo2).
  // Bike/swim object sessions: a discipline ladder that bumps target watts (%FTP)
  // or swim pace (CSS offset). Both are sourced (Coggan & Allen 2019 / CSS zones).
  // Object run sessions stay duration-only (no run-pace context here).
  const disc = (workout as any).discipline as string | undefined;
  const ftp = s.triConfig?.bike?.ftp;
  const css = s.triConfig?.swim?.cssSecPer100m;
  let intensityMode: IntensityMode = 'none';
  if (persist === 'object') {
    if (disc === 'bike' && ftp && ftp > 0) intensityMode = 'bike';
    else if (disc === 'swim' && css && css > 0) intensityMode = 'swim';
  } else if (allowIntensity) {
    intensityMode = 'run';
  }
  const showIntensity = intensityMode !== 'none';
  const discLadder = intensityMode === 'bike' ? BIKE_INTENSITY_LADDER
    : intensityMode === 'swim' ? SWIM_INTENSITY_LADDER : null;

  // Current rung for a discipline ladder: saved intensityLevel, else the matching
  // session type, else a sensible aerobic default (endurance).
  const defaultRung = intensityMode === 'swim' ? 1 : 0; // swim endurance = idx 1; bike endurance = idx 0
  let rungIdx = defaultRung;
  if (discLadder) {
    const cur = workout.intensityLevel;
    const byLevel = cur ? discLadder.findIndex(r => r.key === cur) : -1;
    const byType = byLevel < 0 ? discLadder.findIndex(r => r.key === workout.t) : -1;
    rungIdx = byLevel >= 0 ? byLevel : byType >= 0 ? byType : defaultRung;
  }
  const baseRungIdx = rungIdx;
  const rungTarget = (idx: number): string => {
    if (intensityMode === 'bike' && ftp) {
      const r = BIKE_INTENSITY_LADDER[idx];
      return `${r.label} · ${bikeWattLabel(r.key, r.pct, ftp)}`;
    }
    if (intensityMode === 'swim' && css) {
      const r = SWIM_INTENSITY_LADDER[idx];
      return `${r.label} · ${fmtSwimPace(css + r.cssOffsetSec)}`;
    }
    return '';
  };

  const minPct = Math.round(DURATION_SCALE_MIN * 100);
  const maxPct = Math.round(DURATION_SCALE_MAX * 100);
  const initPct = origMin > 0 ? Math.round((currentMin / origMin) * 100) : 100;
  let pct = Math.max(minPct, Math.min(maxPct, initPct));

  const hasExistingScale = persist === 'object'
    ? !!((workout as any).userScaledAt || ((workout as any).originalDurationMin && (workout as any).originalDurationMin > 0))
    : (s.wks[weekIdx]?.workoutMods ?? [])
        .some(m => m.userScaledAt
          && ((workoutId && m.workoutId === workoutId)
            || (m.name === workout.n && (m.dayOfWeek == null || m.dayOfWeek === workout.dayOfWeek))));

  const overlay = document.createElement('div');
  overlay.id = 'workout-adjust-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.cssText = 'background:rgba(0,0,0,0.45);overflow-y:auto';

  overlay.innerHTML = `
    <div style="background:var(--c-surface);width:100%;max-width:420px;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3);position:relative">
      <div style="padding:20px 22px 14px;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div>
            <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em">Adjust this session</div>
            <div style="font-size:12px;color:var(--c-muted);margin-top:4px;line-height:1.5">Applies to this session only. Your plan and prediction stay the same.</div>
          </div>
          <button id="wadj-close" aria-label="Close" style="flex-shrink:0;width:30px;height:30px;background:transparent;border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <div style="padding:18px 22px 4px">
        ${canDuration ? `
        <div style="margin-bottom:20px">
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
            <span style="font-size:13px;font-weight:600;color:var(--c-black)">Duration</span>
            <span id="wadj-dur-readout" style="font-size:13px;color:var(--c-muted);font-variant-numeric:tabular-nums"></span>
          </div>
          <input id="wadj-slider" type="range" min="${minPct}" max="${maxPct}" step="5" value="${pct}"
            style="width:100%;accent-color:var(--c-black);cursor:pointer">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-faint);margin-top:4px">
            <span>Shorter</span><span>Planned</span><span>Longer</span>
          </div>
        </div>
        ` : ''}

        ${showIntensity ? `
        <div style="margin-bottom:18px">
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
            <span style="font-size:13px;font-weight:600;color:var(--c-black)">Intensity</span>
            <span id="wadj-int-readout" style="font-size:13px;color:var(--c-muted);font-variant-numeric:tabular-nums"></span>
          </div>
          <div style="display:flex;gap:8px">
            <button id="wadj-easier" style="flex:1;height:40px;border-radius:10px;border:1px solid var(--c-border);background:transparent;color:var(--c-black);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f)">Easier</button>
            <button id="wadj-harder" style="flex:1;height:40px;border-radius:10px;border:1px solid var(--c-border);background:transparent;color:var(--c-black);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f)">Harder</button>
          </div>
          ${intensityMode !== 'run' ? `<div style="font-size:11px;color:var(--c-faint);margin-top:8px;line-height:1.4">Target ${intensityMode === 'bike' ? 'watts' : 'pace'} from your ${intensityMode === 'bike' ? 'FTP' : 'CSS'}. Applies to this session only.</div>` : ''}
        </div>
        ` : ''}

        ${canDuration ? `
        <div style="margin-bottom:6px">
          <div style="font-size:11px;color:var(--c-faint);margin-bottom:8px">Got less time</div>
          <div style="display:flex;gap:8px">
            ${showIntensity ? `<button id="wadj-preset-easy" style="flex:1;padding:9px 6px;border-radius:10px;border:1px solid var(--c-border);background:transparent;color:var(--c-muted);font-size:12px;font-weight:500;cursor:pointer;font-family:var(--f)">Less time, easier</button>` : ''}
            <button id="wadj-preset-same" style="flex:1;padding:9px 6px;border-radius:10px;border:1px solid var(--c-border);background:transparent;color:var(--c-muted);font-size:12px;font-weight:500;cursor:pointer;font-family:var(--f)">${showIntensity ? 'Less time, same effort' : 'Less time'}</button>
          </div>
        </div>
        ` : ''}
      </div>

      <div style="padding:8px 22px 20px;display:flex;flex-direction:column;gap:8px">
        <button id="wadj-apply" class="m-btn-glass" style="width:100%">Apply</button>
        ${hasExistingScale ? `<button id="wadj-reset" style="width:100%;padding:9px;background:transparent;border:none;color:var(--c-muted);font-size:13px;cursor:pointer;font-family:var(--f)">Reset to plan</button>` : ''}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const slider = overlay.querySelector('#wadj-slider') as HTMLInputElement | null;
  const durReadout = overlay.querySelector('#wadj-dur-readout');
  const intReadout = overlay.querySelector('#wadj-int-readout');
  const easierBtn = overlay.querySelector('#wadj-easier') as HTMLButtonElement | null;
  const harderBtn = overlay.querySelector('#wadj-harder') as HTMLButtonElement | null;

  const renderDuration = () => {
    if (!canDuration || !durReadout) return;
    const f = pct / 100;
    const parts: string[] = [];
    if (isSimple && origLeadKm) parts.push(formatKm(origLeadKm * f, unit));
    if (origMin > 0) parts.push(`${Math.round(origMin * f)} min`);
    durReadout.textContent = parts.join(' · ');
  };
  // Discipline-ladder stepping (bike/swim). Harder = up the ladder (higher %FTP /
  // faster swim pace); index bounds clamp at the ends.
  const stepRung = (dir: 'easier' | 'harder') => {
    if (!discLadder) return;
    const next = dir === 'harder' ? rungIdx + 1 : rungIdx - 1;
    if (next >= 0 && next < discLadder.length) rungIdx = next;
  };
  const renderIntensity = () => {
    if (intensityMode === 'run') {
      if (intReadout) intReadout.textContent = typeLabel(selectedType);
      if (easierBtn) easierBtn.style.opacity = canStepIntensity(selectedType, 'easier') ? '1' : '0.4';
      if (harderBtn) harderBtn.style.opacity = canStepIntensity(selectedType, 'harder') ? '1' : '0.4';
    } else if (discLadder) {
      if (intReadout) intReadout.textContent = rungTarget(rungIdx);
      if (easierBtn) easierBtn.style.opacity = rungIdx > 0 ? '1' : '0.4';
      if (harderBtn) harderBtn.style.opacity = rungIdx < discLadder.length - 1 ? '1' : '0.4';
    }
  };

  slider?.addEventListener('input', () => { pct = parseInt(slider.value, 10); renderDuration(); });
  easierBtn?.addEventListener('click', () => {
    if (intensityMode === 'run') selectedType = stepIntensity(selectedType, 'easier');
    else stepRung('easier');
    renderIntensity();
  });
  harderBtn?.addEventListener('click', () => {
    if (intensityMode === 'run') selectedType = stepIntensity(selectedType, 'harder');
    else stepRung('harder');
    renderIntensity();
  });

  overlay.querySelector('#wadj-preset-easy')?.addEventListener('click', () => {
    pct = Math.round(LESS_TIME_FACTOR * 100);
    if (slider) slider.value = String(pct);
    renderDuration();
  });
  overlay.querySelector('#wadj-preset-same')?.addEventListener('click', () => {
    pct = Math.round(LESS_TIME_FACTOR * 100);
    if (slider) slider.value = String(pct);
    // "Same effort" = shorter session but a notch harder.
    if (intensityMode === 'run') selectedType = stepIntensity(selectedType, 'harder');
    else stepRung('harder');
    renderDuration();
    renderIntensity();
  });

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#wadj-close')?.addEventListener('click', close);

  overlay.querySelector('#wadj-reset')?.addEventListener('click', () => {
    if (persist === 'object') removeObjectScale(weekIdx, store, workoutId, workout);
    else removeUserScaleMod(weekIdx, workout, workoutId);
    close();
    rerender();
  });

  overlay.querySelector('#wadj-apply')?.addEventListener('click', () => {
    const typeChanged = intensityMode === 'run' && selectedType !== baseType;
    const rungChanged = !!discLadder && rungIdx !== baseRungIdx;
    const durChanged = canDuration && Math.abs(pct - initPct) >= 1;
    if (!typeChanged && !rungChanged && !durChanged) { close(); return; } // nothing to apply

    const f = pct / 100;
    const args: ScaleArgs = {
      origDesc,
      origMin,
      newDesc: canDuration ? scaleDescriptionProportional(origDesc, f) : origDesc,
      newDurationMin: origMin > 0 ? scaleDurationMin(origMin, f) : undefined,
      newType: typeChanged ? selectedType : undefined,
      newRpe: typeChanged ? RPE_BY_TYPE[selectedType] : undefined,
      newIntensityLevel: rungChanged && discLadder ? discLadder[rungIdx].key : undefined,
    };
    if (persist === 'object') applyObjectScale(weekIdx, store, workoutId, workout, args);
    else applyUserScale(weekIdx, workout, workoutId, args);
    close();
    rerender();
  });

  renderDuration();
  renderIntensity();
}

function rerenderPlan(): void {
  import('@/ui/plan-view').then(m => m.renderPlanView()).catch(() => {});
}

interface ScaleArgs {
  origDesc: string;
  origMin: number;
  newDesc: string;
  newDurationMin?: number;
  newType?: string;
  newRpe?: number;
  /** New bike/swim intensity rung key (object mode only). */
  newIntensityLevel?: string;
}

/** Write (or replace) the single user-scale WorkoutMod for this workout. */
function applyUserScale(weekIdx: number, workout: Workout, workoutId: string | undefined, args: ScaleArgs): void {
  const s = getMutableState();
  const wk = s.wks[weekIdx];
  if (!wk) return;
  if (!wk.workoutMods) wk.workoutMods = [];

  // Replace any prior user-scale mod for this workout so they don't stack.
  removeUserScaleModInner(wk.workoutMods, workout, workoutId);

  // Always 'reduced' (the generic "modified from plan" status), never 'replaced':
  // plan-view strikes through and filters out 'replaced' runs, which would make a
  // longer/harder-scaled session vanish. 'reduced' inherits the neutral "Adjusted"
  // chip + "Undo adjustment" affordance regardless of direction.
  wk.workoutMods.push({
    name: workout.n,
    dayOfWeek: workout.dayOfWeek,
    // Stable slot id is the primary match key on re-render (see WorkoutMod.workoutId).
    // name + dayOfWeek stay for back-compat and as a fallback.
    workoutId,
    status: 'reduced',
    modReason: 'UserScaled: adjusted for this session',
    userScaledAt: new Date().toISOString(),
    // Original full plan description; the card's "Original:" caption is gated to
    // pure-distance labels, so a structured session's long description is suppressed.
    originalDistance: args.origDesc,
    originalDurationMin: args.origMin > 0 ? args.origMin : undefined,
    newDistance: args.newDesc,
    newDurationMin: args.newDurationMin,
    newType: args.newType,
    newRpe: args.newRpe,
  });

  saveState();
}

function removeUserScaleMod(weekIdx: number, workout: Workout, workoutId?: string): void {
  const s = getMutableState();
  const wk = s.wks[weekIdx];
  if (!wk?.workoutMods) return;
  removeUserScaleModInner(wk.workoutMods, workout, workoutId);
  saveState();
}

function removeUserScaleModInner(mods: WorkoutMod[], workout: Workout, workoutId?: string): void {
  for (let i = mods.length - 1; i >= 0; i--) {
    const m = mods[i];
    if (!m.userScaledAt) continue;
    const matchById = workoutId != null && m.workoutId === workoutId;
    const matchByNameDay = m.name === workout.n && (m.dayOfWeek == null || m.dayOfWeek === workout.dayOfWeek);
    if (matchById || matchByNameDay) mods.splice(i, 1);
  }
}

// ── Persisted-object scaling (tri / cycling / HYROX) ──────────────────────────
// These sessions live as objects in wk.triWorkouts and are NOT regenerated each
// render, so the scale is written straight onto the stored object. This is the
// same in-place mutation the drag-to-reorder handlers use, and is reload-safe
// without any match key. The original duration/description are stashed on the
// object so the slider re-anchors to the plan and Reset can restore it.

function findStored(weekIdx: number, store: 'triWorkouts' | 'adhocWorkouts', workoutId: string | undefined, workout: Workout): any | null {
  const s = getMutableState();
  const wk = s.wks[weekIdx] as any;
  if (!wk) return null;
  const key = workoutId ?? (workout as any).id ?? workout.n;
  // Search the hinted store first, then the other. Injury capability-substitute
  // sessions (bike/swim/erg) and other accepted offers live in adhocWorkouts, not
  // triWorkouts, so a hardcoded store would miss them and the adjust would no-op.
  const order: Array<'triWorkouts' | 'adhocWorkouts'> = store === 'adhocWorkouts'
    ? ['adhocWorkouts', 'triWorkouts'] : ['triWorkouts', 'adhocWorkouts'];
  for (const name of order) {
    const arr = wk[name] as any[] | undefined;
    const hit = arr?.find(w => (w.id ?? w.n) === key);
    if (hit) return hit;
  }
  return null;
}

function applyObjectScale(weekIdx: number, store: 'triWorkouts' | 'adhocWorkouts', workoutId: string | undefined, workout: Workout, args: ScaleArgs): void {
  const w = findStored(weekIdx, store, workoutId, workout);
  if (!w) return;

  // Anchor originals once. On a re-scale these are already present (the slider
  // re-opened from them), so don't overwrite with the already-scaled values.
  if (w.originalDistance == null && args.origDesc) w.originalDistance = args.origDesc;
  if (w.originalDurationMin == null && args.origMin > 0) w.originalDurationMin = args.origMin;
  // Stash original load once so Reset can restore it (the recompute below overwrites it).
  if (w.originalAerobic == null && typeof w.aerobic === 'number') w.originalAerobic = w.aerobic;
  if (w.originalAnaerobic == null && typeof w.anaerobic === 'number') w.originalAnaerobic = w.anaerobic;

  w.d = args.newDesc;
  if (args.newDurationMin != null) w.estimatedDurationMin = args.newDurationMin;
  if (args.newType) w.t = args.newType;
  if (args.newRpe != null) w.rpe = args.newRpe;
  // Bike/swim intensity rung (target watts/pace are derived live from FTP/CSS at
  // this rung; nothing baked into the description, so duration scaling stays clean).
  if (args.newIntensityLevel) w.intensityLevel = args.newIntensityLevel;

  // Planned load reflects the adjustment (PLANNING side — feeds the load bars and,
  // once the session is completed, the realized load; the forecast itself stays
  // neutral to the plan, moving only on completed activities). Two cases:
  //  • an intensity rung is in effect → recompute absolute load from kind + the
  //    (possibly scaled) duration via the same per-kind helper the plan engine uses;
  //  • duration-only change on a session that already carries load → scale it
  //    proportionally (load ∝ duration at fixed intensity). No invented numbers.
  const effectiveLevel = args.newIntensityLevel ?? w.intensityLevel;
  const finalDur = (typeof w.estimatedDurationMin === 'number' && w.estimatedDurationMin > 0)
    ? w.estimatedDurationMin : (args.origMin > 0 ? args.origMin : 0);
  if (effectiveLevel && finalDur > 0) {
    const load = loadForRung(effectiveLevel, finalDur);
    if (load) { w.aerobic = load.aerobic; w.anaerobic = load.anaerobic; }
  } else if (args.newDurationMin != null && args.origMin > 0 && typeof w.aerobic === 'number') {
    const f = args.newDurationMin / args.origMin;
    w.aerobic = Math.round(w.aerobic * f);
    if (typeof w.anaerobic === 'number') w.anaerobic = Math.round(w.anaerobic * f);
  }

  w.status = 'reduced';
  w.modReason = 'UserScaled: adjusted for this session';
  w.userScaledAt = new Date().toISOString();

  saveState();
}

function removeObjectScale(weekIdx: number, store: 'triWorkouts' | 'adhocWorkouts', workoutId: string | undefined, workout: Workout): void {
  const w = findStored(weekIdx, store, workoutId, workout);
  if (!w) return;
  if (w.originalDistance != null) { w.d = w.originalDistance; delete w.originalDistance; }
  if (w.originalDurationMin != null) { w.estimatedDurationMin = w.originalDurationMin; delete w.originalDurationMin; }
  // Restore original load (or clear it if the session never had any, e.g. an
  // injury cross session that only gained load when first made harder).
  if (w.originalAerobic != null) { w.aerobic = w.originalAerobic; delete w.originalAerobic; }
  else delete w.aerobic;
  if (w.originalAnaerobic != null) { w.anaerobic = w.originalAnaerobic; delete w.originalAnaerobic; }
  else delete w.anaerobic;
  delete w.intensityLevel;
  delete w.userScaledAt;
  delete w.status;
  delete w.modReason;
  saveState();
}
