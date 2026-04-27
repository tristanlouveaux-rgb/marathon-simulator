/**
 * Garmin Health API webhook receiver.
 *
 * Garmin pushes data to this endpoint after a user is registered via
 * garmin-auth-callback. The webhook URL is configured in the Garmin
 * Developer Portal (Health API → Application → Push Endpoints).
 *
 * Garmin sends POST requests with JSON arrays for different data types.
 * Each push includes a path segment identifying the type:
 *   /garmin-webhook/activities   → activity summaries
 *   /garmin-webhook/dailies      → daily metrics (HR, stress, steps)
 *   /garmin-webhook/sleeps       → sleep summaries
 *   /garmin-webhook/epochs       → 15-min epoch summaries (ignored)
 *   /garmin-webhook/bodyComps    → body composition (ignored)
 *
 * Alternatively, all data arrives at the root with a top-level key
 * indicating the type (activities, dailies, sleeps, etc.).
 *
 * Each payload item has a `userAccessToken` that maps to the
 * `oauth_token` in our `garmin_tokens` table, letting us resolve
 * the Supabase user_id.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  // Garmin sends GET to verify the endpoint exists
  if (req.method === "GET") {
    return new Response("ok", { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();

    // Log ALL top-level keys so we can see exactly what Garmin pushes
    console.log(`[garmin-webhook] Received keys: ${Object.keys(body).join(', ')}`);

    // Garmin sends data as arrays under typed keys
    if (body.activities) {
      await handleActivities(supabase, body.activities);
    }
    if (body.dailies) {
      await handleDailies(supabase, body.dailies);
    }
    if (body.sleeps) {
      await handleSleeps(supabase, body.sleeps);
    }
    if (body.activityDetails) {
      await handleActivityDetails(supabase, body.activityDetails);
    }
    if (body.userMetrics) {
      await handleUserMetrics(supabase, body.userMetrics);
    }
    if (body.hrv) {
      await handleHrv(supabase, body.hrv);
    }
    if (body.hrvSummaries) {
      await handleHrv(supabase, body.hrvSummaries);
    }
    if (body.stressDetails) {
      await handleStressDetails(body.stressDetails);
    }
    if (body.deregistrations) {
      await handleDeregistrations(supabase, body.deregistrations);
    }
    if (body.userPermissions) {
      await handleUserPermissions(supabase, body.userPermissions);
    }

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("[garmin-webhook] Error:", e);
    // Always return 200 to Garmin to avoid retries on our processing errors
    return new Response("ok", { status: 200 });
  }
});

/**
 * Resolve a Garmin identifier to our Supabase user_id.
 *
 * Garmin webhook payloads include both:
 *   - userId        → stable Garmin user ID (stored in garmin_tokens.garmin_user_id by auth callback)
 *   - userAccessToken → OAuth access token (stored in garmin_tokens.access_token)
 *
 * We try garmin_user_id first (preferred — stable). If that fails (e.g. auth
 * callback's /user/id fetch silently errored and never stored it), we fall back
 * to matching by access_token so data is never silently dropped.
 */
async function resolveUserId(
  supabase: ReturnType<typeof createClient>,
  identifier: string,
): Promise<string | null> {
  console.log("[garmin-webhook] resolveUserId lookup:", identifier);

  // Primary: stable Garmin user ID
  const { data, error } = await supabase
    .from("garmin_tokens")
    .select("user_id")
    .eq("garmin_user_id", identifier)
    .limit(1);

  if (!error && data?.[0]) return data[0].user_id;

  // Fallback: OAuth access token (covers case where garmin_user_id was never stored)
  const { data: data2, error: err2 } = await supabase
    .from("garmin_tokens")
    .select("user_id")
    .eq("access_token", identifier)
    .limit(1);

  if (!err2 && data2?.[0]) {
    console.log("[garmin-webhook] resolveUserId matched via access_token fallback");
    return data2[0].user_id;
  }

  console.warn("[garmin-webhook] resolveUserId: no match for identifier");
  return null;
}

