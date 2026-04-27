import type { OnboardingState } from '@/types/onboarding';
import type { PBs, RunnerType } from '@/types/training';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { formatKm } from '@/utils/format';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  getAccessToken,
} from '@/data/supabaseClient';
import {
  readPBsFromHistory,
  type ActivityWithBestEfforts,
  type PBsWithSource,
  type PBWithSource,
} from '@/calculations/pbs-from-history';
import { backfillStravaHistory } from '@/data/stravaSync';
import { syncPhysiologySnapshot } from '@/data/physiologySync';

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

/** Inline row state — which row (if any) is currently in edit mode. */
type EditingRow = null | 'volume' | 'pb-k5' | 'pb-k10' | 'pb-h' | 'pb-m';
let editing: EditingRow = null;

/** Cached activity rows between renders so inline edits don't refetch. */
let cachedActivities: ActivityWithBestEfforts[] | null = null;
/** Cached derived PBs with source so captions stay stable across rerenders. */
let cachedPbSources: PBsWithSource | null = null;

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
  // First-mount: show a lightweight loading state while we pull activities.
  // Once data is in, decide: render the review or divert to manual-entry.
  if (cachedActivities === null) {
    renderLoading(container, 'Connecting to Strava…');
    // Full 26-week history backfill so best_efforts (race PBs) are populated
    // for every running activity in the lookback window. syncStravaActivities
    // only pulls 28 days and misses race PBs from earlier in the year.
    // Swallow errors — if the backfill fails, fall through and let the DB read
    // decide (legitimate empty = manual-entry).
    const lookback = Math.ceil(ACTIVITY_LOOKBACK_DAYS / 7);
    // Order matters here:
    //   1. backfill — writes activities to DB + onboardingRunHistory; its
    //      internal refreshBlendedFitness fires here but RHR/maxHR aren't
    //      loaded yet, so hrCalibratedVdot will be 'no-rhr' at this point.
    //   2. syncPhysiologySnapshot — daily_metrics gives RHR; the activity
    //      envelope (now populated by step 1) gives maxHR.
    //   3. refreshBlendedFitness — re-run with RHR + maxHR + runs in state
    //      so hrCalibratedVdot lands with a real confidence tier.
    //   4. fetchRecentActivities — DB read for PB extraction (independent).
    renderLoading(container, 'Reading your recent training…');
    backfillStravaHistory(lookback).catch(() => {}).then(() => {
      renderLoading(container, 'Reading your physiology…');
      return syncPhysiologySnapshot(28).catch(() => {});
    }).then(async () => {
      try {
        const { refreshBlendedFitness } = await import('@/calculations/blended-fitness');
        const { getMutableState } = await import('@/state/store');
        refreshBlendedFitness(getMutableState());
      } catch (e) {
        console.warn('[review] post-physio refresh failed:', e);
      }
      renderLoading(container, 'Reading your recent runs…');
      return fetchRecentActivities();
    }).then((rows) => {
      renderLoading(container, 'Pulling out your personal bests…');
      cachedActivities = rows;
      cachedPbSources = readPBsFromHistory(rows);
      const runs = countRunningActivities(rows);
      const hasVolume = !!getState().detectedWeeklyKm && getState().detectedWeeklyKm! > 0;
      const hasAnyPb = !!(cachedPbSources.k5 || cachedPbSources.k10 || cachedPbSources.h || cachedPbSources.m);

      // Diagnostic — one-shot summary of what the backfill + DB read produced.
      // Remove once PB auto-fill is proven reliable across test accounts.
      const withBE = rows.filter(r => Array.isArray((r as any).best_efforts) && (r as any).best_efforts.length > 0).length;
      console.log(`[review] rows=${rows.length} running=${runs} withBestEfforts=${withBE} detectedWeeklyKm=${getState().detectedWeeklyKm}`);
      console.log('[review] cachedPbSources:', cachedPbSources);
      // One-shot: surface the distinct best_effort names actually stored so we
      // can catch any Strava naming variants our map doesn't cover.
      const beNames = new Set<string>();
      for (const r of rows) {
        const be = (r as any).best_efforts;
        if (Array.isArray(be)) for (const e of be) if (e && typeof e.name === 'string') beNames.add(e.name);
      }
      console.log('[review] distinct best_effort names:', Array.from(beNames));

      const insufficient = runs < INSUFFICIENT_RUN_COUNT || !hasVolume || !hasAnyPb;
      if (insufficient) {
        console.log(`[review] Insufficient data (runs=${runs}, hasVolume=${hasVolume}, hasAnyPb=${hasAnyPb}) — diverting to manual-entry`);
        // Persist whatever PBs we DID find so manual-entry prefills those rows
        // (partial Strava data is still useful — user may only have a 5K PB).
        const curState = getState();
        const partialPbs: PBs = { ...(curState.onboarding?.pbs ?? {}) };
        if (cachedPbSources.k5 && partialPbs.k5 == null) partialPbs.k5 = cachedPbSources.k5.timeSec;
        if (cachedPbSources.k10 && partialPbs.k10 == null) partialPbs.k10 = cachedPbSources.k10.timeSec;
        if (cachedPbSources.h && partialPbs.h == null) partialPbs.h = cachedPbSources.h.timeSec;
        if (cachedPbSources.m && partialPbs.m == null) partialPbs.m = cachedPbSources.m.timeSec;
        updateOnboarding({ skippedStrava: true, pbs: partialPbs });
        saveState();
        // Reset cache so a return visit re-fetches fresh data.
        cachedActivities = null;
        cachedPbSources = null;
        try { window.wizardNext(); } catch { nextStep(); }
        return;
      }
      renderContent(container, state);
    });
    return;
  }
  renderContent(container, state);
}

