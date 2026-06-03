/**
 * Illness classification + plan-modification schedule.
 *
 * Implements the Friman/Schwellnus above-neck / below-neck return-to-train rule:
 *   - Above-neck symptoms (runny nose, sore throat, mild headache): training at
 *     easy effort permitted with reduced volume.
 *   - Below-neck symptoms (fever, chest cough, body aches, GI): rest, then a
 *     graded return. Systemic symptoms (fever, body aches) extend the window.
 * Resting HR delta vs 28d baseline is used as an objective severity marker
 * (Hellard 2015): >+10 bpm shifts an above-neck case toward a rest day.
 *
 * All functions are pure. No DOM, no state mutation. UI calls these and writes
 * the result to s.illnessState.
 *
 * See docs/SCIENCE_LOG.md for the full rationale.
 */

import type { SimulatorState } from '@/types/state';

export type Symptom =
  | 'fever' | 'body_aches' | 'cough' | 'runny_nose'
  | 'sore_throat' | 'gi' | 'headache' | 'fatigue';

export type IllnessType = 'flu_chest' | 'head_cold' | 'gi' | 'other';
export type DayOfSymptoms = '1-2' | '3-5' | '6+';
export type Capacity = 'rest' | 'easy_only' | 'reduced' | 'full';
export type IntensityCeiling = 'rest' | 'easy' | 'steady' | 'full';

export interface ClassifyInput {
  illnessType: IllnessType;
  symptoms: Symptom[];
  severity1to10: number;
  rhrDeltaBpm: number | null;        // null when no baseline available
}

export interface Classification {
  neckRule: 'above' | 'below';
  severityTier: 'mild' | 'moderate' | 'severe';
  hasSystemic: boolean;
  rhrFlag: 'normal' | 'elevated' | 'high';
}

export interface ScheduleEntry {
  dateOffsetDays: number;
  capacity: Capacity;
  volumeFactor: number;              // 0–1
  intensityCeiling: IntensityCeiling;
}

// Symptoms that always indicate below-neck involvement (chest, gut, systemic).
const BELOW_NECK_SYMPTOMS: Symptom[] = ['fever', 'body_aches', 'cough', 'gi'];
// Systemic symptoms. Fever or body aches force the longer recovery window
// regardless of any other input (viral myocarditis risk per Schwellnus 2016).
const SYSTEMIC_SYMPTOMS: Symptom[] = ['fever', 'body_aches'];

/**
 * Classify an illness from form inputs into the four-axis schema the
 * schedule builder consumes. Pure function.
 */
export function classifyIllness(input: ClassifyInput): Classification {
  const hasSystemic = input.symptoms.some(s => SYSTEMIC_SYMPTOMS.includes(s));
  const hasBelowNeck = input.symptoms.some(s => BELOW_NECK_SYMPTOMS.includes(s));
  // Illness type 'flu_chest' or 'gi' also implies below-neck even before symptom selection.
  const typeForcesBelow = input.illnessType === 'flu_chest' || input.illnessType === 'gi';
  const neckRule: 'above' | 'below' = (hasBelowNeck || typeForcesBelow) ? 'below' : 'above';

  let severityTier: 'mild' | 'moderate' | 'severe';
  if (input.severity1to10 <= 3) severityTier = 'mild';
  else if (input.severity1to10 <= 6) severityTier = 'moderate';
  else severityTier = 'severe';

  let rhrFlag: 'normal' | 'elevated' | 'high' = 'normal';
  if (input.rhrDeltaBpm != null) {
    if (input.rhrDeltaBpm >= 10) rhrFlag = 'high';
    else if (input.rhrDeltaBpm >= 5) rhrFlag = 'elevated';
  }

  return { neckRule, severityTier, hasSystemic, rhrFlag };
}

/**
 * Convert the day-of-symptoms enum to a numeric estimate of how many days
 * the user is already into the illness when reporting. Used to shift the
 * schedule forward. A user reporting on day 4 doesn't get day-0 mods.
 */