/**
 * Handle activity summary pushes.
 * Garmin schema: https://developer.garmin.com/gc-developer-program/activity-api/
 */
async function handleActivities(
  supabase: ReturnType<typeof createClient>,
  activities: any[],
) {
  for (const a of activities) {
    const userId = await resolveUserId(supabase, a.userId ?? a.userAccessToken);
    if (!userId) {
      console.warn("[garmin-webhook] Unknown userAccessToken for activity, skipping");
      continue;
    }

    const startTime = a.startTimeInSeconds
      ? new Date(a.startTimeInSeconds * 1000).toISOString()
      : null;

    // Calculate avg pace in sec/km from duration and distance
    const distanceM = a.distanceInMeters ?? 0;
    const durationSec = a.durationInSeconds ?? 0;
    const avgPaceSecKm = distanceM > 0 ? Math.round((durationSec / distanceM) * 1000) : null;

    // Garmin perceivedExertionRating is 0-10 (sometimes 0-100 in older firmware)
    let garminRpe: number | null = a.perceivedExertionRating ?? null;
    if (garminRpe !== null && garminRpe > 10) {
      garminRpe = Math.round(garminRpe / 10); // Normalise legacy 0-100 scale
    }

    const { error } = await supabase.from("garmin_activities").upsert(
      {
        garmin_id: String(a.activityId),
        user_id: userId,
        activity_type: a.activityType ?? "UNKNOWN",
        start_time: startTime,
        duration_sec: durationSec,
        distance_m: Math.round(distanceM),
        avg_pace_sec_km: avgPaceSecKm,
        avg_hr: a.averageHeartRateInBeatsPerMinute ?? null,
        max_hr: a.maxHeartRateInBeatsPerMinute ?? null,
        calories: a.activeKilocalories ?? null,
        aerobic_effect: a.aerobicTrainingEffect ?? null,
        anaerobic_effect: a.anaerobicTrainingEffect ?? null,
        garmin_rpe: garminRpe,
      },
      { onConflict: "garmin_id" },
    );

    if (error) {
      console.error("[garmin-webhook] Failed to upsert activity:", error);
    }
  }
}

/**
 * Handle daily summary pushes (resting HR, HRV, stress, VO2max).
 * Garmin schema: https://developer.garmin.com/gc-developer-program/daily-api/
 */
async function handleDailies(
  supabase: ReturnType<typeof createClient>,
  dailies: any[],
) {
  for (const d of dailies) {
    const userId = await resolveUserId(supabase, d.userId ?? d.userAccessToken);
    if (!userId) continue;

    const dayDate = d.calendarDate ?? (d.startTimeInSeconds
      ? new Date(d.startTimeInSeconds * 1000).toISOString().split("T")[0]
      : null);

    if (!dayDate) continue;

    // Webhook payload uses `steps`; REST/backfill uses `totalSteps`. Accept either.
    const stepsVal = d.steps ?? d.totalSteps ?? d.stepsCount ?? null;
    const activeCalVal = d.activeKilocalories ?? null;
    const activeDurVal = d.activeDurationInSeconds ?? null;
    const moderateSec = d.moderateIntensityDurationInSeconds ?? 0;
    const vigorousSec = d.vigorousIntensityDurationInSeconds ?? 0;
    const activeMinVal = (moderateSec + vigorousSec) > 0
      ? Math.round((moderateSec + vigorousSec) / 60)
      : (activeDurVal != null ? Math.round(activeDurVal / 60) : null);
    const vigorousMinVal = vigorousSec > 0 ? Math.round(vigorousSec / 60) : null;

    // Only include hrv_rmssd if the dailies payload actually has HRV data.
    // Otherwise we'd overwrite a value previously stored by handleHrv().
    const hrvFromDaily = d.hrvSummary?.lastNight ?? d.hrvSummary?.lastNightAvg ?? undefined;
    const row: Record<string, unknown> = {
      user_id: userId,
      day_date: dayDate,
      resting_hr: d.restingHeartRateInBeatsPerMinute ?? null,
      max_hr: d.maxHeartRateInBeatsPerMinute ?? null,
      stress_avg: d.averageStressLevel ?? null,
      vo2max: d.vo2Max ?? null,
      steps: stepsVal,
      active_calories: activeCalVal != null ? Math.round(activeCalVal) : null,
      active_minutes: activeMinVal,
      highly_active_minutes: vigorousMinVal,
    };
    if (hrvFromDaily != null) {
      row.hrv_rmssd = hrvFromDaily;
    }

    const { error } = await supabase.from("daily_metrics").upsert(
      row,
      { onConflict: "user_id,day_date" },
    );

    if (error) {
      console.error("[garmin-webhook] Failed to upsert daily metric:", error);
    } else {
      console.log(`[garmin-webhook] Daily metric stored for user ${userId} on ${dayDate}`);
    }
  }
}

