/**
 * sport-picker-modal.ts
 * Centered modal for reclassifying a cross-training activity to a different sport.
 * Opened from the activity detail page when the auto-derived sport is wrong or missing
 * (most commonly "Cardio" activities that map to generic_sport).
 *
 * Writes back:
 *  - actual.manualSport (user override for load/impact/leg-load)
 *  - wk.actualTSS / wk.actualImpactLoad delta
 *  - recentLegLoads entry (old removed, new added)
 *  - sportNameMappings[normalizedName] so future syncs of same-named activities auto-apply
 */

import { getMutableState, saveState } from '@/state';
import { SPORTS_DB, SPORT_LABELS, SPORT_ALIASES, TL_PER_MIN, IMPACT_PER_KM } from '@/constants';
import { applyRbeDiscount } from '@/calculations/readiness';
import type { GarminActual, SportKey, Week } from '@/types';

// ── Running leg load ─────────────────────────────────────────────────────────
//
// Running EIMD scales with footstrikes (distance) and per-stride force (effort).
// We reuse IMPACT_PER_KM (already calibrated for matched workout types) and map
// RPE → impact tier when a planned type isn't available. Rationale in
// docs/SCIENCE_LOG.md.

/** Map RPE 1-10 to an effort multiplier mirroring IMPACT_PER_KM tiers. */
function effortMultiplierForRpe(rpe: number): number {
  if (rpe <= 4)  return IMPACT_PER_KM.easy;          // 1.00
  if (rpe === 5) return IMPACT_PER_KM.marathon_pace; // 1.15
  if (rpe === 6) return IMPACT_PER_KM.float;         // 1.25
  if (rpe === 7) return IMPACT_PER_KM.threshold;     // 1.30
  if (rpe === 8) return IMPACT_PER_KM.race_pace;     // 1.35
  return IMPACT_PER_KM.vo2;                          // 1.50 — RPE 9-10
}

/** Detect a running activity from its activityType string. */
function isRunActivity(actual: GarminActual): boolean {
  const t = (actual.activityType || '').toUpperCase();
  if (!t) return false;
  return t.includes('RUN');
}

/**
 * Derive RPE for a run when computing leg load. Priority: explicit week.rated[id],
 * HR-based Karvonen mapping (same tiers as deriveRPE), then default 5.
 */
function deriveRunRpe(actual: GarminActual, weekRpe: number | undefined): number {
  if (weekRpe != null && weekRpe >= 1 && weekRpe <= 10) return weekRpe;
  const s = getMutableState();
  const avgHR = actual.avgHR;
  if (avgHR != null) {
    const estimatedMax = s.maxHR || (s.onboarding?.age ? Math.round(220 - s.onboarding.age) : null);
    const estimatedResting = s.restingHR || 55;
    if (estimatedMax && estimatedMax > estimatedResting + 20) {
      const intensity = (avgHR - estimatedResting) / (estimatedMax - estimatedResting);
      if (intensity >= 0) {
        if (intensity < 0.5)  return 3;
        if (intensity < 0.65) return 4;
        if (intensity < 0.75) return 5;
        if (intensity < 0.82) return 6;
        if (intensity < 0.89) return 8;
        return 9;
      }
    }
  }
  return 5;
}

/**
 * Compute run leg load: distance × effort multiplier. Returns 0 if no GPS distance.
 * Hard-run RBE is the caller's responsibility — RPE >= 7 should skip RBE since
 * maximal efforts are novel stress and protection does not transfer (Chen et al.
 * 2007: RBE attenuates when bout intensity exceeds the protective bout's).
 */
function computeRunLegLoad(actual: GarminActual, rpe: number): number {
  if (!actual.distanceKm || actual.distanceKm <= 0) return 0;
  return actual.distanceKm * effortMultiplierForRpe(rpe);
}

/** Threshold above which RBE is suppressed for runs (novel-stress argument). */
const HARD_RUN_RPE = 7;

// ── Design tokens (match activity-detail.ts) ─────────────────────────────────

const PAGE_BG = '#FAF9F6';
const TEXT_M  = '#0F172A';
const TEXT_S  = '#64748B';
const TEXT_L  = '#94A3B8';

// ── Sport resolution ──────────────────────────────────────────────────────────

/** Normalize an activity name for mapping lookup. Lowercase + strip non-letters. */
export function normalizeActivityName(name: string): string {
  return (name || '').toLowerCase().trim().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
}