function daysIntoIllness(dayOfSymptoms: DayOfSymptoms): number {
  switch (dayOfSymptoms) {
    case '1-2': return 1;
    case '3-5': return 4;
    case '6+':  return 7;
  }
}

/**
 * Build the day-by-day schedule based on classification + how far into the
 * illness the user already is. Schedule entries are indexed by days from
 * startDate (today when the user reports). Beyond schedule end = full capacity.
 */
export function buildSchedule(c: Classification, dayOfSymptoms: DayOfSymptoms): ScheduleEntry[] {
  const elapsed = daysIntoIllness(dayOfSymptoms);

  // Total acute-phase length from start of illness, before graded return.
  // Numbers calibrated against Friman/Schwellnus return-to-train guidance.
  let acuteTotalDays: number;
  if (c.hasSystemic) acuteTotalDays = 10;
  else if (c.neckRule === 'below') acuteTotalDays = 7;
  else if (c.severityTier === 'severe' || c.rhrFlag === 'high') acuteTotalDays = 4;
  else if (c.severityTier === 'moderate') acuteTotalDays = 3;
  else acuteTotalDays = 2;

  // Days remaining in the acute phase from today.
  const remaining = Math.max(1, acuteTotalDays - elapsed);

  const entries: ScheduleEntry[] = [];

  if (c.neckRule === 'below') {
    // Below-neck: full rest for the remainder of acute phase.
    for (let i = 0; i < remaining; i++) {
      entries.push({
        dateOffsetDays: i,
        capacity: 'rest',
        volumeFactor: 0,
        intensityCeiling: 'rest',
      });
    }
    // Then graded return. 4 days standard, 5 for systemic.
    const rampDays = c.hasSystemic ? 5 : 4;
    const rampFactors = c.hasSystemic
      ? [0.50, 0.65, 0.80, 0.90, 1.00]
      : [0.50, 0.70, 0.85, 1.00];
    const rampCeilings: IntensityCeiling[] = c.hasSystemic
      ? ['easy', 'easy', 'steady', 'steady', 'full']
      : ['easy', 'easy', 'steady', 'full'];
    for (let i = 0; i < rampDays; i++) {
      entries.push({
        dateOffsetDays: remaining + i,
        capacity: rampFactors[i] >= 1 ? 'full' : 'reduced',
        volumeFactor: rampFactors[i],
        intensityCeiling: rampCeilings[i],
      });
    }
  } else {
    // Above-neck: reduced easy volume during acute phase. RHR high → day 0 is rest.
    const volFactor = c.severityTier === 'severe' ? 0.60
      : c.severityTier === 'moderate' ? 0.70
      : 0.85;
    for (let i = 0; i < remaining; i++) {
      const isFirstDayHighRhr = i === 0 && c.rhrFlag === 'high';
      entries.push({
        dateOffsetDays: i,
        capacity: isFirstDayHighRhr ? 'rest' : 'easy_only',
        volumeFactor: isFirstDayHighRhr ? 0 : volFactor,
        intensityCeiling: isFirstDayHighRhr ? 'rest' : 'easy',
      });
    }
    // One day of light step-back before lifting all caps.
    entries.push({
      dateOffsetDays: remaining,
      capacity: 'reduced',
      volumeFactor: 0.95,
      intensityCeiling: 'full',
    });
  }

  return entries;
}

/** Derive a legacy severity tier from a schedule for back-compat consumers. */
export function deriveLegacySeverity(schedule: ScheduleEntry[]): 'light' | 'resting' {
  return schedule[0]?.capacity === 'rest' ? 'resting' : 'light';
}

/**
 * Look up today's schedule entry. Returns null when the user is past the
 * end of the schedule (i.e. fully returned).
 *
 * `todayISO` and `startISO` are 'YYYY-MM-DD' strings. Date math uses the
 * noon-UTC trick to dodge DST and timezone edges (same pattern as
 * buildIllnessBanner in plan-view.ts).
 */