/**
 * Handle sleep summary pushes.
 * Garmin schema: https://developer.garmin.com/gc-developer-program/sleep-api/
 */
async function handleSleeps(
  supabase: ReturnType<typeof createClient>,
  sleeps: any[],
) {
  for (const s of sleeps) {
    const userId = await resolveUserId(supabase, s.userId ?? s.userAccessToken);
    if (!userId) continue;

    const calendarDate = s.calendarDate ?? null;
    if (!calendarDate) continue;

    // Garmin may send the score in different formats depending on firmware.
    // qualifierKey is a string (e.g. "EXCELLENT"), not a number — skip it.
    const sleepScore: number | null =
      s.sleepScores?.overall?.value
      ?? s.overallSleepScore?.value
      ?? null;

    // Store stage durations (seconds). These arrive in the webhook payload
    // regardless of whether the score is available yet.
    // Note: Garmin's field naming is inconsistent — REM uses "remSleepInSeconds"
    // (no "Duration"), while deep/awake use "...DurationInSeconds". Check both.
    const durationSec: number | null = s.durationInSeconds ?? null;
    const deepSec: number | null = s.deepSleepDurationInSeconds ?? null;
    const remSec: number | null = s.remSleepInSeconds ?? s.remSleepDurationInSeconds ?? null;
    const lightSec: number | null = s.lightSleepDurationInSeconds ?? s.lightSleepInSeconds ?? null;
    const awakeSec: number | null = s.awakeDurationInSeconds ?? null;

    // Log all top-level keys for diagnostics (helps catch future Garmin field name changes)
    console.log(`[garmin-webhook] Sleep keys for ${calendarDate}: ${Object.keys(s).join(', ')}`);

    if (sleepScore != null) {
      console.log(`[garmin-webhook] Sleep score received: ${sleepScore} (${calendarDate}), deep=${deepSec}s, rem=${remSec}s, light=${lightSec}s, awake=${awakeSec}s`);
    } else if (durationSec != null) {
      console.log(`[garmin-webhook] Sleep stages only (score pending): ${(durationSec/3600).toFixed(1)}h, deep=${deepSec}s, rem=${remSec}s, light=${lightSec}s, awake=${awakeSec}s`);
    }

    const { error } = await supabase.from("sleep_summaries").upsert(
      {
        user_id: userId,
        calendar_date: calendarDate,
        overall_sleep_score: sleepScore,
        duration_sec: durationSec,
        deep_sec: deepSec,
        rem_sec: remSec,
        light_sec: lightSec,
        awake_sec: awakeSec,
      },
      { onConflict: "user_id,calendar_date" },
    );

    if (error) {
      console.error("[garmin-webhook] Failed to upsert sleep summary:", error);
    } else {
      console.log(`[garmin-webhook] Sleep summary stored for user ${userId} on ${calendarDate}`);
    }
  }
}