/** ---------- Loading skeleton ---------- */

function renderLoading(container: HTMLElement, message: string): void {
  container.innerHTML = `
    <style>
      @keyframes spin { to { transform: rotate(360deg); } }
      .r-spinner { width:22px; height:22px; border-radius:50%; border:2px solid rgba(0,0,0,0.08); border-top-color: var(--c-black); animation: spin 0.8s linear infinite; }
    </style>
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 20px;gap:14px">
      ${renderProgressIndicator(4, 7)}
      <div class="r-spinner" style="margin-top:12px"></div>
      <p style="font-size:13px;color:var(--c-muted);margin:0;text-align:center">${message}</p>
      <p style="font-size:11px;color:var(--c-faint);margin:0;text-align:center">This can take 20 to 30 seconds on first connect.</p>
    </div>
  `;
}

/** ---------- Full content render ---------- */

function renderContent(container: HTMLElement, state: OnboardingState): void {
  const s = getState();
  const unitPref = s.unitPref ?? 'km';
  const weeklyKm = s.detectedWeeklyKm ?? 0;
  const pbs = state.pbs ?? {};
  const pbSources: PBsWithSource = cachedPbSources ?? {};
  const activityCount = cachedActivities ? countRunningActivities(cachedActivities) : 0;

  // VDOT: use confirmed state.v (already computed by sync). No manual entry.
  const vdot = s.v;

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
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 32%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(4, 7)}

        <div class="r-rise" style="width:100%;max-width:480px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.15">
            Here's what we found
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">
            Confirm or edit anything that looks off. Personal bests show the last 3 years. Tap any row to enter an older PB.
          </p>
        </div>

        <div class="r-rise" style="width:100%;max-width:480px;margin-top:22px;animation-delay:0.12s;display:flex;flex-direction:column;gap:10px">
          ${renderVolumeRow(weeklyKm, unitPref, activityCount)}
          ${pbs.k5 || pbSources.k5 ? renderPbRow('k5', '5K', pbs.k5, pbSources.k5, false) : ''}
          ${pbs.k10 || pbSources.k10 ? renderPbRow('k10', '10K', pbs.k10, pbSources.k10, false) : ''}
          ${pbs.h || pbSources.h ? renderPbRow('h', 'Half marathon', pbs.h, pbSources.h, true) : ''}
          ${pbs.m || pbSources.m ? renderPbRow('m', 'Marathon', pbs.m, pbSources.m, true) : ''}
          ${renderVdotRow(vdot)}
          ${renderRunnerTypeRow(activeRunnerType)}
        </div>
      </div>

      <div class="r-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.28s">
        <div style="max-width:480px;margin:0 auto">
          <button id="r-continue" class="r-cta">Continue</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(container, state);
}

/** ---------- Row renderers ---------- */