export function getTodayCapacity(
  schedule: ScheduleEntry[] | undefined,
  startISO: string,
  todayISO: string,
): ScheduleEntry | null {
  if (!schedule || schedule.length === 0) return null;
  const start = new Date(startISO + 'T12:00:00');
  const today = new Date(todayISO + 'T12:00:00');
  const offset = Math.round((today.getTime() - start.getTime()) / 86400000);
  if (offset < 0) return null;
  // Find the entry whose dateOffsetDays matches; if none, use the largest
  // offset entry when within ±1 day; else return null (past end).
  const exact = schedule.find(e => e.dateOffsetDays === offset);
  if (exact) return exact;
  const maxOffset = schedule[schedule.length - 1]?.dateOffsetDays ?? -1;
  if (offset > maxOffset) return null;
  return null;
}

/**
 * Was a given calendar date a full-REST day under this illness? Reads the
 * persisted schedule + startDate (both survive recovery — clearIllness only
 * flips `active`). Used by adherence so illness-rested days don't count as
 * missed sessions (the banner promises "skipped workouts don't count against
 * adherence"). Only the most-recent illness is on state, so older illnesses
 * can't be corrected — an accepted limitation. Date strings are 'YYYY-MM-DD'.
 */
export function wasIllnessRestDay(
  illness: { schedule?: ScheduleEntry[]; startDate?: string } | undefined,
  dateISO: string,
): boolean {
  if (!illness?.schedule || illness.schedule.length === 0 || !illness.startDate) return false;
  return getTodayCapacity(illness.schedule, illness.startDate, dateISO)?.capacity === 'rest';
}

/** Build a short, plain-English bullet list summarising the schedule. UI uses this for the "Mosaic's response" preview. */
export function summariseSchedule(c: Classification, schedule: ScheduleEntry[]): string[] {
  if (schedule.length === 0) return [];
  const lines: string[] = [];

  const restDays = schedule.filter(e => e.capacity === 'rest').length;
  const rampDays = schedule.filter(e => e.capacity === 'reduced').length;
  const easyDays = schedule.filter(e => e.capacity === 'easy_only').length;

  if (c.neckRule === 'below') {
    if (restDays > 0) {
      lines.push(`Rest for the next ${restDays} ${restDays === 1 ? 'day' : 'days'}. Hard sessions in that window become rest.`);
    }
    if (rampDays > 0) {
      const last = schedule[schedule.length - 1];
      const startPct = Math.round((schedule.find(e => e.capacity === 'reduced')?.volumeFactor ?? 0.5) * 100);
      const endPct = Math.round((last.volumeFactor ?? 1) * 100);
      lines.push(`Then gradual return over ${rampDays} days: ${startPct}% to ${endPct}% volume, easy effort lifting to full.`);
    }
    if (c.hasSystemic) {
      lines.push('Systemic symptoms (fever or body aches) extend the rest window. Lifting and intensity blunt recovery and raise injury risk.');
    }
  } else {
    if (easyDays > 0) {
      const volPct = Math.round((schedule.find(e => e.capacity === 'easy_only')?.volumeFactor ?? 0.85) * 100);
      lines.push(`Easy effort only for ${easyDays} ${easyDays === 1 ? 'day' : 'days'} at ${volPct}% volume. Quality sessions downgraded to easy.`);
    }
    if (c.rhrFlag === 'high') {
      lines.push('Resting HR elevated more than 10 bpm. Today is a rest day; easy effort resumes once HR settles.');
    }
    if (rampDays > 0) {
      lines.push('Then one light day back at 95% before full intensity returns.');
    }
  }

  lines.push('Skipped workouts don\'t count against adherence.');
  return lines;
}

/** Modes for which strength sessions during below-neck recovery should be replaced with rest. */
export function shouldSuppressStrength(c: Classification | undefined): boolean {
  return !!c && c.neckRule === 'below';
}