/**
 * Handle user metrics pushes (VO2max running, lactate threshold).
 * Garmin schema: https://developer.garmin.com/gc-developer-program/user-metrics-api/
 *
 * Key fields: vo2MaxRunning, lactateThresholdSpeed (m/s), lactateThresholdHeartRateInBeatsPerMinute
 */
async function handleUserMetrics(
  supabase: ReturnType<typeof createClient>,
  metrics: any[],
) {
  for (const m of metrics) {
    // Log raw payload so we can diagnose when fields land as null — Garmin's
    // webhook occasionally uses `vo2Max` instead of `vo2MaxRunning` and other
    // field-name drift shows up here.
    console.log(`[garmin-webhook] userMetrics raw:`, JSON.stringify(m));

    const userId = await resolveUserId(supabase, m.userId ?? m.userAccessToken);
    if (!userId) {
      console.warn("[garmin-webhook] Unknown userAccessToken for userMetrics, skipping");
      continue;
    }

    const calendarDate = m.calendarDate ?? null;
    if (!calendarDate) continue;

    // Accept both `vo2MaxRunning` (documented webhook field) and `vo2Max`
    // (seen on the REST endpoint and occasionally in webhook pushes).
    const vo2Value: number | null = m.vo2MaxRunning ?? m.vo2Max ?? null;

    // Convert LT speed from m/s → sec/km (what the app uses for pace)
    const ltSpeedMps: number | null = m.lactateThresholdSpeed ?? null;
    const ltPaceSecKm = ltSpeedMps && ltSpeedMps > 0
      ? Math.round(1000 / ltSpeedMps)
      : null;
    const ltHR: number | null = m.lactateThresholdHeartRateInBeatsPerMinute ?? null;

    // Skip rows with no actual data — Garmin sometimes emits userMetrics events
    // with only calendarDate+userId and no metrics, which would otherwise
    // overwrite good data with nulls.
    if (vo2Value == null && ltSpeedMps == null && ltHR == null) {
      console.log(`[garmin-webhook] userMetrics for ${calendarDate} has no metrics — skipping upsert`);
      continue;
    }

    const { error } = await supabase.from("physiology_snapshots").upsert(
      {
        user_id: userId,
        calendar_date: calendarDate,
        vo2_max_running: vo2Value,
        lactate_threshold_pace: ltPaceSecKm,
        lt_heart_rate: ltHR,
      },
      { onConflict: "user_id,calendar_date" },
    );

    if (error) {
      console.error("[garmin-webhook] Failed to upsert physiology snapshot:", error);
    } else {
      console.log(`[garmin-webhook] Physiology snapshot saved for ${calendarDate}: VO2max=${vo2Value}, LT=${ltPaceSecKm}s/km, ltHR=${ltHR}`);
    }
  }
}

/**
 * Handle HRV summary pushes (overnight HRV monitoring).
 * Garmin sends HRV as a separate body.hrv key, distinct from body.dailies.
 * FR965 and other HRV-capable devices push this after each nightly sync.
 * Garmin schema: https://developer.garmin.com/gc-developer-program/hrv-api/
 */
async function handleHrv(
  supabase: ReturnType<typeof createClient>,
  hrvSummaries: any[],
) {
  for (const h of hrvSummaries) {
    const userId = await resolveUserId(supabase, h.userId ?? h.userAccessToken);
    if (!userId) continue;

    const calendarDate = h.calendarDate ?? null;
    if (!calendarDate) continue;

    // lastNight = overall nightly HRV RMSSD (ms). lastNightAvg is the 5-min average.
    const hrv = h.lastNight ?? h.lastNightAvg ?? null;
    if (hrv == null) continue;

    // Upsert into daily_metrics — merge with existing row for the same day
    const { error } = await supabase.from("daily_metrics").upsert(
      {
        user_id: userId,
        day_date: calendarDate,
        hrv_rmssd: hrv,
      },
      { onConflict: "user_id,day_date", ignoreDuplicates: false },
    );

    if (error) {
      console.error("[garmin-webhook] Failed to upsert HRV:", error);
    } else {
      console.log(`[garmin-webhook] HRV stored for user ${userId} on ${calendarDate}: ${hrv}ms`);
    }
  }
}

