import type { OnboardingState } from '@/types/onboarding';
import type { PBs, RunnerType } from '@/types/training';
import type { GarminActual } from '@/types/state';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { formatKm, fp } from '@/utils/format';
import { hasPhysiologySource } from '@/data/sources';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  getAccessToken,
  isGarminConnected,
  triggerGarminBackfill,
} from '@/data/supabaseClient';
import {
  readPBsFromHistory,
  type ActivityWithBestEfforts,
  type PBsWithSource,
  type PBWithSource,
} from '@/calculations/pbs-from-history';
import { backfillStravaHistory } from '@/data/stravaSync';
import { syncPhysiologySnapshot } from '@/data/physiologySync';
import { loadActivitiesFromDB } from '@/data/tri-activity-loader';
import { deriveTriBenchmarksFromHistory, type TriBenchmarks } from '@/calculations/tri-benchmarks-from-history';
import { deriveVdotFromLT } from '@/calculations/lt-derivation';
import { cv } from '@/calculations/vdot';
import { recomputeLT, diagnoseLTForState } from '@/data/ltSync';
import { awaitStartupSyncs } from '@/main';
import { getPhysiologicalVdot } from '@/calculations/physiological-vdot';

/**
 * Page 4 — "Here's what we found" magic-moment review.
 *
 * Renders after connect-strava on the Strava path. Shows the four pieces of
 * data we infer from the sync (weekly volume, 10K/Half/Marathon PBs, VDOT,
 * runner type) as a single scrollable column of editable rows. Tap a row to
 * inline-edit in place; no modal, no bottom sheet.
 *
 * If the connected account does not produce enough signal to make this screen
 * meaningful (< INSUFFICIENT_RUN_COUNT running activities, or zero volume,
 * or every PB missing), we silently divert to the manual-entry fallback.
 */

// Minimum number of running activities needed to justify showing the review
// screen. Strava's own "best_efforts" are only populated on running activities,
// and the 4-week volume metric needs roughly a run per week to be meaningful;
// below 12 runs the page reads as empty. No established constant for this in
// the codebase — flagged for review.
// TODO(tristan): confirm 12 running activities is the right floor, or tie
// this to `state.detectedWeeklyKm` availability alone once more users are on
// the new flow.
const INSUFFICIENT_RUN_COUNT = 12;

/** How many days of activities to read when deciding sufficiency + source caption. */
const ACTIVITY_LOOKBACK_DAYS = 1095;

/** Runner-type picker copy — mirrors `runner-type.ts` canonical labels. */
const RUNNER_TYPE_LABELS: Record<RunnerType, { label: string; sub: string }> = {
  Speed: { label: 'Speed', sub: 'Stronger over short, fast races.' },
  Balanced: { label: 'Balanced', sub: 'Consistent across distances.' },
  Endurance: { label: 'Endurance', sub: 'Stronger the longer it gets.' },
};

/** Athlete-tier user-friendly labels. The internal enum is the chronic-load
 *  bucket derived from CTL — these labels keep the tier readable without
 *  exposing the engine vocabulary. */
const ATHLETE_TIER_LABELS: Record<NonNullable<ReturnType<typeof getState>['athleteTier']>, { label: string; sub: string }> = {
  beginner: { label: 'Building a base', sub: 'Light, consistent training will move the needle quickly.' },
  recreational: { label: 'Consistent training base', sub: 'Steady weekly volume. We size workouts to keep building.' },
  trained: { label: 'Well-trained', sub: 'Solid base. Ready for structured intensity and longer efforts.' },
  performance: { label: 'High-performance', sub: 'High training stress. We protect recovery while sharpening.' },
  high_volume: { label: 'Elite training load', sub: 'Sustained heavy load. Plan emphasises maintenance and race specificity.' },
};

/** Hard cap on the data-loading spinner — shown above the loading message
 *  once the chain has run longer than this. Per the user spec (30s). */
const LOADING_TIMEOUT_MS = 30_000;

/** Inline row state — which row (if any) is currently in edit mode. */
type EditingRow = null | 'volume' | 'pb-k5' | 'pb-k10' | 'pb-h' | 'pb-m' | 'ftp' | 'css';
let editing: EditingRow = null;

/** Cached activity rows between renders so inline edits don't refetch. */
let cachedActivities: ActivityWithBestEfforts[] | null = null;
/** Cached derived PBs with source so captions stay stable across rerenders. */
let cachedPbSources: PBsWithSource | null = null;
/** Cached triathlon benchmarks (derived on first render in tri mode). */
let cachedTriBenchmarks: TriBenchmarks | null = null;

/** Race-distance-matched bike ride and swim from history. Among activities
 *  clearing the threshold (80 % of own race distance OR half-Ironman distance,
 *  whichever is lower), we pick the one *closest* to the race distance — not
 *  the longest — so the row reflects an effort the athlete has done over a
 *  comparable distance, not the most extreme outing on file. Null when
 *  nothing qualifies. */
type RaceDistanceEffort = { distanceKm: number; durationSec: number; name: string };
let cachedClosestBike: RaceDistanceEffort | null = null;
let cachedClosestSwim: RaceDistanceEffort | null = null;

/** Weekly volume per discipline, last 4 weeks. Triathlon mode uses three rows
 *  (run / bike / swim); running mode shows just the run row. Computed in the
 *  triathlon branch from `loadActivitiesFromDB` (working REST query) so the
 *  numbers are consistent with the FTP/CSS derivation source rather than
 *  depending on the edge-function `mode: 'history'` aggregation that's been
 *  intermittently returning empty. */
let cachedWeeklyBikeKm: number | null = null;
let cachedWeeklySwimKm: number | null = null;

/** ---------- Time parse / format (mirror of manual-entry.ts) ---------- */