/**
 * Resolve today's effective schedule entry by honouring the user's self-reported
 * capacity ("What can you do today?") when it is *more restrictive* than the
 * engine-derived schedule. Engine wins on ties or when equally/more restrictive.
 *
 * Rationale: the schedule reflects the literature-derived prescription, but the
 * user is the only one who knows how they actually feel today. If they say "I
 * can only walk" while the engine says "easy run is fine", we trust the user —
 * dialling down is always safe. We never dial *up* on a user override because
 * that would let a "feeling good" report cancel a clinically-indicated rest day.
 *
 * Ordering (most → least restrictive): rest > walks > easy_only > reduced > full.
 * 'walks' maps to 'rest' for plan-mutation purposes (no scheduled workout, the
 * user walks instead. Distinction is messaging, not engine behaviour).
 */
export function resolveEffectiveEntry(
  scheduleEntry: ScheduleEntry | null,
  override: 'easy_only' | 'walks' | 'rest' | undefined,
): ScheduleEntry | null {
  if (!override) return scheduleEntry;

  const baseOffset = scheduleEntry?.dateOffsetDays ?? 0;
  const scheduleCap = scheduleEntry?.capacity ?? 'full';

  // rest / walks → force rest. Walks collapses to rest at the plan level
  // (we don't generate "walk" workouts as plan substitutes. The user just
  // walks instead of doing the scheduled session).
  if (override === 'rest' || override === 'walks') {
    return { dateOffsetDays: baseOffset, capacity: 'rest', volumeFactor: 0, intensityCeiling: 'rest' };
  }

  // override === 'easy_only'
  // Engine more restrictive ('rest') or equal ('easy_only') → engine wins.
  if (scheduleCap === 'rest' || scheduleCap === 'easy_only') return scheduleEntry;

  // Engine says 'reduced' or 'full'. User is more restrictive. Synthesise an
  // easy_only entry. Inherit the engine's volumeFactor if the engine had one
  // (so a ramp day at 0.7 stays at 0.7 but capped to easy); otherwise default
  // to 0.85 (matches buildSchedule's mild above-neck factor).
  return {
    dateOffsetDays: baseOffset,
    capacity: 'easy_only',
    volumeFactor: scheduleEntry?.volumeFactor ?? 0.85,
    intensityCeiling: 'easy',
  };
}

/**
 * Compute today's resting-HR delta vs the 28d baseline from a PhysiologyDayEntry-like
 * history. Returns null when there isn't enough usable data:
 *   - fewer than 5 baseline points, or
 *   - the latest valid entry is more than 3 days stale.
 *
 * Kept here (not in illness-modal.ts) so the banner can read the same delta the
 * modal used at save time. I.e. so "still elevated past schedule end" nudges
 * use a consistent calculation.
 */
export function computeRhrDeltaFromHistory(history: Array<{ date: string; restingHR?: number }> | undefined): number | null {
  const usable = (history ?? []).filter(e => typeof e?.restingHR === 'number' && (e.restingHR as number) > 0);
  if (usable.length < 5) return null;

  const todayMs = Date.now();
  const latest = usable[usable.length - 1];
  const latestMs = new Date(latest.date + 'T12:00:00').getTime();
  if ((todayMs - latestMs) / 86400000 > 3) return null;

  const latestRhr = latest.restingHR as number;
  const baselinePool = usable.slice(-29, -1).map(e => e.restingHR as number);
  if (baselinePool.length < 5) return null;
  const baseline = baselinePool.reduce((a: number, b: number) => a + b, 0) / baselinePool.length;
  return Math.round(latestRhr - baseline);
}

/**
 * Returns the user's race / target-event date if one is set, else null.
 * Looks across all four mode-specific surfaces (running, triathlon, hyrox,
 * generic onboarding override). Returns YYYY-MM-DD or null.
 */