/**
 * Handle activity detail pushes (lap data, etc.).
 * Garmin schema: https://developer.garmin.com/gc-developer-program/activity-details-api/
 */
async function handleActivityDetails(
  supabase: ReturnType<typeof createClient>,
  details: any[],
) {
  for (const d of details) {
    const userId = await resolveUserId(supabase, d.userId ?? d.userAccessToken);
    if (!userId) continue;

    const garminId = String(d.activityId);

    const { error } = await supabase.from("activity_details").upsert(
      {
        garmin_id: garminId,
        user_id: userId,
        json_data: d,
      },
      { onConflict: "garmin_id" },
    );

    if (error) {
      console.error("[garmin-webhook] Failed to upsert activity detail:", error);
    }
  }
}

/**
 * Handle stress detail pushes (per-minute stress samples).
 * We don't store these — the app reads `daily_metrics.stress_avg` instead. This
 * handler exists so the endpoint can be enabled in the Garmin Portal without
 * the receiver dropping payloads silently, which confuses Active User tests.
 */
async function handleStressDetails(details: any[]) {
  console.log(`[garmin-webhook] stressDetails acknowledged (${details.length} items, not stored)`);
}

/**
 * Handle deregistration pushes — user revoked consent from Garmin Connect.
 * Required by Garmin Partner Verification: Garmin insists we have a functioning
 * endpoint for this so users can actually disconnect.
 *
 * Action: delete the `garmin_tokens` row for the affected user. Physiology
 * data in other tables is preserved — if the user reconnects later, it's
 * still there. Future webhooks for this user will fail `resolveUserId` and
 * be dropped cleanly.
 *
 * Garmin schema: https://developer.garmin.com/gc-developer-program/user-registration-api/
 */
async function handleDeregistrations(
  supabase: ReturnType<typeof createClient>,
  deregistrations: any[],
) {
  for (const dr of deregistrations) {
    const identifier = dr.userId ?? dr.userAccessToken;
    if (!identifier) {
      console.warn("[garmin-webhook] Deregistration with no identifier, skipping");
      continue;
    }

    const userId = await resolveUserId(supabase, identifier);
    if (!userId) {
      console.warn(`[garmin-webhook] Deregistration for unknown user ${identifier}, already cleared`);
      continue;
    }

    // Delete by user_id (covers both rows keyed by garmin_user_id and access_token)
    const { error } = await supabase
      .from("garmin_tokens")
      .delete()
      .eq("user_id", userId);

    if (error) {
      console.error(`[garmin-webhook] Failed to delete garmin_tokens for ${userId}:`, error);
    } else {
      console.log(`[garmin-webhook] Deregistered user ${userId} — tokens cleared`);
    }
  }
}

/**
 * Handle user permission change pushes.
 * Required by Garmin Partner Verification. Fires when a user toggles what data
 * categories they share (e.g. keeps Dailies but revokes Activities).
 *
 * Action: log the new permission set. No automatic action — Garmin will simply
 * stop sending webhooks for revoked categories, and the tokens remain valid.
 * If we later want to surface "missing permissions" in the UI, this is where
 * we'd persist the latest permission list per user.
 *
 * Garmin schema: https://developer.garmin.com/gc-developer-program/user-permissions-api/
 */
async function handleUserPermissions(
  supabase: ReturnType<typeof createClient>,
  changes: any[],
) {
  for (const c of changes) {
    const identifier = c.userId ?? c.userAccessToken;
    const userId = identifier ? await resolveUserId(supabase, identifier) : null;
    const perms = Array.isArray(c.permissions) ? c.permissions.join(",") : String(c.permissions ?? "");
    console.log(`[garmin-webhook] userPermissions change for user=${userId ?? identifier ?? 'unknown'}: [${perms}]`);
  }
}