/** Best-guess sport from activityType string (Garmin/Strava raw or normalised). */
function deriveSportFromActivityType(activityType: string | null | undefined): SportKey {
  if (!activityType) return 'generic_sport';
  const raw = activityType.toLowerCase().trim();
  // Direct SportKey hit
  if (raw in SPORTS_DB) return raw as SportKey;
  // Alias hit
  if (raw in SPORT_ALIASES) return SPORT_ALIASES[raw];
  // Garmin-style codes
  if (raw.includes('run')) return 'extra_run';
  if (raw.includes('swim')) return 'swimming';
  if (raw.includes('cycl') || raw.includes('bike') || raw.includes('ride') || raw.includes('mountain_bik')) return 'cycling';
  if (raw.includes('walk')) return 'walking';
  if (raw.includes('hik')) return 'hiking';
  if (raw.includes('ski') && raw.includes('board')) return 'snowboarding';
  if (raw.includes('ski')) return 'skiing';
  if (raw.includes('yoga')) return 'yoga';
  if (raw.includes('row')) return 'rowing';
  if (raw.includes('climb')) return 'climbing';
  if (raw.includes('strength') || raw.includes('weight') || raw.includes('gym')) return 'strength';
  if (raw.includes('kite')) return 'kitesurfing';
  if (raw.includes('surf')) return 'surfing';
  if (raw.includes('sail')) return 'sailing';
  if (raw.includes('kayak') || raw.includes('canoe')) return 'kayaking';
  if (raw.includes('paddle') || raw === 'sup') return 'paddleboard';
  if (raw.includes('wake')) return 'wakeboarding';
  return 'generic_sport';
}

/** Resolve the effective sport for an activity.
 *  Precedence: manual override > activityType derivation (when unambiguous) >
 *  persistent name mapping (only when type derives to generic_sport) > generic_sport.
 *
 *  Name mappings are deliberately checked AFTER the activity-type derivation so
 *  that an explicit Strava sport (e.g. "kitesurf", "running") is always trusted.
 *  A learned name mapping only kicks in when Strava itself was ambiguous (e.g.
 *  catch-all "Workout" → CARDIO → generic_sport), which is the only case where
 *  the user's prior reclassification of a same-named activity is meaningful. */
export function getEffectiveSport(actual: GarminActual): SportKey {
  if (actual.manualSport && actual.manualSport in SPORTS_DB) return actual.manualSport;
  const derived = deriveSportFromActivityType(actual.activityType);
  if (derived !== 'generic_sport') return derived;
  const s = getMutableState();
  const nameKey = normalizeActivityName(actual.workoutName || actual.displayName || actual.activityType || '');
  if (nameKey && s.sportNameMappings?.[nameKey]) {
    const mapped = s.sportNameMappings[nameKey];
    if (mapped in SPORTS_DB) return mapped;
  }
  return derived;
}

/**
 * Resolve a SportKey for an incoming activity during sync. Order of precedence:
 *   1. App-type mapping (from mapAppTypeToSport) when it gives a real sport
 *   2. Raw activityType deriving when it gives a real sport
 *   3. Persistent name mapping (only when the type is ambiguous / generic_sport)
 *   4. generic_sport fallback
 *
 * Name mappings are intentionally LAST so that an explicit Strava sport always
 * wins over a learned name override — otherwise reclassifying one same-named
 * activity would silently flip every future activity sharing that name.
 */
export function resolveSportForActivity(
  activityName: string | null | undefined,
  appTypeSport: string | null | undefined,
  rawActivityType?: string | null,
): SportKey {
  if (appTypeSport && appTypeSport in SPORTS_DB && appTypeSport !== 'generic_sport') {
    return appTypeSport as SportKey;
  }
  const derived = deriveSportFromActivityType(rawActivityType ?? appTypeSport ?? null);
  if (derived !== 'generic_sport') return derived;
  const s = getMutableState();
  const nameKey = normalizeActivityName(activityName ?? '');
  if (nameKey && s.sportNameMappings?.[nameKey]) {
    const mapped = s.sportNameMappings[nameKey];
    if (mapped in SPORTS_DB) return mapped;
  }
  return derived;
}

// ── Load deltas ──────────────────────────────────────────────────────────────

/** Compute crossTL for an activity using a given sport's runSpec.
 *  Mirrors the calculation in activity-review.ts:1293 and activity-matcher.ts so
 *  the reclassify delta lines up exactly. */