export function getRaceDateISO(s: any): string | null {
  const raw =
    s?.selectedMarathon?.date ||
    s?.onboarding?.customRaceDate ||
    s?.triConfig?.raceDate ||
    s?.hyroxConfig?.raceDate ||
    null;
  if (!raw) return null;
  // Date strings on state may be 'YYYY-MM-DD' or full ISO. Normalise to YYYY-MM-DD.
  if (typeof raw !== 'string') return null;
  return raw.length >= 10 ? raw.slice(0, 10) : null;
}

/**
 * Flag race-window collisions: returns 'acute' if the race falls during a rest
 * day, 'ramp' if it falls during a reduced/easy_only day, 'safe' if it falls
 * after the schedule, and null if no race is set or schedule is empty.
 *
 * Caller is expected to surface this in the modal preview and the active
 * illness banner. Silent volume scaling on a race day is the worst case we
 * want to avoid.
 */
export function detectRaceCollision(
  raceDateISO: string | null,
  startISO: string,
  schedule: ScheduleEntry[] | undefined,
  todayISO: string = new Date().toISOString().split('T')[0],
): { phase: 'acute' | 'ramp' | 'safe'; daysFromToday: number } | null {
  if (!raceDateISO || !schedule || schedule.length === 0) return null;
  const start = new Date(startISO + 'T12:00:00');
  const race = new Date(raceDateISO + 'T12:00:00');
  const today = new Date(todayISO + 'T12:00:00');
  const daysFromToday = Math.round((race.getTime() - today.getTime()) / 86400000);
  if (daysFromToday < 0) return null; // race already past. Not our problem

  const raceOffset = Math.round((race.getTime() - start.getTime()) / 86400000);
  const entry = schedule.find(e => e.dateOffsetDays === raceOffset);
  if (!entry) return { phase: 'safe', daysFromToday };
  if (entry.capacity === 'rest') return { phase: 'acute', daysFromToday };
  if (entry.capacity === 'easy_only' || entry.capacity === 'reduced') return { phase: 'ramp', daysFromToday };
  return { phase: 'safe', daysFromToday };
}

// ─── Plan modification. Applied at render time ──────────────────────────────
//
// Pure-ish: takes a workouts array + illness state, mutates in place. No DOM,
// no state-store reads. Kept here (not in illness-modal.ts) so unit tests can
// import without pulling in UI / state-store side effects.

type IllnessStateV2 = NonNullable<SimulatorState['illnessState']>;

const REST_LIKE_KW = ['walk', 'yoga', 'pilates', 'rest', 'mobility', 'stretch'];
const QUALITY_RUN_KW = ['threshold', 'interval', 'tempo', 'marathon_pace', 'race_pace', 'strides', 'fartlek', 'hiit', 'vo2'];

function matchesAny(haystack: string, words: string[]): boolean {
  return words.some(w => haystack.includes(w));
}

function parseKmFromDesc(d: string): number {
  const m = (d || '').match(/(\d+\.?\d*)\s*km/i);
  return m ? parseFloat(m[1]) : 0;
}

function parseMinFromDesc(d: string): number {
  const m = (d || '').match(/(\d+\.?\d*)\s*min/i);
  return m ? parseFloat(m[1]) : 0;
}

function markRest(w: any): void {
  const origKm = parseKmFromDesc(w.d);
  w.illnessMod = true;
  w.illnessSeverity = 'resting';
  w.originalDistance = origKm > 0 ? `${origKm}km` : (w.d || w.n);
  w.d = 'Rest — illness';
  w.r = 0;
  // Duration-driven cards (bike/swim/station/brick/strength) render from the
  // numeric fields, not `d`, so zero them too or the card shows full load.
  if (w.estimatedDurationMin != null) {
    w.originalDurationMin = w.estimatedDurationMin;
    w.estimatedDurationMin = 0;
  }
  if (w.musculoTendonLoad != null) w.musculoTendonLoad = 0;
}