function formatTime(seconds: number, long: boolean = false): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (long) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseTime(str: string, long: boolean): number | null {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) {
    const [a, b] = parts;
    if (a < 0 || b < 0 || b >= 60) return null;
    if (long && a >= 1 && a <= 6) return a * 3600 + b * 60;
    return a * 60 + b;
  }
  if (parts.length === 3) {
    const [h, m, s] = parts;
    if (h < 0 || m < 0 || m >= 60 || s < 0 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

/** ---------- Data fetch ---------- */

/**
 * Fetch recent activities (with best_efforts) from garmin_activities via
 * Supabase REST. Pattern follows `isStravaConnected()` / account-view's direct
 * REST reads. Running activities only.
 */
async function fetchRecentActivities(): Promise<ActivityWithBestEfforts[]> {
  try {
    const since = new Date(Date.now() - ACTIVITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const token = await getAccessToken();
    // limit=1000 — users with high activity density (10+/week) can exceed 200
    // rows within the 3-year window, so 200 dropped older PB-bearing runs
    // before the PB extractor saw them. 1000 fits all but the most extreme
    // volumes and stays well under PostgREST's default max_rows.
    const url = `${SUPABASE_URL}/rest/v1/garmin_activities`
      + `?select=garmin_id,start_time,activity_type,activity_name,distance_m,duration_sec,best_efforts`
      + `&start_time=gte.${encodeURIComponent(since)}`
      + `&order=start_time.desc`
      + `&limit=1000`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[review] garmin_activities select failed: ${res.status} ${body}`);
      // Fallback: some deployments haven't applied the best_efforts migration yet.
      // Retry without best_efforts so the run-count gate still works (user will
      // need to enter PBs manually). Remove once migration is applied everywhere.
      if (res.status === 400 && body.toLowerCase().includes('best_efforts')) {
        const fallbackUrl = url.replace(',best_efforts', '');
        const retry = await fetch(fallbackUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'apikey': SUPABASE_ANON_KEY,
          },
        });
        if (retry.ok) {
          const rows = await retry.json();
          return Array.isArray(rows) ? (rows as ActivityWithBestEfforts[]) : [];
        }
      }
      return [];
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows as ActivityWithBestEfforts[];
  } catch (err) {
    console.warn('[review] fetchRecentActivities failed', err);
    return [];
  }
}

function countRunningActivities(rows: ActivityWithBestEfforts[]): number {
  let n = 0;
  for (const r of rows) {
    const t = ((r as any).activity_type ?? (r as any).activityType ?? '') as string;
    if (t && t.toUpperCase().includes('RUN')) n++;
  }
  return n;
}

/** ---------- Entry point ---------- */

export function renderReview(container: HTMLElement, state: OnboardingState): void {
  // Fast path: user reached review having explicitly skipped Strava (manual-entry
  // path). Don't try to backfill — they entered PBs by hand. Render whatever the
  // state has. This was previously the case where the review screen would also
  // divert to manual-entry, which under the new flow would loop back through
  // goals → race-target → schedule → review again.
  if (state.skippedStrava) {
    cachedActivities = cachedActivities ?? [];
    cachedPbSources = cachedPbSources ?? {};
    renderContent(container, state);
    return;
  }

  // First-mount: kick off the data chain (backfill → physiology → DB read).
  // The chain shows progressive loading messages; if it runs over LOADING_TIMEOUT_MS,
  // we swap in an apology line so the user knows we're still working. Whatever
  // arrives gets surfaced — partial data is better than blocking the wizard.
  if (cachedActivities === null) {
    let currentStep = 0;
    const setStep = (n: number): void => {
      currentStep = n;
      renderLoading(container, currentStep, false);
    };
    setStep(0);
    const timeoutId = window.setTimeout(() => {
      renderLoading(container, currentStep, true);
    }, LOADING_TIMEOUT_MS);

    // Full 26-week history backfill so best_efforts (race PBs) are populated.
    // Order matters:
    //   1. backfill — writes activities to DB + onboardingRunHistory.
    //   2. triggerGarminBackfill (if linked) — pushes daily_metrics rows.
    //   3. syncPhysiologySnapshot — pulls RHR/maxHR/sleep into state.
    //   4. refreshBlendedFitness — re-run now that RHR + maxHR + runs are in state.
    //   5. fetchRecentActivities — DB read for PB extraction.
    const lookback = Math.ceil(ACTIVITY_LOOKBACK_DAYS / 7);
    const pipelineStart = performance.now();
    const tickStep = (name: string, t0: number, ok: boolean, summary?: string): void => {
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      const status = ok ? '✓' : '✗';
      console.log(`[Pipeline] ${name} ${status} ${dt}s${summary ? ' — ' + summary : ''}`);
    };
    // Wait for `main.ts` background syncs (Strava backfill, history restore,
    // DB dedup) to settle before we read the activities table. Without this,
    // `loadActivitiesFromDB` later in the pipeline races those writes — on
    // some reloads the row carrying `power_curve` is in the snapshot, on
    // others it isn't, producing the "FTP comes through sometimes" symptom.
    // Bounded at 20 s by `awaitStartupSyncs` so a stuck sync can't lock the
    // wizard. Stays at the "Connecting to Strava" step visually since these
    // tasks ARE the connection / DB-warming work; first user-visible step
    // change is the backfill below.
    let t0: number;
    const startupT0 = performance.now();
    awaitStartupSyncs().then(() => {
      tickStep('awaitStartupSyncs', startupT0, true, 'main.ts background tasks settled');
      setStep(1);
      t0 = performance.now();
      return backfillStravaHistory(lookback).catch((e) => { tickStep('backfillStravaHistory', t0, false, String(e)); return null; });
    }).then(async (backfillResult) => {
      if (backfillResult !== null && backfillResult !== undefined) {
        const sNow = getState();
        tickStep('backfillStravaHistory', t0, true,
          `runs:${sNow.onboardingRunHistory?.length ?? 0} ` +
          `processed:${backfillResult?.processed ?? 0} ` +
          `wkKm:${sNow.detectedWeeklyKm?.toFixed(1) ?? 'null'} ` +
          `histTSS:${sNow.historicWeeklyTSS?.length ?? 0}w`);
      }
      t0 = performance.now();
      try {
        const garminLinked = await isGarminConnected();
        if (garminLinked) {
          await triggerGarminBackfill(8);
          tickStep('garminBackfill', t0, true, 'linked');
        } else {
          tickStep('garminBackfill', t0, true, 'skipped (not linked)');
        }
      } catch (e) {
        tickStep('garminBackfill', t0, false, String(e));
      }
      setStep(2);
      t0 = performance.now();
      const physResult = await syncPhysiologySnapshot(28).catch((e) => { tickStep('syncPhysiologySnapshot', t0, false, String(e)); return null; });
      if (physResult !== null) {
        const sNow = getState();
        tickStep('syncPhysiologySnapshot', t0, true,
          `vo2:${sNow.vo2 ?? 'null'} maxHR:${sNow.maxHR ?? 'null'} rhr:${sNow.restingHR ?? 'null'} history:${sNow.physiologyHistory?.length ?? 0}d`);
      }
    }).then(async () => {
      t0 = performance.now();
      try {
        const { refreshBlendedFitness } = await import('@/calculations/blended-fitness');
        const { getMutableState } = await import('@/state/store');
        const ok = refreshBlendedFitness(getMutableState());
        const sNow = getState();
        tickStep('refreshBlendedFitness', t0, true,
          `applied:${ok} hrVdot:${sNow.hrCalibratedVdot?.vdot?.toFixed(1) ?? 'null'}(${sNow.hrCalibratedVdot?.confidence ?? 'none'}) ` +
          `v:${sNow.v?.toFixed(1) ?? 'null'} blended:${sNow.blendedEffectiveVdot?.toFixed(1) ?? 'null'} ` +
          `lt:${sNow.lt ?? 'null'}(${sNow.ltSource ?? 'none'},${sNow.ltConfidence ?? 'n/a'})`);
      } catch (e) {
        tickStep('refreshBlendedFitness', t0, false, String(e));
      }
      setStep(3);
      t0 = performance.now();
      return fetchRecentActivities();
    }).then(async (rows) => {
      tickStep('fetchRecentActivities', t0, true,
        `rows:${rows.length} running:${countRunningActivities(rows)} ` +
        `withBE:${rows.filter(r => Array.isArray((r as any).best_efforts) && (r as any).best_efforts.length > 0).length}`);
      cachedActivities = rows;
      cachedPbSources = readPBsFromHistory(rows);

      // Client-side fallback for weekly volume. The canonical path is
      // `fetchStravaHistory` (mode='history' on the edge function) writing
      // `s.historicWeeklyKm` → derives `s.detectedWeeklyKm`. That path bails
      // early when the aggregation returns zero rows, leaving weekly volume
      // as `--` even when the user has hundreds of activities visible via
      // REST (`cachedActivities`). This computes a 4-week average directly
      // from the activities we already have, but only as a fallback — if
      // the edge function aggregation produced a value, we leave it alone.
      const sm = getMutableState();
      if (sm.detectedWeeklyKm == null && rows.length > 0) {
        const fourWeeksAgoMs = Date.now() - 28 * 24 * 60 * 60 * 1000;
        const recentRunMeters = rows
          .filter(r => {
            const t = ((r as any).activity_type ?? '').toUpperCase();
            const isRun = t === 'RUNNING' || t.includes('RUN');
            const startMs = (r as any).start_time ? new Date((r as any).start_time).getTime() : 0;
            return isRun && startMs >= fourWeeksAgoMs;
          })
          .reduce((sum, r) => sum + (((r as any).distance_m as number | null) ?? 0), 0);
        if (recentRunMeters > 0) {
          sm.detectedWeeklyKm = Math.round((recentRunMeters / 1000 / 4) * 10) / 10;
          console.log(`[review] detectedWeeklyKm fallback: ${sm.detectedWeeklyKm} km/wk (4w avg from ${rows.length} REST activities)`);
        }
      }

      // Seed s.pbs immediately so the LT derivation's critical-speed path can fit
      // race-distance PBs on the very first review render. The Continue handler
      // still does an authoritative merge into onboarding.pbs (which the user can
      // edit), but we don't want to wait until then to make the LT estimate good.
      // Fastest-wins merge: never replace a faster saved value with a slower one.
      if (cachedPbSources && Object.keys(cachedPbSources).length > 0) {
        const sm = getMutableState();
        const next: PBs = { ...(sm.pbs ?? {}) };
        const takeFastest = (k: 'k5' | 'k10' | 'h' | 'm') => {
          const stravaSec = cachedPbSources![k]?.timeSec;
          if (stravaSec == null) return;
          const saved = next[k];
          if (saved == null || stravaSec < saved) next[k] = stravaSec;
        };
        takeFastest('k5'); takeFastest('k10'); takeFastest('h'); takeFastest('m');
        sm.pbs = next;
      }

      // Step 4: FTP, CSS, and threshold-pace calculation. Surfacing the step
      // change here (not at pipeline end) so the user sees the spinner on
      // this label *during* the heavy work — `loadActivitiesFromDB`,
      // `deriveTriBenchmarksFromHistory`, the final `refreshBlendedFitness`,
      // and the LT recompute that follows in `renderContent`.
      setStep(4);

      // Triathlon mode: derive bike FTP + swim CSS from the history we just
      // backfilled. Pre-fill onboarding state so the FTP / CSS rows render
      // with the auto-derived values; the user can still edit either row.
      if (state.trainingMode === 'triathlon') {
        t0 = performance.now();
        try {
          const triActs = await loadActivitiesFromDB(500);
          const rideCount = triActs.filter(a => {
            const u = (a.activityType ?? '').toUpperCase();
            return u === 'CYCLING' || u.includes('BIKE') || u.includes('RIDE') || u === 'VIRTUAL_RIDE';
          }).length;
          const swimCount = triActs.filter(a => {
            const u = (a.activityType ?? '').toUpperCase();
            return u === 'SWIMMING' || u.includes('SWIM');
          }).length;
          tickStep('loadActivitiesFromDB', t0, true,
            `total:${triActs.length} runs:${triActs.length - rideCount - swimCount} rides:${rideCount} swims:${swimCount}`);

          // Seed onboardingRunHistory and maxHR from the DB read. The edge
          // function's `result.runs` summary is lightweight (no quality fields)
          // and sometimes empty during fresh triathlon onboarding. Without
          // this seed the LT empirical path has no candidates, falls back to
          // Daniels-only, and produces a low-confidence VDOT-anchored value.
          const sm = getMutableState();
          const runRows = triActs.filter(a => {
            const t = (a.activityType || '').toUpperCase();
            return t === 'RUNNING' || t.includes('RUN');
          });
          if (runRows.length > 0) {
            sm.onboardingRunHistory = runRows
              .filter(a => !!a.startTime && a.durationSec > 0 && a.distanceKm > 0)
              .map(a => ({
                startTime: a.startTime as string,
                distKm: a.distanceKm,
                durSec: a.durationSec,
                activityType: a.activityType ?? 'RUNNING',
                activityName: a.workoutName ?? a.displayName ?? undefined,
                avgHR: a.avgHR ?? null,
                avgPaceSecKm: a.avgPaceSecKm ?? null,
                hrDrift: a.hrDrift ?? null,
                kmSplits: a.kmSplits ?? null,
                elevationGainM: a.elevationGainM ?? null,
                ambientTempC: a.ambientTempC ?? null,
              }));
            // Fallback maxHR: if Garmin/Apple physiology hasn't supplied one,
            // take the highest per-activity max_hr we've observed across the
            // user's running history. Strava records peak HR per activity, so
            // this is a reasonable approximation of HRmax until the watch /
            // physiology snapshot lands. Only writes when nothing has set
            // s.maxHR yet — never clobbers a real physiology value.
            if (sm.maxHR == null) {
              const observedMax = runRows.reduce((acc, a) => {
                const hr = a.maxHR ?? 0;
                return hr > acc ? hr : acc;
              }, 0);
              if (observedMax >= 140 && observedMax <= 220) {
                sm.maxHR = observedMax;
                console.log(`[review] seeded maxHR=${observedMax} from highest activity peak HR (no physiology snapshot available yet)`);
              }
            }
          }

          const onb = (getState().onboarding ?? {}) as OnboardingState;
          const triBenchT0 = performance.now();
          cachedTriBenchmarks = deriveTriBenchmarksFromHistory(triActs, undefined, {
            swim400Sec: onb.triSwim?.pbs?.m400,
            swim200Sec: onb.triSwim?.pbs?.m200,
          });
          tickStep('deriveTriBenchmarks', triBenchT0, true,
            `ftp:${cachedTriBenchmarks.ftp.ftpWatts ?? 'null'}W(${cachedTriBenchmarks.ftp.confidence},${cachedTriBenchmarks.ftp.bikeActivityCount} rides) ` +
            `css:${cachedTriBenchmarks.css.cssSecPer100m ?? 'null'}s/100m(${cachedTriBenchmarks.css.confidence},${cachedTriBenchmarks.css.swimActivityCount} swims)`);

          // Best wins (mirrors PB logic on the running side): take the
          // higher FTP and the faster CSS regardless of whether a stale
          // value sits in state. A stale 90W entered weeks ago must not
          // beat a 261W derived from a current powered ride.
          const patch: Partial<OnboardingState> = {};
          const savedCss = onb.triSwim?.cssSecPer100m;
          const derivedCss = cachedTriBenchmarks.css.cssSecPer100m;
          if (derivedCss && (savedCss == null || derivedCss < savedCss)) {
            patch.triSwim = { ...(onb.triSwim ?? {}), cssSecPer100m: derivedCss };
          }
          const savedFtp = onb.triBike?.ftp;
          const savedFtpSrc = onb.triBike?.ftpSource;
          const derivedFtp = cachedTriBenchmarks.ftp.ftpWatts;
          // Auto-fill or refresh whenever the saved value isn't user-typed.
          // When the saved value IS user-typed, only override if the derived
          // beats it by ≥3W with high/medium confidence (matches main.ts).
          const derivedConf = cachedTriBenchmarks.ftp.confidence;
          const userBeaten =
            savedFtpSrc === 'user' &&
            savedFtp != null &&
            derivedFtp != null &&
            derivedFtp >= savedFtp + 3 &&
            (derivedConf === 'high' || derivedConf === 'medium');
          const refreshDerived = savedFtpSrc !== 'user' && derivedFtp != null;
          if (derivedFtp && (savedFtp == null || refreshDerived || userBeaten)) {
            patch.triBike = { ...(onb.triBike ?? {}), ftp: derivedFtp, hasPowerMeter: true, ftpSource: 'derived' };
          }
          if (Object.keys(patch).length > 0) updateOnboarding(patch);

          // Longest race-distance-equivalent bike + swim. Used by the
          // "Personal bests" section to recognise efforts the athlete has
          // already put in over a comparable distance. Threshold is the
          // lower of (80 % of own race) or (half-Ironman distance) so a
          // long-course athlete who has only done 70.3-distance work still
          // sees credit for it.
          const isIM = state.triDistance === 'ironman';
          const bikeRaceKm = isIM ? 180 : 90;
          const swimRaceKm = isIM ? 3.8 : 1.9;
          const bikeMinKm = Math.min(bikeRaceKm * 0.8, 90);
          const swimMinKm = Math.min(swimRaceKm * 0.8, 1.9);

          const isBike = (t: string | null | undefined) => {
            const u = (t ?? '').toUpperCase();
            return u === 'CYCLING' || u.includes('BIKE') || u.includes('RIDE') || u === 'VIRTUAL_RIDE';
          };
          const isSwim = (t: string | null | undefined) => {
            const u = (t ?? '').toUpperCase();
            return u === 'SWIMMING' || u.includes('SWIM');
          };

          // CSS provenance — list every swim the estimator considered + the
          // anchor swim that won, so the user can answer "where did this
          // 2:56/100m come from?" by reading the console rather than
          // hunting through Strava. Placed AFTER `isSwim` is defined so
          // the temporal-dead-zone error from the previous attempt can't
          // recur.
          const swimsForLog = triActs.filter(a => isSwim(a.activityType));
          if (swimsForLog.length > 0) {
            const fmtPace = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}/100m`;
            const swimRows = swimsForLog
              .filter(a => a.distanceKm != null && a.distanceKm > 0 && a.durationSec > 0)
              .map(a => {
                const metres = a.distanceKm * 1000;
                const pacePer100m = a.durationSec / (metres / 100);
                return {
                  date: a.startTime?.slice(0, 10) ?? 'unknown',
                  distance: `${Math.round(metres)} m`,
                  duration: `${Math.round(a.durationSec / 60)} min`,
                  pace: fmtPace(pacePer100m),
                  paceSec: pacePer100m,
                };
              })
              .sort((a, b) => (a.date > b.date ? -1 : 1)); // newest first
            console.log(`[review] CSS swim source: ${cachedTriBenchmarks.css.sourceActivityISO?.slice(0, 10) ?? 'none'} ` +
              `(${cachedTriBenchmarks.css.sourceDistanceM ?? 'n/a'}m, ${cachedTriBenchmarks.css.sourceWeeksOld ?? 'n/a'}w old) — buffered to ${cachedTriBenchmarks.css.cssSecPer100m ?? 'null'}s/100m`);
            console.log('[review] all qualifying swims:', swimRows);
          }

          // Pick the user's *best* effort over the race-equivalent distance,
          // not the closest match by length. "Best" = highest average speed
          // (km / hour for bike, m / sec for swim) among activities of at
          // least the minimum distance. A 92 km ride at 30 km/h is a stronger
          // signal than a 90.9 km ride at 12.7 km/h even though the latter
          // is closer to 90 km. Min distance is the same threshold as before
          // (80 % of own race, capped at half-IM) so a long-course athlete
          // who has only done 70.3-distance work still sees credit.
          const pickFastest = (filter: (a: GarminActual) => boolean, minKm: number): RaceDistanceEffort | null => {
            const candidates = triActs
              .filter(a => filter(a) && a.distanceKm >= minKm && a.durationSec > 0);
            if (candidates.length === 0) return null;
            // Highest avg speed wins. Equal speeds: prefer longer distance
            // (more reliable demonstration of pace at race-equivalent length).
            candidates.sort((a, b) => {
              const speedA = a.distanceKm / a.durationSec;
              const speedB = b.distanceKm / b.durationSec;
              if (speedB !== speedA) return speedB - speedA;
              return b.distanceKm - a.distanceKm;
            });
            const c = candidates[0];
            return {
              distanceKm: c.distanceKm,
              durationSec: c.durationSec,
              name: c.displayName ?? c.workoutName ?? '',
            };
          };

          cachedClosestBike = pickFastest(a => isBike(a.activityType), bikeMinKm);
          cachedClosestSwim = pickFastest(a => isSwim(a.activityType), swimMinKm);

          // Weekly volume per discipline — last 4 calendar weeks averaged.
          // Pulls from `triActs` (REST-loaded) so it doesn't depend on the
          // edge-function history aggregation that's been returning empty.
          const fourWeeksAgoMs = Date.now() - 28 * 24 * 60 * 60 * 1000;
          const sumKm = (filter: (a: GarminActual) => boolean): number => {
            return triActs
              .filter(a => filter(a) && a.startTime && new Date(a.startTime).getTime() >= fourWeeksAgoMs)
              .reduce((sum, a) => sum + (a.distanceKm ?? 0), 0);
          };
          const totalRunKm4w = sumKm(a => {
            const t = (a.activityType ?? '').toUpperCase();
            return t === 'RUNNING' || t.includes('RUN');
          });
          const totalBikeKm4w = sumKm(a => isBike(a.activityType));
          const totalSwimKm4w = sumKm(a => isSwim(a.activityType));
          cachedWeeklyBikeKm = totalBikeKm4w > 0 ? Math.round((totalBikeKm4w / 4) * 10) / 10 : null;
          cachedWeeklySwimKm = totalSwimKm4w > 0 ? Math.round((totalSwimKm4w / 4) * 10) / 10 : null;
          // Override the running fallback when triathlon mode has the richer
          // DB read available — same activities, more reliable distance field.
          const sm2 = getMutableState();
          if (totalRunKm4w > 0) {
            sm2.detectedWeeklyKm = Math.round((totalRunKm4w / 4) * 10) / 10;
          }
          // Per-week breakdown for diagnostic — shows whether the 4-week avg
          // is dragged down by zero-run weeks (triathletes typically have them).
          const weeklyBuckets: Record<string, { run: number; bike: number; swim: number }> = {};
          for (let i = 0; i < 4; i++) {
            const weekStart = new Date(Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000);
            weeklyBuckets[weekStart.toISOString().slice(0, 10)] = { run: 0, bike: 0, swim: 0 };
          }
          for (const a of triActs) {
            if (!a.startTime || !a.distanceKm) continue;
            const aMs = new Date(a.startTime).getTime();
            if (aMs < fourWeeksAgoMs) continue;
            const weekIdx = Math.floor((Date.now() - aMs) / (7 * 24 * 60 * 60 * 1000));
            if (weekIdx < 0 || weekIdx > 3) continue;
            const weekStart = new Date(Date.now() - (weekIdx + 1) * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const bucket = weeklyBuckets[weekStart];
            if (!bucket) continue;
            const t = (a.activityType ?? '').toUpperCase();
            if (t === 'RUNNING' || t.includes('RUN')) bucket.run += a.distanceKm;
            else if (isBike(a.activityType)) bucket.bike += a.distanceKm;
            else if (isSwim(a.activityType)) bucket.swim += a.distanceKm;
          }
          console.log('[review] last-4-week volume breakdown (km/week):', Object.entries(weeklyBuckets)
            .sort()
            .map(([w, v]) => `${w}: run=${v.run.toFixed(1)} bike=${v.bike.toFixed(1)} swim=${v.swim.toFixed(2)}`)
            .join(' | '));
        } catch (e) {
          tickStep('triathlon-block', t0, false, String(e));
          console.warn('[review] tri benchmark derivation failed:', e);
        }
      }

      // (setStep(4) already fired before the triathlon block — the user has
      // been seeing "Calculating FTP, CSS and threshold pace" during the
      // heavy work above.)
      // Final blend pass — refreshBlendedFitness ran early in the pipeline
      // (step 4), before s.pbs / s.maxHR / s.onboardingRunHistory had been
      // seeded by the steps that follow. So `s.v` and `s.blendedEffectiveVdot`
      // were computed against an incomplete state, then re-computed ~500ms
      // later when an unrelated background trigger (ActivitySync etc.) ran
      // refreshBlendedFitness again — producing the visible "first render
      // shows 4:21, second render shows 4:08" flash.
      // Re-running it here, with all sources seeded, makes the first render
      // already correct. The cost is ~10ms (refresh is cheap) and downstream
      // background triggers find nothing to update so no second render fires.
      try {
        const tFinalBlend = performance.now();
        const { refreshBlendedFitness } = await import('@/calculations/blended-fitness');
        refreshBlendedFitness(getMutableState());
        tickStep('finalBlend', tFinalBlend, true, 'final refresh after all sources seeded');
      } catch (e) {
        console.warn('[Pipeline] final blend pass failed:', e);
      }

      // Final summary — what the page is about to render with. If a value is
      // missing (vo2:null, ftp:null, weeklyKm:null), the per-step logs above
      // tell you which step couldn't produce it. If everything is null but
      // the steps say ✓, the issue is in derivation logic, not data flow.
      const sFinal = getState();
      const totalDt = ((performance.now() - pipelineStart) / 1000).toFixed(1);
      const pbs = sFinal.pbs ?? {};
      const pbList = (['k5', 'k10', 'h', 'm'] as const).filter(k => pbs[k] != null && pbs[k]! > 0).join(',') || 'none';
      console.log(
        `%c[Pipeline] ALL STEPS COMPLETE in ${totalDt}s — about to render`,
        'background:#0A0A0A;color:#FDFCF7;padding:2px 8px;border-radius:4px;font-weight:600',
      );
      console.log(
        `  physiology — vo2:${sFinal.vo2 ?? 'null'} maxHR:${sFinal.maxHR ?? 'null'} rhr:${sFinal.restingHR ?? 'null'} historyDays:${sFinal.physiologyHistory?.length ?? 0}\n` +
        `  vdot       — v:${sFinal.v?.toFixed(1) ?? 'null'} blended:${sFinal.blendedEffectiveVdot?.toFixed(1) ?? 'null'} hrVdot:${sFinal.hrCalibratedVdot?.vdot?.toFixed(1) ?? 'null'}(${sFinal.hrCalibratedVdot?.confidence ?? 'none'})\n` +
        `  lt         — pace:${sFinal.lt ?? 'null'}s/km hr:${sFinal.ltHR ?? 'null'} src:${sFinal.ltSource ?? 'none'} conf:${sFinal.ltConfidence ?? 'n/a'}\n` +
        `  pbs        — ${pbList} (${Object.keys(pbs).filter(k => pbs[k as keyof typeof pbs] != null).length} entries)\n` +
        `  runs       — onboardingRunHistory:${sFinal.onboardingRunHistory?.length ?? 0} weeklyKm:${sFinal.detectedWeeklyKm?.toFixed(1) ?? 'null'}\n` +
        `  tri        — ftp:${cachedTriBenchmarks?.ftp?.ftpWatts ?? 'null'}W (${cachedTriBenchmarks?.ftp?.confidence ?? 'n/a'}) css:${cachedTriBenchmarks?.css?.cssSecPer100m ?? 'null'}s/100m (${cachedTriBenchmarks?.css?.confidence ?? 'n/a'})`,
      );

      window.clearTimeout(timeoutId);
      // Re-read onboarding state from the store before rendering — the pipeline
      // above ran `updateOnboarding({ triBike, triSwim, ... })` to patch derived
      // FTP/CSS into state, but `updateOnboarding` creates a new onboarding
      // object via spread (controller.ts:79–89). The `state` argument captured
      // when this wizard step started is the pre-patch reference, so reading
      // `state.triBike?.ftp` directly would render `--` even though the derived
      // value is sitting in the store.
      const freshState = (getState().onboarding ?? state) as OnboardingState;
      renderContent(container, freshState);
    }).catch((e) => {
      console.warn(`[Pipeline] FAILED — falling through to render with whatever state has: ${e}`);
      window.clearTimeout(timeoutId);
      // Fall through to render whatever the state already has.
      cachedActivities = cachedActivities ?? [];
      cachedPbSources = cachedPbSources ?? {};
      const freshState = (getState().onboarding ?? state) as OnboardingState;
      renderContent(container, freshState);
    });
    return;
  }
  renderContent(container, state);
}