function computeCrossTL(actual: GarminActual, sport: SportKey): number {
  const cfg = SPORTS_DB[sport];
  const runSpec = cfg?.runSpec ?? 0.35;
  const durationMin = actual.durationSec > 0 ? actual.durationSec / 60 : 0;
  if (actual.iTrimp != null && actual.iTrimp > 0) {
    return (actual.iTrimp * 100) / 15000 * runSpec;
  }
  // Fallback to RPE-based. No RPE on GarminActual → use moderate default (5 ≈ 1.15/min).
  const rpeRate = TL_PER_MIN[5] ?? 1.15;
  return durationMin * rpeRate * runSpec;
}

function computeImpact(actual: GarminActual, sport: SportKey): number {
  const cfg = SPORTS_DB[sport];
  const impactPerMin = cfg?.impactPerMin ?? 0.04;
  const durationMin = actual.durationSec > 0 ? actual.durationSec / 60 : 0;
  return durationMin * impactPerMin;
}

function computeLegLoad(actual: GarminActual, sport: SportKey, weekRpe?: number): number {
  // Runs use km × effort multiplier (footstrike-driven EIMD), not duration × per-min rate.
  if (sport === 'running' || isRunActivity(actual)) {
    const rpe = deriveRunRpe(actual, weekRpe);
    return computeRunLegLoad(actual, rpe);
  }
  const cfg = SPORTS_DB[sport];
  const rate = cfg?.legLoadPerMin ?? 0;
  const durationMin = actual.durationSec > 0 ? actual.durationSec / 60 : 0;
  return durationMin * rate;
}

/**
 * Reconcile `recentLegLoads` against current `garminActuals` across all weeks.
 *
 * Leg-load entries are normally pushed by the activity-review flow. Activities
 * that are auto-matched at sync time (no review modal) don't pass through that
 * path, so their leg load is silently missed — even if the auto-resolved sport
 * (via `sportNameMappings`) correctly identifies them as leg-loading.
 *
 * This pass walks every garminActual in the last 7 days, computes the effective
 * sport's leg-load contribution, and adds a `recentLegLoads` entry for any
 * activity missing one (keyed by garminId). Idempotent — runs cheaply on each
 * leg-load view open.
 *
 * Returns true if entries were added (caller can saveState).
 */
export function reconcileRecentLegLoads(): boolean {
  const s = getMutableState();
  const nowMs = Date.now();
  const sevenDaysMs = 7 * 24 * 3_600_000;
  const existing = s.recentLegLoads ?? [];
  const byGarminId = new Map<string, true>();
  for (const e of existing) {
    if (e.garminId) byGarminId.set(e.garminId, true);
  }

  // Collect all candidate backfills, then sort chronologically so that earlier
  // bouts are recorded first and correctly establish RBE protection for later ones.
  const candidates: Array<{ actual: GarminActual; sport: SportKey; rawLoad: number; ts: number; rpe: number; isRun: boolean }> = [];
  for (const wk of s.wks ?? []) {
    if (!wk.garminActuals) continue;
    for (const [workoutId, actual] of Object.entries(wk.garminActuals)) {
      if (!actual.garminId || byGarminId.has(actual.garminId)) continue;
      if (!actual.startTime) continue;
      const ts = new Date(actual.startTime).getTime();
      if (nowMs - ts >= sevenDaysMs) continue;

      const isRun = isRunActivity(actual);
      // Runs route through the 'running' sport bucket for distance-based EIMD.
      // Cross-training keeps its activity-type-derived sport.
      const sport: SportKey = isRun ? 'running' : getEffectiveSport(actual);
      const ratedRaw = wk.rated?.[workoutId];
      const weekRpe = typeof ratedRaw === 'number' ? ratedRaw : undefined;
      const rpe = isRun ? deriveRunRpe(actual, weekRpe) : 5;
      const rawLoad = computeLegLoad(actual, sport, weekRpe);
      if (rawLoad <= 0) continue;
      candidates.push({ actual, sport, rawLoad, ts, rpe, isRun });
    }
  }
  candidates.sort((a, b) => a.ts - b.ts);

  let added = false;
  for (const c of candidates) {
    const sportLabel = (SPORT_LABELS as Record<string, string>)[c.sport] ?? c.sport;
    // Hard runs (RPE >= 7) skip RBE: maximal-effort EIMD is novel stress and
    // adaptation from prior easy bouts does not transfer.
    const skipRbe = c.isRun && c.rpe >= HARD_RUN_RPE;
    const { load, protected: rbeProtected } = skipRbe
      ? { load: c.rawLoad, protected: false }
      : applyRbeDiscount(c.sport, c.ts, c.rawLoad, existing);
    existing.push({ load, sport: c.sport, sportLabel, timestampMs: c.ts, garminId: c.actual.garminId, rbeProtected });
    byGarminId.set(c.actual.garminId!, true);
    added = true;
  }

  if (added) s.recentLegLoads = existing;
  return added;
}

