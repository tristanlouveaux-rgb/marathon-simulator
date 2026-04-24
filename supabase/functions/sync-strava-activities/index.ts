/**
 * sync-strava-activities
 * ======================
 * Three modes (set via body.mode):
 *
 * - standalone (default): Fetch Strava activities + HR streams, upsert into
 *   garmin_activities, return GarminActivityRow[] for matchAndAutoComplete().
 *
 * - history: Aggregate garmin_activities from the past N weeks (default 8)
 *   into HistorySummaryRow[] for the Training tab sparkline + Stats PMC chart.
 *   No Strava API call — uses what's already in the DB. (Phase C1)
 *
 * Strava is always the activity source when connected — regardless of whether
 * the user also has a Garmin wearable. The Garmin/Apple wearable is used
 * separately for biometrics (VO2max, LT, HRV, sleep) via sync-physiology-snapshot.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// iTRIMP calculation (inlined — no imports in Deno edge)
// ---------------------------------------------------------------------------

function calculateITrimp(
  hrSamples: number[],
  timeSamples: number[],
  restingHR: number,
  maxHR: number,
  sex?: "male" | "female",
): number {
  const beta = sex === "female" ? 1.67 : 1.92;
  const hrRange = maxHR - restingHR;
  if (hrRange <= 0) return 0;
  let trimp = 0;
  for (let i = 1; i < hrSamples.length; i++) {
    const hr = hrSamples[i];
    if (hr <= restingHR) continue;
    const dt = timeSamples[i] - timeSamples[i - 1];
    if (dt <= 0) continue;
    const hrr = (hr - restingHR) / hrRange;
    trimp += dt * hrr * Math.exp(beta * hrr);
  }
  return trimp;
}

function calculateITrimpFromSummary(
  avgHR: number,
  durationSec: number,
  restingHR: number,
  maxHR: number,
  sex?: "male" | "female",
): number {
  const beta = sex === "female" ? 1.67 : 1.92;
  const hrRange = maxHR - restingHR;
  if (hrRange <= 0 || avgHR <= restingHR) return 0;
  const hrr = (avgHR - restingHR) / hrRange;
  return durationSec * hrr * Math.exp(beta * hrr);
}

// ---------------------------------------------------------------------------
// HR zone computation (% of MaxHR — matches Garmin's default scheme)
// ---------------------------------------------------------------------------

interface HRZones { z1: number; z2: number; z3: number; z4: number; z5: number; }

function calculateHRZones(
  hrSamples: number[],
  timeSamples: number[],
  maxHR: number,
): HRZones {
  const zones: HRZones = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  if (maxHR <= 0 || hrSamples.length < 2) return zones;
  for (let i = 1; i < hrSamples.length; i++) {
    const dt = timeSamples[i] - timeSamples[i - 1];
    if (dt <= 0) continue;
    const pct = hrSamples[i] / maxHR;
    if      (pct < 0.60) zones.z1 += dt;
    else if (pct < 0.70) zones.z2 += dt;
    else if (pct < 0.80) zones.z3 += dt;
    else if (pct < 0.90) zones.z4 += dt;
    else                  zones.z5 += dt;
  }
  return zones;
}

// ---------------------------------------------------------------------------
// Km splits (runs only — uses moving stream to exclude pauses)
// ---------------------------------------------------------------------------

function calculateKmSplits(
  distanceSamples: number[],
  timeSamples: number[],
  movingSamples?: boolean[],
): number[] {
  if (distanceSamples.length < 2) return [];
  const totalM = distanceSamples[distanceSamples.length - 1];
  if (totalM < 1000) return [];

  const movingTime: number[] = new Array(timeSamples.length).fill(0);
  for (let i = 1; i < timeSamples.length; i++) {
    const dt = timeSamples[i] - timeSamples[i - 1];
    const isMoving = !movingSamples || movingSamples[i - 1];
    movingTime[i] = movingTime[i - 1] + (isMoving ? dt : 0);
  }

  const splits: number[] = [];
  const numKm = Math.floor(totalM / 1000);

  for (let km = 1; km <= numKm; km++) {
    const targetM = km * 1000;
    const prevTargetM = (km - 1) * 1000;

    let hiIdx = 1;
    while (hiIdx < distanceSamples.length - 1 && distanceSamples[hiIdx] < targetM) hiIdx++;
    const loIdx = hiIdx - 1;

    const dDist = distanceSamples[hiIdx] - distanceSamples[loIdx];
    const mtAtTarget = dDist > 0
      ? movingTime[loIdx] + (targetM - distanceSamples[loIdx]) / dDist * (movingTime[hiIdx] - movingTime[loIdx])
      : movingTime[hiIdx];

    let mtAtPrev = 0;
    if (km > 1) {
      let prevIdx = loIdx;
      while (prevIdx > 0 && distanceSamples[prevIdx] > prevTargetM) prevIdx--;
      const hiPrev = Math.min(prevIdx + 1, distanceSamples.length - 1);
      const dDistPrev = distanceSamples[hiPrev] - distanceSamples[prevIdx];
      mtAtPrev = dDistPrev > 0
        ? movingTime[prevIdx] + (prevTargetM - distanceSamples[prevIdx]) / dDistPrev * (movingTime[hiPrev] - movingTime[prevIdx])
        : movingTime[hiPrev];
    }

    const paceSecKm = mtAtTarget - mtAtPrev;
    if (paceSecKm > 0) splits.push(Math.round(paceSecKm));
  }
  return splits;
}

/**
 * Compute HR drift from raw HR + time arrays.
 * drift% = (avgHR_2nd_half - avgHR_1st_half) / avgHR_1st_half × 100
 * Strips first 10% (warmup). Requires ≥20 min of HR data.
 * Only meaningful for steady-state runs (easy, long, marathon pace).
 */
function calculateHRDrift(
  hrData: number[],
  timeData: number[],
): number | null {
  if (!hrData || !timeData || hrData.length < 120 || hrData.length !== timeData.length) return null;
  const totalSec = timeData[timeData.length - 1] - timeData[0];
  if (totalSec < 1200) return null; // < 20 min
  const startIdx = Math.floor(hrData.length * 0.10);
  const valid: number[] = [];
  for (let i = startIdx; i < hrData.length; i++) {
    if (hrData[i] > 0) valid.push(hrData[i]);
  }
  if (valid.length < 60) return null;
  const mid = Math.floor(valid.length / 2);
  const avgFirst = valid.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const avgSecond = valid.slice(mid).reduce((a, b) => a + b, 0) / (valid.length - mid);
  if (avgFirst <= 0) return null;
  return Math.round(((avgSecond - avgFirst) / avgFirst) * 1000) / 10; // one decimal
}

/** Steady-state run types where HR drift is meaningful */
const DRIFT_TYPES = new Set(["RUNNING", "TREADMILL_RUNNING", "TRAIL_RUNNING", "VIRTUAL_RUN", "TRACK_RUNNING"]);

/**
 * Fetch ambient temperature at the activity's start time and location from
 * Open-Meteo (free, no API key). Returns null if lat/lng missing or fetch fails.
 * Uses the archive endpoint for activities ≥ 6 days old (where archive data is
 * final); otherwise uses the forecast endpoint with `past_days` for recent runs.
 * Treadmill runs are intentionally still called — indoor temp is usually fine
 * at ambient, but the value will be the outdoor reading at the Strava-reported
 * location, so callers should prefer to skip indoor types.
 */