const ICON_VOLUME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5"/><path d="M8 19v-6"/><path d="M12 19v-10"/><path d="M16 19v-4"/><path d="M20 19v-8"/></svg>`;
const ICON_CLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/></svg>`;
const ICON_FITNESS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 4 5-7 4 5"/></svg>`;
const ICON_PROFILE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="3.2"/><path d="M5 19c1.5-3 4-4.2 7-4.2s5.5 1.2 7 4.2"/></svg>`;
const CHEV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;

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
  const value = weeklyKm > 0 ? `${formatKm(weeklyKm, unitPref, 0)} / week` : '--';
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
  const displaySec = currentSec ?? source?.timeSec;
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
  if (source) {
    if (source.activityName) subline = source.activityName;
    else subline = 'From your Strava history';
  } else if (currentSec) {
    subline = 'Entered manually';
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

function renderVdotRow(vdot: number | undefined): string {
  // Prefer the HR-calibrated VDOT when available: it's the freshest, fittest
  // signal we have (last 8 weeks of HR-vs-pace) and the one we want to
  // explain to the user. Fall back to s.v (PB-derived) when HR data is missing.
  const hr = getState().hrCalibratedVdot;
  const showHR = hr && hr.vdot != null && hr.confidence !== 'none';
  const displayVdot = showHR ? hr!.vdot! : (vdot && vdot > 0 ? vdot : null);
  const value = displayVdot != null ? displayVdot.toFixed(1) : '--';

  // Sub-caption: always tell the user *what we did* with their data. The
  // bland "aerobic fitness estimate" fallback only shows if hrCalibratedVdot
  // is completely undefined (refresh hasn't fired yet).
  let sub = 'Aerobic fitness estimate from your recent harder runs.';
  if (showHR) {
    // N is the *qualifying* run count — duration ≥20 min, stable HR, in the
    // 8-week window. Make this explicit so users don't think we ignored runs.
    const runWord = hr!.n === 1 ? 'run' : 'runs';
    if (hr!.confidence === 'low') {
      sub = `Rough estimate from ${hr!.n} steady ${runWord} in the last 8 weeks. We'll refine this as more training comes in.`;
    } else {
      const tier = hr!.confidence === 'high' ? 'High confidence' : 'Medium confidence';
      sub = `Measured from your heart rate response to pace across ${hr!.n} steady ${runWord} in the last 8 weeks. ${tier}.`;
    }
  } else if (hr && hr.reason === 'no-rhr') {
    sub = 'Connect Garmin or add a resting HR to calibrate this from your heart rate.';
  } else if (hr && hr.reason === 'no-maxhr') {
    sub = 'Once a few more activities sync we can calibrate this from your heart rate.';
  } else if (hr && hr.reason === 'too-few-points') {
    sub = `Only ${hr.n} steady ${hr.n === 1 ? 'run' : 'runs'} in the last 8 weeks. Need 3 to read fitness from heart rate.`;
  } else if (hr && hr.reason === 'no-points') {
    sub = "No qualifying runs in the last 8 weeks yet. We'll calibrate this from heart rate once you've trained for a few weeks.";
  } else if (hr && hr.reason === 'bad-fit') {
    sub = "Heart rate signal is noisy across your recent runs. We'll keep watching.";
  }
  return `
    <div class="r-row shadow-ap readonly">
      <div class="r-row-icon">${ICON_FITNESS}</div>
      <div class="r-row-body">
        <p class="r-row-label">Current fitness (VDOT)</p>
        <p class="r-row-value">${value}</p>
        <p class="r-row-sub">${sub}</p>
      </div>
    </div>
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
          <p class="r-row-label">Runner type</p>
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
        <p class="r-row-label">Runner type</p>
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
        <p class="r-row-label">Runner type</p>
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

    if (row === 'volume' || row === 'pb-k5' || row === 'pb-k10' || row === 'pb-h' || row === 'pb-m') {
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

  // Continue
  container.querySelector<HTMLButtonElement>('#r-continue')?.addEventListener('click', () => {
    editing = null;
    // Persist auto-filled PBs to state.pbs. The Strava-sourced values drive
    // display on this page, but only manual edits write to state. On Continue,
    // fold in any remaining Strava PBs that the user didn't touch so downstream
    // steps (race-target, plan-preview-v2) see a complete pbs object.
    if (cachedPbSources) {
      const cur = getState();
      const nextPbs: PBs = { ...(cur.onboarding?.pbs ?? {}) };
      if (cachedPbSources.k5  && nextPbs.k5  == null) nextPbs.k5  = cachedPbSources.k5.timeSec;
      if (cachedPbSources.k10 && nextPbs.k10 == null) nextPbs.k10 = cachedPbSources.k10.timeSec;
      if (cachedPbSources.h   && nextPbs.h   == null) nextPbs.h   = cachedPbSources.h.timeSec;
      if (cachedPbSources.m   && nextPbs.m   == null) nextPbs.m   = cachedPbSources.m.timeSec;
      updateOnboarding({ pbs: nextPbs });
    }
    // Clear caches so the next onboarding pass (if any) re-fetches fresh.
    cachedActivities = null;
    cachedPbSources = null;
    try { window.wizardNext(); } catch { nextStep(); }
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

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const current = getOnboardingState() ?? state;
    const container = document.getElementById('app-root');
    if (container) renderReview(container, current);
  });
}
