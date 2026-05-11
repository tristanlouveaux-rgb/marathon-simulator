/**
 * Tri past-race step — asks whether the user completed a triathlon in the
 * past year and, if so, collects the distance, date, total time, and
 * optional per-leg splits.
 *
 * Scan logic covers both recording patterns:
 *   A. SEPARATE activities — three swim/bike/run rows in garmin_activities
 *      on the same calendar day. Per-leg splits pre-filled from DB.
 *   B. MULTISPORT recording — one TRIATHLON row from Garmin's tri mode,
 *      Suunto, Coros, or Apple Watch multi-sport. Total time only; a
 *      "Load splits from Strava" button calls the getTriLaps edge function
 *      to fetch per-lap data and fill in swim/bike/run times.
 *
 * Benchmark seeding (in initialization.triathlon.ts):
 *   Swim leg → CSS;  Run leg → VDOT (fatigue discount backed out).
 *   Bike time alone is not enough to derive FTP without watts.
 */

import type { OnboardingState, PastTriathlonDistance, TriPastRaceEntry } from '@/types/onboarding';
import { PAST_TRI_LEG_DISTANCES } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { getState } from '@/state/store';
import { buildRingBackground, buildSunGlint, buildAtmosphereBase } from '@/ui/page-flair';
import { supabase } from '@/data/supabaseClient';
import { callEdgeFunction } from '@/data/supabaseClient';

// ──────────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────────

type CandidateSource = 'separate' | 'multisport';

interface RaceCandidate {
  stravaId: string | null;   // null when source is Garmin-only (no laps available)
  dateISO: string;
  source: CandidateSource;
  // Separate: all three available. Multisport: only total known until laps fetched.
  swimSec: number | null;
  bikeSec: number | null;
  runSec:  number | null;
  totalSec: number;
  distance: PastTriathlonDistance;
}

// ──────────────────────────────────────────────────────────────────────────
// Render
// ──────────────────────────────────────────────────────────────────────────