/** ---------- Loading skeleton ---------- */

// Loading checklist visible to the user. Each phase of the pipeline maps to
// one of these labels. The wording is intentionally specific to the work
// happening in that phase (e.g. "Calculating FTP and CSS" rather than a
// generic "Building your profile") so the user can tell what's pending.
const LOADING_STEPS = [
  'Connecting to Strava',
  'Loading your training history',
  'Reading your physiology',
  'Finding personal bests',
  'Calculating FTP, CSS and threshold pace',
];

function renderLoading(container: HTMLElement, activeStep: number, timedOut: boolean): void {
  // Step-by-step checklist. Each step is one of:
  //   done    — filled circle with a tick (steps before the active one)
  //   active  — circle with an inline spinner (the step currently running)
  //   pending — empty circle (steps still to come)
  // Timeout state keeps the active step but swaps the footer note to an apology.
  const note = timedOut
    ? 'Still syncing — sorry, this is taking longer than usual. You can keep waiting, or come back to your profile from the Stats page once it has finished.'
    : 'This can take 20 to 30 seconds on first connect.';

  const rows = LOADING_STEPS.map((label, i) => {
    let icon: string;
    let color: string;
    if (i < activeStep) {
      icon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,7.5 6,10.5 11,4.5"/></svg>`;
      color = 'var(--c-black)';
    } else if (i === activeStep) {
      icon = `<span class="r-step-spin"></span>`;
      color = 'var(--c-black)';
    } else {
      icon = '';
      color = 'var(--c-faint)';
    }
    const ring = i < activeStep
      ? 'background:var(--c-black);color:var(--c-bg);border:1px solid var(--c-black)'
      : i === activeStep
        ? 'background:transparent;border:1px solid var(--c-black)'
        : 'background:transparent;border:1px solid var(--c-border)';
    return `
      <div style="display:flex;align-items:center;gap:12px">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;${ring};flex-shrink:0">${icon}</span>
        <span style="font-size:13px;color:${color};line-height:1.4">${label}</span>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <style>
      @keyframes spin { to { transform: rotate(360deg); } }
      .r-step-spin { width:10px; height:10px; border-radius:50%; border:1.5px solid rgba(0,0,0,0.15); border-top-color: var(--c-black); animation: spin 0.8s linear infinite; display:inline-block; }
    </style>
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 20px;gap:24px">
      ${renderProgressIndicator(6, 7)}
      <div style="display:flex;flex-direction:column;gap:12px;align-items:flex-start;min-width:240px">
        ${rows}
      </div>
      <p style="font-size:11px;color:var(--c-faint);margin:0;text-align:center;max-width:340px;line-height:1.5">${note}</p>
    </div>
  `;
}

/** ---------- Full content render ---------- */

function renderContent(container: HTMLElement, state: OnboardingState): void {
  const s = getState();
  // Recompute LT from PBs + maxHR + sustained Strava efforts whenever review renders.
  // The launch-time refreshBlendedFitness is gated on `hasCompletedOnboarding`,
  // so mid-onboarding users would otherwise see s.lt === null and the VDOT row
  // would skip the LT-derived path entirely.
  try {
    const ltAction = recomputeLT(s);
    // Diagnostic: print the unified physiological-VDOT result alongside every
    // raw VDOT-flavoured field, so we can verify which tier won and how the
    // alternates compared. Useful for the next "why doesn't this match my
    // watch / Garmin / etc" debug session.
    const physio = getPhysiologicalVdot(s);
    const pbVdotCandidates: number[] = [];
    const pbs = s.pbs ?? {};
    if (pbs.k5 && pbs.k5 > 0) pbVdotCandidates.push(cv(5000, pbs.k5));
    if (pbs.k10 && pbs.k10 > 0) pbVdotCandidates.push(cv(10000, pbs.k10));
    if (pbs.h && pbs.h > 0) pbVdotCandidates.push(cv(21097.5, pbs.h));
    if (pbs.m && pbs.m > 0) pbVdotCandidates.push(cv(42195, pbs.m));
    pbVdotCandidates.sort((a, b) => a - b);
    console.log('[review] recomputeLT →', ltAction,
      's.lt =', s.lt, 's.ltSource =', s.ltSource,
      '| Daniels read VDOT =', physio.vdot, `(source: ${physio.source}, ${physio.confidence} conf)`,
      'detail =', physio.detail,
      '| s.vo2 =', s.vo2, `(deviceAgeDays: ${physio.deviceAgeDays != null ? Math.round(physio.deviceAgeDays) : 'n/a'})`,
      ', HR-calibrated =', s.hrCalibratedVdot?.vdot, `(${s.hrCalibratedVdot?.confidence ?? 'none'} conf)`,
      ', individual PBs =', pbVdotCandidates.map(v => v.toFixed(1)),
      ', s.v =', s.v, ', s.blendedEffectiveVdot =', s.blendedEffectiveVdot,
      ', s.maxHR =', s.maxHR, ', s.restingHR =', s.restingHR);
    // Same per-run LT diagnostic the LT detail page emits, fired from the
    // onboarding review screen so triathlon users (who can't reach the LT
    // detail page yet) get the same visibility into qualifying runs.
    try {
      const diag = diagnoseLTForState(s);
      const qualifiedCount = diag.filter(d => d.qualified).length;
      const fmtPace = (p: number | null) => (p && p > 0 ? `${Math.floor(p / 60)}:${String(Math.round(p % 60)).padStart(2, '0')}/km` : '—');
      const rows = diag.map(d => ({
        date: d.startTime.slice(0, 10),
        duration: `${d.durationMin}min`,
        pace: fmtPace(d.paceSecKm),
        hr: d.avgHR != null ? `${Math.round(d.avgHR)} (${d.hrPctMax}%)` : '—',
        hrDrift: d.hrDriftPct != null ? `${d.hrDriftPct}%` : '—',
        paceCV: d.paceCV != null ? `${d.paceCV}%` : '—',
        paceDrift: d.decouplingPct != null ? `${d.decouplingPct}%` : '—',
        qualified: d.qualified ? 'YES' : 'no',
        reason: d.reason,
      }));
      console.log('%c[LT diagnostic — review]', 'background:#0A0A0A;color:#FDFCF7;padding:2px 8px;border-radius:4px;font-weight:600',
        `${qualifiedCount} of ${diag.length} runs qualified for empirical LT (last 120d, ≥20min)`);
      console.log(`maxHR ${s.maxHR ?? '—'} bpm · LT band 85–92% = ${s.maxHR ? Math.round(s.maxHR * 0.85) : '—'}–${s.maxHR ? Math.round(s.maxHR * 0.92) : '—'} bpm · candidates considered: ${diag.length}`);

      // Raw input visibility — when the candidate pool is empty, the question
      // is "what made it into onboardingRunHistory and wks before filtering?"
      const wks = s.wks ?? [];
      const wkActuals = wks.flatMap(w => Object.values((w as { garminActuals?: Record<string, unknown> }).garminActuals ?? {}));
      const wkRuns = wkActuals.filter((a: any) => {
        const t = (a?.activityType || '').toUpperCase();
        return t === 'RUNNING' || t.includes('RUN');
      });
      const orh = s.onboardingRunHistory ?? [];
      console.log(`[LT diagnostic — review] raw inputs: wks=${wks.length} (${wkActuals.length} actuals, ${wkRuns.length} runs)  ·  onboardingRunHistory=${orh.length}`);
      if (orh.length > 0) {
        const sample = orh.slice(0, 3).map((r: any) => ({
          startTime: r.startTime,
          activityType: r.activityType,
          distKm: r.distKm,
          durMin: r.durSec ? Math.round(r.durSec / 60) : null,
          avgHR: r.avgHR,
        }));
        console.log('[LT diagnostic — review] onboardingRunHistory sample (first 3):', sample);
      }

      if (rows.length === 0) {
        console.warn('[LT diagnostic — review] No candidate runs at all. Either onboardingRunHistory is empty/short, or every run is shorter than 20 min, or activityType doesn\'t map to RUNNING.');
      } else {
        console.table(rows);
      }
    } catch (e) {
      console.warn('[LT diagnostic — review] failed:', e);
    }
  } catch (e) { console.warn('[review] recomputeLT failed:', e); }
  const unitPref = s.unitPref ?? 'km';
  const weeklyKm = s.detectedWeeklyKm ?? 0;
  const pbs = state.pbs ?? {};
  const pbSources: PBsWithSource = cachedPbSources ?? {};
  const activityCount = cachedActivities ? countRunningActivities(cachedActivities) : 0;

  // PB-derived VDOT: compute from race times via Daniels (cv) and take the max.
  // Don't use s.v — that's blended with current volume/intensity and drags peak
  // PBs down. HR-calibrated value handles "what you'd run today".
  const pbVdotCandidates: number[] = [];
  if (pbs.k5 && pbs.k5 > 0) pbVdotCandidates.push(cv(5000, pbs.k5));
  if (pbs.k10 && pbs.k10 > 0) pbVdotCandidates.push(cv(10000, pbs.k10));
  if (pbs.h && pbs.h > 0) pbVdotCandidates.push(cv(21097.5, pbs.h));
  if (pbs.m && pbs.m > 0) pbVdotCandidates.push(cv(42195, pbs.m));
  const pbVdot = pbVdotCandidates.length > 0 ? Math.max(...pbVdotCandidates) : null;
  const vdot = pbVdot ?? s.v;

  // Runner type: prefer onboarding confirmation, fall back to calculated, fall back to engine value.
  const activeRunnerType: RunnerType | null =
    state.confirmedRunnerType ?? state.calculatedRunnerType ?? s.typ ?? null;

  container.innerHTML = `
    <style>
      @keyframes rRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .r-rise { opacity:0; animation: rRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      /* Row card — full-width pill with icon, label, value, sub caption */
      .r-row { display:flex; align-items:center; gap:14px; width:100%; background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:14px 16px; text-align:left; cursor:pointer; transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .r-row:active { transform: translateY(0.5px) scale(0.997); }
      .r-row.readonly { cursor:default; }
      .r-row.editing { cursor:default; background:rgba(255,255,255,0.98); }

      .r-row-icon { flex:0 0 28px; width:28px; height:28px; border-radius:8px; background:rgba(0,0,0,0.04); color:var(--c-black); display:flex; align-items:center; justify-content:center; }
      .r-row-icon svg { width:16px; height:16px; stroke-width:1.5; }

      .r-row-body { flex:1; min-width:0; }
      .r-row-label { font-size:11.5px; color:var(--c-faint); letter-spacing:0.04em; margin:0 0 3px; }
      .r-row-value { font-size:17px; font-weight:400; color:var(--c-black); letter-spacing:-0.01em; margin:0; line-height:1.15; }
      .r-row-sub { font-size:12px; color:var(--c-faint); margin:2px 0 0; line-height:1.35; }

      .r-row-chev { flex:0 0 auto; color:var(--c-faint); }
      .r-row-chev svg { width:14px; height:14px; stroke-width:1.8; }

      /* Inline edit affordance */
      .r-edit-input { width:100%; box-sizing:border-box; background:rgba(255,255,255,0.98); border:1px solid rgba(0,0,0,0.2); color:var(--c-black); border-radius:10px; padding:9px 12px; font-size:16px; outline:none; font-variant-numeric: tabular-nums; }
      .r-edit-input:focus { border-color: rgba(0,0,0,0.45); box-shadow: 0 0 0 3px rgba(0,0,0,0.04); }
      .r-edit-row { display:flex; gap:10px; align-items:center; }
      .r-edit-unit { font-size:13px; color:var(--c-faint); flex:0 0 auto; }
      .r-edit-actions { display:flex; gap:12px; margin-top:8px; }
      .r-edit-btn { background:none; border:none; font-size:12.5px; cursor:pointer; padding:4px 0; color:var(--c-muted); }
      .r-edit-btn.save { color:var(--c-black); font-weight:500; }

      /* Runner-type selector (opens in place of the value) */
      .r-type-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:4px; }
      .r-type-opt { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.08); border-radius:12px; padding:10px 6px; cursor:pointer; text-align:center; color:var(--c-black); transition: background 0.15s ease, border-color 0.15s ease; }
      .r-type-opt.selected { background:#0A0A0A; color:#FDFCF7; border-color:rgba(0,0,0,0.9); }
      .r-type-opt .t-label { font-size:13px; font-weight:500; }
      .r-type-opt .t-sub { font-size:10.5px; opacity:0.7; margin-top:2px; line-height:1.2; }

      /* Continue — monochrome pill, same proportions as goals' CTA */
      .r-cta { width:100%; height:50px; border-radius:25px; background:#0A0A0A; color:#FDFCF7; border:none; font-size:15px; font-weight:500; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.1), 0 8px 22px -8px rgba(0,0,0,0.35); transition: transform 0.12s ease, box-shadow 0.2s ease; }
      .r-cta:active { transform: translateY(1px); }
      .r-cta:disabled { opacity:0.45; cursor:not-allowed; box-shadow:none; }
      .r-cta:disabled:active { transform:none; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 32%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(6, 7)}

        <div class="r-rise" style="width:100%;max-width:480px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.15">
            Here's what we found
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">
            Confirm or edit anything that looks off. Personal bests show the last 3 years. Tap any row to enter an older PB.
          </p>
        </div>

        <div class="r-rise" style="width:100%;max-width:480px;margin-top:22px;animation-delay:0.12s;display:flex;flex-direction:column;gap:10px">
          ${renderSectionLabel('Recent training')}
          ${renderVolumeRow(weeklyKm, unitPref, activityCount)}
          ${state.trainingMode === 'triathlon' && cachedWeeklyBikeKm != null
            ? renderDisciplineVolumeRow('bike', cachedWeeklyBikeKm, unitPref) : ''}
          ${state.trainingMode === 'triathlon' && cachedWeeklySwimKm != null
            ? renderDisciplineVolumeRow('swim', cachedWeeklySwimKm, unitPref) : ''}
          ${renderSectionLabel('What we measured')}
          ${renderVdotRow(vdot)}
          ${renderHRSparkline()}
          ${renderLtRow(unitPref)}
          ${state.trainingMode === 'triathlon' ? renderFtpRow(state) : ''}
          ${state.trainingMode === 'triathlon' ? renderCssRow(state) : ''}
          ${renderSectionLabel('Athlete profile')}
          ${renderAthleteTierRow()}
          ${renderRunnerTypeRow(activeRunnerType)}
          ${renderTriPbsSection(state, pbs, pbSources)}
        </div>
      </div>

      <div class="r-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.28s">
        <div style="max-width:480px;margin:0 auto">
          <p id="r-continue-hint" style="font-size:12px;color:var(--c-faint);text-align:center;margin:0 0 8px;line-height:1.5;display:none"></p>
          <button id="r-continue" class="r-cta">${state.trackOnly ? 'Continue' : 'Build my plan'}</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(container, state);
  refreshContinueGate();
}

/**
 * Triathlon plan generation needs the user's race-preference profile.
 * FTP and CSS are optional — the plan engine falls back to skill-rating
 * estimates and HR/RPE-only zones until a real number lands. We nudge the
 * user via the row caption instead of blocking continue.
 */
function refreshContinueGate(): void {
  const cta = document.getElementById('r-continue') as HTMLButtonElement | null;
  const hint = document.getElementById('r-continue-hint') as HTMLElement | null;
  if (!cta) return;
  const onb = (getState().onboarding ?? {}) as OnboardingState;
  if (onb.trainingMode !== 'triathlon') {
    cta.disabled = false;
    if (hint) hint.style.display = 'none';
    return;
  }
  const missing: string[] = [];
  const runnerType = onb.confirmedRunnerType ?? onb.calculatedRunnerType ?? getState().typ ?? null;
  if (!runnerType) missing.push('Race preference');
  cta.disabled = missing.length > 0;
  if (hint) {
    if (missing.length > 0) {
      hint.textContent = `Add ${missing.join(', ')} to continue.`;
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  }
}

/** ---------- Row renderers ---------- */

const ICON_VOLUME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5"/><path d="M8 19v-6"/><path d="M12 19v-10"/><path d="M16 19v-4"/><path d="M20 19v-8"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/></svg>`;
const ICON_FITNESS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 4 5-7 4 5"/></svg>`;
const ICON_PROFILE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="3.2"/><path d="M5 19c1.5-3 4-4.2 7-4.2s5.5 1.2 7 4.2"/></svg>`;
const CHEV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
const ICON_LT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/><path d="M4 19h16"/></svg>`;
const ICON_TIER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 6 6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1z"/></svg>`;
const ICON_BIKE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17l4-9h5l3 9"/><path d="M10 8l-2-3h-2"/></svg>`;
const ICON_SWIM = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/><path d="M3 13c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/><circle cx="17" cy="7" r="1.6"/></svg>`;
const ICON_INFO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.6" fill="currentColor"/></svg>`;

function renderSectionLabel(text: string): string {
  return `<p style="font-size:10px;color:var(--c-faint);letter-spacing:0.08em;text-transform:uppercase;margin:8px 4px 0;font-weight:500">${text}</p>`;
}

/**
 * Small confidence chip rendered inline next to a row's value. Mirrors the
 * stats-view pattern (`buildConfidenceChip`) but tuned for the smaller row
 * sizing on this screen. Returns empty string for `'high'` (no badge needed
 * when the value is solid) and `null`/`undefined` (don't show what we don't
 * know). Visible specifically when the user shouldn't trust the number at
 * face value — e.g. CSS derived from a 16-month-old swim, FTP from a stale
 * test, etc.
 */
function renderConfidenceChip(c: 'high' | 'medium' | 'low' | 'none' | null | undefined): string {
  if (!c || c === 'high') return '';
  const map = {
    medium: { bg: 'rgba(245,158,11,0.12)', fg: '#B45309', label: 'Medium confidence' },
    low: { bg: 'rgba(148,163,184,0.18)', fg: '#475569', label: 'Low confidence' },
    none: { bg: 'rgba(148,163,184,0.18)', fg: '#475569', label: 'Rough estimate' },
  } as const;
  const m = map[c];
  return `<span style="font-size:9px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;padding:2px 7px;border-radius:99px;background:${m.bg};color:${m.fg};margin-left:6px;vertical-align:middle">${m.label}</span>`;
}

/**
 * Personal-bests block. In running mode this is the existing 5K/10K/HM/M
 * grid; in triathlon mode we collapse the run side to the single race-distance
 * PB (HM for 70.3, Marathon for IM) and add the longest-recorded bike ride and
 * swim — but only when something in history clears the threshold computed
 * during derivation. If nothing qualifies, the section is omitted entirely.
 */
function renderTriPbsSection(
  state: OnboardingState,
  pbs: PBs,
  pbSources: PBsWithSource,
): string {
  if (state.trainingMode === 'triathlon') {
    const isIM = state.triDistance === 'ironman';
    const runKey: 'h' | 'm' = isIM ? 'm' : 'h';
    const runLabel = isIM ? 'Marathon' : 'Half marathon';
    const runIsLong = true;
    const runHasValue = !!pbs[runKey] || !!pbSources[runKey];

    const rows: string[] = [];
    if (cachedClosestBike) rows.push(renderRaceDistanceEffortRow('bike', cachedClosestBike));
    if (cachedClosestSwim) rows.push(renderRaceDistanceEffortRow('swim', cachedClosestSwim));
    if (runHasValue) rows.push(renderPbRow(runKey, runLabel, pbs[runKey], pbSources[runKey], runIsLong));

    if (rows.length === 0) return '';
    return `${renderSectionLabel('Personal bests (for closest distances)')}\n${rows.join('\n')}`;
  }

  const anyPb =
    pbs.k5 || pbSources.k5 ||
    pbs.k10 || pbSources.k10 ||
    pbs.h || pbSources.h ||
    pbs.m || pbSources.m;
  if (!anyPb) return '';
  return `
    ${renderSectionLabel('Personal bests')}
    ${pbs.k5 || pbSources.k5 ? renderPbRow('k5', '5K', pbs.k5, pbSources.k5, false) : ''}
    ${pbs.k10 || pbSources.k10 ? renderPbRow('k10', '10K', pbs.k10, pbSources.k10, false) : ''}
    ${pbs.h || pbSources.h ? renderPbRow('h', 'Half marathon', pbs.h, pbSources.h, true) : ''}
    ${pbs.m || pbSources.m ? renderPbRow('m', 'Marathon', pbs.m, pbSources.m, true) : ''}
  `;
}

function renderRaceDistanceEffortRow(discipline: 'bike' | 'swim', e: RaceDistanceEffort): string {
  const icon = discipline === 'bike' ? ICON_BIKE : ICON_SWIM;
  const label = discipline === 'bike' ? 'Long ride' : 'Long swim';
  const distLabel = discipline === 'swim'
    ? `${(e.distanceKm * 1000).toFixed(0)} m`
    : `${e.distanceKm.toFixed(1)} km`;
  const time = formatTime(e.durationSec, true);
  const sub = e.name || 'From your synced history';
  return `
    <div class="r-row shadow-ap" style="cursor:default">
      <div class="r-row-icon">${icon}</div>
      <div class="r-row-body">
        <p class="r-row-label">${label}</p>
        <p class="r-row-value">${time} · ${distLabel}</p>
        <p class="r-row-sub">${sub}</p>
      </div>
    </div>
  `;
}

function renderInfoButton(action: 'vdot' | 'lt'): string {
  return `<button type="button" data-info="${action}" aria-label="How this was measured" style="background:none;border:none;padding:2px;margin-left:6px;cursor:pointer;color:var(--c-faint);width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle">${ICON_INFO}</button>`;
}

/**
 * Read-only weekly volume row for triathlon disciplines (bike / swim).
 * The running row is editable via `renderVolumeRow`; bike/swim are derived
 * from synced activities and don't have a manual-entry path on this screen.
 * Swim shows in metres-per-week because km is unwieldy at that scale.
 */
function renderDisciplineVolumeRow(
  discipline: 'bike' | 'swim',
  weeklyKm: number,
  unitPref: 'km' | 'mi',
): string {
  const icon = discipline === 'bike' ? ICON_BIKE : ICON_SWIM;
  const label = discipline === 'bike' ? 'Weekly bike volume' : 'Weekly swim volume';
  let valueStr: string;
  if (weeklyKm <= 0) {
    valueStr = '--';
  } else if (discipline === 'swim') {
    // Swim distances are typically a few km; show metres for legibility
    // (1.2 km/wk reads better as "1,200 m / week"). Mile-pref users still
    // see metres — open-water swimming is uniformly metric in practice.
    const meters = Math.round(weeklyKm * 1000);
    valueStr = `${meters.toLocaleString()} m / week`;
  } else {
    // 1 decimal place — at low triathlon-cycling volumes (one ride per
    // month giving ~14 km/wk), zero-decimal rounding can flip 14.5 to 15
    // and contradict what the user knows they did. At high volumes the
    // decimal is noise but harmless.
    valueStr = `${formatKm(weeklyKm, unitPref, 1)} / week`;
  }
  return `
    <div class="r-row shadow-ap readonly">
      <div class="r-row-icon">${icon}</div>
      <div class="r-row-body">
        <p class="r-row-label">${label}</p>
        <p class="r-row-value">${valueStr}</p>
        <p class="r-row-sub">last 4 weeks</p>
      </div>
    </div>
  `;
}

function renderVolumeRow(weeklyKm: number, unitPref: 'km' | 'mi', activityCount: number): string {
  if (editing === 'volume') {
    const raw = unitPref === 'mi' ? (weeklyKm / 1.609).toFixed(1) : String(Math.round(weeklyKm));
    const unitLabel = unitPref === 'mi' ? 'mi / week' : 'km / week';
    return `
      <div class="r-row shadow-ap editing" data-row="volume">
        <div class="r-row-icon">${ICON_VOLUME}</div>
        <div class="r-row-body">
          <p class="r-row-label">Weekly volume</p>
          <div class="r-edit-row">
            <input id="r-volume-input" class="r-edit-input" type="number" inputmode="decimal" min="0" step="1" value="${raw}">
            <span class="r-edit-unit">${unitLabel}</span>
          </div>
          <div class="r-edit-actions">
            <button class="r-edit-btn" data-action="cancel">Cancel</button>
            <button class="r-edit-btn save" data-action="save">Save</button>
          </div>
        </div>
      </div>
    `;
  }
  // 1 decimal place — same reasoning as the bike/swim rows: at the
  // triathlon-running volumes typical for IM training (10-30 km/wk),
  // integer rounding on .5 boundaries can flip a known number visibly.
  const value = weeklyKm > 0 ? `${formatKm(weeklyKm, unitPref, 1)} / week` : '--';
  // Caption: "last 4 weeks · N runs". "·" is a middle dot, not an em dash.
  const runsNote = activityCount > 0 ? `last 4 weeks · ${activityCount} runs in your history` : 'last 4 weeks';
  return `
    <button class="r-row shadow-ap" data-row="volume">
      <div class="r-row-icon">${ICON_VOLUME}</div>
      <div class="r-row-body">
        <p class="r-row-label">Weekly volume</p>
        <p class="r-row-value">${value}</p>
        <p class="r-row-sub">${runsNote}</p>
      </div>
      <div class="r-row-chev">${CHEV}</div>
    </button>
  `;
}

function renderPbRow(
  key: 'k5' | 'k10' | 'h' | 'm',
  label: string,
  currentSec: number | undefined,
  source: PBWithSource | undefined,
  isLong: boolean,
): string {
  const editKey = key === 'k5' ? 'pb-k5' : key === 'k10' ? 'pb-k10' : key === 'h' ? 'pb-h' : 'pb-m';
  // Fastest wins. If both a saved PB and a Strava-derived PB exist, take the
  // lower of the two — a PB is by definition the fastest time, so a stale
  // slower cache must never beat a faster Strava read (or vice versa).
  const stravaSec = source?.timeSec;
  const sourceWins = stravaSec != null && (currentSec == null || stravaSec < currentSec);
  const displaySec = sourceWins ? stravaSec : (currentSec ?? stravaSec);
  const formatted = displaySec != null ? formatTime(displaySec, isLong) : '--';

  if (editKey && editing === editKey) {
    return `
      <div class="r-row shadow-ap editing" data-row="${editKey}">
        <div class="r-row-icon">${ICON_CLOCK}</div>
        <div class="r-row-body">
          <p class="r-row-label">${label}</p>
          <input
            id="r-pb-input"
            class="r-edit-input"
            type="text"
            inputmode="numeric"
            placeholder="${isLong ? 'h:mm:ss' : 'mm:ss'}"
            value="${formatted !== '--' ? formatted : ''}"
          >
          <div class="r-edit-actions">
            <button class="r-edit-btn" data-action="cancel">Cancel</button>
            <button class="r-edit-btn save" data-action="save">Save</button>
          </div>
        </div>
      </div>
    `;
  }

  let subline = 'Not found in recent activities';
  if (sourceWins && source) {
    subline = source.activityName ?? 'From your Strava history';
  } else if (displaySec != null && currentSec != null) {
    subline = 'Entered manually';
  } else if (source) {
    // Strava found a value but currentSec is missing — display Strava's.
    subline = source.activityName ?? 'From your Strava history';
  }

  const rowTag = 'button';
  const rowCls = 'r-row shadow-ap';
  const dataAttr = `data-row="${editKey}"`;
  const chev = `<div class="r-row-chev">${CHEV}</div>`;

  return `
    <${rowTag} class="${rowCls}" ${dataAttr}>
      <div class="r-row-icon">${ICON_CLOCK}</div>
      <div class="r-row-body">
        <p class="r-row-label">${label}</p>
        <p class="r-row-value">${formatted}</p>
        <p class="r-row-sub">${subline}</p>
      </div>
      ${chev}
    </${rowTag}>
  `;
}

function renderVdotRow(_vdot: number | undefined): string {
  // VDOT row — value comes from the unified `getPhysiologicalVdot` resolver
  // so the number on this screen always matches the VO2 stats card and the
  // VDOT input feeding the LT engine. The caption then explains which tier
  // of the priority chain produced the number, with extra context (e.g.
  // for HR-calibrated low-confidence cases or pre-physiology-sync states)
  // that tells the user how this value will refine.
  //
  // Priority chain (defined in physiological-vdot.ts):
  //   1. s.vo2 (device, fresh ≤90d)        → "From your watch"
  //   2. s.hrCalibratedVdot (medium+ conf) → "Measured from your heart rate response..."
  //   3. deriveVdotFromLT(s.lt)            → "Estimated from your LT pace..."
  //   4. PB-median                         → "Estimated from your race times..."
  //   5. s.v (Tanda fallback)              → "Rough estimate from recent training"
  //   6. none                              → calibration-pending messaging from hr.reason
  const s = getState();
  const physio = getPhysiologicalVdot(s);
  const value = physio.vdot != null ? physio.vdot.toFixed(1) : '--';

  const hr = s.hrCalibratedVdot;
  const physioLinked = hasPhysiologySource(s, 'garmin') || hasPhysiologySource(s, 'apple');
  const physioLanding = physioLinked && hr && (hr.reason === 'no-rhr' || hr.reason === 'no-maxhr');

  let sub = 'Aerobic fitness estimate from your recent harder runs.';
  switch (physio.source) {
    case 'device':
      sub = 'From your watch.';
      break;
    case 'hr-calibrated': {
      const runWord = (hr?.n ?? 0) === 1 ? 'run' : 'runs';
      const tier = physio.confidence === 'high' ? 'High confidence' : 'Medium confidence';
      sub = `Measured from your heart rate response to pace across ${hr?.n ?? 0} steady ${runWord} in the last 8 weeks. ${tier}.`;
      break;
    }
    case 'lt-derived': {
      const ltConf = s.ltConfidence;
      const ltTier = ltConf === 'high' ? 'high confidence' : ltConf === 'medium' ? 'medium confidence' : 'rough estimate';
      sub = physioLanding
        ? `Estimated from your LT pace (${ltTier}). Will refine to a heart-rate-calibrated value once Garmin physiology lands.`
        : `Estimated from your LT pace (${ltTier}). Refines as more steady running comes in.`;
      break;
    }
    case 'pb-median':
      sub = physioLanding
        ? 'Estimated from your race times. Will refine to a heart-rate-calibrated value once Garmin physiology lands.'
        : 'Estimated from your race times. Refines as we measure your heart rate response.';
      break;
    case 'tanda-fallback':
      sub = 'Rough estimate from recent training. Add race times or sync HR data to refine.';
      break;
    case 'none':
      // No usable signal yet — surface the most actionable HR-calibrated
      // failure reason if known, so the user knows what to wait for.
      if (hr && hr.reason === 'no-rhr') {
        const garminLinked = hasPhysiologySource(s, 'garmin');
        sub = garminLinked
          ? 'Garmin connected. Resting HR lands over the next few minutes. Refresh once it has synced.'
          : 'Connect Garmin or Apple Health (or add a resting HR manually) to calibrate from heart rate.';
      } else if (hr && hr.reason === 'no-maxhr') {
        const garminLinked = hasPhysiologySource(s, 'garmin');
        sub = garminLinked
          ? 'Garmin connected. Max HR lands once Garmin pushes recent activity data.'
          : 'Once a few more activities sync we can calibrate from your heart rate.';
      } else if (hr && hr.reason === 'too-few-points') {
        sub = `Only ${hr.n} steady ${hr.n === 1 ? 'run' : 'runs'} in the last 8 weeks. Need 3 to read fitness from heart rate.`;
      } else if (hr && hr.reason === 'no-points') {
        sub = "No qualifying runs in the last 8 weeks yet. We'll calibrate from heart rate once you've trained for a few weeks.";
      } else if (hr && hr.reason === 'bad-fit') {
        sub = "Heart rate signal is noisy across your recent runs. We'll keep watching.";
      }
      break;
  }

  return `
    <div class="r-row shadow-ap readonly">
      <div class="r-row-icon">${ICON_FITNESS}</div>
      <div class="r-row-body">
        <p class="r-row-label">Current fitness (VDOT)${renderInfoButton('vdot')}</p>
        <p class="r-row-value">${value}</p>
        <p class="r-row-sub">${sub}</p>
      </div>
    </div>
  `;
}

function renderLtRow(unitPref: 'km' | 'mi'): string {
  const s = getState();
  const lt = s.lt;
  if (!lt || lt <= 0) return '';
  const conf = s.ltConfidence;
  const src = s.ltSource;
  const value = fp(lt, unitPref);
  let sub = '';
  if (src === 'garmin') {
    sub = `From your Garmin LT reading${conf ? ` (${conf} confidence)` : ''}.`;
  } else if (src === 'override') {
    sub = 'Set manually.';
  } else if (src) {
    // Caption reflects which derivation method actually fired — anchored to
    // the same `ltSource` value `deriveLT` returned in `recomputeLT`.
    const tier = conf === 'high' ? 'High confidence' : conf === 'medium' ? 'Medium confidence' : 'Rough estimate';
    let basis: string;
    switch (src) {
      case 'empirical':
        basis = 'Inferred from your recent threshold-effort runs.';
        break;
      case 'critical-speed':
        basis = 'Fitted to your race-distance PBs (critical speed).';
        break;
      case 'daniels': {
        // Show the VDOT actually consumed by Daniels, not the raw `s.v`. The
        // engine reads via `getPhysiologicalVdot` which prefers device →
        // HR-calibrated → LT-back-derived → PB-median → Tanda. Captioning with
        // raw `s.v` would lie when any of the higher-priority tiers won.
        const usedVdot = getPhysiologicalVdot(s).vdot ?? s.v ?? 0;
        basis = `Estimated from your VDOT (${usedVdot.toFixed(1)}). Refines as PBs and threshold runs come in.`;
        break;
      }
      case 'blended':
      default:
        basis = 'Blended from your PBs and recent threshold-effort runs.';
        break;
    }
    sub = `${basis} ${tier}.`;
  } else {
    sub = 'Threshold pace estimate.';
  }
  return `
    <div class="r-row shadow-ap readonly">
      <div class="r-row-icon">${ICON_LT}</div>
      <div class="r-row-body">
        <p class="r-row-label">Lactate threshold pace${renderInfoButton('lt')}</p>
        <p class="r-row-value">${value}</p>
        <p class="r-row-sub">${sub}</p>
      </div>
    </div>
  `;
}

function renderHRSparkline(): string {
  const hr = getState().hrCalibratedVdot as
    | { points?: Array<{ vo2r: number; paceSecKm: number; durationSec: number }>; alpha?: number | null; beta?: number | null }
    | undefined;
  const pts = hr?.points;
  if (!pts || pts.length < 3) return '';
  const xs = pts.map(p => p.vo2r);
  const ys = pts.map(p => p.paceSecKm);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xPad = (xMax - xMin) * 0.08 || 0.02;
  const yPad = (yMax - yMin) * 0.12 || 5;
  const x0 = xMin - xPad, x1 = xMax + xPad;
  const y0 = yMin - yPad, y1 = yMax + yPad;
  const W = 320, H = 88, ML = 8, MR = 8, MT = 10, MB = 10;
  const sx = (x: number) => ML + ((x - x0) / (x1 - x0)) * (W - ML - MR);
  const sy = (y: number) => MT + ((y - y0) / (y1 - y0)) * (H - MT - MB);
  const dots = pts.map(p =>
    `<circle cx="${sx(p.vo2r).toFixed(1)}" cy="${sy(p.paceSecKm).toFixed(1)}" r="2.6" fill="#0A0A0A"/>`,
  ).join('');
  let line = '';
  if (hr?.alpha != null && hr?.beta != null) {
    const xa = xMin, xb = xMax;
    const ya = hr.alpha + hr.beta * xa;
    const yb = hr.alpha + hr.beta * xb;
    line = `<line x1="${sx(xa).toFixed(1)}" y1="${sy(ya).toFixed(1)}" x2="${sx(xb).toFixed(1)}" y2="${sy(yb).toFixed(1)}" stroke="rgba(0,0,0,0.55)" stroke-width="1.2"/>`;
  }
  // Pace axis: y is sec/km, smaller = faster (top of chart)
  const fast = fp(yMin, 'km');
  const slow = fp(yMax, 'km');
  return `
    <div class="r-row shadow-ap readonly" style="display:block;padding:14px 16px 10px">
      <p class="r-row-label" style="margin-bottom:8px">Heart rate vs pace</p>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block">
        ${line}
        ${dots}
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--c-faint);margin-top:4px">
        <span>← easier</span><span>harder →</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--c-faint);margin-top:2px">
        <span>${fast}</span><span>${slow}</span>
      </div>
    </div>
  `;
}

function renderAthleteTierRow(): string {
  const tier = getState().athleteTier;
  if (!tier) return '';
  const meta = ATHLETE_TIER_LABELS[tier];
  if (!meta) return '';
  return `
    <div class="r-row shadow-ap readonly">
      <div class="r-row-icon">${ICON_TIER}</div>
      <div class="r-row-body">
        <p class="r-row-label">Athlete profile</p>
        <p class="r-row-value">${meta.label}</p>
        <p class="r-row-sub">${meta.sub}</p>
      </div>
    </div>
  `;
}

/** Format CSS/swim pace as mm:ss per 100m. */
function formatCss(secPer100m: number | null | undefined): string {
  if (!secPer100m || secPer100m <= 0) return '--';
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${s.toString().padStart(2, '0')} / 100m`;
}

/** Parse mm:ss to seconds. Returns null on bad input. */
function parseCss(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length !== 2) return null;
  const [m, s] = parts.map(p => parseInt(p, 10));
  if (!Number.isFinite(m) || !Number.isFinite(s) || s < 0 || s >= 60 || m < 0) return null;
  return m * 60 + s;
}

/** Format the source ride date as e.g. "Apr 27" — short, no-year. */
function formatShortDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Build the caption for the FTP row when a derived estimate exists. Returns
 * null when the estimate isn't usable (no derived FTP, or derivation produced
 * `confidence: 'none'`). Caller decides what to do in those cases.
 *
 * Tier copy:
 *   high   (≤ 4w)  — "Derived from your 20-min effort on Apr 27 (310 W)."
 *   medium (≤ 8w)  — "Derived from your last test on Mar 15. Sit a fresh one to confirm."
 *   low    (≤ 12w) — "Last test was 10 weeks ago. Estimate is getting stale."
 */
function formatFtpDerivationCaption(d: import('@/calculations/tri-benchmarks-from-history').FtpEstimate | undefined): string | null {
  if (!d || d.ftpWatts == null) return null;
  if (d.confidence === 'none') return null;
  const date = formatShortDate(d.sourceRideISO);
  const weeks = d.newestContributingRideWeeksOld;
  if (d.confidence === 'high') {
    if (d.sourceWindow && d.sourceWindow !== 'whole-ride' && d.sourceWatts && date) {
      return `Derived from your ${d.sourceWindow} effort on ${date} (${d.sourceWatts} W).`;
    }
    if (date) return `Derived from your ride on ${date}.`;
    return 'Derived from a recent powered ride.';
  }
  if (d.confidence === 'medium') {
    if (date) return `Derived from your last test on ${date}. Sit a fresh one to confirm.`;
    return 'Derived from your last test. Sit a fresh one to confirm.';
  }
  // low — stale curve estimate, OR fallback whole-ride NP
  if (d.sourceWindow === 'whole-ride') {
    return 'Best guess from whole-ride power. Do a 20-min test for a tighter number.';
  }
  if (weeks != null && weeks >= 1) {
    const w = Math.round(weeks);
    return `Last test was ${w} week${w === 1 ? '' : 's'} ago. Estimate is getting stale.`;
  }
  return 'Estimate is getting stale. Sit a fresh test.';
}

function renderFtpRow(state: OnboardingState): string {
  const ftp = state.triBike?.ftp;
  const derived = cachedTriBenchmarks?.ftp;
  if (editing === 'ftp') {
    return `
      <div class="r-row shadow-ap editing" data-row="ftp">
        <div class="r-row-icon">${ICON_BIKE}</div>
        <div class="r-row-body">
          <p class="r-row-label">Bike FTP</p>
          <div class="r-edit-row">
            <input id="r-ftp-input" class="r-edit-input" type="number" inputmode="numeric" min="80" max="500" step="1" value="${ftp ?? ''}" placeholder="e.g. 220">
            <span class="r-edit-unit">W</span>
          </div>
          <div class="r-edit-actions">
            <button class="r-edit-btn" data-action="cancel">Cancel</button>
            <button class="r-edit-btn save" data-action="save">Save</button>
          </div>
        </div>
      </div>
    `;
  }
  const value = ftp ? `${ftp} W` : '--';
  // Provenance: when ftpSource is undefined, treat as 'derived' to match the
  // launch-time migration policy in main.ts. Pre-provenance values are almost
  // always auto-derived; the worst case is a user-typed value that will be
  // labelled "auto-derived" once and re-tagged 'user' next time they edit.
  const ftpIsUserSet = state.triBike?.ftpSource === 'user';
  let sub = 'Tap to enter your FTP. Heart rate is used until power data lands.';
  const derivedSub = formatFtpDerivationCaption(derived);
  if (ftp && derived?.ftpWatts === ftp && derivedSub) {
    sub = derivedSub;
  } else if (ftp && !ftpIsUserSet) {
    // Auto-derived value sitting in state. Show it as auto-derived even when
    // the current derivation differs (e.g. older saved value, or fallback path
    // that returned a lower number this run).
    if (derived?.ftpWatts != null && derived.ftpWatts !== ftp && (derived.confidence === 'high' || derived.confidence === 'medium')) {
      sub = `Auto-derived. Your rides now show ${derived.ftpWatts} W. We'll update on next sync.`;
    } else if (derivedSub) {
      sub = derivedSub;
    } else {
      sub = 'Auto-derived from your ride history.';
    }
  } else if (ftp) {
    const beats =
      derived?.ftpWatts != null &&
      derived.ftpWatts >= ftp + 3 &&
      (derived.confidence === 'high' || derived.confidence === 'medium');
    sub = beats
      ? `Set manually. Your rides show ${derived!.ftpWatts} W. We'll update on next sync.`
      : 'Set manually.';
  } else if (derived && derived.confidence === 'none' && derived.bikeActivityCount > 0) {
    sub = 'No recent FTP test. Tap to enter, or do a 20-min test.';
  } else if (derivedSub) {
    sub = derivedSub;
  }
  const ftpChip = (ftp && derived?.ftpWatts === ftp)
    ? renderConfidenceChip(derived.confidence)
    : '';
  return `
    <button class="r-row shadow-ap" data-row="ftp">
      <div class="r-row-icon">${ICON_BIKE}</div>
      <div class="r-row-body">
        <p class="r-row-label">Bike FTP</p>
        <p class="r-row-value">${value}${ftpChip}</p>
        <p class="r-row-sub">${sub}</p>
      </div>
      <div class="r-row-chev">${CHEV}</div>
    </button>
  `;
}

function renderCssRow(state: OnboardingState): string {
  const css = state.triSwim?.cssSecPer100m;
  const derived = cachedTriBenchmarks?.css;
  if (editing === 'css') {
    const cur = css ? `${Math.floor(css / 60)}:${(Math.round(css % 60)).toString().padStart(2, '0')}` : '';
    return `
      <div class="r-row shadow-ap editing" data-row="css">
        <div class="r-row-icon">${ICON_SWIM}</div>
        <div class="r-row-body">
          <p class="r-row-label">Swim CSS</p>
          <div class="r-edit-row">
            <input id="r-css-input" class="r-edit-input" type="text" inputmode="numeric" placeholder="mm:ss" value="${cur}">
            <span class="r-edit-unit">/ 100m</span>
          </div>
          <div class="r-edit-actions">
            <button class="r-edit-btn" data-action="cancel">Cancel</button>
            <button class="r-edit-btn save" data-action="save">Save</button>
          </div>
        </div>
      </div>
    `;
  }
  const value = formatCss(css);
  let sub = 'Tap to enter your CSS, or run a 400 m time-trial test.';
  if (css && derived?.cssSecPer100m === css) {
    const baseSub = `Derived from ${derived.swimActivityCount} swim${derived.swimActivityCount === 1 ? '' : 's'} in your history.`;
    // Hedge harder when the derived estimate is low/none confidence — flag
    // the value as a rough guess and nudge the paired-TT test.
    const conf = derived.confidence;
    sub = (conf === 'low' || conf === 'none')
      ? `${baseSub} Estimate only — run a 400 m + 200 m test to lock in your real CSS.`
      : (conf === 'medium')
      ? `${baseSub} Run a 400 m + 200 m test to sharpen this number.`
      : baseSub;
  } else if (css) {
    const beats =
      derived?.cssSecPer100m != null &&
      derived.cssSecPer100m < css &&
      (derived.swimActivityCount ?? 0) >= 2;
    sub = beats
      ? `Set manually. Your swims show ${formatCss(derived!.cssSecPer100m)}. We'll update on next sync.`
      : 'Set manually.';
  }
  // Confidence chip — only shows when we wouldn't fully trust the number.
  // Specifically the user's "16-month-old swim" case → confidence 'none',
  // chip reads "Rough estimate". The caption already explains; the chip
  // makes the caveat visible at a glance.
  const cssChip = (css && derived?.cssSecPer100m === css)
    ? renderConfidenceChip(derived.confidence)
    : '';
  return `
    <button class="r-row shadow-ap" data-row="css">
      <div class="r-row-icon">${ICON_SWIM}</div>
      <div class="r-row-body">
        <p class="r-row-label">Swim CSS</p>
        <p class="r-row-value">${value}${cssChip}</p>
        <p class="r-row-sub">${sub}</p>
      </div>
      <div class="r-row-chev">${CHEV}</div>
    </button>
  `;
}

function renderRunnerTypeRow(active: RunnerType | null): string {
  if (editing === null) {
    const label = active ? RUNNER_TYPE_LABELS[active].label : '--';
    const sub = active ? RUNNER_TYPE_LABELS[active].sub : 'Pick the profile that fits best.';
    return `
      <button class="r-row shadow-ap" data-row="runner-type-open">
        <div class="r-row-icon">${ICON_PROFILE}</div>
        <div class="r-row-body">
          <p class="r-row-label">Race preference</p>
          <p class="r-row-value">${label}</p>
          <p class="r-row-sub">${sub}</p>
        </div>
        <div class="r-row-chev">${CHEV}</div>
      </button>
    `;
  }
  return `
    <button class="r-row shadow-ap" data-row="runner-type-open">
      <div class="r-row-icon">${ICON_PROFILE}</div>
      <div class="r-row-body">
        <p class="r-row-label">Race preference</p>
        <p class="r-row-value">${active ? RUNNER_TYPE_LABELS[active].label : '--'}</p>
        <p class="r-row-sub">${active ? RUNNER_TYPE_LABELS[active].sub : 'Pick the profile that fits best.'}</p>
      </div>
      <div class="r-row-chev">${CHEV}</div>
    </button>
  `;
}

/** Runner-type picker is a transient overlay inside the row, invoked on tap. */
function renderRunnerTypePickerInline(active: RunnerType | null): string {
  return `
    <div class="r-row shadow-ap editing" data-row="runner-type-picker">
      <div class="r-row-icon">${ICON_PROFILE}</div>
      <div class="r-row-body">
        <p class="r-row-label">Race preference</p>
        <div class="r-type-grid">
          ${(Object.keys(RUNNER_TYPE_LABELS) as RunnerType[]).map(t => {
            const selected = active === t;
            const { label, sub } = RUNNER_TYPE_LABELS[t];
            return `
              <button class="r-type-opt ${selected ? 'selected' : ''}" data-runner-type="${t}">
                <div class="t-label">${label}</div>
                <div class="t-sub">${sub}</div>
              </button>
            `;
          }).join('')}
        </div>
        <div class="r-edit-actions">
          <button class="r-edit-btn" data-action="cancel">Close</button>
        </div>
      </div>
    </div>
  `;
}

/** ---------- Handlers ---------- */

function wireHandlers(container: HTMLElement, state: OnboardingState): void {
  // Row tap → enter edit mode for that row
  container.querySelectorAll<HTMLElement>('[data-row]').forEach(el => {
    const row = el.getAttribute('data-row');
    if (!row) return;

    if (row === 'volume' || row === 'pb-k5' || row === 'pb-k10' || row === 'pb-h' || row === 'pb-m' || row === 'ftp' || row === 'css') {
      if (el.classList.contains('editing')) return;
      el.addEventListener('click', (e) => {
        // Ignore clicks that land on cancel/save buttons inside an already-open editor
        const target = e.target as HTMLElement;
        if (target.closest('[data-action]')) return;
        editing = row as EditingRow;
        rerender(state);
      });
    }

    if (row === 'runner-type-open') {
      el.addEventListener('click', () => {
        openRunnerTypePicker(state);
      });
    }
  });

  // Cancel / Save buttons inside editing rows
  container.querySelectorAll<HTMLElement>('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      if (action === 'cancel') {
        editing = null;
        rerender(state);
        return;
      }
      if (action === 'save') {
        commitEditing(state);
      }
    });
  });

  // Info popups (VDOT / LT)
  container.querySelectorAll<HTMLElement>('[data-info]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const which = btn.getAttribute('data-info');
      if (which === 'vdot') showVDOTExplanation();
      else if (which === 'lt') showLTExplanation();
    });
  });

  // Continue
  container.querySelector<HTMLButtonElement>('#r-continue')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled) return;
    editing = null;
    // Persist auto-filled PBs to state.pbs. Fastest wins — if Strava found a
    // faster time than what's already saved, overwrite it. A stale slower
    // cache must not beat a fresh Strava read.
    if (cachedPbSources) {
      const cur = getState();
      const nextPbs: PBs = { ...(cur.onboarding?.pbs ?? {}) };
      const takeFastest = (k: keyof PBsWithSource, slot: keyof PBs) => {
        const stravaSec = cachedPbSources![k]?.timeSec;
        if (stravaSec == null) return;
        const saved = nextPbs[slot];
        if (saved == null || stravaSec < saved) nextPbs[slot] = stravaSec;
      };
      takeFastest('k5', 'k5');
      takeFastest('k10', 'k10');
      takeFastest('h', 'h');
      takeFastest('m', 'm');
      updateOnboarding({ pbs: nextPbs });
    }
    // Clear caches so the next onboarding pass (if any) re-fetches fresh.
    cachedActivities = null;
    cachedPbSources = null;
    cachedTriBenchmarks = null;
    cachedClosestBike = null;
    cachedClosestSwim = null;
    cachedWeeklyBikeKm = null;
    cachedWeeklySwimKm = null;
    nextStep();
  });
}