function scaleAndCap(w: any, entry: ScheduleEntry, kind: 'run' | 'bike' | 'swim' | 'strength'): void {
  w.illnessMod = true;
  w.illnessSeverity = 'light';

  const isQuality = kind === 'run' && matchesAny((w.t || '').toLowerCase() + ' ' + (w.n || '').toLowerCase(), QUALITY_RUN_KW);
  const downgradeIntensity = entry.intensityCeiling === 'easy' && (isQuality || kind === 'bike' || kind === 'swim');

  const origKm = parseKmFromDesc(w.d);
  if (origKm > 0) {
    const newKm = Math.max(2, Math.round(origKm * entry.volumeFactor * 2) / 2);
    w.originalDistance = `${origKm}km`;
    w.d = downgradeIntensity ? `${newKm}km easy pace` : `${newKm}km ${entry.intensityCeiling === 'steady' ? 'steady' : 'easy'} pace`;
  } else {
    const origMin = parseMinFromDesc(w.d);
    if (origMin > 0) {
      const newMin = Math.max(15, Math.round(origMin * entry.volumeFactor / 5) * 5);
      w.originalDistance = `${origMin}min`;
      w.d = downgradeIntensity ? `${newMin}min easy` : `${newMin}min ${entry.intensityCeiling === 'steady' ? 'steady' : 'easy'}`;
    } else {
      w.originalDistance = w.d || w.n;
      w.d = `${(w.d || w.n || '').trim()} (illness — reduced)`.trim();
    }
  }

  if (isQuality && downgradeIntensity) {
    w.t = 'easy';
  }
  w.r = Math.min(typeof w.r === 'number' ? w.r : 4, downgradeIntensity ? 4 : 5);

  // Duration-driven cards (bike/swim/station/brick/strength) render from the
  // numeric fields, so scale them by the same volume factor as the description.
  if (typeof w.estimatedDurationMin === 'number' && w.estimatedDurationMin > 0) {
    w.originalDurationMin = w.originalDurationMin ?? w.estimatedDurationMin;
    w.estimatedDurationMin = Math.max(15, Math.round(w.estimatedDurationMin * entry.volumeFactor / 5) * 5);
  }
  if (typeof w.musculoTendonLoad === 'number') {
    w.musculoTendonLoad = Math.round(w.musculoTendonLoad * entry.volumeFactor);
  }
}

/**
 * Discipline-aware illness mods for the legacy `{severity}` illnessState used
 * by the live illness modal. The legacy `applyIllnessMods` (illness-modal.ts and
 * the `applyLegacyMods` fallback above) skip everything in NON_RUN_TYPES, so on
 * triathlon and HYROX they only ever touch the run legs and silently leave bike,
 * swim, stations, and bricks at full load. This generalises the same severity
 * tiers across all sport disciplines via `classifyWorkoutKind`, so resting rests
 * the whole week and light reduces every discipline.
 *
 * Reuses the existing volume ratio (0.6) and the canonical `scaleAndCap`/`markRest`
 * helpers — no new constants. Run-leg behaviour is unchanged versus the legacy
 * path (quality downgraded to easy, volume reduced); the only new behaviour is
 * that non-run disciplines are no longer skipped.
 *
 *   resting → every run/bike/swim/strength session becomes rest.
 *   light   → volume scaled to 0.6, intensity capped to easy (quality/bike/swim
 *             downgraded; stations/bricks reduced in duration, intensity kept).
 *
 * rest_like (walk/yoga/mobility) and 'other' (padel/climb) are left alone, matching
 * the v2 engine. Render-time only — not persisted.
 */
const ILLNESS_LIGHT_ENTRY: ScheduleEntry = {
  dateOffsetDays: 0,
  capacity: 'reduced',
  volumeFactor: 0.6,
  intensityCeiling: 'easy',
};

export function applyIllnessModsAllDisciplines(workouts: any[], severity: 'light' | 'resting'): void {
  for (const w of workouts) {
    const kind = classifyWorkoutKind(w);
    if (kind === 'rest_like' || kind === 'other') continue;
    // markRest / scaleAndCap now scale the numeric duration + musculoTendonLoad
    // fields too (the cards render from those, not `d`), so no manual scaling here.
    if (severity === 'resting') markRest(w);
    else scaleAndCap(w, ILLNESS_LIGHT_ENTRY, kind);
  }
}