export function renderTriPastRace(container: HTMLElement, state: OnboardingState): void {
  const existing = state.triPastRace;
  const hasRace = !!existing;

  container.innerHTML = `
    <style>
      @keyframes tRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .t-rise { opacity:0; animation: tRise 0.5s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .tri-card { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.06); border-radius:16px; padding:18px; margin-bottom:14px; box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.3); }
      .tri-label { font-size:13px; color:var(--c-muted); letter-spacing:0.01em; margin:0 0 10px; text-transform:uppercase; font-weight:500; }
      .tri-pill-row { display:flex; gap:8px; flex-wrap:wrap; }
      .tri-pill { flex:1; min-width:80px; padding:10px 12px; border-radius:12px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.9); font-size:14px; color:var(--c-black); cursor:pointer; text-align:left; transition: all 0.15s ease; }
      .tri-pill.active { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }
      .tri-pill .tri-pill-sub { display:block; font-size:10px; opacity:0.65; margin-top:2px; }
      .tri-hint { font-size:12px; color:var(--c-faint); margin:6px 0 0; line-height:1.5; }
      .tri-cta { width:100%; padding:14px 20px; height:50px; background:var(--c-black); color:#FDFCF7; border:none; border-radius:25px; font-size:15px; font-weight:500; cursor:pointer; margin-top:8px; box-shadow:0 2px 8px rgba(0,0,0,0.15); }
      .tri-input { background:rgba(255,255,255,0.95); border:1px solid rgba(0,0,0,0.08); color:var(--c-black); border-radius:10px; padding:9px 12px; font-size:14px; width:100%; box-sizing:border-box; outline:none; }
      .tri-input:focus { border-color:var(--c-black); }
      .tri-toggle { display:flex; align-items:center; gap:10px; font-size:15px; color:var(--c-black); cursor:pointer; user-select:none; padding:4px 0; }
      .tri-toggle input[type="checkbox"] { width:18px; height:18px; accent-color: var(--c-black); flex-shrink:0; }
      .tri-time-row { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px; }
      .tri-time-cell label { display:block; font-size:11px; color:var(--c-faint); margin-bottom:4px; }
      .tri-time-cell input { text-align:center; }
      .tri-leg-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
      .tri-leg-cell label { display:block; font-size:11px; color:var(--c-faint); margin-bottom:4px; font-weight:500; }
      .tpr-scan-btn { width:100%; padding:11px 16px; border:1px solid rgba(0,0,0,0.12); border-radius:12px; background:rgba(255,255,255,0.9); font-size:13px; color:var(--c-black); cursor:pointer; transition:all 0.15s; text-align:center; }
      .tpr-scan-btn:hover { border-color:var(--c-black); }
      .tpr-scan-btn:disabled { opacity:0.45; cursor:not-allowed; }
      .tpr-candidate { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:11px 13px; border-radius:10px; border:1px solid rgba(0,0,0,0.08); background:rgba(255,255,255,0.9); text-align:left; transition:all 0.15s; width:100%; }
      .tpr-candidate.selected { border-color:var(--c-black); background:var(--c-black); color:#FDFCF7; }
      .tpr-candidate.selected .tpr-load-btn { color:#FDFCF7; border-color:rgba(255,255,255,0.3); }
      .tpr-load-btn { margin-top:6px; padding:4px 10px; border:1px solid rgba(0,0,0,0.15); border-radius:8px; background:transparent; font-size:11px; color:var(--c-muted); cursor:pointer; white-space:nowrap; }
      .tpr-load-btn:disabled { opacity:0.4; cursor:not-allowed; }
      #tri-race-form { display:${hasRace ? 'block' : 'none'}; margin-top:16px; }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;display:flex;flex-direction:column">
      <div aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildAtmosphereBase()}
        ${buildRingBackground('tpr', { variant: 'asymmetric', side: 'right' })}
        ${buildSunGlint('mid')}
      </div>

      <div style="position:relative;z-index:1;padding:36px 20px 140px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(6, 8)}

        <div class="t-rise" style="width:100%;max-width:480px;text-align:center;margin-bottom:20px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.5rem,5vw,1.9rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 6px;line-height:1.15">
            Any recent race results?
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">A completed triathlon is the most precise calibration source for your swim and run benchmarks.</p>
        </div>

        <div style="width:100%;max-width:480px">

          <!-- Has-race toggle -->
          <div class="tri-card t-rise" style="animation-delay:0.1s">
            <label class="tri-toggle">
              <input type="checkbox" id="tpr-has-race" ${hasRace ? 'checked' : ''}>
              I've completed a triathlon in the past year
            </label>
            <p class="tri-hint" style="margin-top:10px">Sprint, Olympic, 70.3, or Ironman. Swim and run legs calibrate your CSS and running benchmarks directly.</p>
          </div>

          <!-- All fields shown when toggled -->
          <div id="tri-race-form">

            <!-- Strava scan -->
            <div class="tri-card t-rise" style="animation-delay:0.14s">
              <div class="tri-label">Scan Strava history</div>
              <button id="tpr-strava-btn" class="tpr-scan-btn">
                Find recent race days automatically
              </button>
              <p id="tpr-scan-hint" class="tri-hint">Detects both multi-sport recordings (single Garmin/Suunto/Coros file) and separately logged swim + bike + run activities.</p>
              <div id="tpr-candidates" style="margin-top:10px;display:flex;flex-direction:column;gap:8px"></div>
            </div>

            <!-- Distance -->
            <div class="tri-card t-rise" style="animation-delay:0.18s">
              <div class="tri-label">Race distance</div>
              <div class="tri-pill-row">
                ${([ ['sprint', 'Sprint', '0.75k / 20k / 5k'], ['olympic', 'Olympic', '1.5k / 40k / 10k'], ['70.3', '70.3', '1.9k / 90k / 21.1k'], ['ironman', 'Ironman', '3.8k / 180k / 42.2k'] ] as [PastTriathlonDistance, string, string][]).map(([d, label, sub]) => `
                  <button class="tri-pill ${existing?.distance === d ? 'active' : ''}" data-dist="${d}">
                    ${label}
                    <span class="tri-pill-sub">${sub}</span>
                  </button>
                `).join('')}
              </div>
            </div>

            <!-- Date -->
            <div class="tri-card t-rise" style="animation-delay:0.22s">
              <div class="tri-label">When was it?</div>
              <input type="month" id="tpr-date" class="tri-input"
                value="${existing?.dateISO?.slice(0, 7) ?? ''}"
                min="${monthBefore(12)}" max="${currentMonth()}">
              <p class="tri-hint">Month and year is enough.</p>
            </div>

            <!-- Total finish time -->
            <div class="tri-card t-rise" style="animation-delay:0.26s">
              <div class="tri-label">Total finish time</div>
              <div class="tri-time-row">
                <div class="tri-time-cell">
                  <label>Hours</label>
                  <input type="number" id="tpr-h" class="tri-input" min="0" max="17" placeholder="h"
                    value="${existing ? Math.floor(existing.totalSec / 3600) : ''}">
                </div>
                <div class="tri-time-cell">
                  <label>Minutes</label>
                  <input type="number" id="tpr-m" class="tri-input" min="0" max="59" placeholder="mm"
                    value="${existing ? Math.floor((existing.totalSec % 3600) / 60) : ''}">
                </div>
                <div class="tri-time-cell">
                  <label>Seconds</label>
                  <input type="number" id="tpr-s" class="tri-input" min="0" max="59" placeholder="ss"
                    value="${existing ? existing.totalSec % 60 : ''}">
                </div>
              </div>
              <p id="tpr-total-hint" class="tri-hint" style="${existing ? '' : 'display:none'}">
                ${existing ? fmtLongTime(existing.totalSec) : ''}
              </p>
            </div>

            <!-- Per-leg splits -->
            <div class="tri-card t-rise" style="animation-delay:0.30s">
              <label class="tri-toggle" style="margin-bottom:0">
                <input type="checkbox" id="tpr-has-legs" ${existing?.perLeg ? 'checked' : ''}>
                I have per-leg splits (optional — but very useful)
              </label>
              <div id="tpr-legs" style="display:${existing?.perLeg ? 'block' : 'none'};margin-top:14px">
                <p class="tri-hint" style="margin-bottom:12px">Swim and run splits calibrate CSS and running pace directly. Check your Garmin Connect or Strava activity for leg times.</p>
                <div class="tri-leg-grid">
                  <div class="tri-leg-cell">
                    <label>Swim</label>
                    <input type="text" id="tpr-swim" class="tri-input" placeholder="25:30"
                      value="${existing?.perLeg ? fmtLegTime(existing.perLeg.swim, false) : ''}">
                    <div style="font-size:10px;color:var(--c-faint);margin-top:2px">mm:ss</div>
                  </div>
                  <div class="tri-leg-cell">
                    <label>Bike</label>
                    <input type="text" id="tpr-bike" class="tri-input" placeholder="2:35:00"
                      value="${existing?.perLeg ? fmtLegTime(existing.perLeg.bike, true) : ''}">
                    <div style="font-size:10px;color:var(--c-faint);margin-top:2px">h:mm:ss</div>
                  </div>
                  <div class="tri-leg-cell">
                    <label>Run</label>
                    <input type="text" id="tpr-run" class="tri-input" placeholder="1:45:00"
                      value="${existing?.perLeg ? fmtLegTime(existing.perLeg.run, true) : ''}">
                    <div style="font-size:10px;color:var(--c-faint);margin-top:2px">h:mm:ss</div>
                  </div>
                </div>
                <p id="tpr-legs-hint" class="tri-hint" style="margin-top:8px;display:none"></p>
              </div>
              <p id="tpr-legs-caption" class="tri-hint" style="margin-top:8px;display:${existing?.perLeg ? 'none' : 'block'}">
                Swim and run splits set your CSS and run pace baseline. Transitions are not needed.
              </p>
            </div>

          </div><!-- /tri-race-form -->

          <!-- CTA -->
          <div class="t-rise" style="animation-delay:0.34s;margin-top:6px">
            <button id="tpr-continue" class="tri-cta">Continue</button>
          </div>

        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers();
}

// ──────────────────────────────────────────────────────────────────────────
// Time helpers
// ──────────────────────────────────────────────────────────────────────────

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthBefore(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmtLegTime(sec: number, long: boolean): string {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (long) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseLegTime(str: string, long: boolean): number | null {
  if (!str.trim()) return null;
  const parts = str.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (long && parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (long && parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  if (!long && parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function fmtLongTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDateDisplay(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T12:00:00Z');
  return d.toLocaleDateString('en', { month: 'long', year: 'numeric' });
}

function distLabel(d: PastTriathlonDistance): string {
  return { sprint: 'Sprint', olympic: 'Olympic', '70.3': '70.3', ironman: 'Ironman' }[d];
}

function guessDistance(swimM: number): PastTriathlonDistance {
  if (swimM < 900)  return 'sprint';
  if (swimM < 1700) return 'olympic';
  if (swimM < 2800) return '70.3';
  return 'ironman';
}

// ──────────────────────────────────────────────────────────────────────────
// Strava scan — queries garmin_activities for race candidates.
//
// Two result buckets:
//   separate:   3 rows (SWIMMING + CYCLING + RUNNING) on the same day
//   multisport: 1 row with activity_type TRIATHLON
// ──────────────────────────────────────────────────────────────────────────

async function scanStravaForRaces(): Promise<RaceCandidate[]> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return [];

  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);

  const { data, error } = await supabase
    .from('garmin_activities')
    .select('garmin_id, activity_type, start_time, duration_sec, distance_m')
    .eq('user_id', session.user.id)
    .gte('start_time', since.toISOString())
    .in('activity_type', ['SWIMMING', 'OPEN_WATER_SWIMMING', 'CYCLING', 'RUNNING', 'TRAIL_RUNNING', 'TRIATHLON'])
    .order('start_time', { ascending: false });

  if (error || !data) return [];

  const candidates: RaceCandidate[] = [];

  // ── Bucket A: multisport (single TRIATHLON row) ──────────────────────
  for (const row of data) {
    const t = (row.activity_type as string).toUpperCase();
    if (t !== 'TRIATHLON') continue;
    const totalSec = (row.duration_sec as number) ?? 0;
    if (totalSec < 30 * 60) continue;  // sanity: < 30 min = not a tri
    const garminId = row.garmin_id as string;
    const isStrava = garminId.startsWith('strava-');
    candidates.push({
      stravaId: isStrava ? garminId.replace('strava-', '') : null,
      dateISO: (row.start_time as string).slice(0, 10),
      source: 'multisport',
      swimSec: null, bikeSec: null, runSec: null,
      totalSec,
      distance: '70.3',  // best guess until laps fetched; user can override pill
    });
  }

  // ── Bucket B: separately logged swim+bike+run on same day ─────────────
  const byDay: Record<string, {
    swim?: typeof data[0];
    bike?: typeof data[0];
    run?:  typeof data[0];
  }> = {};
  for (const row of data) {
    const t = (row.activity_type as string).toUpperCase();
    if (t === 'TRIATHLON') continue;
    const day = (row.start_time as string).slice(0, 10);
    byDay[day] ??= {};
    if ((t === 'SWIMMING' || t === 'OPEN_WATER_SWIMMING') && !byDay[day].swim) byDay[day].swim = row;
    if (t === 'CYCLING' && !byDay[day].bike) byDay[day].bike = row;
    if ((t === 'RUNNING' || t === 'TRAIL_RUNNING') && !byDay[day].run) byDay[day].run = row;
  }

  for (const [day, legs] of Object.entries(byDay)) {
    if (!legs.swim || !legs.bike || !legs.run) continue;
    const swimSec = (legs.swim.duration_sec as number) ?? 0;
    const bikeSec = (legs.bike.duration_sec as number) ?? 0;
    const runSec  = (legs.run.duration_sec  as number) ?? 0;
    const totalSec = swimSec + bikeSec + runSec;
    if (totalSec < 60 * 60) continue;  // < 1h combined — not a tri
    const swimM = (legs.swim.distance_m as number) ?? 0;
    candidates.push({
      stravaId: null,
      dateISO: day,
      source: 'separate',
      swimSec, bikeSec, runSec,
      totalSec,
      distance: guessDistance(swimM),
    });
  }

  return candidates.sort((a, b) => b.dateISO.localeCompare(a.dateISO));
}

// ──────────────────────────────────────────────────────────────────────────
// Fetch per-leg splits for a multisport recording via edge function
// ──────────────────────────────────────────────────────────────────────────

async function fetchTriLaps(stravaActivityId: string): Promise<{
  swim: number; bike: number; run: number; totalSec: number;
  swimM: number; bikeKm: number; runKm: number;
} | null> {
  try {
    const result = await callEdgeFunction<{
      ok: boolean;
      swim: number; bike: number; run: number; totalSec: number;
      swimM: number; bikeKm: number; runKm: number;
    }>('sync-strava-activities', {
      mode: 'getTriLaps',
      stravaActivityId,
    });
    if (!result.ok || !result.swim) return null;
    return result;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Form read helpers
// ──────────────────────────────────────────────────────────────────────────

function getSelectedDistance(): PastTriathlonDistance | null {
  const active = document.querySelector<HTMLButtonElement>('[data-dist].active');
  return (active?.getAttribute('data-dist') as PastTriathlonDistance) ?? null;
}

function readTotalSec(): number | null {
  const h = parseInt((document.getElementById('tpr-h') as HTMLInputElement)?.value ?? '', 10);
  const m = parseInt((document.getElementById('tpr-m') as HTMLInputElement)?.value ?? '', 10);
  const s = parseInt((document.getElementById('tpr-s') as HTMLInputElement)?.value ?? '', 10);
  const total = (isNaN(h) ? 0 : h) * 3600 + (isNaN(m) ? 0 : m) * 60 + (isNaN(s) ? 0 : s);
  return total > 0 ? total : null;
}

function buildEntry(): TriPastRaceEntry | null {
  const distance = getSelectedDistance();
  const dateISO  = (document.getElementById('tpr-date') as HTMLInputElement)?.value;
  const totalSec = readTotalSec();
  if (!distance || !dateISO || !totalSec) return null;

  const hasLegs = (document.getElementById('tpr-has-legs') as HTMLInputElement)?.checked;
  let perLeg: TriPastRaceEntry['perLeg'];
  if (hasLegs) {
    const swim = parseLegTime((document.getElementById('tpr-swim') as HTMLInputElement)?.value ?? '', false);
    const bike = parseLegTime((document.getElementById('tpr-bike') as HTMLInputElement)?.value ?? '', true);
    const run  = parseLegTime((document.getElementById('tpr-run')  as HTMLInputElement)?.value ?? '', true);
    if (swim && bike && run) perLeg = { swim, bike, run };
  }

  return { distance, dateISO, totalSec, perLeg, source: 'manual' };
}

// ──────────────────────────────────────────────────────────────────────────
// Pre-fill from a candidate (fills all form fields)
// ──────────────────────────────────────────────────────────────────────────

function prefillFromCandidate(c: RaceCandidate, source: 'manual' | 'strava' = 'strava'): void {
  // Distance pill
  document.querySelectorAll<HTMLButtonElement>('[data-dist]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-dist') === c.distance);
  });
  // Date (month field)
  const dateEl = document.getElementById('tpr-date') as HTMLInputElement;
  if (dateEl) dateEl.value = c.dateISO.slice(0, 7);
  // Total time
  (document.getElementById('tpr-h') as HTMLInputElement).value = String(Math.floor(c.totalSec / 3600));
  (document.getElementById('tpr-m') as HTMLInputElement).value = String(Math.floor((c.totalSec % 3600) / 60));
  (document.getElementById('tpr-s') as HTMLInputElement).value = String(c.totalSec % 60);
  updateTotalHint();

  // Per-leg splits (if we have them)
  if (c.swimSec != null && c.bikeSec != null && c.runSec != null) {
    const toggle = document.getElementById('tpr-has-legs') as HTMLInputElement;
    if (toggle && !toggle.checked) { toggle.checked = true; toggle.dispatchEvent(new Event('change')); }
    (document.getElementById('tpr-swim') as HTMLInputElement).value = fmtLegTime(c.swimSec, false);
    (document.getElementById('tpr-bike') as HTMLInputElement).value = fmtLegTime(c.bikeSec, true);
    (document.getElementById('tpr-run')  as HTMLInputElement).value = fmtLegTime(c.runSec,  true);
    updateLegsHint();
  }

  // Mark candidate selected visually
  document.querySelectorAll<HTMLElement>('[data-cand-idx]').forEach(el => el.classList.remove('selected'));
  const btn = document.querySelector<HTMLElement>(`[data-cand-date="${c.dateISO}"]`);
  if (btn) btn.classList.add('selected');

  // Save source attribution
  void source;
}

function updateTotalHint(): void {
  const sec = readTotalSec();
  const hint = document.getElementById('tpr-total-hint') as HTMLElement;
  if (!hint) return;
  if (sec && sec > 0) { hint.textContent = fmtLongTime(sec); hint.style.display = 'block'; }
  else hint.style.display = 'none';
}

function updateLegsHint(): void {
  const swim = parseLegTime((document.getElementById('tpr-swim') as HTMLInputElement)?.value ?? '', false);
  const bike = parseLegTime((document.getElementById('tpr-bike') as HTMLInputElement)?.value ?? '', true);
  const run  = parseLegTime((document.getElementById('tpr-run')  as HTMLInputElement)?.value ?? '', true);
  const hint = document.getElementById('tpr-legs-hint') as HTMLElement;
  if (!hint) return;
  if (swim && bike && run) {
    hint.textContent = `Swim ${fmtLegTime(swim, false)} · Bike ${fmtLegTime(bike, true)} · Run ${fmtLegTime(run, true)}`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Render candidates list
// ──────────────────────────────────────────────────────────────────────────

function renderCandidates(candidates: RaceCandidate[]): void {
  const el = document.getElementById('tpr-candidates');
  if (!el) return;
  if (candidates.length === 0) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = candidates.map((c, idx) => {
    const legLine = c.source === 'separate' && c.swimSec != null
      ? `Swim ${fmtLegTime(c.swimSec!, false)} · Bike ${fmtLegTime(c.bikeSec!, true)} · Run ${fmtLegTime(c.runSec!, true)}`
      : `Total: ${fmtLongTime(c.totalSec)}`;

    const sourceLabel = c.source === 'multisport'
      ? `<span style="font-size:10px;opacity:0.55;margin-left:6px">multi-sport recording</span>`
      : `<span style="font-size:10px;opacity:0.55;margin-left:6px">separate activities</span>`;

    const loadBtn = c.source === 'multisport' && c.stravaId
      ? `<button class="tpr-load-btn" data-strava-id="${c.stravaId}" data-cand-idx="${idx}">Load splits from Strava</button>`
      : c.source === 'multisport' && !c.stravaId
      ? `<div style="font-size:10px;color:var(--c-faint);margin-top:6px">Garmin-only — enter splits manually</div>`
      : '';  // separate: splits already populated

    return `
      <button class="tpr-candidate" data-cand-idx="${idx}" data-cand-date="${c.dateISO}" style="flex-direction:column;align-items:stretch">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <span style="font-size:14px;font-weight:500">${distLabel(c.distance)} · ${formatDateDisplay(c.dateISO)}</span>
            ${sourceLabel}
          </div>
          <span style="font-size:12px;opacity:0.55;flex-shrink:0">Select</span>
        </div>
        <div style="font-size:12px;opacity:0.65;margin-top:3px">${legLine}</div>
        ${loadBtn}
      </button>
    `;
  }).join('');

  // Wire select (clicking the card body)
  el.querySelectorAll<HTMLButtonElement>('[data-cand-idx]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      // Don't trigger if clicking the inner load-btn
      if ((e.target as HTMLElement).closest('.tpr-load-btn')) return;
      const idx = parseInt(btn.getAttribute('data-cand-idx') ?? '0', 10);
      const c = candidates[idx];
      if (!c) return;
      prefillFromCandidate(c);
    });
  });

  // Wire "Load splits from Strava" buttons for multisport candidates
  el.querySelectorAll<HTMLButtonElement>('.tpr-load-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const stravaId = btn.getAttribute('data-strava-id');
      const idx = parseInt(btn.getAttribute('data-cand-idx') ?? '0', 10);
      const c = candidates[idx];
      if (!stravaId || !c) return;

      btn.disabled = true;
      btn.textContent = 'Loading…';

      const laps = await fetchTriLaps(stravaId);
      if (!laps) {
        btn.textContent = 'Failed — enter splits manually';
        btn.disabled = false;
        return;
      }

      // Update candidate in place with fetched leg times
      candidates[idx] = {
        ...c,
        swimSec: laps.swim,
        bikeSec: laps.bike,
        runSec:  laps.run,
        distance: guessDistance(laps.swimM),
        source:  'multisport',
      };

      btn.textContent = 'Splits loaded';
      btn.disabled = true;

      // Pre-fill form from updated candidate
      prefillFromCandidate(candidates[idx], 'strava');
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Wire all handlers
// ──────────────────────────────────────────────────────────────────────────

function wireHandlers(): void {
  // Has-race toggle
  const hasRaceToggle = document.getElementById('tpr-has-race') as HTMLInputElement;
  const form = document.getElementById('tri-race-form') as HTMLElement;
  hasRaceToggle?.addEventListener('change', () => {
    form.style.display = hasRaceToggle.checked ? 'block' : 'none';
    if (!hasRaceToggle.checked) updateOnboarding({ triPastRace: null });
  });

  // Distance pills
  document.querySelectorAll<HTMLButtonElement>('[data-dist]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLButtonElement>('[data-dist]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Total time → live hint
  ['tpr-h', 'tpr-m', 'tpr-s'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateTotalHint);
  });

  // Per-leg toggle
  const hasLegsToggle = document.getElementById('tpr-has-legs') as HTMLInputElement;
  const legsPanel     = document.getElementById('tpr-legs') as HTMLElement;
  const legsCaption   = document.getElementById('tpr-legs-caption') as HTMLElement;
  hasLegsToggle?.addEventListener('change', () => {
    legsPanel.style.display   = hasLegsToggle.checked ? 'block' : 'none';
    if (legsCaption) legsCaption.style.display = hasLegsToggle.checked ? 'none' : 'block';
  });

  // Per-leg time inputs → live summary hint
  ['tpr-swim', 'tpr-bike', 'tpr-run'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateLegsHint);
  });

  // Strava scan button
  const stravaBtn  = document.getElementById('tpr-strava-btn') as HTMLButtonElement;
  const scanHint   = document.getElementById('tpr-scan-hint') as HTMLElement;

  stravaBtn?.addEventListener('click', async () => {
    stravaBtn.disabled = true;
    stravaBtn.textContent = 'Scanning…';

    try {
      const candidates = await scanStravaForRaces();
      stravaBtn.style.display = 'none';

      if (candidates.length === 0) {
        if (scanHint) scanHint.textContent = 'No race days found in the past year. Enter details manually below.';
      } else {
        if (scanHint) scanHint.textContent = `Found ${candidates.length} candidate${candidates.length > 1 ? 's' : ''}. Select one to pre-fill, then adjust if needed.`;
        renderCandidates(candidates);
      }
    } catch {
      if (scanHint) scanHint.textContent = 'Scan failed — enter details manually below.';
      stravaBtn.textContent = 'Retry scan';
      stravaBtn.disabled = false;
    }
  });

  // Continue
  document.getElementById('tpr-continue')?.addEventListener('click', () => {
    const hasRace = (document.getElementById('tpr-has-race') as HTMLInputElement)?.checked;
    if (!hasRace) {
      updateOnboarding({ triPastRace: null });
      nextStep();
      return;
    }
    const entry = buildEntry();
    if (!entry) {
      // Flash the missing section
      const missing = !getSelectedDistance()
        ? document.querySelector<HTMLElement>('[data-dist]')?.closest('.tri-card') as HTMLElement
        : !(document.getElementById('tpr-date') as HTMLInputElement)?.value
        ? document.getElementById('tpr-date')?.closest('.tri-card') as HTMLElement
        : document.getElementById('tpr-h')?.closest('.tri-card') as HTMLElement;
      if (missing) {
        missing.style.borderColor = 'rgba(0,0,0,0.3)';
        setTimeout(() => { missing.style.borderColor = ''; }, 1500);
      }
      return;
    }
    updateOnboarding({ triPastRace: entry });
    nextStep();
  });
}

function getCurrentOnboarding(): OnboardingState {
  return getState().onboarding as OnboardingState;
}
void getCurrentOnboarding;