function commitEditing(state: OnboardingState): void {
  if (editing === 'volume') {
    const input = document.getElementById('r-volume-input') as HTMLInputElement | null;
    if (!input) return;
    const raw = parseFloat(input.value);
    if (isFinite(raw) && raw >= 0) {
      const unitPref = getState().unitPref ?? 'km';
      const km = unitPref === 'mi' ? raw * 1.609 : raw;
      const s = getMutableState();
      s.detectedWeeklyKm = km;
      saveState();
    }
    editing = null;
    rerender(state);
    return;
  }

  if (editing === 'ftp') {
    const input = document.getElementById('r-ftp-input') as HTMLInputElement | null;
    if (!input) return;
    const raw = parseInt(input.value, 10);
    const onb = (getState().onboarding ?? {}) as OnboardingState;
    if (Number.isFinite(raw) && raw >= 80 && raw <= 500) {
      updateOnboarding({ triBike: { ...(onb.triBike ?? {}), ftp: raw, hasPowerMeter: true } });
    } else if (input.value.trim() === '') {
      updateOnboarding({ triBike: { ...(onb.triBike ?? {}), ftp: undefined } });
    } else {
      input.style.borderColor = 'rgba(185,28,28,0.6)';
      return;
    }
    editing = null;
    rerender(state);
    return;
  }

  if (editing === 'css') {
    const input = document.getElementById('r-css-input') as HTMLInputElement | null;
    if (!input) return;
    const onb = (getState().onboarding ?? {}) as OnboardingState;
    const parsed = parseCss(input.value);
    if (parsed !== null && parsed > 30 && parsed < 600) {
      updateOnboarding({ triSwim: { ...(onb.triSwim ?? {}), cssSecPer100m: parsed } });
    } else if (input.value.trim() === '') {
      updateOnboarding({ triSwim: { ...(onb.triSwim ?? {}), cssSecPer100m: undefined } });
    } else {
      input.style.borderColor = 'rgba(185,28,28,0.6)';
      return;
    }
    editing = null;
    rerender(state);
    return;
  }

  if (editing === 'pb-k5' || editing === 'pb-k10' || editing === 'pb-h' || editing === 'pb-m') {
    const input = document.getElementById('r-pb-input') as HTMLInputElement | null;
    if (!input) return;
    const key: keyof PBs = editing === 'pb-k5' ? 'k5' : editing === 'pb-k10' ? 'k10' : editing === 'pb-h' ? 'h' : 'm';
    const long = key === 'h' || key === 'm';
    const parsed = parseTime(input.value, long);
    const nextPbs: PBs = { ...state.pbs };
    if (parsed !== null) {
      nextPbs[key] = parsed;
    } else if (input.value.trim() === '') {
      delete nextPbs[key];
    } else {
      // Bad input — do not close the editor so the user can fix it.
      input.style.borderColor = 'rgba(185,28,28,0.6)';
      return;
    }
    updateOnboarding({ pbs: nextPbs });
    editing = null;
    rerender(state);
  }
}