/**
 * Classify a workout by its primary discipline. Order matters:
 *   rest_like  → walk/yoga/pilates/rest/mobility (never mutated outside rest)
 *   bike       → type starts with bike_/cycl_  OR name leads with Bike/Cycl/Ride/Spin
 *   swim       → type starts with swim_         OR name leads with Swim
 *   strength   → hyrox_station/assessment/brick types, OR strength/gym/lift
 *   run        → has km in description, or type/name matches known run keywords
 *   other      → fallback (padel, tennis, climb, etc.). Non-rest capacity leaves these alone
 */
export function classifyWorkoutKind(w: any): 'run' | 'bike' | 'swim' | 'strength' | 'rest_like' | 'other' {
  const t = (w.t || '').toLowerCase();
  const n = (w.n || '').toLowerCase();

  if (matchesAny(t + ' ' + n, REST_LIKE_KW)) return 'rest_like';

  if (/^bike|^cycl/.test(t) || /^(bike|cycl|ride|spin)\b/.test(n)) return 'bike';
  if (/^swim/.test(t)         || /^swim\b/.test(n))                   return 'swim';

  if (/^hyrox_(station|assessment|brick|mini_brick)/.test(t)) return 'strength';
  if (/^(strength|gym|lift)/.test(t))                           return 'strength';
  if (/^(strength|gym|lift)\b/.test(n))                         return 'strength';

  if (parseKmFromDesc(w.d) > 0) return 'run';
  if (/^(easy|long|tempo|threshold|interval|fartlek|strides|marathon|race|recovery)/.test(t)) return 'run';
  if (/easy|long|tempo|threshold|interval|fartlek|strides|marathon|race/.test(n)) return 'run';

  return 'other';
}

/**
 * Apply illness modifications to a workouts array IN MEMORY.
 *
 * - capacity 'rest': all sport workouts become rest (run, bike, swim, strength).
 * - capacity 'easy_only': scale volume, cap intensity to easy. Quality runs downgraded.
 * - capacity 'reduced': scale volume; intensity cap only if ceiling is 'easy' or 'steady'.
 * - capacity 'full': no mutation.
 * - Below-neck classification: strength always suppressed (myocarditis risk).
 * - userCapacityOverride: when more restrictive than the engine, overrides today's entry.
 * - 'other' workouts (padel, climb, …): skipped outside the rest case (no reliable parser).
 * - Optional todayISO: lets tests pin today; falls back to actual current date.
 */
export function applyIllnessMods(
  workouts: any[],
  illness: IllnessStateV2,
  todayISO: string = new Date().toISOString().split('T')[0],
): void {
  if (!illness.schedule || illness.schedule.length === 0) {
    // Legacy state (pre-v2, only `severity`): scale ALL disciplines, not just
    // runs. (The old run-only fallback silently left bike/swim/strength at full
    // load — the bug this whole wiring closes.) No classification → no below-neck
    // strength suppression, but the modal now always writes a schedule, so this
    // only fires for an in-flight illness reported before the upgrade.
    applyIllnessModsAllDisciplines(workouts, illness.severity);
    return;
  }

  const scheduleEntry = getTodayCapacity(illness.schedule, illness.startDate, todayISO);
  const entry = resolveEffectiveEntry(scheduleEntry, illness.userCapacityOverride);
  if (!entry || entry.capacity === 'full') return;

  const suppressStrength = shouldSuppressStrength(illness.classification);

  for (const w of workouts) {
    const kind = classifyWorkoutKind(w);
    if (kind === 'rest_like') continue;

    if (suppressStrength && kind === 'strength') {
      markRest(w);
      continue;
    }

    if (entry.capacity === 'rest') {
      markRest(w);
      continue;
    }

    if (kind === 'other') continue;

    scaleAndCap(w, entry, kind);
  }
}