async function fetchAmbientTemp(
  startDateIso: string,
  lat: number,
  lng: number,
): Promise<number | null> {
  try {
    const startMs = new Date(startDateIso).getTime();
    const ageDays = (Date.now() - startMs) / 86_400_000;
    const date = startDateIso.slice(0, 10); // YYYY-MM-DD
    const targetHour = new Date(startDateIso).getUTCHours();

    const base = ageDays >= 6
      ? `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&start_date=${date}&end_date=${date}&hourly=temperature_2m&timezone=UTC`
      : `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=temperature_2m&past_days=7&timezone=UTC`;

    const res = await fetch(base);
    if (!res.ok) return null;
    const json = await res.json() as { hourly?: { time?: string[]; temperature_2m?: (number | null)[] } };
    const times = json.hourly?.time;
    const temps = json.hourly?.temperature_2m;
    if (!times || !temps || times.length === 0) return null;

    // Match by exact ISO hour prefix, e.g. "2026-04-17T09:00"
    const targetPrefix = `${date}T${String(targetHour).padStart(2, "0")}:00`;
    const idx = times.findIndex((t) => t.startsWith(targetPrefix));
    if (idx === -1) return null;
    const t = temps[idx];
    return typeof t === "number" ? Math.round(t * 10) / 10 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function refreshStravaToken(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  refreshToken: string,
  stravaClientId: string,
  stravaClientSecret: string,
): Promise<string> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: stravaClientId,
      client_secret: stravaClientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`);
  const json = await res.json();
  const newAccessToken: string = json.access_token;
  await supabase.from("strava_tokens").update({
    access_token: newAccessToken,
    refresh_token: json.refresh_token ?? refreshToken,
    expires_at: json.expires_at ? new Date(json.expires_at * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);
  return newAccessToken;
}

// ---------------------------------------------------------------------------
// Strava API helper
// ---------------------------------------------------------------------------

async function stravaGet(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { "Authorization": `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Strava API ${path} failed: ${res.status}`);
  return res.json();
}

// Map Strava activity type → Garmin-compatible activity_type string
// Strava has two fields: sport_type (specific, newer) and type (generic, older).
// We prefer sport_type as it gives HIIT, TrailRun, etc. rather than the catch-all "Workout".
function mapStravaType(stravaType: string): string {
  const t = stravaType.toLowerCase();
  // Running
  if (t === "run" || t === "virtualrun" || t === "trailrun" || t === "treadmill") return "RUNNING";
  // Cycling
  if (t === "ride" || t === "virtualride" || t === "ebikeride" || t === "gravelride" || t === "emountainbikeride" || t === "velomobile" || t === "handcycle" || t === "rollerski") return "CYCLING";
  if (t === "mountainbikeride") return "MOUNTAIN_BIKING";
  // Swimming
  if (t === "swim") return "SWIMMING";
  // Walking / hiking
  if (t === "walk" || t === "hike" || t === "snowshoe") return "WALKING";
  // Strength
  if (t === "weighttraining" || t === "crossfit") return "STRENGTH_TRAINING";
  // HIIT / indoor cardio
  if (t === "hiit" || t === "highintensityintervaltraining") return "HIIT";
  if (t === "elliptical" || t === "stairstepper" || t === "iceskate" || t === "inlineskate") return "INDOOR_CARDIO";
  // Yoga / Pilates
  if (t === "yoga") return "YOGA";
  if (t === "pilates") return "PILATES";
  // Racket sports
  if (t === "tennis" || t === "squash" || t === "badminton" || t === "tabletennis" || t === "racquetball") return "TENNIS";
  if (t === "pickleball") return "PICKLEBALL";
  // Team sports
  if (t === "soccer" || t === "football") return "SOCCER";
  if (t === "rugby") return "RUGBY";
  // Rowing / paddle
  if (t === "rowing" || t === "indoorrowing" || t === "virtualrow" || t === "canoeing") return "ROWING";
  if (t === "standuppaddling") return "PADDLEBOARDING";
  if (t === "kayaking") return "KAYAKING";
  // Combat sports
  if (t === "boxing" || t === "kickboxing") return "BOXING";
  // Climbing
  if (t === "rockclimbing") return "ROCK_CLIMBING";
  // Golf
  if (t === "golf") return "GOLF";
  // Wheelchair
  if (t === "wheelchair") return "WHEELCHAIR_PUSH_WALK";
  // Skiing / snow — differentiate backcountry/nordic (aerobic) from alpine/snowboard (less aerobic)
  if (t === "backcountryski") return "BACKCOUNTRY_SKIING";
  if (t === "nordicski") return "NORDIC_SKIING";
  if (t === "alpineski" || t === "snowboard") return "ALPINE_SKIING";
  // Water / other outdoor — map to generic cardio
  if (t === "sail" || t === "surfing" || t === "windsurf" || t === "kitesurf" || t === "skateboard") return "CARDIO";
  // "Workout" is Strava's old catch-all type
  if (t === "workout") return "CARDIO";
  return stravaType.toUpperCase();
}

// ---------------------------------------------------------------------------
// History aggregation helpers (Phase C1)
// ---------------------------------------------------------------------------

interface HistorySummaryRow {
  weekStart: string;       // ISO date of Monday  e.g. "2026-02-17"
  totalTSS: number;        // Signal A — running-equivalent TSS (with runSpec discount)
  rawTSS: number;          // Signal B — raw physiological TSS (no runSpec discount)
  runningKm: number;       // km from running activities only
  zoneBase: number;        // Estimated base (Z1+Z2) TSS
  zoneThreshold: number;   // Estimated threshold (Z3) TSS
  zoneIntensity: number;   // Estimated intensity (Z4+Z5) TSS
  sportBreakdown: { sport: string; durationMin: number; tss: number; rawTSS: number; sessionCount: number }[];
}

/** ISO date string of the Monday of the week containing `date` (UTC). */
function getMondayISO(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = d.getUTCDay(); // 0=Sun
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  d.setUTCDate(d.getUTCDate() + daysToMonday);
  return d.toISOString().split("T")[0];
}

function isRunningActivity(actType: string): boolean {
  const t = actType.toUpperCase();
  return t === "RUNNING" || t.includes("RUN");
}

/** Simplified running-equivalent coefficient per activity type. Mirrors SPORTS_DB.runSpec. */
function getRunSpec(actType: string): number {
  const t = actType.toUpperCase();
  if (isRunningActivity(t)) return 1.0;
  // Skiing: backcountry/nordic is highly aerobic (close to running); alpine is less so
  if (t === "NORDIC_SKIING" || t === "BACKCOUNTRY_SKIING") return 0.75;
  if (t.includes("SKI") || t === "SNOWBOARD") return 0.55;
  if (t.includes("CYCLING") || t.includes("RIDE") || t === "MOUNTAIN_BIKING") return 0.55;
  if (t === "CARDIO") return 0.55; // catch-all Strava "Workout" / generic cardio
  if (t.includes("SWIMMING") || t.includes("SWIM")) return 0.20;
  if (t.includes("WALKING") || t.includes("HIKING") || t.includes("WALK")) return 0.40;
  if (t.includes("STRENGTH") || t.includes("WEIGHT")) return 0.30;
  if (t.includes("SOCCER") || t.includes("FOOTBALL")) return 0.40;
  if (t.includes("RUGBY")) return 0.35;
  if (t.includes("ROWING")) return 0.35;
  if (t.includes("YOGA") || t.includes("PILATES")) return 0.10;
  if (t.includes("TENNIS") || t.includes("SQUASH")) return 0.45;
  if (t.includes("BOXING") || t.includes("HIIT")) return 0.30;
  return 0.40;
}

/**
 * Duration-based TSS fallback (no HR data available).
 * Returns running-equivalent TSS directly — do NOT apply runSpec on top.
 * Values are per-minute rates: running ~0.70 TSS/min (42/hr moderate effort).
 */
function getDurationFallbackTSS(actType: string, durationMin: number): number {
  const t = actType.toUpperCase();
  if (isRunningActivity(t)) return durationMin * 0.70;
  if (t === "NORDIC_SKIING" || t === "BACKCOUNTRY_SKIING") return durationMin * 0.60;
  if (t.includes("SKI") || t === "SNOWBOARD") return durationMin * 0.45;
  if (t.includes("CYCLING") || t.includes("RIDE") || t === "MOUNTAIN_BIKING" || t === "CARDIO") return durationMin * 0.40;
  if (t.includes("WALKING") || t.includes("HIKING") || t.includes("WALK")) return durationMin * 0.35;
  if (t.includes("SWIMMING") || t.includes("SWIM")) return durationMin * 0.15;
  if (t.includes("STRENGTH") || t.includes("WEIGHT")) return durationMin * 0.20;
  if (t.includes("ROWING")) return durationMin * 0.35;
  if (t.includes("BOXING") || t.includes("HIIT")) return durationMin * 0.35;
  return durationMin * 0.35; // generic cardio fallback
}

/**
 * Signal B duration fallback — raw physiological load with NO runSpec discount.
 * Represents cardiovascular + systemic stress regardless of running specificity.
 * Used when iTRIMP is null; rates are per-minute physiological effort.
 */
function getRawFallbackTSS(actType: string, durationMin: number): number {
  const t = actType.toUpperCase();
  if (isRunningActivity(t)) return durationMin * 0.70;            // same as Signal A (rs=1.0)
  if (t.includes("HIIT") || t.includes("BOXING") || t.includes("KICKBOX")) return durationMin * 0.65;
  if (t === "NORDIC_SKIING" || t === "BACKCOUNTRY_SKIING") return durationMin * 0.65;
  if (t.includes("CYCLING") || t.includes("RIDE") || t === "MOUNTAIN_BIKING") return durationMin * 0.60;
  if (t.includes("SOCCER") || t.includes("FOOTBALL") || t.includes("RUGBY")) return durationMin * 0.60;
  if (t.includes("TENNIS") || t.includes("SQUASH") || t.includes("BADMINTON") || t.includes("PADEL") || t.includes("PICKLE")) return durationMin * 0.55;
  if (t.includes("SWIMMING") || t.includes("SWIM")) return durationMin * 0.55;
  if (t.includes("ROWING")) return durationMin * 0.55;
  if (t === "CARDIO" || t.includes("ALPINE_SKI") || t.includes("SNOWBOARD")) return durationMin * 0.50;
  if (t.includes("STRENGTH") || t.includes("WEIGHT")) return durationMin * 0.45;
  if (t.includes("WALKING") || t.includes("HIKING") || t.includes("WALK")) return durationMin * 0.30;
  if (t.includes("YOGA") || t.includes("PILATES")) return durationMin * 0.15;
  return durationMin * 0.50; // generic cardio fallback
}

/**
 * Extract power fields from a Strava activity (ride, virtual ride, etc.).
 * Returns nulls across the board when the activity has no power data, which
 * is the vast majority of non-ride activities. We write the result
 * regardless — the columns default to null for activities without power.
 *
 * Strava fields (docs):
 *   - average_watts: avg power across the activity (null if no power data)
 *   - weighted_average_watts: normalized power (NP), only set on rides
 *     with sufficient sample density
 *   - max_watts: peak 1-second power
 *   - device_watts: true = from a power meter, false = estimated by Strava
 *     (estimated values should not drive FTP — we still store them but the
 *     client can choose to ignore)
 *   - kilojoules: total energy expenditure
 */
function extractPowerFields(act: Record<string, unknown> | null | undefined): {
  average_watts: number | null;
  normalized_power: number | null;
  max_watts: number | null;
  device_watts: boolean | null;
  kilojoules: number | null;
} {
  const allNull = { average_watts: null, normalized_power: null, max_watts: null, device_watts: null, kilojoules: null };
  if (!act || typeof act !== 'object') return allNull;
  try {
    const avg = (act["average_watts"] as number | null | undefined);
    const np = (act["weighted_average_watts"] as number | null | undefined);
    const mx = (act["max_watts"] as number | null | undefined);
    const dev = (act["device_watts"] as boolean | null | undefined);
    const kj = (act["kilojoules"] as number | null | undefined);
    return {
      average_watts:    typeof avg === 'number' && isFinite(avg) && avg > 0 ? Math.round(avg * 10) / 10 : null,
      normalized_power: typeof np  === 'number' && isFinite(np)  && np  > 0 ? Math.round(np  * 10) / 10 : null,
      max_watts:        typeof mx  === 'number' && isFinite(mx)  && mx  > 0 ? Math.round(mx) : null,
      device_watts:     typeof dev === 'boolean' ? dev : null,
      kilojoules:       typeof kj  === 'number' && isFinite(kj)  && kj  > 0 ? Math.round(kj * 10) / 10 : null,
    };
  } catch (e) {
    console.warn('[extractPowerFields] failed, returning nulls:', e);
    return allNull;
  }
}

/** Normalise activity_type to a clean sport label for the breakdown. */
function getSportLabel(actType: string): string {
  const t = actType.toUpperCase();
  if (isRunningActivity(t)) return "running";
  if (t.includes("CYCLING") || t.includes("RIDE") || t === "MOUNTAIN_BIKING") return "cycling";
  if (t.includes("SWIMMING") || t.includes("SWIM")) return "swimming";
  if (t.includes("WALKING") || t.includes("HIKING") || t.includes("WALK")) return "walking";
  if (t.includes("SKI") || t === "SNOWBOARD") return "skiing";
  if (t.includes("STRENGTH") || t.includes("WEIGHT")) return "strength";
  if (t.includes("SOCCER") || t.includes("FOOTBALL")) return "soccer";
  if (t.includes("RUGBY")) return "rugby";
  if (t.includes("ROWING")) return "rowing";
  if (t.includes("YOGA")) return "yoga";
  if (t.includes("TENNIS") || t.includes("SQUASH")) return "tennis";
  if (t.includes("BOXING") || t.includes("HIIT")) return "hiit";
  return "other";
}

/**
 * Estimate zone distribution from TSS/hr.
 * Uses LOAD_PROFILES fractions from the client-side spec:
 *   easy      → base 0.90 / threshold 0.09 / intensity 0.01  (TSS/hr < 70)
 *   threshold → base 0.25 / threshold 0.60 / intensity 0.15  (70–95)
 *   vo2       → base 0.15 / threshold 0.35 / intensity 0.50  (> 95)
 */
function estimateZoneProfile(
  tss: number,
  durationMin: number,
): { base: number; threshold: number; intensity: number } {
  const tssPerHour = durationMin > 0 ? tss * (60 / durationMin) : 55;
  if (tssPerHour < 70) return { base: 0.90, threshold: 0.09, intensity: 0.01 };
  if (tssPerHour < 95) return { base: 0.25, threshold: 0.60, intensity: 0.15 };
  return { base: 0.15, threshold: 0.35, intensity: 0.50 };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stravaClientId = Deno.env.get("STRAVA_CLIENT_ID")!;
    const stravaClientSecret = Deno.env.get("STRAVA_CLIENT_SECRET")!;

    // Authenticate caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonError(401, { error: "missing_auth_header" });

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return jsonError(401, { error: "invalid_auth" });

    const body = await req.json().catch(() => ({}));
    const mode: "standalone" | "history" | "calibrate" | "backfill" =
      body.mode === "history" ? "history"
      : body.mode === "calibrate" ? "calibrate"
      : body.mode === "backfill" ? "backfill"
      : "standalone";
    const afterTimestamp: number = body.after_timestamp ?? Math.floor(Date.now() / 1000) - 28 * 86400;
    const biologicalSex: "male" | "female" | undefined =
      body.biological_sex === "male" || body.biological_sex === "female" ? body.biological_sex : undefined;
    const maxHROverride: number | null = typeof body.max_hr_override === 'number' && body.max_hr_override > 100 ? body.max_hr_override : null;

    const supabase = createClient(supabaseUrl, serviceKey);

    // -----------------------------------------------------------------------
    // HISTORY mode — aggregate garmin_activities into weekly TSS summaries.
    // No Strava API call needed; early-returns before token loading.
    // -----------------------------------------------------------------------
    if (mode === "history") {
      const weeksBack: number = typeof body.weeks === "number" ? Math.min(body.weeks, 52) : 8;
      const historyStart = new Date();
      historyStart.setUTCDate(historyStart.getUTCDate() - weeksBack * 7);

      const { data: actRows, error: actErr } = await supabase
        .from("garmin_activities")
        .select("activity_type, start_time, duration_sec, distance_m, itrimp, hr_zones")
        .eq("user_id", user.id)
        .gte("start_time", historyStart.toISOString())
        .order("start_time", { ascending: true });

      if (actErr) return jsonError(500, { error: "db_error", details: actErr.message });

      console.log(`[History] ${actRows?.length ?? 0} rows for user ${user.id.slice(0,8)} since ${historyStart.toISOString().split('T')[0]} (${weeksBack}w)`);

      // Deduplicate: Garmin webhook and Strava backfill can both store the same physical
      // activity with different garmin_id formats (numeric Garmin ID vs "strava-{id}").
      // Rows are sorted by start_time ascending — collapse rows within a 2-min window,
      // keeping the one with iTRIMP (Strava-processed, higher quality) over the fallback.
      const dedupedRows: typeof actRows = [];
      for (const row of actRows ?? []) {
        const startMs = new Date(row.start_time as string).getTime();
        const last = dedupedRows[dedupedRows.length - 1];
        if (last && startMs - new Date(last.start_time as string).getTime() < 2 * 60 * 1000) {
          // Same activity — prefer the row with iTRIMP (Strava-processed data)
          if ((row.itrimp ?? 0) > (last.itrimp ?? 0)) {
            dedupedRows[dedupedRows.length - 1] = row;
          }
        } else {
          dedupedRows.push(row);
        }
      }
      if (dedupedRows.length < (actRows?.length ?? 0)) {
        console.log(`[History] Deduped ${(actRows?.length ?? 0) - dedupedRows.length} duplicate rows (Garmin+Strava overlap)`);
      }

      const weekMap = new Map<string, HistorySummaryRow>();

      for (const row of dedupedRows) {
        const weekStart = getMondayISO(new Date(row.start_time as string));
        if (!weekMap.has(weekStart)) {
          weekMap.set(weekStart, {
            weekStart, totalTSS: 0, rawTSS: 0, runningKm: 0,
            zoneBase: 0, zoneThreshold: 0, zoneIntensity: 0, sportBreakdown: [],
          });
        }
        const week = weekMap.get(weekStart)!;
        const durationMin = ((row.duration_sec as number) ?? 0) / 60;
        const actType = (row.activity_type as string) ?? "";
        const isRun = isRunningActivity(actType);
        const rs = getRunSpec(actType);

        const iTrimpVal = (row.itrimp as number | null) ?? null;

        // Signal A (running-equivalent): iTRIMP × runSpec, or duration fallback already discounted
        const equivTSS = (iTrimpVal != null && iTrimpVal > 0)
          ? (iTrimpVal * 100) / 15000 * (isRun ? 1.0 : rs)
          : getDurationFallbackTSS(actType, durationMin);

        // Signal B (raw physiological): iTRIMP with NO runSpec discount, or raw duration fallback
        const rawTSSVal = (iTrimpVal != null && iTrimpVal > 0)
          ? (iTrimpVal * 100) / 15000
          : getRawFallbackTSS(actType, durationMin);

        week.totalTSS += equivTSS;
        week.rawTSS += rawTSSVal;
        if (isRun && row.distance_m) week.runningKm += (row.distance_m as number) / 1000;

        // Zone distribution: prefer actual HR zone data when available (activities that went through
        // full stream processing). Fall back to TSS-intensity estimate for avg-HR-only activities.
        // Using actual zones gives accurate anaerobic bars for HIIT, intervals, tempo runs.
        const storedZones = row.hr_zones as { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
        const storedZoneTotal = storedZones ? (storedZones.z1 + storedZones.z2 + storedZones.z3 + storedZones.z4 + storedZones.z5) : 0;
        let zp: { base: number; threshold: number; intensity: number };
        let zoneSrc: string;
        if (storedZoneTotal > 0) {
          // Real per-second HR zone data from the Strava stream
          zp = {
            base: (storedZones!.z1 + storedZones!.z2) / storedZoneTotal,
            threshold: storedZones!.z3 / storedZoneTotal,
            intensity: (storedZones!.z4 + storedZones!.z5) / storedZoneTotal,
          };
          zoneSrc = "hr";
        } else {
          // Use raw (pre-rs-discount) iTRIMP intensity for zone classification so high-intensity
          // cross-training (HIIT, Hyrox, climbing) correctly shows anaerobic zones even after
          // the running-equivalent rs discount reduces the total TSS contribution.
          const rawTssForZone = (iTrimpVal != null && iTrimpVal > 0)
            ? (iTrimpVal * 100) / 15000
            : equivTSS;
          zp = estimateZoneProfile(rawTssForZone, durationMin);
          zoneSrc = "est";
        }
        week.zoneBase += equivTSS * zp.base;
        week.zoneThreshold += equivTSS * zp.threshold;
        week.zoneIntensity += equivTSS * zp.intensity;

        // Per-activity debug log — helps diagnose missing weeks and wrong types
        console.log(`[History:row] ${(row.start_time as string).slice(0,10)} ${(actType||"?").padEnd(20)} ${Math.round(durationMin)}min iTRIMP=${iTrimpVal != null ? Math.round(iTrimpVal) : "null"} equivTSS=${Math.round(equivTSS)} zone=${zp.intensity > 0.15 ? "intensity" : zp.threshold > 0.4 ? "threshold" : "base"}(${zoneSrc})`);

        const sport = getSportLabel(actType);
        const existing = week.sportBreakdown.find((s) => s.sport === sport);
        if (existing) {
          existing.durationMin += durationMin;
          existing.tss += equivTSS;
          existing.rawTSS += rawTSSVal;
          existing.sessionCount += 1;
        } else {
          week.sportBreakdown.push({ sport, durationMin, tss: equivTSS, rawTSS: rawTSSVal, sessionCount: 1 });
        }
      }

      const result: HistorySummaryRow[] = Array.from(weekMap.values())
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
        .map((w) => ({
          ...w,
          totalTSS: Math.round(w.totalTSS),
          rawTSS: Math.round(w.rawTSS),
          runningKm: Math.round(w.runningKm * 10) / 10,
          zoneBase: Math.round(w.zoneBase),
          zoneThreshold: Math.round(w.zoneThreshold),
          zoneIntensity: Math.round(w.zoneIntensity),
          sportBreakdown: w.sportBreakdown.map((s) => ({
            ...s,
            durationMin: Math.round(s.durationMin),
            tss: Math.round(s.tss),
            rawTSS: Math.round(s.rawTSS),
          })),
        }));

      // Wrap in envelope so client can log diagnostic info
      return new Response(JSON.stringify({
        rows: result,
        _debug: { rowCount: actRows?.length ?? 0, historyStart: historyStart.toISOString(), weeksBack, userId: user.id.slice(0, 8) },
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // -----------------------------------------------------------------------
    // CALIBRATE mode — return individual labelled running activities so the
    // client can calibrate iTRIMP intensity thresholds from workout names.
    // No Strava API call; reads from garmin_activities where activity_name is set.
    // Returns: { name, durationMin, iTrimp }[] for running activities only.
    // -----------------------------------------------------------------------
    if (mode === "calibrate") {
      const weeksBack: number = typeof body.weeks === "number" ? Math.min(body.weeks, 52) : 12;
      const calibStart = new Date();
      calibStart.setUTCDate(calibStart.getUTCDate() - weeksBack * 7);

      const { data: calibRows, error: calibErr } = await supabase
        .from("garmin_activities")
        .select("activity_name, activity_type, duration_sec, itrimp")
        .eq("user_id", user.id)
        .gte("start_time", calibStart.toISOString())
        .not("activity_name", "is", null)
        .not("itrimp", "is", null)
        .order("start_time", { ascending: false });

      // activity_name column may not exist yet — return empty rather than 500
      if (calibErr) {
        console.warn("[Calibrate] Query failed (column may be missing):", calibErr.message);
        return new Response(JSON.stringify([]), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const labelled = (calibRows ?? [])
        .filter((r) => isRunningActivity((r.activity_type as string) ?? ""))
        .map((r) => ({
          name: r.activity_name as string,
          durationMin: Math.round(((r.duration_sec as number) ?? 0) / 60),
          iTrimp: r.itrimp as number,
        }))
        .filter((r) => r.durationMin >= 10 && r.iTrimp > 0);

      return new Response(JSON.stringify(labelled), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load Strava tokens
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("strava_tokens")
      .select("access_token, refresh_token, expires_at")
      .eq("user_id", user.id)
      .maybeSingle();

    if (tokenErr || !tokenRow) return jsonError(400, { error: "strava_not_connected" });

    // Refresh token if expired (60s buffer)
    let accessToken: string = tokenRow.access_token;
    if (tokenRow.expires_at) {
      const expiresMs = new Date(tokenRow.expires_at).getTime();
      if (Date.now() >= expiresMs - 60_000 && tokenRow.refresh_token) {
        accessToken = await refreshStravaToken(
          supabase, user.id, tokenRow.refresh_token, stravaClientId, stravaClientSecret,
        );
      }
    }

    // -----------------------------------------------------------------------
    // BACKFILL mode — fetch N weeks of Strava activity history, upsert with
    // HR-based iTRIMP. Full HR stream for most-recent ≤99 uncached activities,
    // avg_heartrate estimate for the remainder.
    // -----------------------------------------------------------------------
    if (mode === "backfill") {
      // Cap at 156w (3y) so onboarding can scan far enough to pick up older PBs.
      // STREAM_BUDGET=99 already limits HR-stream fetches to the most-recent 99,
      // so older runs cost only best_efforts detail fetches (one per ≤ 300).
      const weeksBack: number = typeof body.weeks === "number" ? Math.min(body.weeks, 156) : 16;
      const afterTs = Math.floor(Date.now() / 1000) - weeksBack * 7 * 86400;

      // 1. Fetch full activity list from Strava (paginated, per_page=200).
      // 429 mid-pagination is tolerable: we proceed with whatever pages we got
      // and let the subsequent session fill the gap. Throwing 500 here forces a
      // full reset on every reload and wastes user time.
      const allActivities: Array<Record<string, unknown>> = [];
      let page = 1;
      let listTruncatedBy429 = false;
      while (true) {
        try {
          const batch = await stravaGet(
            `/athlete/activities?per_page=200&after=${afterTs}&page=${page}`,
            accessToken,
          ) as Array<Record<string, unknown>>;
          if (!Array.isArray(batch) || batch.length === 0) break;
          allActivities.push(...batch);
          if (batch.length < 200) break;
          page++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("429")) {
            console.warn(`[Backfill] list fetch 429 on page ${page}, proceeding with ${allActivities.length} activities`);
            listTruncatedBy429 = true;
            break;
          }
          throw err;
        }
      }

      if (allActivities.length === 0) {
        // List fetch returned nothing (likely 429 on page 1, or all already in DB with no new ones).
        // Still try to heal best_efforts for historical running rows — onboarding PB auto-fill
        // depends on this and would otherwise be blocked forever once list calls are rate-limited.
        const { data: dbRuns } = await supabase
          .from("garmin_activities")
          .select("garmin_id, activity_type, duration_sec, distance_m, best_efforts")
          .eq("user_id", user.id);
        const dbRunningNeedsBE = (dbRuns ?? []).filter((r) =>
          r.best_efforts == null
          && (r.activity_type === "RUNNING" || r.activity_type === "TRAIL_RUNNING")
          && (r.distance_m as number) > 0
          && (r.duration_sec as number) > 0
        );
        function dbPaceSecPerKm(r: Record<string, unknown>): number {
          const d = (r.distance_m as number) ?? 0;
          const t = (r.duration_sec as number) ?? 0;
          if (d <= 0 || t <= 0) return Infinity;
          return (t / d) * 1000;
        }
        function dbPickBand(minM: number, maxM: number, take: number): Array<Record<string, unknown>> {
          return dbRunningNeedsBE
            .filter((r) => {
              const d = (r.distance_m as number) ?? 0;
              return d >= minM && d < maxM;
            })
            .sort((a, b) => dbPaceSecPerKm(a) - dbPaceSecPerKm(b))
            .slice(0, take);
        }
        const dbBandSelections = [
          ...dbPickBand(4000,  8000,  12),
          ...dbPickBand(8000,  15000, 12),
          ...dbPickBand(18000, 28000, 12),
          ...dbPickBand(40000, Infinity, 8),
        ];
        const seenDB = new Set<string>();
        const dbCandidates = dbBandSelections.filter((r) => {
          const gid = r.garmin_id as string;
          if (seenDB.has(gid)) return false;
          seenDB.add(gid);
          return true;
        });
        let dbHealed = 0;
        let dbTruncatedBy429 = false;
        for (const r of dbCandidates) {
          const garminId = r.garmin_id as string;
          const stravaId = Number(garminId.replace("strava-", ""));
          if (!stravaId) continue;
          try {
            const detail = await stravaGet(`/activities/${stravaId}`, accessToken) as Record<string, unknown>;
            const be = Array.isArray(detail.best_efforts) ? detail.best_efforts : null;
            const payload = be ?? [];
            const { error: beErr } = await supabase.from("garmin_activities")
              .update({ best_efforts: payload })
              .eq("garmin_id", garminId).eq("user_id", user.id);
            if (!beErr) dbHealed++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("429")) dbTruncatedBy429 = true;
            break;
          }
        }
        console.log(
          `[Backfill] list empty — DB best_efforts heal: ${dbHealed}/${dbCandidates.length}` +
          ` (pool: ${dbRunningNeedsBE.length} running rows without best_efforts${dbTruncatedBy429 ? ", truncated by 429" : ""})`,
        );
        return new Response(
          JSON.stringify({
            processed: 0, withHRStream: 0, withAvgHR: 0, hasHRMonitor: false, runs: [],
            bestEffortsHealed: dbHealed,
            bestEffortsCandidates: dbCandidates.length,
            bestEffortsPool: dbRunningNeedsBE.length,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // 2. Check which are already fully processed (hr_zones present in DB)
      const allGarminIds = allActivities.map((a) => `strava-${a.id as number}`);
      const { data: cachedRows } = await supabase
        .from("garmin_activities")
        .select("garmin_id, hr_zones, itrimp, calories, hr_drift, ambient_temp_c, activity_type, best_efforts")
        .eq("user_id", user.id)
        .in("garmin_id", allGarminIds);

      const cachedWithZones = new Set<string>();
      const cachedBasic = new Set<string>();
      const cachedWithITrimp = new Set<string>();
      const cachedCalories = new Map<string, number>();
      const cachedNeedsDriftHeal = new Set<string>(); // cached-with-zones running activities with null hr_drift
      const cachedNeedsTempOnly = new Set<string>();  // drift already present but ambient_temp_c is null
      const cachedWithBestEfforts = new Set<string>(); // RUNNING activities already carrying best_efforts — skip detail re-fetch
      for (const r of (cachedRows ?? [])) {
        if (r.calories != null && r.calories > 0) cachedCalories.set(r.garmin_id, r.calories);
        if (r.best_efforts != null) cachedWithBestEfforts.add(r.garmin_id);
        // Only treat as "fully cached" if hr_zones has actual non-zero zone data.
        // Activities stored with all-zero zones ({z1:0,...}) had no HR data at first sync
        // and should be re-attempted so they can get iTRIMP from avg_heartrate.
        const zones = r.hr_zones as { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
        const hasRealZones = zones && (zones.z1 + zones.z2 + zones.z3 + zones.z4 + zones.z5 > 0);
        if (hasRealZones) {
          cachedWithZones.add(r.garmin_id);
          const isDriftType = DRIFT_TYPES.has(r.activity_type as string);
          const isNotTreadmill = r.activity_type !== "TREADMILL_RUNNING";
          if (r.hr_drift == null && isDriftType) {
            cachedNeedsDriftHeal.add(r.garmin_id);
          } else if (r.hr_drift != null && r.ambient_temp_c == null && isDriftType && isNotTreadmill) {
            cachedNeedsTempOnly.add(r.garmin_id);
          }
        } else {
          cachedBasic.add(r.garmin_id);
        }
        if (r.itrimp) cachedWithITrimp.add(r.garmin_id);
      }

      // Log per-week breakdown of what Strava API returned — compare with history to find gaps
      const stravaWeekCounts = new Map<string, number>();
      for (const act of allActivities) {
        const wk = getMondayISO(new Date(act.start_date as string));
        stravaWeekCounts.set(wk, (stravaWeekCounts.get(wk) ?? 0) + 1);
      }
      for (const [wk, count] of [...stravaWeekCounts.entries()].sort()) {
        console.log(`[Backfill:strava] Week ${wk}: ${count} activities`);
      }
      console.log(`[Backfill] Strava has ${allActivities.length} activities in ${weeksBack}w. DB has ${cachedWithZones.size} with real zones + ${cachedBasic.size} basic (${cachedBasic.size - [...cachedBasic].filter(g => cachedWithITrimp.has(g)).length} without iTRIMP).`);

      // 3. Does the athlete use a HR monitor?
      const hasHRMonitor = allActivities.some(
        (a) => (a["average_heartrate"] as number | null) != null,
      );

      // 4. Load physiology for iTRIMP.
      // maxHR: 95th percentile of all activity max HRs — robust against wrist-sensor spikes.
      // Top-N approaches still catch outliers; percentile across the full distribution is safer.
      const [{ data: physioRow2 }, { data: bfMaxHRRows }] = await Promise.all([
        supabase
          .from("daily_metrics")
          .select("resting_hr, max_hr")
          .eq("user_id", user.id)
          .order("day_date", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("garmin_activities")
          .select("max_hr")
          .eq("user_id", user.id)
          .not("max_hr", "is", null),
      ]);
      const bfRestingHR: number = physioRow2?.resting_hr ?? 55;
      let bfMaxHR: number;
      if (maxHROverride) {
        bfMaxHR = maxHROverride;
        console.log(`[Backfill] Using client max HR override: ${bfMaxHR}`);
      } else {
        const allHRs = (bfMaxHRRows ?? []).map((r: any) => r.max_hr as number).filter((v: number) => v > 0);
        if (allHRs.length >= 5) {
          allHRs.sort((a: number, b: number) => a - b);
          const p95Idx = Math.floor(allHRs.length * 0.95);
          bfMaxHR = allHRs[Math.min(p95Idx, allHRs.length - 1)];
          console.log(`[Backfill] Max HR from p95 of ${allHRs.length} activities: ${bfMaxHR}`);
        } else if (allHRs.length > 0) {
          allHRs.sort((a: number, b: number) => a - b);
          bfMaxHR = allHRs[Math.floor(allHRs.length / 2)]; // median for small samples
        } else {
          bfMaxHR = (physioRow2?.max_hr) ?? 190;
        }
      }

      // 5. Partition uncached activities: full stream (recent ≤99) vs avg HR
      const sorted = [...allActivities].sort(
        (a, b) => new Date(b.start_date as string).getTime() - new Date(a.start_date as string).getTime(),
      );

      const STREAM_BUDGET = 99;
      let streamCount = 0;
      const needFullStream: Array<Record<string, unknown>> = [];
      const needAvgHR: Array<Record<string, unknown>> = [];

      for (const act of sorted) {
        const gid = `strava-${act.id as number}`;
        if (cachedWithZones.has(gid)) continue; // already fully processed
        const hasAvgHR = (act["average_heartrate"] as number | null) != null;
        if (hasHRMonitor && hasAvgHR && streamCount < STREAM_BUDGET) {
          needFullStream.push(act);
          streamCount++;
        } else {
          needAvgHR.push(act);
        }
      }

      let withHRStream = 0;
      let withAvgHR = 0;
      const upsertErrors: string[] = []; // Collect first few errors for client-side diagnosis

      // 6. Process activities needing full HR stream (one-by-one to respect rate limits)
      for (const act of needFullStream) {
        const stravaId = act.id as number;
        const garminId = `strava-${stravaId}`;
        const actType = mapStravaType((act.sport_type as string) || (act.type as string) || "");
        const isRun = actType === "RUNNING";
        const durSec = (act.elapsed_time as number) ?? 0;
        const movingTimeSec = (act.moving_time as number | null) ?? null;
        const distM = (act.distance as number | null) ?? null;
        const avgHR = (act["average_heartrate"] as number | null) ?? null;
        const maxHRVal = (act["max_heartrate"] as number | null) ?? null;
        const actName = (act.name as string | null) ?? null;
        const elevGainM = (act["total_elevation_gain"] as number | null) ?? null;
        let iTrimp: number | null = null;
        let hrZones: HRZones | null = null;
        let kmSplits: number[] = [];
        let hrDrift: number | null = null;
        let avgPace: number | null = null;
        let bestEfforts: unknown = null;
        // Use moving_time for pace (matches Strava's displayed pace which excludes pauses)
        const paceTimeSec = (movingTimeSec && movingTimeSec > 0) ? movingTimeSec : durSec;
        if (distM && distM > 0 && paceTimeSec > 0) avgPace = Math.round((paceTimeSec / distM) * 1000);

        try {
          const streamKeys = isRun ? "heartrate,time,distance,moving" : "heartrate,time";
          const streamData = await stravaGet(
            `/activities/${stravaId}/streams?keys=${streamKeys}&key_by_type=true`,
            accessToken,
          ) as Record<string, { data: number[] | boolean[] }>;

          const hrData = streamData?.heartrate?.data as number[] | undefined;
          const timeData = streamData?.time?.data as number[] | undefined;
          const distData = streamData?.distance?.data as number[] | undefined;
          const movingData = streamData?.moving?.data as boolean[] | undefined;

          if (hrData && timeData && hrData.length > 1 && hrData.length === timeData.length) {
            iTrimp = calculateITrimp(hrData, timeData, bfRestingHR, bfMaxHR, biologicalSex);
            hrZones = calculateHRZones(hrData, timeData, bfMaxHR);
            // HR drift only for steady-state runs ≥ 20 min
            if (DRIFT_TYPES.has(actType)) {
              hrDrift = calculateHRDrift(hrData, timeData);
            }
          } else if (avgHR && durSec > 0) {
            iTrimp = calculateITrimpFromSummary(avgHR, durSec, bfRestingHR, bfMaxHR, biologicalSex);
          }
          if (isRun && distData && timeData && distData.length === timeData.length) {
            kmSplits = calculateKmSplits(distData, timeData as number[], movingData as boolean[] | undefined);
          }
          // Fetch detail for calories + run splits (already doing per-activity calls)
          if (isRun || (act["calories"] as number | null) == null) {
            try {
              const detail = await stravaGet(`/activities/${stravaId}`, accessToken) as Record<string, unknown>;
              if ((act["calories"] as number | null) == null && detail.calories != null) {
                (act as any).calories = detail.calories;
              }
              if (isRun && kmSplits.length === 0) {
                const sm = detail.splits_metric as Array<{ moving_time: number; distance: number }> | null;
                if (sm?.length) {
                  kmSplits = sm.filter(s => s.distance > 10).map(s => Math.round((s.moving_time / s.distance) * 1000));
                }
              }
              // Capture best_efforts for running activities only (Strava only emits these on runs).
              // Stored as-is so the client can pick its own canonical distances later.
              if (isRun && Array.isArray(detail.best_efforts)) {
                bestEfforts = detail.best_efforts;
              }
            } catch { /* ignore */ }
          }
        } catch {
          if (avgHR && durSec > 0) {
            iTrimp = calculateITrimpFromSummary(avgHR, durSec, bfRestingHR, bfMaxHR, biologicalSex);
          }
        }

        // Ambient temperature — only fetch when drift was computed (steady-state run)
        // and Strava returned a start location. Outdoor types only.
        let ambientTempC: number | null = null;
        if (hrDrift != null && actType !== "TREADMILL_RUNNING") {
          const latlng = act["start_latlng"] as [number, number] | null | undefined;
          if (latlng && latlng.length === 2 && latlng[0] !== 0) {
            ambientTempC = await fetchAmbientTemp(act.start_date as string, latlng[0], latlng[1]);
          }
        }

        const bfCalories = (act["calories"] as number | null) ?? cachedCalories.get(garminId) ?? null;
        const powerFields = extractPowerFields(act);
        const { error: upsertErr } = await supabase.from("garmin_activities").upsert({
          user_id: user.id, garmin_id: garminId, source: "strava",
          activity_type: actType, start_time: act.start_date as string,
          duration_sec: durSec,
          distance_m: distM != null ? Math.round(distM) : null,
          avg_pace_sec_km: avgPace,
          avg_hr: avgHR != null ? Math.round(avgHR) : null,
          max_hr: maxHRVal != null ? Math.round(maxHRVal) : null,
          calories: bfCalories,
          aerobic_effect: null, anaerobic_effect: null,
          itrimp: iTrimp != null && iTrimp > 0 ? iTrimp : null,
          // Store null (not all-zero object) when no HR data so activity re-enters cachedBasic
          // on next backfill and can be reprocessed if avg_heartrate becomes available.
          hr_zones: hrZones && (hrZones.z1 + hrZones.z2 + hrZones.z3 + hrZones.z4 + hrZones.z5 > 0) ? hrZones : null,
          km_splits: kmSplits.length > 0 ? kmSplits : null,
          hr_drift: hrDrift,
          ambient_temp_c: ambientTempC,
          activity_name: actName,
          elevation_gain_m: elevGainM,
          best_efforts: bestEfforts,
          ...powerFields,
        }, { onConflict: "garmin_id" });
        if (upsertErr) {
          console.error(`[Backfill] HR-stream upsert failed for ${garminId}:`, upsertErr.message);
          if (upsertErrors.length < 3) upsertErrors.push(`${garminId}: ${upsertErr.message}`);
        } else {
          withHRStream++;
        }
      }

      // 5c. Fetch best_efforts for running activities that still lack them.
      // Onboarding-critical: the review page auto-fills 5K / 10K / half / marathon
      // PBs from this data. Strava's rate limit is ~100 req / 15 min.
      //
      // Strategy: bucket candidates by distance band, then rank within each
      // band by pace (ascending). A PB for distance D can only live in a run
      // ≥D long, but in practice the fastest 5K isn't in your 30 km long run
      // — it's in your standalone 5K race. Pace-sort per band surfaces those.
      //
      // Budget per band gives first-pass coverage across all four PB distances
      // even under rate-limit pressure. Remaining activities roll in on
      // subsequent launches via the "needs best_efforts" filter.
      const runningUnfetched = sorted.filter((act) => {
        const gid = `strava-${act.id as number}`;
        if (cachedWithBestEfforts.has(gid)) return false;
        const actType = mapStravaType((act.sport_type as string) || (act.type as string) || "");
        return actType === "RUNNING";
      });

      function paceSecPerKm(act: Record<string, unknown>): number {
        const dist = (act.distance as number) ?? 0;
        const mov = (act.moving_time as number) ?? (act.elapsed_time as number) ?? 0;
        if (dist <= 0 || mov <= 0) return Infinity;
        return (mov / dist) * 1000;
      }

      function pickBand(minM: number, maxM: number, take: number): Array<Record<string, unknown>> {
        return runningUnfetched
          .filter((a) => {
            const d = (a.distance as number) ?? 0;
            return d >= minM && d < maxM;
          })
          .sort((a, b) => paceSecPerKm(a) - paceSecPerKm(b))
          .slice(0, take);
      }

      // Take fastest-per-band; marathons grab all (rare & always a candidate).
      const bandSelections = [
        ...pickBand(4000,  8000,  12), // 5K PB lives in runs ~4–8 km
        ...pickBand(8000,  15000, 12), // 10K PB
        ...pickBand(18000, 28000, 12), // Half PB
        ...pickBand(40000, Infinity, 8), // Marathon PB
      ];
      // Dedupe (an activity only falls in one band anyway, but defensive).
      const seen = new Set<number>();
      const bestEffortsCandidates = bandSelections.filter((a) => {
        const id = a.id as number;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      let bestEffortsHealed = 0;
      let bestEffortsTruncatedBy429 = false;
      for (const act of bestEffortsCandidates) {
        const stravaId = act.id as number;
        const garminId = `strava-${stravaId}`;
        try {
          const detail = await stravaGet(`/activities/${stravaId}`, accessToken) as Record<string, unknown>;
          const be = Array.isArray(detail.best_efforts) ? detail.best_efforts : null;
          // Update with the array when present, or an empty array when the run truly has none —
          // empty `[]` still satisfies `best_efforts IS NOT NULL` so we don't re-fetch next time.
          const payload = be ?? [];
          const { error: beErr } = await supabase.from("garmin_activities").update({ best_efforts: payload })
            .eq("garmin_id", garminId).eq("user_id", user.id);
          if (beErr) {
            console.warn(`[Backfill] best_efforts update failed for ${garminId}:`, beErr.message);
          } else {
            bestEffortsHealed++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("429")) bestEffortsTruncatedBy429 = true;
          break; // stop on rate limit / network error
        }
      }
      console.log(
        `[Backfill] best_efforts: fetched ${bestEffortsHealed}/${bestEffortsCandidates.length} candidates` +
        ` (already cached: ${cachedWithBestEfforts.size}${bestEffortsTruncatedBy429 ? ", truncated by 429" : ""})`,
      );

      // 5d. Power backfill — Strava returns power fields (average_watts,
      // weighted_average_watts, max_watts, device_watts, kilojoules) on
      // every ride in the activities LIST response itself; no detail
      // fetch needed. Walks every cycling activity the user has and patches
      // the new power columns so FTP derivation sees a real power curve
      // immediately. Uses per-row UPDATE rather than upsert so we don't
      // touch any other column (iTRIMP / zones / etc).
      let powerHealed = 0;
      let powerAttempted = 0;
      let powerDebugLogged = 0;
      try {
        for (const act of allActivities) {
          const stravaId = act?.id as number | undefined;
          if (stravaId == null) continue;
          const garminId = `strava-${stravaId}`;
          const actType = mapStravaType((act?.sport_type as string) || (act?.type as string) || "");
          if (actType !== "CYCLING" && actType !== "MOUNTAIN_BIKING") continue;
          const power = extractPowerFields(act);
          // Log the raw power fields of the first 3 rides so we can see what
          // Strava actually returned. Drop this log once FTP derivation is
          // confirmed working for the user.
          if (powerDebugLogged < 3) {
            console.log(`[Power debug] ${garminId}: raw avg=${act?.average_watts} np=${act?.weighted_average_watts} max=${act?.max_watts} dev=${act?.device_watts} kj=${act?.kilojoules} → extracted=${JSON.stringify(power)}`);
            powerDebugLogged++;
          }
          if (
            power.average_watts == null &&
            power.normalized_power == null &&
            power.max_watts == null &&
            power.device_watts == null &&
            power.kilojoules == null
          ) continue;
          powerAttempted++;
          try {
            const { error: powErr } = await supabase.from("garmin_activities")
              .update(power)
              .eq("garmin_id", garminId)
              .eq("user_id", user.id);
            if (powErr) {
              console.warn(`[Backfill] Power update failed for ${garminId}:`, powErr.message);
              continue;
            }
            powerHealed++;
          } catch (inner) {
            console.warn(`[Backfill] Power update threw for ${garminId}:`, inner);
          }
        }
      } catch (outer) {
        console.warn('[Backfill] Power heal loop aborted:', outer);
      }
      console.log(`[Backfill] Power heal: attempted=${powerAttempted} patched=${powerHealed} (out of ${allActivities.length} activities)`);

      // 6b. Heal hr_drift on cached-with-zones running activities that pre-date the column.
      // Budget: 20 per run to stay well under Strava's rate limits (we already spent up to
      // STREAM_BUDGET=99 on needFullStream). Prioritise most-recent first so the durability
      // chart fills in from the present backwards. Also fetches ambient_temp_c alongside.
      const DRIFT_HEAL_BUDGET = 20;
      const driftHealCandidates = sorted
        .filter((act) => cachedNeedsDriftHeal.has(`strava-${act.id as number}`))
        .slice(0, DRIFT_HEAL_BUDGET);
      let driftHealed = 0;
      for (const act of driftHealCandidates) {
        const stravaId = act.id as number;
        const garminId = `strava-${stravaId}`;
        try {
          const streamData = await stravaGet(
            `/activities/${stravaId}/streams?keys=heartrate,time&key_by_type=true`,
            accessToken,
          ) as Record<string, { data: number[] }>;
          const hrData = streamData?.heartrate?.data;
          const timeData = streamData?.time?.data;
          if (hrData && timeData && hrData.length > 1 && hrData.length === timeData.length) {
            const drift = calculateHRDrift(hrData, timeData);
            if (drift != null) {
              const actType = mapStravaType((act.sport_type as string) || (act.type as string) || "");
              let ambientTempC: number | null = null;
              if (actType !== "TREADMILL_RUNNING") {
                const latlng = act["start_latlng"] as [number, number] | null | undefined;
                if (latlng && latlng.length === 2 && latlng[0] !== 0) {
                  ambientTempC = await fetchAmbientTemp(act.start_date as string, latlng[0], latlng[1]);
                }
              }
              await supabase.from("garmin_activities").update({ hr_drift: drift, ambient_temp_c: ambientTempC })
                .eq("garmin_id", garminId).eq("user_id", user.id);
              driftHealed++;
            }
          }
        } catch {
          break; // stop on rate limit
        }
      }
      if (driftHealed > 0) console.log(`[Backfill] Healed hr_drift for ${driftHealed} cached running activities`);

      // 6c. Heal ambient_temp_c for rows that already have drift but pre-date the temp column.
      // No HR stream fetch needed — only the weather API call, which is free (Open-Meteo).
      const TEMP_HEAL_BUDGET = 30;
      const tempHealCandidates = sorted
        .filter((act) => cachedNeedsTempOnly.has(`strava-${act.id as number}`))
        .slice(0, TEMP_HEAL_BUDGET);
      let tempHealed = 0;
      for (const act of tempHealCandidates) {
        const stravaId = act.id as number;
        const garminId = `strava-${stravaId}`;
        const latlng = act["start_latlng"] as [number, number] | null | undefined;
        if (!latlng || latlng.length !== 2 || latlng[0] === 0) continue;
        const ambientTempC = await fetchAmbientTemp(act.start_date as string, latlng[0], latlng[1]);
        if (ambientTempC == null) continue;
        await supabase.from("garmin_activities").update({ ambient_temp_c: ambientTempC })
          .eq("garmin_id", garminId).eq("user_id", user.id);
        tempHealed++;
      }
      if (tempHealed > 0) console.log(`[Backfill] Healed ambient_temp_c for ${tempHealed} cached running activities`);

      // 7. Batch-upsert activities using avg HR only (no stream needed)
      const avgHRBatch: Record<string, unknown>[] = [];
      for (const act of needAvgHR) {
        const garminId = `strava-${act.id as number}`;
        if (cachedBasic.has(garminId) && cachedWithITrimp.has(garminId)) continue; // already stored with iTRIMP
        const actType = mapStravaType((act.sport_type as string) || (act.type as string) || "");
        const durSec = (act.elapsed_time as number) ?? 0;
        const movingTimeSec2 = (act.moving_time as number | null) ?? null;
        const distM = (act.distance as number | null) ?? null;
        const avgHR = (act["average_heartrate"] as number | null) ?? null;
        const actName = (act.name as string | null) ?? null;
        let iTrimp: number | null = null;
        if (avgHR && durSec > 0) {
          iTrimp = calculateITrimpFromSummary(avgHR, durSec, bfRestingHR, bfMaxHR, biologicalSex);
        }
        let avgPace: number | null = null;
        // Use moving_time for pace (matches Strava's displayed pace which excludes pauses)
        const paceTimeSec2 = (movingTimeSec2 && movingTimeSec2 > 0) ? movingTimeSec2 : durSec;
        if (distM && distM > 0 && paceTimeSec2 > 0) avgPace = Math.round((paceTimeSec2 / distM) * 1000);

        avgHRBatch.push({
          user_id: user.id, garmin_id: garminId, source: "strava",
          activity_type: actType, start_time: act.start_date as string,
          duration_sec: durSec,
          distance_m: distM != null ? Math.round(distM) : null,
          avg_pace_sec_km: avgPace,
          avg_hr: avgHR != null ? Math.round(avgHR) : null,
          max_hr: (act["max_heartrate"] as number | null) != null ? Math.round((act["max_heartrate"] as number)) : null,
          calories: (act["calories"] as number | null) ?? cachedCalories.get(garminId) ?? null,
          aerobic_effect: null, anaerobic_effect: null,
          itrimp: iTrimp != null && iTrimp > 0 ? iTrimp : null,
          hr_zones: null, km_splits: null,
          activity_name: actName,
          elevation_gain_m: (act["total_elevation_gain"] as number | null) ?? null,
          ...extractPowerFields(act),
        });
        withAvgHR++;
      }
      if (avgHRBatch.length > 0) {
        const { error: batchErr } = await supabase.from("garmin_activities").upsert(avgHRBatch, { onConflict: "garmin_id" });
        if (batchErr) console.error("[Backfill] Avg-HR batch upsert failed:", batchErr.message);
      }

      // 7b. Heal missing calories for avg-HR batch activities via detail endpoint (capped at 15)
      const missingCalAvgHR = needAvgHR.filter(a => (a["calories"] as number | null) == null);
      let calHealed = 0;
      for (const act of missingCalAvgHR) {
        if (calHealed >= 15) break;
        const stravaId = act.id as number;
        try {
          const detail = await stravaGet(`/activities/${stravaId}`, accessToken) as Record<string, unknown>;
          if (detail.calories != null) {
            await supabase.from("garmin_activities").update({ calories: detail.calories as number })
              .eq("garmin_id", `strava-${stravaId}`).eq("user_id", user.id);
            calHealed++;
          }
        } catch { break; } // stop on rate limit
      }
      if (calHealed > 0) console.log(`[Backfill] Healed calories for ${calHealed} avg-HR activities via detail endpoint`);

      // 8. Force-update activity_type + activity_name for ALL activities.
      // This fixes stale types stored by old edge fn versions (e.g. CARDIO instead of BACKCOUNTRY_SKIING).
      // Runs in batches of 100 to avoid payload limits; only touches these two fields on existing rows.
      const typeFixBatch = allActivities.map((act) => ({
        user_id: user.id,
        garmin_id: `strava-${act.id as number}`,
        source: "strava",
        activity_type: mapStravaType((act.sport_type as string) || (act.type as string) || ""),
        activity_name: (act.name as string | null) ?? null,
      }));
      for (let i = 0; i < typeFixBatch.length; i += 100) {
        const chunk = typeFixBatch.slice(i, i + 100);
        const { error: fixErr } = await supabase.from("garmin_activities").upsert(chunk, { onConflict: "garmin_id" });
        if (fixErr) console.warn("[Backfill] Type-fix upsert failed:", fixErr.message);
      }
      console.log(`[Backfill] Updated activity_type for ${typeFixBatch.length} activities`);

      console.log(`[Backfill] ${withHRStream} HR stream + ${withAvgHR} avg HR — ${allActivities.length} total activities, hasHRMonitor=${hasHRMonitor}`);
      // Include per-week Strava breakdown in response so client can log it (server logs not visible in browser)
      const stravaWeeksObj: Record<string, number> = {};
      for (const [wk, count] of stravaWeekCounts.entries()) stravaWeeksObj[wk] = count;

      // Compact per-activity run summary so the client can seed `computePredictionInputs`
      // (Tanda 2011) immediately after onboarding, without a second DB round-trip.
      // Only includes RUNNING-mapped activities; client applies its own 2 km / pace filters.
      const runs = allActivities
        .map((act: Record<string, unknown>) => ({
          startTime: act.start_date as string,
          distKm: ((act.distance as number | null) ?? 0) / 1000,
          durSec: ((act.moving_time as number | null) ?? (act.elapsed_time as number | null) ?? 0),
          activityType: mapStravaType((act.sport_type as string) || (act.type as string) || ""),
          activityName: (act.name as string | null) ?? undefined,
        }))
        .filter((r) => r.activityType === "RUNNING" && r.distKm > 0 && r.durSec > 0);

      return new Response(
        JSON.stringify({
          processed: withHRStream + withAvgHR, withHRStream, withAvgHR, hasHRMonitor,
          stravaWeeks: stravaWeeksObj, totalStravaActivities: allActivities.length,
          runs,
          _debug: {
            cachedWithZones: cachedWithZones.size, cachedBasic: cachedBasic.size, cachedWithITrimp: cachedWithITrimp.size,
            needFullStream: needFullStream.length, needAvgHR: needAvgHR.length,
            upsertErrors,
          },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch Strava activities
    const activities = await stravaGet(
      `/athlete/activities?per_page=50&after=${afterTimestamp}`,
      accessToken,
    ) as Array<Record<string, unknown>>;

    if (!Array.isArray(activities) || activities.length === 0) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load physiology context for iTRIMP.
    // maxHR: robust estimate — median of top 5 activity max HRs (filters wrist-sensor spikes).
    const [{ data: physioRow }, { data: maxHRRows }] = await Promise.all([
      supabase
        .from("daily_metrics")
        .select("resting_hr, max_hr")
        .eq("user_id", user.id)
        .order("day_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("garmin_activities")
        .select("max_hr")
        .eq("user_id", user.id)
        .not("max_hr", "is", null)
        .order("max_hr", { ascending: false })
        .limit(5),
    ]);

    const restingHR: number = physioRow?.resting_hr ?? 55;
    let maxHR: number;
    if (maxHROverride) {
      maxHR = maxHROverride;
      console.log(`[Standalone] Using client max HR override: ${maxHR}`);
    } else {
      const allHRsStandalone = (maxHRRows ?? []).map((r: any) => r.max_hr as number).filter((v: number) => v > 0);
      if (allHRsStandalone.length >= 5) {
        allHRsStandalone.sort((a: number, b: number) => a - b);
        const p95Idx = Math.floor(allHRsStandalone.length * 0.95);
        maxHR = allHRsStandalone[Math.min(p95Idx, allHRsStandalone.length - 1)];
      } else if (allHRsStandalone.length > 0) {
        allHRsStandalone.sort((a: number, b: number) => a - b);
        maxHR = allHRsStandalone[Math.floor(allHRsStandalone.length / 2)];
      } else {
        maxHR = (physioRow?.max_hr) ?? 190;
      }
    }

    // Load cached HR zones + km splits from DB for all activities in this batch.
    // This avoids re-fetching Strava streams for activities already processed —
    // Strava rate-limits at 100 req/15 min, so fetching 50 streams every sync burns
    // the quota and causes later activities to silently lose zone data.
    const garminIds = activities.map((a) => `strava-${a.id as number}`);
    const { data: cachedRows } = await supabase
      .from("garmin_activities")
      .select("garmin_id, itrimp, hr_zones, km_splits, calories, hr_drift, ambient_temp_c")
      .eq("user_id", user.id)
      .in("garmin_id", garminIds);

    const cachedMap = new Map<string, { itrimp: number | null; hr_zones: HRZones | null; km_splits: number[] | null; calories: number | null; hr_drift: number | null; ambient_temp_c: number | null }>();
    for (const r of (cachedRows ?? [])) {
      cachedMap.set(r.garmin_id, {
        itrimp: r.itrimp ?? null,
        hr_zones: r.hr_zones ?? null,
        km_splits: r.km_splits ?? null,
        calories: r.calories ?? null,
        hr_drift: r.hr_drift ?? null,
        ambient_temp_c: r.ambient_temp_c ?? null,
      });
    }

    // Also look up calories from Garmin webhook rows (different garmin_id, same start_time).
    // Garmin webhooks often have calories when Strava doesn't.
    const startTimes = activities.map((a) => a.start_date as string);
    const { data: garminCalRows } = await supabase
      .from("garmin_activities")
      .select("start_time, calories")
      .eq("user_id", user.id)
      .not("garmin_id", "like", "strava-%")
      .in("start_time", startTimes)
      .not("calories", "is", null)
      .gt("calories", 0);
    const garminCalByTime = new Map<string, number>();
    for (const r of (garminCalRows ?? [])) {
      garminCalByTime.set(r.start_time, r.calories);
    }

    // Process each activity: use cached stream data when available; fetch fresh otherwise.
    const rows: Record<string, unknown>[] = [];
    let calHealCount = 0; // cap detail fetches for cached activities missing calories

    for (const act of activities) {
      const stravaId = act.id as number;
      const garminId = `strava-${stravaId}`;
      const startTime = act.start_date as string;
      const durationSec = (act.elapsed_time as number) ?? 0;
      const distanceM = (act.distance as number | null) ?? null;
      const avgHR = (act["average_heartrate"] as number | null) ?? null;
      const maxHrVal = (act["max_heartrate"] as number | null) ?? null;
      // sport_type is Strava's newer, more specific field (e.g. "HIIT", "TrailRun").
      // Fall back to type (e.g. "Workout", "Run") for older activities / API versions.
      const stravaActivityType = (act.sport_type as string) || (act.type as string) || "";
      const activityType = mapStravaType(stravaActivityType);
      const activityName = (act.name as string | null) ?? null;
      const elevationGainM = (act["total_elevation_gain"] as number | null) ?? null;
      const isRun = activityType === "RUNNING";
      const mapObj = act.map as Record<string, unknown> | null;
      const polyline = (mapObj?.summary_polyline as string | null) ?? null;

      let iTrimp: number | null = null;
      let hrZones: HRZones | null = null;
      let kmSplits: number[] = [];
      let hrDrift: number | null = null;
      let ambientTempC: number | null = null;
      let avgPaceSecKm: number | null = null;
      let needsUpsert = false; // only write to DB when we have new stream data

      // Distance-based pace (Strava doesn't give avg pace directly).
      // Use moving_time (excludes pauses) to match the pace Strava displays.
      const movingTimeSec3 = (act.moving_time as number | null) ?? null;
      const paceTimeSec3 = (movingTimeSec3 && movingTimeSec3 > 0) ? movingTimeSec3 : durationSec;
      if (distanceM && distanceM > 0 && paceTimeSec3 > 0) {
        avgPaceSecKm = Math.round((paceTimeSec3 / distanceM) * 1000);
      }

      const cached = cachedMap.get(garminId);
      // Strava list endpoint often returns null calories; fall back to DB (strava row), then Garmin webhook row, then detail endpoint
      let calories = (act["calories"] as number | null) ?? cached?.calories ?? garminCalByTime.get(startTime) ?? null;

      if (cached?.hr_zones) {
        // Already processed — return cached zones without touching the Strava API
        iTrimp = cached.itrimp;
        hrZones = cached.hr_zones;
        kmSplits = cached.km_splits ?? [];
        hrDrift = cached.hr_drift ?? null;
        ambientTempC = cached.ambient_temp_c ?? null;
        // Heal: cached activity still missing calories — fetch detail endpoint once (capped at 10)
        if (calories == null && calHealCount < 10) {
          try {
            const detail = await stravaGet(`/activities/${stravaId}`, accessToken) as Record<string, unknown>;
            if (detail.calories != null) {
              calories = detail.calories as number;
              needsUpsert = true; // persist to DB
            }
            calHealCount++;
          } catch { /* ignore — likely rate limited */ }
        }
      } else {
        // First time seeing this activity (or zones were missing) — fetch stream
        needsUpsert = true;
        try {
          const streamKeys = isRun ? "heartrate,time,distance,moving" : "heartrate,time";
          const streamData = await stravaGet(
            `/activities/${stravaId}/streams?keys=${streamKeys}&key_by_type=true`,
            accessToken,
          ) as Record<string, { data: number[] | boolean[] }>;

          const hrData = streamData?.heartrate?.data as number[] | undefined;
          const timeData = streamData?.time?.data as number[] | undefined;
          const distData = streamData?.distance?.data as number[] | undefined;
          const movingData = streamData?.moving?.data as boolean[] | undefined;

          if (hrData && timeData && hrData.length > 1 && hrData.length === timeData.length) {
            iTrimp = calculateITrimp(hrData, timeData, restingHR, maxHR, biologicalSex);
            hrZones = calculateHRZones(hrData, timeData, maxHR);
            if (DRIFT_TYPES.has(activityType)) {
              hrDrift = calculateHRDrift(hrData, timeData);
              if (hrDrift != null && activityType !== "TREADMILL_RUNNING") {
                const latlng = act["start_latlng"] as [number, number] | null | undefined;
                if (latlng && latlng.length === 2 && latlng[0] !== 0) {
                  ambientTempC = await fetchAmbientTemp(startTime, latlng[0], latlng[1]);
                }
              }
            }
          } else if (avgHR && durationSec > 0) {
            iTrimp = calculateITrimpFromSummary(avgHR, durationSec, restingHR, maxHR, biologicalSex);
          }

          // Fetch detail endpoint: runs need splits_metric, all activities need calories
          // One call per new activity — cached activities skip this entire block
          if (isRun || calories == null) {
            try {
              const detail = await stravaGet(`/activities/${stravaId}`, accessToken) as Record<string, unknown>;
              if (calories == null && detail.calories != null) {
                calories = detail.calories as number;
              }
              if (isRun) {
                const sm = detail.splits_metric as Array<{ moving_time: number; distance: number }> | null;
                if (sm?.length) {
                  kmSplits = sm.filter(s => s.distance > 10).map(s => Math.round((s.moving_time / s.distance) * 1000));
                }
              }
            } catch { /* ignore — stream fallback below */ }
            // Fallback: compute from GPS streams if detail fetch failed or returned no splits
            if (isRun && kmSplits.length === 0 && distData && timeData && distData.length === timeData.length) {
              kmSplits = calculateKmSplits(distData, timeData as number[], movingData as boolean[] | undefined);
            }
          }
        } catch (streamErr: any) {
          console.error(`[Standalone] Stream fetch FAILED for ${garminId}:`, streamErr?.message ?? streamErr);
          if (avgHR && durationSec > 0) {
            iTrimp = calculateITrimpFromSummary(avgHR, durationSec, restingHR, maxHR, biologicalSex);
          }
        }
      }
      console.log(`[Standalone] ${garminId}: needsUpsert=${needsUpsert} iTrimp=${iTrimp?.toFixed(0) ?? 'null'} zones=${hrZones ? 'YES' : 'null'}`);

      // Cached runs with no km_splits: fetch from Strava detail and patch DB
      if (isRun && kmSplits.length === 0 && cached?.hr_zones) {
        try {
          const detail = await stravaGet(`/activities/${stravaId}`, accessToken) as Record<string, unknown>;
          const sm = detail.splits_metric as Array<{ moving_time: number; distance: number }> | null;
          if (sm?.length) {
            kmSplits = sm.filter(s => s.distance > 10).map(s => Math.round((s.moving_time / s.distance) * 1000));
            void supabase.from("garmin_activities")
              .update({ km_splits: kmSplits })
              .eq("garmin_id", garminId).eq("user_id", user.id);
          }
        } catch { /* ignore — splits will be absent this sync */ }
      }

      // Heal hr_drift for activities cached before the column existed:
      // hr_zones is set but hr_drift is NULL. Re-fetch the HR stream once and patch DB.
      // Also fetches ambient_temp_c alongside so heat correction applies to healed rows.
      if (cached?.hr_zones && cached.hr_drift == null && DRIFT_TYPES.has(activityType) && durationSec >= 1200) {
        try {
          const streamData = await stravaGet(
            `/activities/${stravaId}/streams?keys=heartrate,time&key_by_type=true`,
            accessToken,
          ) as Record<string, { data: number[] | boolean[] }>;
          const hrData = streamData?.heartrate?.data as number[] | undefined;
          const timeData = streamData?.time?.data as number[] | undefined;
          if (hrData && timeData && hrData.length > 1 && hrData.length === timeData.length) {
            hrDrift = calculateHRDrift(hrData, timeData);
            if (hrDrift != null) {
              if (activityType !== "TREADMILL_RUNNING") {
                const latlng = act["start_latlng"] as [number, number] | null | undefined;
                if (latlng && latlng.length === 2 && latlng[0] !== 0) {
                  ambientTempC = await fetchAmbientTemp(startTime, latlng[0], latlng[1]);
                }
              }
              void supabase.from("garmin_activities")
                .update({ hr_drift: hrDrift, ambient_temp_c: ambientTempC })
                .eq("garmin_id", garminId).eq("user_id", user.id);
            }
          }
        } catch { /* ignore — drift will be absent this sync */ }
      }

      // Upsert into garmin_activities — only write when we fetched fresh stream data
      if (needsUpsert) {
        const { error: standaloneErr } = await supabase.from("garmin_activities").upsert(
          {
            user_id: user.id,
            garmin_id: garminId,
            source: "strava",
            activity_type: activityType,
            start_time: startTime,
            duration_sec: durationSec,
            distance_m: distanceM != null ? Math.round(distanceM) : null,
            avg_pace_sec_km: avgPaceSecKm,
            avg_hr: avgHR != null ? Math.round(avgHR) : null,
            max_hr: maxHrVal != null ? Math.round(maxHrVal) : null,
            calories,
            aerobic_effect: null,
            anaerobic_effect: null,
            itrimp: iTrimp != null && iTrimp > 0 ? iTrimp : null,
            hr_zones: hrZones && (hrZones.z1 + hrZones.z2 + hrZones.z3 + hrZones.z4 + hrZones.z5 > 0) ? hrZones : null,
            km_splits: kmSplits.length > 0 ? kmSplits : null,
            hr_drift: hrDrift,
            ambient_temp_c: ambientTempC,
            activity_name: activityName,
            elevation_gain_m: elevationGainM,
            ...extractPowerFields(act),
          },
          { onConflict: "garmin_id" },
        );
        if (standaloneErr) console.error(`[Standalone] Upsert FAILED for ${garminId}:`, standaloneErr.message, standaloneErr.code, standaloneErr.details);
        else console.log(`[Standalone] Upsert OK for ${garminId}`);
      }

      const powerFields = extractPowerFields(act);
      rows.push({
        garmin_id: garminId,
        activity_type: activityType,
        start_time: startTime,
        duration_sec: durationSec,
        distance_m: distanceM != null ? Math.round(distanceM) : null,
        avg_pace_sec_km: avgPaceSecKm,
        avg_hr: avgHR,
        max_hr: maxHrVal,
        calories,
        aerobic_effect: null,
        anaerobic_effect: null,
        garmin_rpe: null,
        iTrimp: iTrimp != null && iTrimp > 0 ? iTrimp : null,
        hrZones: hrZones,
        kmSplits: kmSplits.length > 0 ? kmSplits : null,
        hrDrift: hrDrift,
        ambientTempC: ambientTempC,
        polyline,
        elevationGainM,
        averageWatts: powerFields.average_watts,
        normalizedPowerW: powerFields.normalized_power,
        maxWatts: powerFields.max_watts,
        deviceWatts: powerFields.device_watts,
        kilojoules: powerFields.kilojoules,
      });
    }

    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return jsonError(500, { error: String(e) });
  }
});