// ── Reclassify ───────────────────────────────────────────────────────────────

/** Find the week containing a given garminId (via garminActuals map). */
function findWeekForActual(garminId: string): { wk: Week; workoutId: string } | null {
  const s = getMutableState();
  for (const wk of s.wks ?? []) {
    if (!wk.garminActuals) continue;
    for (const [wid, ga] of Object.entries(wk.garminActuals)) {
      if (ga.garminId === garminId) return { wk, workoutId: wid };
    }
  }
  return null;
}

/**
 * Reclassify an activity to a different sport. Applies deltas to week totals and
 * leg load history, persists the user's choice as a name mapping, and saves state.
 * Returns the updated GarminActual (mutated in place).
 */
export function reclassifyActivity(actual: GarminActual, newSport: SportKey): GarminActual {
  const oldSport = getEffectiveSport(actual);
  if (oldSport === newSport) return actual;

  const s = getMutableState();
  const located = findWeekForActual(actual.garminId);

  // Apply week-scoped deltas only if the activity is matched to a week. An activity
  // that lives in garminPending (not yet matched) has no week totals to update,
  // but we still update leg-load + the persisted override below.
  if (located) {
    const { wk } = located;
    const oldTL = computeCrossTL(actual, oldSport);
    const newTL = computeCrossTL(actual, newSport);
    const oldImpact = computeImpact(actual, oldSport);
    const newImpact = computeImpact(actual, newSport);
    wk.actualTSS = Math.max(0, Math.round((wk.actualTSS ?? 0) + (newTL - oldTL)));
    wk.actualImpactLoad = Math.max(0, Math.round((wk.actualImpactLoad ?? 0) + (newImpact - oldImpact)));
  }

  // Leg load: remove any previous entry for this activity, then re-add from the
  // new sport. Runs even when the activity isn't matched to a week, so that
  // leg-load tracking reflects the user's chosen sport as soon as they pick it.
  // RBE discount applied against the filtered prior entries (same-sport within 14d
  // → 0.6× raw load).
  const existing = s.recentLegLoads ?? [];
  const filtered = existing.filter(e => e.garminId !== actual.garminId);
  const rawLegLoad = computeLegLoad(actual, newSport);
  const ts = actual.startTime ? new Date(actual.startTime).getTime() : Date.now();
  if (rawLegLoad > 0) {
    const sportLabel = (SPORT_LABELS as Record<string, string>)[newSport] ?? newSport;
    const { load, protected: rbeProtected } = applyRbeDiscount(newSport, ts, rawLegLoad, filtered);
    filtered.push({ load, sport: newSport, sportLabel, timestampMs: ts, garminId: actual.garminId, rbeProtected });
  }
  s.recentLegLoads = filtered;

  // Persist user override on the actual ONLY. Reclassification is scoped to this
  // activity. We deliberately do NOT write a name → sport mapping: name-keyed
  // propagation is unsafe because Strava reuses generic names ("Workout",
  // "Morning Activity") across unrelated sessions, so a single correction would
  // flip every same-named activity. If recurring auto-classification is needed
  // later, it should be an explicit user opt-in, not a side-effect.

  saveState();
  return actual;
}

// ── Picker modal ─────────────────────────────────────────────────────────────