/**
 * Runner-type picker is rendered inline by temporarily replacing the runner-
 * type row with a selector. Uses the same row slot so the flow stays a single
 * scrollable column.
 */
function openRunnerTypePicker(state: OnboardingState): void {
  const row = document.querySelector<HTMLElement>('[data-row="runner-type-open"]');
  if (!row) return;
  const active = state.confirmedRunnerType ?? state.calculatedRunnerType ?? getState().typ ?? null;
  row.outerHTML = renderRunnerTypePickerInline(active);

  const picker = document.querySelector<HTMLElement>('[data-row="runner-type-picker"]');
  if (!picker) return;

  picker.querySelectorAll<HTMLElement>('[data-runner-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.getAttribute('data-runner-type') as RunnerType | null;
      if (!t) return;
      updateOnboarding({ confirmedRunnerType: t });
      // Mirror to engine state — runner-type.ts does the same.
      const s = getMutableState();
      s.typ = t;
      saveState();
      rerender(state);
    });
  });

  picker.querySelector<HTMLElement>('[data-action="cancel"]')?.addEventListener('click', () => {
    rerender(state);
  });
}

function openInfoPopup(innerHTML: string): void {
  const existing = document.getElementById('r-info-popup');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'r-info-popup';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `
    <div style="background:#FDFCF7;border-radius:18px;max-width:440px;width:100%;max-height:80vh;overflow-y:auto;padding:24px 22px;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      ${innerHTML}
      <button id="r-info-close" style="margin-top:18px;width:100%;height:44px;border-radius:22px;background:#0A0A0A;color:#FDFCF7;border:none;font-size:14px;font-weight:500;cursor:pointer">Close</button>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#r-info-close')?.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

function showVDOTExplanation(): void {
  const hr = getState().hrCalibratedVdot;
  const tier = hr?.confidence;
  let method = '';
  if (hr && hr.vdot != null && tier !== 'none') {
    const tierLabel = tier === 'high' ? 'high confidence' : tier === 'medium' ? 'medium confidence' : 'rough estimate';
    const r2Str = hr.r2 != null ? hr.r2.toFixed(2) : '—';
    method = `<p style="font-size:13px;color:var(--c-black);margin:0 0 14px;line-height:1.5">Your value comes from <strong>${hr.n}</strong> qualifying runs in the last 8 weeks (${tierLabel}, R² = ${r2Str}).</p>`;
  } else if (hr?.reason === 'no-rhr') {
    method = `<p style="font-size:13px;color:var(--c-black);margin:0 0 14px;line-height:1.5">Your value falls back to a PB-derived estimate. Connect Garmin or add a resting HR to switch to the heart-rate-calibrated method.</p>`;
  }
  openInfoPopup(`
    <h3 style="font-size:18px;font-weight:500;margin:0 0 12px">Current fitness (VDOT)</h3>
    ${method}
    <p style="font-size:13px;color:var(--c-muted);margin:0 0 10px;line-height:1.5">VDOT is your aerobic capacity expressed as a number. We estimate it from how your heart rate responds to pace.</p>
    <p style="font-size:13px;color:var(--c-muted);margin:0 0 10px;line-height:1.5">For each steady run we compute %HRR (Swain &amp; Leutholtz 1997, %HRR ≈ %VO₂R), then fit a weighted line through pace vs %HRR. The pace at 100% gives vVO₂max, which converts to VDOT via Daniels' formula.</p>
    <p style="font-size:12px;color:var(--c-faint);margin:0;line-height:1.5">References: Daniels (Running Formula), Swain &amp; Leutholtz 1997.</p>
  `);
}

function showLTExplanation(): void {
  const s = getState();
  const src = s.ltSource;
  const conf = s.ltConfidence;
  let method = '';
  if (src === 'garmin') {
    method = `<p style="font-size:13px;color:var(--c-black);margin:0 0 14px;line-height:1.5">From your watch's lactate-threshold reading${conf ? ` (${conf} confidence)` : ''}.</p>`;
  } else if (src === 'override') {
    method = `<p style="font-size:13px;color:var(--c-black);margin:0 0 14px;line-height:1.5">Set manually. We're using the value you entered.</p>`;
  } else if (src === 'blended') {
    method = `<p style="font-size:13px;color:var(--c-black);margin:0 0 14px;line-height:1.5">Blended from your half / 10K PBs and recent threshold-effort runs.</p>`;
  } else if (src === 'daniels') {
    method = `<p style="font-size:13px;color:var(--c-black);margin:0 0 14px;line-height:1.5">Estimated from your VDOT via Daniels' T-pace (88% of vVO₂max). This is the rough-estimate fallback — refines as race-distance PBs and steady threshold runs arrive.</p>`;
  } else if (src === 'critical-speed') {
    method = `<p style="font-size:13px;color:var(--c-black);margin:0 0 14px;line-height:1.5">Estimated from a Monod–Scherrer critical speed model — fits multi-distance results to a sustained-effort asymptote.</p>`;
  } else if (src === 'empirical') {
    method = `<p style="font-size:13px;color:var(--c-black);margin:0 0 14px;line-height:1.5">Inferred from your recent threshold-effort runs.</p>`;
  }
  openInfoPopup(`
    <h3 style="font-size:18px;font-weight:500;margin:0 0 12px">Lactate threshold pace</h3>
    ${method}
    <p style="font-size:13px;color:var(--c-muted);margin:0 0 10px;line-height:1.5">Lactate threshold is the fastest pace you can hold roughly steady-state — beyond it lactate accumulates and you slow.</p>
    <p style="font-size:13px;color:var(--c-muted);margin:0 0 10px;line-height:1.5">It anchors threshold and tempo workouts in your plan, and combines with VDOT to set easy / marathon / VO₂ paces.</p>
    <p style="font-size:12px;color:var(--c-faint);margin:0;line-height:1.5">References: Daniels (Running Formula), Monod &amp; Scherrer (critical-power model).</p>
  `);
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const current = getOnboardingState() ?? state;
    const container = document.getElementById('app-root');
    if (container) renderReview(container, current);
  });
}