/** Sports excluded from the picker list (internal types, not user-selectable). */
const PICKER_EXCLUDE: Set<SportKey> = new Set(['extra_run', 'hybrid_test_sport']);

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SVG check mark (used to indicate the currently-selected sport in the list). */
function checkSvg(size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${TEXT_M}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>`;
}

/**
 * Open the sport picker modal. User taps a sport to select, then Save to confirm.
 * Resolves with the chosen SportKey on Save, or null on Cancel / backdrop / same-as-current.
 */
export function showSportPicker(currentSport: SportKey): Promise<SportKey | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
    overlay.style.background = 'rgba(0,0,0,0.5)';
    overlay.style.backdropFilter = 'blur(6px)';
    (overlay.style as any).webkitBackdropFilter = 'blur(6px)';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.18s ease';

    let selected: SportKey = currentSport;

    const sports: { key: SportKey; label: string }[] = (Object.keys(SPORT_LABELS) as SportKey[])
      .filter(k => !PICKER_EXCLUDE.has(k))
      .map(k => ({ key: k, label: SPORT_LABELS[k] }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const renderRows = (): string => sports.map(({ key, label }) => {
      const isSelected = key === selected;
      const isCurrent = key === currentSport;
      const bg = isSelected ? 'rgba(15,23,42,0.07)' : 'transparent';
      const weight = isSelected ? '600' : '500';
      const currentBadge = isCurrent && !isSelected
        ? `<span style="font-size:10px;font-weight:500;color:${TEXT_L};margin-left:8px">current</span>`
        : '';
      const check = isSelected ? checkSvg(15) : '';
      return `<button data-sport="${key}" style="
        width:100%;padding:12px 14px;border:none;background:${bg};
        display:flex;align-items:center;justify-content:space-between;gap:8px;
        font-size:14px;font-weight:${weight};color:${TEXT_M};cursor:pointer;
        font-family:var(--f);text-align:left;border-radius:10px;transition:background 0.12s ease;
      ">
        <span style="display:flex;align-items:baseline;min-width:0"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label)}</span>${currentBadge}</span>
        ${check}
      </button>`;
    }).join('');

    overlay.innerHTML = `
      <style>
        @keyframes spModalIn { from { opacity:0; transform:translateY(8px) scale(0.98); } to { opacity:1; transform:translateY(0) scale(1); } }
        #sp-card { animation: spModalIn 0.22s cubic-bezier(0.2,0.8,0.2,1) forwards; }
        #sp-list::-webkit-scrollbar { width:4px }
        #sp-list::-webkit-scrollbar-thumb { background:rgba(0,0,0,0.12); border-radius:4px }
        #sp-save:disabled { opacity:0.35; cursor:not-allowed; }
      </style>
      <div id="sp-card" class="w-full max-w-sm" style="
        background:${PAGE_BG};border-radius:20px;display:flex;flex-direction:column;max-height:78vh;
        box-shadow:0 4px 12px rgba(0,0,0,0.08),0 20px 48px rgba(0,0,0,0.18);overflow:hidden;
      ">
        <div style="padding:20px 22px 12px;flex-shrink:0">
          <div style="font-size:17px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em;margin-bottom:4px">Choose activity</div>
          <div style="font-size:12px;color:${TEXT_S};line-height:1.5">Load, impact and leg fatigue will recalculate for this activity.</div>
        </div>
        <div id="sp-list" style="flex:1;overflow-y:auto;padding:6px 14px 14px;display:flex;flex-direction:column;gap:1px"></div>
        <div style="padding:14px 20px 18px;flex-shrink:0;border-top:1px solid rgba(0,0,0,0.06);display:flex;gap:10px">
          <button id="sp-cancel" style="
            flex:1;padding:12px;border-radius:12px;border:1px solid rgba(0,0,0,0.09);
            background:transparent;font-size:13px;font-weight:600;color:${TEXT_S};cursor:pointer;
            font-family:var(--f);transition:background 0.12s ease;
          ">Cancel</button>
          <button id="sp-save" style="
            flex:1;padding:12px;border-radius:12px;border:none;
            background:${TEXT_M};font-size:13px;font-weight:600;color:#fff;cursor:pointer;
            font-family:var(--f);transition:opacity 0.12s ease;
          ">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });

    const listEl = overlay.querySelector('#sp-list') as HTMLElement;
    const saveBtn = overlay.querySelector('#sp-save') as HTMLButtonElement;
    listEl.innerHTML = renderRows();

    const syncSave = () => { saveBtn.disabled = selected === currentSport; };
    syncSave();

    const close = (val: SportKey | null) => {
      overlay.style.opacity = '0';
      setTimeout(() => { overlay.remove(); resolve(val); }, 160);
    };

    listEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-sport]');
      if (!btn) return;
      const sport = btn.dataset.sport as SportKey;
      if (!sport || !(sport in SPORTS_DB)) return;
      if (sport === selected) return;
      selected = sport;
      listEl.innerHTML = renderRows();
      syncSave();
    });

    saveBtn.addEventListener('click', () => {
      if (selected === currentSport) return;
      close(selected);
    });
    overlay.querySelector('#sp-cancel')!.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
  });
}
